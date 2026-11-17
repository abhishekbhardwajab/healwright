import type { Action, ElementTarget, TestCase, Assertion } from '../model/actions.js';
import { describeAction } from '../model/actions.js';
import { frameRootCode, locatorCode } from '../selectors/locator.js';

export interface CodegenOptions {
  /** Hoist locators used more than once into named constants. */
  reuseLocators?: boolean;
  /** Emit fallback selectors as comments under each step. */
  fallbackComments?: boolean;
  /** Emit the step description as a comment above each step. */
  stepComments?: boolean;
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const re = (s: string) => `/${s.replace(/\//g, '\\/')}/`;

/**
 * Generate a standalone @playwright/test spec from the action model.
 * Pure function: no browser needed, safe to call on every edit.
 */
export function generatePlaywrightTest(test: Pick<TestCase, 'name' | 'actions' | 'variables'>, opts: CodegenOptions = {}): string {
  const o = { reuseLocators: true, fallbackComments: false, stepComments: true, ...opts };
  const actions = test.actions.filter((a) => !a.disabled);
  const lines: string[] = [];
  const out = (s = '') => lines.push(s ? '  ' + s : '');

  // Test data: variables become env-overridable constants; secrets come only from env.
  const varNames = Object.keys(test.variables ?? {});
  const secretNames = [...new Set(actions.flatMap((a) => (a.type === 'fill' && a.secretVariable ? [a.secretVariable] : [])))];

  // Reusable locators: targets referenced 2+ times on the first tab.
  const hoisted = new Map<string, string>();
  if (o.reuseLocators) {
    const counts = new Map<string, { n: number; t: ElementTarget }>();
    for (const a of actions) {
      for (const t of targetsOf(a)) {
        if (a.pageAlias !== 'page' || !t.selectors[0]) continue;
        const key = targetCode('page', t);
        const c = counts.get(key) ?? { n: 0, t };
        c.n++; counts.set(key, c);
      }
    }
    const used = new Set<string>();
    for (const [code, { n, t }] of counts) {
      if (n < 2) continue;
      let name = varNameFor(t);
      for (let i = 2; used.has(name); i++) name = varNameFor(t) + i;
      used.add(name);
      hoisted.set(code, name);
    }
  }

  const loc = (alias: string, t: ElementTarget) => {
    const code = targetCode(alias, t);
    return hoisted.get(code) ?? code;
  };

  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  if (varNames.length) {
    lines.push('const testData = {');
    for (const v of varNames) lines.push(`  ${safeKey(v)}: process.env.${envName(v)} ?? ${q(test.variables[v])},`);
    lines.push('};');
    lines.push('');
  }
  lines.push(`test(${q(test.name || 'Recorded flow')}, async ({ page }) => {`);
  if (hoisted.size) {
    for (const [code, name] of hoisted) out(`const ${name} = ${code};`);
    out();
  }

  const fillValue = (v: string) => {
    if (!varNames.length || !/\$\{[\w.]+\}/.test(v)) return q(v);
    const tpl = v.replace(/`/g, '\\`').replace(/\$\{([\w.]+)\}/g, (_m, n) => (varNames.includes(n) ? `\${testData.${safeKey(n)}}` : `\\\${${n}}`));
    return '`' + tpl + '`';
  };

  for (const a of actions) {
    const p = a.pageAlias || 'page';
    if (o.stepComments) out(`// ${a.name || describeAction(a)}`.replace(/\n/g, ' '));
    const pre: string[] = [];
    const post: string[] = [];
    if (a.signals?.dialog) {
      const d = a.signals.dialog;
      pre.push(`${p}.once('dialog', (dialog) => dialog.${d.response}(${d.response === 'accept' && d.promptText !== undefined ? q(d.promptText) : ''}));`);
    }
    if (a.signals?.popup) {
      pre.push(`const ${a.signals.popup}Promise = ${p}.waitForEvent('popup');`);
      post.push(`const ${a.signals.popup} = await ${a.signals.popup}Promise;`);
    }
    if (a.signals?.download) {
      const v = `download${a.id.replace(/\W/g, '').slice(-6)}`;
      pre.push(`const ${v}Promise = ${p}.waitForEvent('download');`);
      post.push(`const ${v} = await ${v}Promise; // ${a.signals.download.suggestedFilename}`);
    }
    pre.forEach((l) => out(l));
    out(stepCode(a, p, loc, fillValue));
    post.forEach((l) => out(l));
    if (o.fallbackComments && a.target && a.target.selectors.length > 1) {
      for (const s of a.target.selectors.slice(1, 4)) out(`//   fallback: ${locatorCode(frameRootCode(p, a.target.framePath), s)}`);
    }
    if (o.stepComments) out();
  }
  while (lines[lines.length - 1] === '') lines.pop();
  lines.push('});');
  if (secretNames.length) {
    lines.unshift(`// Secrets are never recorded. Provide them via environment variables: ${secretNames.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

function stepCode(a: Action, p: string, loc: (alias: string, t: ElementTarget) => string, fillValue: (v: string) => string): string {
  switch (a.type) {
    case 'navigate': return `await ${p}.goto(${q(a.url)});`;
    case 'goBack': return `await ${p}.goBack();`;
    case 'goForward': return `await ${p}.goForward();`;
    case 'reload': return `await ${p}.reload();`;
    case 'click': {
      const m = a.modifiers?.length ? `{ modifiers: [${a.modifiers.map(q).join(', ')}] }` : '';
      return `await ${loc(p, a.target)}.click(${m});`;
    }
    case 'dblclick': return `await ${loc(p, a.target)}.dblclick();`;
    case 'rightClick': return `await ${loc(p, a.target)}.click({ button: 'right' });`;
    case 'hover': return `await ${loc(p, a.target)}.hover();`;
    case 'fill':
      if (a.secretVariable) return `await ${loc(p, a.target)}.fill(process.env.${a.secretVariable} ?? '');`;
      return `await ${loc(p, a.target)}.fill(${fillValue(a.value)});`;
    case 'clear': return `await ${loc(p, a.target)}.clear();`;
    case 'press': return a.target ? `await ${loc(p, a.target)}.press(${q(a.key)});` : `await ${p}.keyboard.press(${q(a.key)});`;
    case 'select': return `await ${loc(p, a.target)}.selectOption(${a.values.length === 1 ? q(a.values[0]) : `[${a.values.map(q).join(', ')}]`});`;
    case 'check': return `await ${loc(p, a.target)}.check();`;
    case 'uncheck': return `await ${loc(p, a.target)}.uncheck();`;
    case 'setInputFiles': {
      const files = (a.filePaths?.length ? a.filePaths : a.files).map(q);
      return `await ${loc(p, a.target)}.setInputFiles(${files.length === 1 ? files[0] : `[${files.join(', ')}]`});`;
    }
    case 'scroll':
      return a.target
        ? `await ${loc(p, a.target)}.evaluate((el) => el.scrollTo(${a.x}, ${a.y}));`
        : `await ${p}.evaluate(() => window.scrollTo(${a.x}, ${a.y}));`;
    case 'dragTo': return `await ${loc(p, a.target)}.dragTo(${loc(p, a.destination)});`;
    case 'wait':
      switch (a.wait) {
        case 'timeout': return `await ${p}.waitForTimeout(${a.ms ?? 1000}); // prefer an assertion over a fixed wait`;
        case 'loadState': return `await ${p}.waitForLoadState(${q(a.loadState ?? 'load')});`;
        case 'url': return `await ${p}.waitForURL(${a.urlPattern ? re(a.urlPattern) : "'**'"});`;
        case 'elementVisible': return `await ${loc(p, a.target!)}.waitFor({ state: 'visible' });`;
        case 'elementHidden': return `await ${loc(p, a.target!)}.waitFor({ state: 'hidden' });`;
      }
      break;
    case 'assert': return assertionCode(a.assertion, p, a.target ? loc(p, a.target) : undefined);
    case 'switchTab': return `await ${p}.bringToFront();`;
    case 'closeTab': return `await ${p}.close();`;
  }
  return `// unsupported step ${(a as Action).type}`;
}

export function assertionCode(as: Assertion, p: string, l?: string): string {
  const not = as.negate ? '.not' : '';
  const exp = (v?: string) => (as.regex ? re(v ?? '') : q(v ?? ''));
  switch (as.kind) {
    case 'url': return `await expect(${p})${not}.toHaveURL(${exp(as.expected)});`;
    case 'title': return `await expect(${p})${not}.toHaveTitle(${exp(as.expected)});`;
    case 'visible': return `await expect(${l})${not}.toBeVisible();`;
    case 'hidden': return `await expect(${l})${not}.toBeHidden();`;
    case 'enabled': return `await expect(${l})${not}.toBeEnabled();`;
    case 'disabled': return `await expect(${l})${not}.toBeDisabled();`;
    case 'checked': return `await expect(${l})${not}.toBeChecked();`;
    case 'containsText': return `await expect(${l})${not}.toContainText(${exp(as.expected)});`;
    case 'hasText': return `await expect(${l})${not}.toHaveText(${exp(as.expected)});`;
    case 'value': return `await expect(${l})${not}.toHaveValue(${exp(as.expected)});`;
    case 'attribute': return `await expect(${l})${not}.toHaveAttribute(${q(as.attribute ?? '')}, ${exp(as.expected)});`;
    case 'count': return `await expect(${l})${not}.toHaveCount(${Number(as.expected ?? 0)});`;
  }
}

function targetsOf(a: Action): ElementTarget[] {
  const out: ElementTarget[] = [];
  if (a.target) out.push(a.target);
  if (a.type === 'dragTo') out.push(a.destination);
  return out;
}

function targetCode(alias: string, t: ElementTarget) {
  const sel = t.selectors[0];
  const root = frameRootCode(alias, t.framePath);
  return sel ? locatorCode(root, sel) : `${root}.locator('${t.tagName.toLowerCase()}')`;
}

function varNameFor(t: ElementTarget): string {
  const words = (t.accessibleName || t.text || t.attributes?.placeholder || t.attributes?.name || t.tagName)
    .replace(/[^a-zA-Z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 3);
  const role = (t.role || t.tagName).toLowerCase();
  const suffix = { button: 'Button', link: 'Link', textbox: 'Input', checkbox: 'Checkbox', radio: 'Radio', combobox: 'Select', heading: 'Heading' }[role] ?? '';
  const camel = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('') || 'element';
  const base = /^[a-z_]/i.test(camel) ? camel : 'el' + camel;
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : base + suffix;
}

const safeKey = (k: string) => k.replace(/\W/g, '_');
/** Test-data env vars are prefixed so they never collide with OS variables such as USER or PATH. */
const envName = (k: string) => 'TEST_' + k.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/\W+/g, '_').toUpperCase();
