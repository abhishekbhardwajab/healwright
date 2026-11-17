import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import type { ElementTarget, FrameHop, SelectorCandidate } from '../model/actions.js';

/**
 * Converts the engine-neutral SelectorCandidate into
 *  (a) a live Playwright Locator (replay engine), and
 *  (b) Playwright TypeScript source (code generator).
 * Both are derived from the same switch so they can never drift apart.
 */

type Root = Page | Frame | Locator | FrameLocator;

export function buildLocator(root: Root, sel: SelectorCandidate): Locator {
  const base = sel.parent ? buildLocator(root, sel.parent) : root;
  const o = sel.options ?? {};
  let loc: Locator;
  switch (sel.strategy) {
    case 'testid': loc = base.getByTestId(sel.value); break;
    case 'role': loc = base.getByRole(sel.value as Parameters<Page['getByRole']>[0], o.name !== undefined ? { name: o.name, exact: o.exact } : {}); break;
    case 'label': loc = base.getByLabel(sel.value, { exact: o.exact }); break;
    case 'placeholder': loc = base.getByPlaceholder(sel.value, { exact: o.exact }); break;
    case 'alt': loc = base.getByAltText(sel.value, { exact: o.exact }); break;
    case 'title': loc = base.getByTitle(sel.value, { exact: o.exact }); break;
    case 'text': loc = base.getByText(sel.value, { exact: o.exact }); break;
    case 'css': loc = base.locator(sel.value); break;
    case 'xpath': loc = base.locator(`xpath=${sel.value}`); break;
  }
  if (o.hasText !== undefined) loc = loc.filter({ hasText: o.hasText });
  return o.nth !== undefined ? loc.nth(o.nth) : loc;
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

export function locatorCode(rootExpr: string, sel: SelectorCandidate): string {
  const base = sel.parent ? locatorCode(rootExpr, sel.parent) : rootExpr;
  const o = sel.options ?? {};
  const exact = o.exact ? ', { exact: true }' : '';
  let code: string;
  switch (sel.strategy) {
    case 'testid': code = `${base}.getByTestId(${q(sel.value)})`; break;
    case 'role': {
      const opts: string[] = [];
      if (o.name !== undefined) opts.push(`name: ${q(o.name)}`);
      if (o.exact) opts.push('exact: true');
      code = `${base}.getByRole(${q(sel.value)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
      break;
    }
    case 'label': code = `${base}.getByLabel(${q(sel.value)}${exact})`; break;
    case 'placeholder': code = `${base}.getByPlaceholder(${q(sel.value)}${exact})`; break;
    case 'alt': code = `${base}.getByAltText(${q(sel.value)}${exact})`; break;
    case 'title': code = `${base}.getByTitle(${q(sel.value)}${exact})`; break;
    case 'text': code = `${base}.getByText(${q(sel.value)}${exact})`; break;
    case 'css': code = `${base}.locator(${q(sel.value)})`; break;
    case 'xpath': code = `${base}.locator(${q('xpath=' + sel.value)})`; break;
  }
  if (o.hasText !== undefined) code += `.filter({ hasText: ${q(o.hasText)} })`;
  return o.nth !== undefined ? `${code}.nth(${o.nth})` : code;
}

/** Root expression for a target, descending through its iframe chain. */
export function frameRootCode(pageExpr: string, framePath?: FrameHop[]): string {
  let expr = pageExpr;
  for (const hop of framePath ?? []) {
    const sel = hop.selectors[0];
    expr = `${sel ? locatorCode(expr, sel) : `${expr}.locator('iframe')`}.contentFrame()`;
  }
  return expr;
}

export function frameRoot(page: Page, framePath?: FrameHop[], hopChoice: number[] = []): Page | FrameLocator {
  let root: Page | FrameLocator = page;
  (framePath ?? []).forEach((hop, i) => {
    const sel = hop.selectors[hopChoice[i] ?? 0];
    root = (sel ? buildLocator(root, sel) : root.locator('iframe')).contentFrame();
  });
  return root;
}

export function primarySelector(t: ElementTarget): SelectorCandidate | undefined {
  return t.selectors[0];
}

export function selectorLabel(sel: SelectorCandidate): string {
  return locatorCode('page', sel).replace(/^page\./, '');
}
