import type { Frame, Locator, Page } from 'playwright';
import type { ElementTarget, SelectorCandidate } from '../model/actions.js';
import { buildLocator, selectorLabel } from '../selectors/locator.js';
import type { AiModel, HealResponse, SnapshotElement } from './types.js';

export const MIN_HEAL_CONFIDENCE = Number(process.env.AI_HEAL_MIN_CONFIDENCE ?? 0.7);
const MAX_ELEMENTS = 250;

export interface AiHealOutcome {
  locator: Locator;
  /** New ranked selectors for the element the model picked (Playwright-verified first). */
  selectors: SelectorCandidate[];
  chosen: SelectorCandidate;
  response: HealResponse;
  element: SnapshotElement;
}

export class HealRejected extends Error {
  constructor(message: string, readonly response?: HealResponse) { super(message); }
}

/**
 * Stage-2 healing. Runs only after every recorded locator failed (or matched
 * several elements): snapshot the page, ask the model which element plays the
 * recorded element's part, then rebuild locators for it with the recorder's
 * selector engine and verify them with Playwright.
 */
export class AiHealer {
  constructor(private ai: AiModel, private minConfidence = MIN_HEAL_CONFIDENCE) {}

  async heal(page: Page, t: ElementTarget, ctx: { step: string; actionType: string; failure: string; recordedUrl: string }): Promise<AiHealOutcome> {
    const frame = await resolveFrame(page, t);
    const token = `h${Date.now().toString(36)}`;
    const elements = await snapshotFrame(frame, token);
    if (!elements.length) throw new HealRejected('AI healing: the page has no candidate elements');

    const response = await this.ai.heal({
      step: ctx.step,
      actionType: ctx.actionType,
      recorded: {
        tagName: t.tagName, role: t.role, accessibleName: t.accessibleName, text: t.text,
        attributes: t.attributes, selectors: t.selectors.map(selectorLabel), url: ctx.recordedUrl,
      },
      failure: ctx.failure,
      page: { url: page.url(), title: await page.title().catch(() => '') },
      elements,
    });

    const element = elements.find((e) => e.index === response.elementIndex);
    if (!element) throw new HealRejected(`AI healing found no confident match: ${response.reasoning}`, response);
    if (response.confidence < this.minConfidence) {
      throw new HealRejected(`AI healing rejected (confidence ${response.confidence.toFixed(2)} < ${this.minConfidence}): ${response.reasoning}`, response);
    }

    const marker = frame.locator(`[data-rp-ai="${token}-${element.index}"]`);
    const raw = (await marker.evaluate((el) => (window as any).__rp?.rankSelectors(el) ?? []).catch(() => [])) as SelectorCandidate[];
    // Verify with Playwright: unique AND pointing at the element the model picked.
    const verified: SelectorCandidate[] = [];
    for (const sel of raw) {
      const loc = buildLocator(frame, sel);
      const ok = (await loc.count().catch(() => 0)) === 1 && (await loc.getAttribute('data-rp-ai').catch(() => null)) === `${token}-${element.index}`;
      verified.push({ ...sel, verified: ok, notes: [...(sel.notes ?? []), 'AI-healed'] });
    }
    const selectors = [...verified.filter((s) => s.verified), ...verified.filter((s) => !s.verified)];
    const chosen = selectors.find((s) => s.verified);
    if (!chosen) throw new HealRejected('AI healing picked an element but no stable locator could be built for it', response);
    // Act through the marker-free locator so the healed path is exactly what gets saved.
    return { locator: buildLocator(frameLocatorRoot(page, t, frame), chosen), selectors, chosen, response, element };
  }
}

/** The frame the target lives in (walks the recorded iframe chain, trying each hop's selectors). */
async function resolveFrame(page: Page, t: ElementTarget): Promise<Frame> {
  let frame: Frame = page.mainFrame();
  for (const hop of t.framePath ?? []) {
    let next: Frame | null = null;
    for (const sel of hop.selectors) {
      const h = await buildLocator(frame, sel).elementHandle({ timeout: 1000 }).catch(() => null);
      next = h ? await h.contentFrame() : null;
      if (next) break;
    }
    if (!next) throw new HealRejected('AI healing: the iframe containing the element was not found');
    frame = next;
  }
  return frame;
}

function frameLocatorRoot(page: Page, t: ElementTarget, frame: Frame): Frame | Page {
  return t.framePath?.length ? frame : page;
}

/**
 * Numbered, compact list of candidate elements (interactive, landmark, labelled
 * or short-text), including open shadow roots. Elements are tagged with
 * data-rp-ai so the model's answer maps back to a node.
 */
export async function snapshotFrame(frame: Frame, token: string): Promise<SnapshotElement[]> {
  return frame.evaluate(({ token, max }) => {
    const rp = (window as any).__rp;
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const SEL = 'a,button,input,select,textarea,label,summary,h1,h2,h3,h4,h5,h6,img,[role],[data-testid],[aria-label],[contenteditable],[onclick],[tabindex],li,td,th,p,span,option,dialog,form,section,nav';
    const all: Element[] = [];
    const visit = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.matches(SEL)) all.push(el);
        if ((el as HTMLElement).shadowRoot) visit((el as HTMLElement).shadowRoot!);
      }
    };
    visit(document);
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const context = (el: Element) => {
      const parts: string[] = [];
      for (let e = el.parentElement; e && parts.length < 3; e = e.parentElement) {
        const tag = e.tagName.toLowerCase();
        if (['form', 'dialog', 'section', 'nav', 'li', 'tr', 'fieldset', 'article', 'header', 'footer', 'main', 'aside'].includes(tag) || e.getAttribute('role')) {
          const label = e.getAttribute('aria-label') || e.id || norm(e.querySelector('legend,h1,h2,h3,h4')?.textContent).slice(0, 30);
          parts.unshift(tag + (label ? ` "${label}"` : ''));
        }
      }
      return parts.join(' > ') || undefined;
    };
    const out: any[] = [];
    for (const el of all) {
      if (out.length >= max) break;
      const text = norm((el as HTMLElement).innerText ?? el.textContent).slice(0, 80);
      const tag = el.tagName.toLowerCase();
      const interactive = el.matches('a,button,input,select,textarea,summary,[role],[contenteditable],[onclick],[tabindex],option,label');
      if (!interactive && (!text || text.length > 80)) continue; // keep only short text containers
      const visible = isVisible(el);
      if (!visible && !interactive) continue;
      const attributes: Record<string, string> = {};
      for (const a of ['id', 'name', 'type', 'placeholder', 'data-testid', 'href', 'aria-label', 'title', 'alt', 'value', 'for']) {
        const v = el.getAttribute(a);
        if (v != null && !(a === 'value' && (el as HTMLInputElement).type === 'password')) attributes[a] = v.slice(0, 80);
      }
      const index = out.length;
      el.setAttribute('data-rp-ai', `${token}-${index}`);
      out.push({ index, tag, role: rp?.getRole(el) ?? el.getAttribute('role') ?? undefined, name: rp ? norm(rp.accessibleName(el)).slice(0, 80) || undefined : undefined, text: text || undefined, attributes, context: context(el), visible });
    }
    return out;
  }, { token, max: MAX_ELEMENTS });
}
