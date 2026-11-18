/*
 * Browser-side recorder. Injected into every frame of the recording context
 * with context.addInitScript(). It talks to Node only through the binding
 * window.__rp_emit (context.exposeBinding), so the page cannot reach the
 * server any other way.
 *
 * Responsibilities:
 *   - observe trusted user events (click, input, change, keys, scroll, drag…)
 *   - retarget them to the meaningful element (button rather than inner <span>)
 *   - describe the element and generate ranked selector candidates
 *   - never ship sensitive values to the log (they go to an in-memory vault)
 *
 * This file is plain ES2020 and must not depend on anything from the page.
 */
(() => {
  if (window.__rp) return;

  const EMIT = '__rp_emit';
  const STATE = '__rp_state';
  const OVERLAY_ATTR = 'data-rp-overlay';
  let mode = 'record'; // 'record' | 'paused' | 'assert' | 'off'
  let seq = 0;

  // ---------------------------------------------------------------------------
  // DOM helpers (shadow-DOM aware)
  // ---------------------------------------------------------------------------
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function parentElementOrHost(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }

  /** All roots: document + every open shadow root, recursively. */
  function allRoots() {
    const roots = [document];
    const walk = (root) => {
      const it = root.querySelectorAll('*');
      for (const el of it) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  }

  function allElements(scope) {
    const out = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    if (scope && scope !== document) {
      visit(scope);
      if (scope.shadowRoot) visit(scope.shadowRoot);
    } else visit(document);
    return out;
  }

  function queryAllDeep(css, scope) {
    const out = [];
    const roots = scope && scope !== document ? [scope, ...allElements(scope).filter((e) => e.shadowRoot).map((e) => e.shadowRoot)] : allRoots();
    for (const r of roots) {
      try {
        for (const el of r.querySelectorAll(css)) out.push(el);
      } catch (e) {
        return [];
      }
    }
    return out;
  }

  function isOverlay(el) {
    return !!(el && el.closest && el.closest(`[${OVERLAY_ATTR}]`));
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || style.display === 'contents';
  }

  function isHiddenForA11y(el) {
    for (let e = el; e; e = parentElementOrHost(e)) {
      if (e.getAttribute && e.getAttribute('aria-hidden') === 'true') return true;
      const s = getComputedStyle(e);
      if (s.display === 'none') return true;
    }
    return getComputedStyle(el).visibility === 'hidden';
  }

  // ---------------------------------------------------------------------------
  // Roles and accessible names (pragmatic subset of WAI-ARIA / accname)
  // ---------------------------------------------------------------------------
  function implicitRole(el) {
    const tag = el.tagName;
    switch (tag) {
      case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': return 'button';
      case 'SUMMARY': return 'button';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'IMG': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'HEADER': return 'banner';
      case 'FOOTER': return 'contentinfo';
      case 'ASIDE': return 'complementary';
      case 'DIALOG': return 'dialog';
      case 'FORM': return 'form';
      case 'SECTION': return (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) ? 'region' : null;
      case 'UL': case 'OL': return 'list';
      case 'LI': return 'listitem';
      case 'TABLE': return 'table';
      case 'TR': return 'row';
      case 'TD': return 'cell';
      case 'TH': return 'columnheader';
      case 'OPTION': return 'option';
      case 'TEXTAREA': return 'textbox';
      case 'SELECT': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'PROGRESS': return 'progressbar';
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (['text', 'email', 'tel', 'url', ''].includes(t)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
        return null; // password, file, date, color, hidden… avoid role locators
      }
    }
    return null;
  }

  function getRole(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    return implicitRole(el);
  }

  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'checkbox', 'radio', 'option', 'cell', 'columnheader', 'rowheader', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'switch', 'tooltip', 'row']);

  function textFromContent(el, depth = 0) {
    if (depth > 20) return '';
    let out = '';
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
    for (const n of kids) {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const c = n;
        if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE' || c.tagName === 'SLOT' && false) continue;
        if (c.getAttribute('aria-hidden') === 'true') continue;
        const s = getComputedStyle(c);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        if (c.tagName === 'IMG') { out += ' ' + (c.getAttribute('alt') || '') + ' '; continue; }
        if (c.tagName === 'SLOT') { for (const a of c.assignedNodes({ flatten: true })) out += a.nodeType === 3 ? a.textContent : ' ' + textFromContent(a, depth + 1) + ' '; continue; }
        const block = s.display !== 'inline';
        out += (block ? ' ' : '') + (c.getAttribute('aria-label') || textFromContent(c, depth + 1)) + (block ? ' ' : '');
      }
    }
    return out;
  }

  function byIdText(ids, root) {
    return ids.split(/\s+/).map((id) => {
      const r = (root && root.getElementById) ? root.getElementById(id) : document.getElementById(id);
      return r ? norm(textFromContent(r)) : '';
    }).join(' ');
  }

  function accessibleName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = norm(byIdText(lb, el.getRootNode()));
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && norm(al)) return norm(al);
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t)) return norm(el.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''));
      if (t === 'image') return norm(el.getAttribute('alt') || el.value || 'Submit');
      const labels = el.labels ? [...el.labels] : [];
      const lt = norm(labels.map((l) => labelText(l, el)).join(' '));
      if (lt) return lt;
      return norm(el.getAttribute('title') || el.getAttribute('placeholder') || '');
    }
    if (tag === 'IMG') return norm(el.getAttribute('alt') || el.getAttribute('title') || '');
    const role = getRole(el);
    if (role && NAME_FROM_CONTENT.has(role)) {
      const t = norm(textFromContent(el));
      if (t) return t;
    }
    if (tag === 'FIELDSET') {
      const lg = el.querySelector(':scope > legend');
      if (lg) return norm(textFromContent(lg));
    }
    if (tag === 'TABLE') {
      const cap = el.querySelector(':scope > caption');
      if (cap) return norm(textFromContent(cap));
    }
    return norm(el.getAttribute('title') || '');
  }

  /** Text of a <label>, excluding the control it labels. */
  function labelText(label, control) {
    let out = '';
    for (const n of label.childNodes) {
      if (n === control) continue;
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.nodeType === Node.ELEMENT_NODE && !['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName)) out += ' ' + textFromContent(n) + ' ';
    }
    return norm(out);
  }

  function labelsOf(el) {
    const out = [];
    if (el.labels) for (const l of el.labels) out.push(labelText(l, el));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) out.push(norm(byIdText(lb, el.getRootNode())));
    const al = el.getAttribute('aria-label');
    if (al) out.push(norm(al));
    return out.filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Matching (mirrors Playwright's default semantics closely enough to score)
  // ---------------------------------------------------------------------------
  function textMatches(actual, expected, exact) {
    if (exact) return norm(actual) === norm(expected);
    return norm(actual).toLowerCase().includes(norm(expected).toLowerCase());
  }

  function countRole(role, name, exact, scope) {
    let n = 0;
    for (const e of allElements(scope)) {
      if (getRole(e) !== role) continue;
      if (isHiddenForA11y(e)) continue;
      if (name !== undefined && !textMatches(accessibleName(e), name, exact)) continue;
      n++;
    }
    return n;
  }

  function countLabel(text, exact, scope) {
    let n = 0;
    for (const e of allElements(scope)) {
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) && !e.hasAttribute('aria-labelledby') && !e.hasAttribute('aria-label')) continue;
      if (labelsOf(e).some((l) => textMatches(l, text, exact))) n++;
    }
    return n;
  }

  function countAttr(attr, value, exact, scope) {
    let n = 0;
    for (const e of allElements(scope)) {
      const v = e.getAttribute(attr);
      if (v != null && textMatches(v, value, exact)) n++;
    }
    return n;
  }

  /** Element text as Playwright's text engine sees it: concatenated text nodes, no layout spacing. */
  function pwText(el) {
    let out = '';
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : el.childNodes;
    for (const n of kids) {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.nodeType === Node.ELEMENT_NODE && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(n.tagName)) out += pwText(n);
    }
    return out;
  }

  /** Deepest elements whose text matches (Playwright getByText semantics). */
  function textMatchesElements(text, exact, scope) {
    const out = [];
    for (const e of allElements(scope)) {
      if (['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'NOSCRIPT', 'HTML', 'BODY'].includes(e.tagName)) continue;
      const t = pwText(e);
      if (!textMatches(t, text, exact)) continue;
      const childMatches = [...e.children].some((c) => textMatches(pwText(c), text, exact));
      if (!childMatches) out.push(e);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Selector generation and scoring
  // ---------------------------------------------------------------------------
  const DYNAMIC = /(\d{3,}|[a-f0-9]{8,}|^:r|^ember\d|^ng-|^mui-|^react-|__\w{5,}$|^[a-z]{1,3}-[a-zA-Z0-9]{5,}$)/;
  const HASHED_CLASS = /(^css-|^sc-|^jsx-|^emotion-|^makeStyles|^_[a-zA-Z0-9]{5,}|[a-zA-Z]+__[a-zA-Z]+___[a-zA-Z0-9]+|\d{3,})/;
  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  function cssEscape(v) { return CSS.escape(v); }
  function attrSel(attr, v) { return `[${attr}=${JSON.stringify(v)}]`; }

  function cssCount(sel, scope) { return queryAllDeep(sel, scope).length; }

  function nthOfType(el) {
    let i = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
    return i;
  }

  function structuralCss(el) {
    const parts = [];
    let e = el;
    const root = el.getRootNode();
    while (e && e.nodeType === 1 && e !== document.documentElement) {
      if (e.id && !DYNAMIC.test(e.id) && e !== el) { parts.unshift('#' + cssEscape(e.id)); break; }
      const tid = e.getAttribute('data-testid');
      if (tid && e !== el) { parts.unshift(attrSel('data-testid', tid)); break; }
      const tag = e.tagName.toLowerCase();
      const parent = e.parentElement;
      const sameTag = parent ? [...parent.children].filter((c) => c.tagName === e.tagName).length : 1;
      parts.unshift(sameTag > 1 ? `${tag}:nth-of-type(${nthOfType(e)})` : tag);
      if (!parent || (root !== document && parent.getRootNode() !== root)) break;
      e = parent;
    }
    return parts.join(' > ');
  }

  function xpathOf(el) {
    if (el.getRootNode() !== document) return null; // XPath cannot cross shadow roots
    const parts = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(`${e.tagName.toLowerCase()}[${i}]`);
    }
    return '/' + parts.join('/');
  }

  function shortText(el) {
    const t = norm(pwText(el));
    return t.length > 0 && t.length <= 60 ? t : null;
  }

  /**
   * Produce candidates for `el` scoped to `scope` (document by default).
   * Each candidate carries its match count so ambiguity is explicit.
   */
  function candidatesFor(el, scope) {
    const c = [];
    const push = (cand) => { if (cand && cand.matchCount > 0) c.push(cand); };
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return [{ strategy: 'css', value: tag, score: 60, matchCount: 1 }];

    // 1. test ids
    const tid = el.getAttribute('data-testid');
    if (tid) push({ strategy: 'testid', value: tid, score: 100, matchCount: countAttr('data-testid', tid, true, scope) });
    for (const a of TESTID_ATTRS.slice(1)) {
      const v = el.getAttribute(a);
      if (v) push({ strategy: 'css', value: attrSel(a, v), score: 92, matchCount: cssCount(attrSel(a, v), scope), notes: [`${a} attribute`] });
    }

    // 2. role + accessible name
    const role = getRole(el);
    const name = accessibleName(el);
    if (role && !['presentation', 'none', 'generic'].includes(role)) {
      if (name && name.length <= 80) {
        let n = countRole(role, name, false, scope);
        const cand = { strategy: 'role', value: role, options: { name }, score: 90, matchCount: n };
        if (n > 1) {
          const ne = countRole(role, name, true, scope);
          if (ne < n) { cand.options.exact = true; cand.matchCount = ne; }
        }
        push(cand);
      } else if (!name) {
        const n = countRole(role, undefined, false, scope);
        if (n >= 1) push({ strategy: 'role', value: role, score: 55, matchCount: n, notes: ['no accessible name'] });
      }
    }

    // 3. label
    if (['input', 'textarea', 'select'].includes(tag) || el.isContentEditable) {
      const labels = labelsOf(el);
      if (labels[0] && labels[0].length <= 80) {
        let n = countLabel(labels[0], false, scope);
        const cand = { strategy: 'label', value: labels[0], score: 86, matchCount: n };
        if (n > 1) { const ne = countLabel(labels[0], true, scope); if (ne < n) { cand.options = { exact: true }; cand.matchCount = ne; } }
        push(cand);
      }
      // 4. placeholder
      const ph = el.getAttribute('placeholder');
      if (ph) {
        let n = countAttr('placeholder', ph, false, scope);
        const cand = { strategy: 'placeholder', value: ph, score: 80, matchCount: n };
        if (n > 1) { const ne = countAttr('placeholder', ph, true, scope); if (ne < n) { cand.options = { exact: true }; cand.matchCount = ne; } }
        push(cand);
      }
    }

    // alt / title
    if (tag === 'img' && el.getAttribute('alt')) {
      push({ strategy: 'alt', value: el.getAttribute('alt'), options: { exact: true }, score: 78, matchCount: countAttr('alt', el.getAttribute('alt'), true, scope) });
    }

    // 5. text (non-form elements)
    if (!['input', 'textarea', 'select'].includes(tag)) {
      const t = shortText(el);
      if (t) {
        const matches = textMatchesElements(t, true, scope);
        if (matches.includes(el) || matches.some((m) => el.contains(m))) {
          push({ strategy: 'text', value: t, options: { exact: true }, score: 70, matchCount: matches.length });
        }
      }
    }

    // 6. CSS
    if (el.id) {
      const dyn = DYNAMIC.test(el.id);
      push({ strategy: 'css', value: '#' + cssEscape(el.id), score: dyn ? 35 : 68, matchCount: cssCount('#' + cssEscape(el.id), scope), notes: dyn ? ['id looks generated'] : undefined });
    }
    const nm = el.getAttribute('name');
    if (nm) { const s = `${tag}${attrSel('name', nm)}`; push({ strategy: 'css', value: s, score: 62, matchCount: cssCount(s, scope) }); }
    if (tag === 'a' && el.getAttribute('href') && el.getAttribute('href').length < 80 && !el.getAttribute('href').startsWith('javascript')) {
      const s = `a${attrSel('href', el.getAttribute('href'))}`; push({ strategy: 'css', value: s, score: 50, matchCount: cssCount(s, scope) });
    }
    const classes = [...el.classList].filter((k) => !HASHED_CLASS.test(k)).slice(0, 2);
    if (classes.length) { const s = tag + classes.map((k) => '.' + cssEscape(k)).join(''); push({ strategy: 'css', value: s, score: 45, matchCount: cssCount(s, scope) }); }
    const path = structuralCss(el);
    push({ strategy: 'css', value: path, score: 30, matchCount: cssCount(path, scope), notes: ['structural path (brittle)'] });

    // 7. XPath
    if (!scope || scope === document) {
      const xp = xpathOf(el);
      if (xp) push({ strategy: 'xpath', value: xp, score: 10, matchCount: 1, notes: ['absolute xpath (last resort)'] });
    }
    return c;
  }

  /** Text snippets inside `container` (outside `exclude`) usable as a hasText filter. */
  function distinctiveTexts(container, exclude) {
    const out = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 8; n = walker.nextNode()) {
      if (exclude.contains(n)) continue;
      const t = norm(n.textContent);
      if (t.length >= 2 && t.length <= 40) out.push(t);
    }
    return out;
  }

  /** e.g. getByRole('listitem').filter({ hasText: 'Blue shoe' }) */
  function hasTextCandidate(container, exclude) {
    const role = getRole(container);
    const peers = role ? allElements().filter((x) => getRole(x) === role && !isHiddenForA11y(x)) : queryAllDeep(container.tagName.toLowerCase());
    for (const t of distinctiveTexts(container, exclude)) {
      const n = peers.filter((x) => norm(x.textContent).toLowerCase().includes(t.toLowerCase())).length;
      if (n === 1) {
        return role
          ? { strategy: 'role', value: role, options: { hasText: t }, score: 75, matchCount: 1 }
          : { strategy: 'css', value: container.tagName.toLowerCase(), options: { hasText: t }, score: 65, matchCount: 1 };
      }
    }
    return null;
  }

  /** Find a unique ancestor container to scope an ambiguous candidate in. */
  function scopedCandidate(el, base) {
    let e = parentElementOrHost(el);
    for (let depth = 0; e && depth < 8 && e !== document.body; depth++, e = parentElementOrHost(e)) {
      const parentCands = candidatesFor(e, document)
        // 'text' is excluded: a container's text includes the child's own text, which is brittle
        .filter((p) => p.matchCount === 1 && ['testid', 'role', 'label'].includes(p.strategy) && p.score >= 60)
        .filter((p) => !(p.strategy === 'role' && !p.options));
      if (!parentCands.length && ['listitem', 'row', 'article', 'group', 'region', 'dialog', 'form', 'cell', 'option'].includes(getRole(e) || '') || (!parentCands.length && ['LI', 'TR', 'ARTICLE', 'SECTION', 'FIELDSET'].includes(e.tagName))) {
        const ht = hasTextCandidate(e, el);
        if (ht) parentCands.push(ht);
      }
      if (!parentCands.length) {
        if (e.id && !DYNAMIC.test(e.id) && cssCount('#' + cssEscape(e.id)) === 1) parentCands.push({ strategy: 'css', value: '#' + cssEscape(e.id), score: 65, matchCount: 1 });
      }
      if (!parentCands.length) continue;
      const parent = parentCands.sort((a, b) => b.score - a.score)[0];
      const inner = candidatesFor(el, e).find((c) => c.strategy === base.strategy && c.value === base.value && c.matchCount === 1);
      if (inner) return { ...inner, parent, score: Math.min(base.score, parent.score) - 4, matchCount: 1, notes: ['scoped to unique container'] };
    }
    return null;
  }

  function rankSelectors(el) {
    const raw = candidatesFor(el, document);
    const out = [];
    for (const c of raw) {
      if (c.matchCount === 1) out.push(c);
      else {
        // ambiguity: try scoping inside a unique ancestor, then fall back to nth.
        if (['role', 'text', 'label', 'placeholder', 'testid'].includes(c.strategy)) {
          const s = scopedCandidate(el, c);
          if (s) out.push(s);
        }
        const idx = indexAmong(el, c);
        if (idx >= 0) out.push({ ...c, options: { ...(c.options || {}), nth: idx }, score: Math.max(5, c.score - 50), notes: [...(c.notes || []), `ambiguous (${c.matchCount} matches), index ${idx}`] });
      }
    }
    // de-duplicate, sort best first
    const seen = new Set();
    return out
      .filter((c) => { const k = JSON.stringify([c.strategy, c.value, c.options, c.parent && c.parent.value]); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  function indexAmong(el, c) {
    let list = [];
    if (c.strategy === 'role') list = allElements().filter((e) => getRole(e) === c.value && !isHiddenForA11y(e) && (!c.options || c.options.name === undefined || textMatches(accessibleName(e), c.options.name, c.options.exact)));
    else if (c.strategy === 'css') list = queryAllDeep(c.value);
    else if (c.strategy === 'text') list = textMatchesElements(c.value, true);
    else if (c.strategy === 'label') list = allElements().filter((e) => labelsOf(e).some((l) => textMatches(l, c.value, c.options && c.options.exact)));
    else if (c.strategy === 'placeholder') list = allElements().filter((e) => e.getAttribute('placeholder') != null && textMatches(e.getAttribute('placeholder'), c.value, c.options && c.options.exact));
    else if (c.strategy === 'testid') list = allElements().filter((e) => e.getAttribute('data-testid') === c.value);
    // Playwright orders matches in document order; our deep walk is close to that for light DOM.
    return list.indexOf(el);
  }

  const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=option], [role=treeitem], [contenteditable=""], [contenteditable=true], [data-testid]';

  /** Retarget from the raw event target to the element a user "means". */
  function retarget(raw) {
    let e = raw;
    for (let depth = 0; e && depth < 6; depth++, e = parentElementOrHost(e)) {
      if (e.matches && e.matches(INTERACTIVE)) return e;
    }
    return raw;
  }

  function describe(el) {
    const attrs = {};
    for (const a of ['id', 'name', 'type', 'placeholder', 'data-testid', 'href', 'aria-label', 'title', 'value', 'class']) {
      const v = el.getAttribute(a);
      if (v != null && !(a === 'value' && isSensitive(el))) attrs[a] = v.slice(0, 200);
    }
    const r = el.getBoundingClientRect();
    return {
      tagName: el.tagName,
      role: getRole(el) || undefined,
      accessibleName: accessibleName(el) || undefined,
      text: (shortText(el) || '').slice(0, 100) || undefined,
      inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
      attributes: attrs,
      selectors: rankSelectors(el),
      inShadowDom: el.getRootNode() !== document,
      boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }

  // ---------------------------------------------------------------------------
  // Sensitive data
  // ---------------------------------------------------------------------------
  const SENSITIVE_NAME = /pass(word|wd)?|secret|token|otp|one.?time|cvv|cvc|ssn|card.?(num|no)|pin\b|api.?key/i;
  function isSensitive(el) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].includes(ac)) return true;
    return SENSITIVE_NAME.test(`${el.getAttribute('name') || ''} ${el.id || ''}`);
  }

  // ---------------------------------------------------------------------------
  // Emission
  // ---------------------------------------------------------------------------
  function emit(kind, data) {
    const fn = window[EMIT];
    if (typeof fn !== 'function') return;
    seq++;
    try { fn({ kind, seq, ts: Date.now(), url: location.href, title: document.title, ...data }); } catch (e) { /* page unloading */ }
  }

  const isEditable = (el) => el && ((el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes((el.type || '').toLowerCase())) || el.tagName === 'TEXTAREA' || el.isContentEditable);
  const isToggle = (el) => el && el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type);
  const realTarget = (ev) => (ev.composedPath && ev.composedPath()[0]) || ev.target;
  // Without the Node binding (e.g. replay contexts, which load this script only for
  // selector generation during AI healing) nothing is captured.
  const active = () => mode === 'record' && typeof window[EMIT] === 'function';

  // ---------------------------------------------------------------------------
  // Assertion / element-picker overlay
  // ---------------------------------------------------------------------------
  let overlay = null;
  function highlight(el) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.setAttribute(OVERLAY_ATTR, '');
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #f97316;background:rgba(249,115,22,.15);border-radius:3px;transition:all 60ms';
      (document.body || document.documentElement).appendChild(overlay);
    }
    if (!el) { overlay.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  // ---------------------------------------------------------------------------
  // Listeners (capture phase so page handlers cannot hide events from us)
  // ---------------------------------------------------------------------------
  let lastPointerDown = null;
  let suppressClickUntil = 0;
  let lastScrollIntent = 0;
  let html5DragSource = null;
  const scrollTimers = new Map();

  function on(type, fn, target = window) {
    target.addEventListener(type, (ev) => {
      if (!ev.isTrusted) return; // ignore synthetic events (incl. our own)
      const t = realTarget(ev);
      if (t && t.nodeType === 1 && isOverlay(t)) return;
      try { fn(ev, t); } catch (e) { console.debug('[rp] listener error', e); }
    }, true);
  }

  on('mousemove', (ev, t) => { if (mode === 'assert') highlight(retarget(t)); });

  on('pointerdown', (ev, t) => {
    if (mode === 'assert') { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    lastPointerDown = { el: t, x: ev.clientX, y: ev.clientY, button: ev.button };
  });
  on('mousedown', (ev, t) => {
    if (mode === 'assert') { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    // Native <select> popups are not part of a (headless) screencast, so the studio
    // renders the options itself. Tell Node which select was opened.
    const el = retarget(t);
    if (active() && el.tagName === 'SELECT' && !el.disabled && ev.button === 0) {
      emit('selectOpen', { target: describe(el), multiple: el.multiple, options: [...el.options].map((o) => ({ value: o.value, label: norm(o.label || o.textContent), selected: o.selected, disabled: o.disabled })) });
    }
  });

  on('pointerup', (ev, t) => {
    if (mode === 'assert') { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    if (!active() || !lastPointerDown || lastPointerDown.button !== 0 || html5DragSource) return;
    const moved = Math.hypot(ev.clientX - lastPointerDown.x, ev.clientY - lastPointerDown.y);
    const src = retarget(lastPointerDown.el);
    const dst = retarget(t);
    if (moved > 12 && src !== dst && !src.contains(dst) && !dst.contains(src) && !isEditable(src)) {
      suppressClickUntil = Date.now() + 300;
      emit('dragTo', { target: describe(src), destination: describe(dst) });
    }
    lastPointerDown = null;
  });

  on('click', (ev, t) => {
    if (mode === 'assert') {
      ev.preventDefault(); ev.stopImmediatePropagation();
      const el = retarget(t);
      highlight(null);
      emit('pick', { target: { ...describe(el), selectors: rankForAssertion(el) }, snapshot: snapshotOf(el) });
      return;
    }
    if (!active() || ev.button !== 0) return;
    if (Date.now() < suppressClickUntil) return;
    const el = retarget(t);
    // These are recorded by their 'change' events instead.
    if (isToggle(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    if (el.tagName === 'INPUT' && el.type === 'file') return;
    if (el.tagName === 'LABEL' && el.control && (isToggle(el.control) || el.control.type === 'file')) return;
    if (ev.detail > 1) return; // second click of a double click: handled by 'dblclick'
    const modifiers = ['Alt', 'Control', 'Meta', 'Shift'].filter((m) => ev[m.toLowerCase() + 'Key'] || (m === 'Control' && ev.ctrlKey));
    emit('click', { target: describe(el), modifiers: modifiers.length ? modifiers : undefined });
  });

  on('dblclick', (ev, t) => { if (active()) emit('dblclick', { target: describe(retarget(t)) }); });
  on('contextmenu', (ev, t) => { if (active()) emit('rightClick', { target: describe(retarget(t)) }); });

  on('input', (ev, t) => {
    if (!active()) return;
    const el = t.nodeType === 1 ? t : t.parentElement;
    if (!el) return;
    if (el.isContentEditable && el.tagName !== 'INPUT') {
      const host = el.closest('[contenteditable]') || el;
      emit('fill', { target: describe(host), value: host.innerText });
      return;
    }
    if (!isEditable(el) && !['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes((el.type || '').toLowerCase())) return;
    if (isEditable(el) || el.tagName === 'INPUT') {
      const sensitive = isSensitive(el);
      emit('fill', { target: describe(el), value: el.value, sensitive });
    }
  });

  on('change', (ev, t) => {
    if (!active()) return;
    const el = t;
    if (el.tagName === 'SELECT') {
      const opts = [...el.selectedOptions];
      emit('select', { target: describe(el), values: opts.map((o) => o.value), labels: opts.map((o) => norm(o.label || o.textContent)) });
    } else if (isToggle(el)) {
      emit(el.checked ? 'check' : 'uncheck', { target: describe(el) });
    } else if (el.tagName === 'INPUT' && el.type === 'file') {
      emit('setInputFiles', { target: describe(el), files: [...el.files].map((f) => f.name) });
    }
  });

  const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', ' ']);
  on('keydown', (ev, t) => {
    if (['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown'].includes(ev.key)) lastScrollIntent = Date.now();
    if (!active()) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(ev.key)) return;
    const el = t.nodeType === 1 ? t : null;
    const editable = isEditable(el);
    const mods = [];
    if (ev.ctrlKey) mods.push('Control');
    if (ev.altKey) mods.push('Alt');
    if (ev.metaKey) mods.push('Meta');
    const hasMod = mods.length > 0;
    if (editable) {
      // typing is captured by 'input'; only keys with side-effects are recorded
      if (hasMod) return; // e.g. Ctrl+A / Ctrl+V: the resulting value is captured by 'input'
      if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
    } else {
      if (!SPECIAL_KEYS.has(ev.key) && !hasMod) return;
      if (ev.key === ' ' && el && (el.tagName === 'BUTTON' || isToggle(el))) return; // becomes click/change
      // Keys that only move through a native dropdown's options are recorded by its 'change'.
      if (el && el.tagName === 'SELECT' && !hasMod && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter', 'Escape'].includes(ev.key)) return;
    }
    if (ev.shiftKey && (hasMod || SPECIAL_KEYS.has(ev.key))) mods.push('Shift');
    const key = ev.key === ' ' ? 'Space' : (ev.key.length === 1 ? ev.key.toLowerCase() : ev.key);
    const focusTarget = el && el !== document.body && el !== document.documentElement ? describe(retarget(el)) : undefined;
    emit('press', { key: [...mods, key].join('+'), target: focusTarget });
  });

  on('wheel', () => { lastScrollIntent = Date.now(); }, window);
  on('touchmove', () => { lastScrollIntent = Date.now(); }, window);
  on('scroll', (ev, t) => {
    if (!active()) return;
    if (Date.now() - lastScrollIntent > 1000) return; // programmatic scroll (focus, anchors, app code), not the user
    const isDoc = t === document || t === document.documentElement || t === document.scrollingElement;
    const key = isDoc ? document : t;
    clearTimeout(scrollTimers.get(key));
    scrollTimers.set(key, setTimeout(() => {
      scrollTimers.delete(key);
      if (!active()) return;
      if (isDoc) emit('scroll', { x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
      else emit('scroll', { x: Math.round(t.scrollLeft), y: Math.round(t.scrollTop), target: describe(t) });
    }, 350));
  }, document);

  on('dragstart', (ev, t) => { if (active()) html5DragSource = retarget(t); });
  on('drop', (ev, t) => {
    if (active() && html5DragSource) {
      const dst = retarget(t);
      if (dst !== html5DragSource) emit('dragTo', { target: describe(html5DragSource), destination: describe(dst) });
    }
    html5DragSource = null;
    suppressClickUntil = Date.now() + 300;
  });
  on('dragend', () => { html5DragSource = null; });

  function snapshotOf(el) {
    return {
      visible: isVisible(el),
      text: norm(el.innerText || el.textContent || '').slice(0, 200),
      value: ('value' in el && !isSensitive(el)) ? String(el.value) : undefined,
      enabled: !el.disabled,
      checked: 'checked' in el ? !!el.checked : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Control surface used by the Node side via page.evaluate / frame.evaluate
  // ---------------------------------------------------------------------------
  /**
   * Selectors for an assertion target must not depend on the content being
   * asserted (getByText('Saved') would make toHaveText('Saved') circular), so
   * content-derived candidates are demoted for picks.
   */
  function rankForAssertion(el) {
    const own = norm(textFromContent(el));
    const contentDerived = (c) => c.strategy === 'text' || (c.strategy === 'role' && c.options && c.options.name && own && c.options.name === own);
    const out = rankSelectors(el).map((c) => (contentDerived(c) ? { ...c, score: c.score - 40, notes: [...(c.notes || []), 'content-derived: demoted for assertions'] } : c));
    // ensure at least one structural candidate exists for assertions
    if (!out.some((c) => !contentDerived(c))) {
      const path = structuralCss(el);
      out.push({ strategy: 'css', value: path, score: 30, matchCount: cssCount(path), notes: ['structural path'] });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  window.__rp = {
    setMode(m) { mode = m; if (m !== 'assert') highlight(null); },
    getMode() { return mode; },
    describe,
    rankSelectors,
    accessibleName,
    getRole,
  };

  // Ask Node for the current mode (frames created mid-recording inherit it).
  const st = window[STATE];
  if (typeof st === 'function') {
    try { Promise.resolve(st()).then((m) => { if (m) mode = m; }).catch(() => {}); } catch (e) { /* ignore */ }
  }
})();
