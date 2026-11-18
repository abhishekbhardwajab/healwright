import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, CDPSession, Frame, Page, FileChooser } from 'playwright';
import { getBrowser } from './browser.js';
import {
  newId, type Action, type ElementTarget, type SelectorCandidate, type FrameHop, type FillAction, type ActionSignals,
} from '../model/actions.js';
import { SecretVault } from './secrets.js';
import { buildLocator, frameRoot } from '../selectors/locator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const INJECTED = readFileSync(path.join(here, 'injected.js'), 'utf8');

export type RecorderMode = 'record' | 'paused' | 'assert' | 'off';

export interface RawEvent {
  kind: string;
  seq: number;
  ts: number;
  url: string;
  title?: string;
  target?: Omit<ElementTarget, 'framePath'>;
  destination?: Omit<ElementTarget, 'framePath'>;
  [k: string]: unknown;
}

export interface RecorderOptions {
  artifactsDir: string;
  uploadsDir: string;
  viewport?: { width: number; height: number };
  /** 'vault' keeps secret values in memory for replay, 'never' discards them. */
  secrets?: 'vault' | 'never';
  screencast?: boolean;
  screenshots?: boolean;
  /**
   * Live browser mode: record in a real, visible Chromium window on the machine
   * running the studio. The user works directly in that window (address bar,
   * tabs, back/forward and native dropdowns included); the studio mirrors it.
   */
  live?: boolean;
}

/** Address-bar style transitions (Chromium's PAGE_TRANSITION_* core types). */
const BROWSER_UI_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated']);

/**
 * A recording session = one isolated BrowserContext + the event pipeline that
 * turns raw DOM events into normalized Actions.
 *
 * Events: 'actions' (Action[]), 'frame' ({data, alias}), 'url', 'pick',
 *         'fileChooser', 'tabs', 'log', 'closed'
 */
export class RecorderSession extends EventEmitter {
  readonly id = newId('rec');
  /** Saved test this session is recording into, once known. */
  testId?: string;
  context!: BrowserContext;
  actions: Action[] = [];
  mode: RecorderMode = 'record';
  readonly vault = new SecretVault();
  readonly pages = new Map<string, Page>();
  activeAlias = 'page';
  private aliasOf = new WeakMap<Page, string>();
  private pageCounter = 0;
  private queue: Promise<void> = Promise.resolve();
  private cdp?: CDPSession;
  private pendingChoosers = new Map<string, FileChooser>();
  private uploads = new Map<string, string>(); // file name -> server path
  private pendingSignals: ActionSignals = {};
  private expectingNav = false;
  private shotTimer?: NodeJS.Timeout;
  private closed = false;
  /** Alias forced on the next page that opens (re-opening the window after it was closed). */
  private nextAlias?: string;
  /** Live mode: per-tab browser history position, to tell back/forward/typed URLs apart. */
  private navHistory = new WeakMap<Page, { index: number; length: number }>();
  private historyCdp = new WeakMap<Page, CDPSession>();

  constructor(readonly opts: RecorderOptions) {
    super();
    mkdirSync(opts.artifactsDir, { recursive: true });
    mkdirSync(opts.uploadsDir, { recursive: true });
  }

  get viewport() { return this.opts.viewport ?? { width: 1280, height: 800 }; }
  get page(): Page { return this.pages.get(this.activeAlias)!; }
  get live() { return !!this.opts.live; }

  async start(url?: string) {
    const browser = await getBrowser({ headed: this.live });
    this.context = await browser.newContext({ viewport: this.viewport, acceptDownloads: true });
    await this.context.exposeBinding('__rp_emit', (source, ev: RawEvent) => {
      // serialize: preserves event order and lets async enrichment finish in order
      this.queue = this.queue.then(() => this.onRawEvent(source.frame, source.page, ev)).catch((e) => this.log('error', String(e)));
    });
    await this.context.exposeBinding('__rp_state', () => this.mode);
    await this.context.addInitScript({ content: INJECTED });
    this.context.on('page', (p) => this.attachPage(p));
    const first = await this.context.newPage();
    if (url) await this.navigate(url);
    return first;
  }

  private attachPage(p: Page) {
    const reopened = this.nextAlias;
    this.nextAlias = undefined;
    const alias = reopened ?? (this.pageCounter === 0 ? 'page' : `page${this.pageCounter}`);
    if (!reopened) this.pageCounter++;
    this.pages.set(alias, p);
    this.aliasOf.set(p, alias);
    if (this.live) void this.trackHistory(p);
    if (reopened) {
      void this.switchTab(alias, false);
    } else if (this.pageCounter > 1) {
      // A new tab opened while recording: attribute it to the action that caused it.
      this.attachSignal({ popup: alias }, 3000);
      this.log('info', `New tab opened: ${alias}`);
      void this.switchTab(alias, false);
    }
    p.on('framenavigated', (f) => {
      if (f !== p.mainFrame()) return;
      if (alias === this.activeAlias) this.emit('url', f.url());
      const expecting = this.expectingNav;
      if (this.live) { void this.onLiveNavigation(p, f.url(), expecting); return; }
      if (!expecting) this.attachSignal({ navigation: { url: f.url() } }, 2000, false, (a) => a.type !== 'navigate');
    });
    p.on('dialog', async (d) => {
      const signal = { type: d.type(), message: d.message(), response: 'accept' as const, promptText: d.type() === 'prompt' ? d.defaultValue() : undefined };
      // Accept first: an open dialog blocks the page (and our selector verification).
      await d.accept(signal.promptText).catch(() => {});
      this.attachSignal({ dialog: signal }, 2000);
      this.log('info', `Dialog (${d.type()}): ${d.message()} -> accepted`);
    });
    p.on('download', (dl) => {
      this.attachSignal({ download: { suggestedFilename: dl.suggestedFilename() } }, 5000, false);
      this.log('info', `Download: ${dl.suggestedFilename()}`);
    });
    p.on('filechooser', (fc) => {
      const id = newId('fc');
      this.pendingChoosers.set(id, fc);
      this.emit('fileChooser', { id, multiple: fc.isMultiple() });
    });
    p.on('pageerror', (e) => this.log('warn', `[${alias}] page error: ${e.message}`));
    p.on('close', () => {
      if (this.pages.get(alias) === p) this.pages.delete(alias);
      if (this.activeAlias === alias) {
        const next = [...this.pages.keys()][0];
        if (next && !this.closed) void this.switchTab(next, false);
      }
      if (this.live && !this.closed && this.pages.size === 0) {
        this.log('warn', 'The live browser window was closed. Press Stop to save the recording, or enter a URL to open the window again.');
        this.emit('windowClosed');
      }
      this.emitTabs();
    });
    this.emitTabs();
  }

  /**
   * Attribute a side-effect (popup, dialog, download, navigation) to the action
   * that caused it. Runs after the event queue drains, because the causing DOM
   * event is always sent before the side-effect but may still be enriching.
   * If no action qualifies yet, the signal is parked for the next action.
   */
  private attachSignal(patch: ActionSignals, windowMs: number, park = true, accept: (a: Action) => boolean = () => true) {
    const at = Date.now();
    this.queue = this.queue.then(() => {
      if (this.mode !== 'record' && this.mode !== 'off') return;
      const last = this.actions[this.actions.length - 1];
      const key = Object.keys(patch)[0] as keyof ActionSignals;
      if (last && at - last.timestamp < windowMs && at >= last.timestamp - 50 && !last.signals?.[key] && accept(last)) {
        last.signals = { ...last.signals, ...patch };
        this.emitActions();
      } else if (park) {
        this.pendingSignals = { ...this.pendingSignals, ...patch };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Live browser window: navigation done with the browser's own UI
  // ---------------------------------------------------------------------------
  private async trackHistory(p: Page) {
    try {
      const cdp = await this.context.newCDPSession(p);
      this.historyCdp.set(p, cdp);
      const h = await cdp.send('Page.getNavigationHistory');
      if (!this.navHistory.has(p)) this.navHistory.set(p, { index: h.currentIndex, length: h.entries.length });
    } catch { /* page closed */ }
  }

  /**
   * In a live window the user can type a URL, go back/forward or reload with the
   * browser's own controls; none of those produce DOM events. Chromium's
   * navigation history tells them apart from link clicks and redirects:
   * back/forward move the history index without adding entries, and address-bar
   * navigations carry a 'typed'-like transition type.
   */
  private async onLiveNavigation(p: Page, url: string, expecting: boolean) {
    const cdp = this.historyCdp.get(p);
    let kind: 'navigate' | 'goBack' | 'goForward' | 'reload' | null = null;
    if (cdp) {
      try {
        const h = await cdp.send('Page.getNavigationHistory');
        const prev = this.navHistory.get(p);
        const entry = h.entries[h.currentIndex];
        this.navHistory.set(p, { index: h.currentIndex, length: h.entries.length });
        if (prev && h.entries.length === prev.length && h.currentIndex === prev.index - 1) kind = 'goBack';
        else if (prev && h.entries.length === prev.length && h.currentIndex === prev.index + 1) kind = 'goForward';
        else if (entry?.transitionType === 'reload' && prev && h.currentIndex === prev.index) kind = 'reload';
        else if (entry && BROWSER_UI_TRANSITIONS.has(entry.transitionType) && h.currentIndex !== prev?.index) kind = 'navigate';
      } catch { /* page closed meanwhile */ }
    }
    if (expecting) return; // started from the studio, which records the step itself
    const alias = this.aliasOf.get(p) ?? this.activeAlias;
    if (!kind || p.isClosed()) {
      this.attachSignal({ navigation: { url } }, 2000, false, (a) => a.type !== 'navigate');
      return;
    }
    this.queue = this.queue.then(() => {
      if (this.mode !== 'record' || this.closed) return;
      const base = { id: newId('step'), timestamp: Date.now(), pageAlias: alias, metadata: { url } };
      this.push(kind === 'navigate' ? { ...base, type: 'navigate', url } : { ...base, type: kind! });
      this.log('info', `Recorded browser ${kind === 'navigate' ? `navigation to ${url}` : kind}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Raw event → normalized action
  // ---------------------------------------------------------------------------
  private async framePath(frame: Frame): Promise<FrameHop[] | undefined> {
    const hops: FrameHop[] = [];
    for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
      const el = await f.frameElement();
      const desc = (await el.evaluate((e) => (window as any).__rp?.describe(e)).catch(() => null)) as ElementTarget | null;
      hops.unshift({ selectors: desc?.selectors ?? [], url: f.url(), name: f.name() || undefined });
    }
    return hops.length ? hops : undefined;
  }

  /**
   * Cross-check browser-side candidates with Playwright's own selector engines
   * (accessible-name rules differ in edge cases). A primary that Playwright does
   * not resolve uniquely is demoted below the first candidate that it does.
   * If nothing resolves any more (the action already navigated away), the
   * browser-side ranking is kept.
   */
  private async verify(frame: Frame, t: Omit<ElementTarget, 'framePath'>) {
    if (frame.isDetached() || !t.selectors.length) return;
    const counts = await Promise.all(t.selectors.map((sel) => buildLocator(frame, sel).count().catch(() => 0)));
    t.selectors.forEach((sel, i) => { sel.verified = counts[i] === 1; });
    if (counts[0] === 1 || !counts.some((c) => c === 1)) return;
    // Stable partition: Playwright-verified candidates first (keeping score order), then the rest.
    t.selectors.forEach((sel, i) => { if (counts[i] !== 1) sel.notes = [...(sel.notes ?? []), `Playwright matched ${counts[i]} element(s) at record time; demoted`]; });
    const ranked = [...t.selectors.filter((sel) => sel.verified), ...t.selectors.filter((sel) => !sel.verified)];
    t.selectors.splice(0, t.selectors.length, ...ranked);
  }

  private async enrich(frame: Frame, t?: Omit<ElementTarget, 'framePath'>, verify = true): Promise<ElementTarget | undefined> {
    if (!t) return undefined;
    if (verify) await this.verify(frame, t);
    const framePath = await this.framePath(frame);
    return framePath ? { ...t, framePath } : t;
  }

  private async onRawEvent(frame: Frame, page: Page, ev: RawEvent) {
    if (this.closed) return;
    const alias = this.aliasOf.get(page) ?? 'page';
    // In a live window the user can switch tabs with the browser's own tab strip, which
    // the page cannot observe. Their first interaction in another tab makes it the active one.
    if (this.live && alias !== this.activeAlias && this.pages.get(alias) === page) await this.switchTab(alias, true, false);
    // Keystrokes into the same field are merged: verify only the first one.
    const last = this.actions[this.actions.length - 1];
    const merging = ev.kind === 'fill' && last?.type === 'fill' && !!ev.target && JSON.stringify(last.target?.selectors.map((x) => [x.strategy, x.value])) === JSON.stringify(ev.target.selectors.map((x) => [x.strategy, x.value]));
    const target = merging ? last!.target : await this.enrich(frame, ev.target);
    if (ev.kind === 'pick') {
      this.emit('pick', { target, snapshot: ev.snapshot, url: ev.url, pageAlias: alias });
      return;
    }
    if (this.mode !== 'record') return;
    if (ev.kind === 'selectOpen') {
      // A live window shows the native dropdown; its 'change' is recorded as usual.
      if (this.live) return;
      this.emit('selectOpen', { target, options: ev.options, multiple: ev.multiple, pageAlias: alias });
      return;
    }
    const base = { id: newId('step'), timestamp: ev.ts || Date.now(), pageAlias: alias, metadata: { url: ev.url, title: ev.title } } as const;
    let action: Action | null = null;
    switch (ev.kind) {
      case 'click': case 'dblclick': case 'rightClick':
        action = { ...base, type: ev.kind, target: target!, modifiers: ev.modifiers as any };
        break;
      case 'fill': {
        const sensitive = !!ev.sensitive;
        const fill: FillAction = { ...base, type: 'fill', target: target!, value: String(ev.value ?? '') };
        if (sensitive) {
          const varName = SecretVault.variableNameFor(target!);
          fill.secretVariable = varName;
          if (this.opts.secrets !== 'never') this.vault.set(varName, fill.value);
          fill.value = '';
        }
        action = fill;
        break;
      }
      case 'press':
        action = { ...base, type: 'press', key: String(ev.key), target };
        break;
      case 'select':
        action = { ...base, type: 'select', target: target!, values: ev.values as string[], labels: ev.labels as string[] };
        break;
      case 'check': case 'uncheck':
        action = { ...base, type: ev.kind, target: target! };
        break;
      case 'setInputFiles': {
        const files = ev.files as string[];
        action = { ...base, type: 'setInputFiles', target: target!, files, filePaths: files.map((f) => this.uploads.get(f)).filter(Boolean) as string[] };
        break;
      }
      case 'scroll':
        action = { ...base, type: 'scroll', x: Number(ev.x), y: Number(ev.y), target };
        break;
      case 'dragTo':
        action = { ...base, type: 'dragTo', target: target!, destination: (await this.enrich(frame, ev.destination))! };
        break;
      default:
        this.log('warn', `Unknown raw event ${ev.kind}`);
        return;
    }
    this.push(action);
  }

  /** Merge rules that turn a stream of DOM events into intent-level steps. */
  private push(a: Action) {
    const last = this.actions[this.actions.length - 1];
    const same = (x?: ElementTarget, y?: ElementTarget) => !!x && !!y && sameTarget(x, y);
    if (Object.keys(this.pendingSignals).length) { a.signals = { ...this.pendingSignals, ...a.signals }; this.pendingSignals = {}; }

    if (a.type === 'fill' && last) {
      // consecutive keystrokes into the same field => one fill
      if (last.type === 'fill' && same(last.target, a.target) && last.pageAlias === a.pageAlias) {
        last.value = a.value; last.timestamp = a.timestamp; last.secretVariable = a.secretVariable;
        this.emitActions(); this.scheduleShot(last);
        return;
      }
      // a click that only focused the field is noise
      if (last.type === 'click' && same(last.target, a.target) && !last.signals) this.actions.pop();
    }
    if (a.type === 'fill' && a.value === '' && !a.secretVariable) {
      (a as unknown as { type: string }).type = 'clear';
      delete (a as Partial<FillAction>).value;
    }
    if (a.type === 'dblclick') {
      // drop the click(s) the browser emitted before 'dblclick'
      for (let i = 0; i < 2; i++) {
        const l = this.actions[this.actions.length - 1];
        if (l && l.type === 'click' && same(l.target, a.target) && a.timestamp - l.timestamp < 1000) this.actions.pop();
      }
    }
    if (a.type === 'scroll' && last?.type === 'scroll' && (a.target ? same(last.target, a.target) : !last.target)) {
      last.x = a.x; last.y = a.y; last.timestamp = a.timestamp; this.emitActions(); return;
    }
    this.actions.push(a);
    this.emitActions();
    this.scheduleShot(a);
  }

  private scheduleShot(a: Action) {
    if (this.opts.screenshots === false) return;
    clearTimeout(this.shotTimer);
    this.shotTimer = setTimeout(async () => {
      const page = this.pages.get(a.pageAlias);
      if (!page || this.closed) return;
      const file = `${this.id}-${a.id}.jpg`;
      try {
        await page.screenshot({ path: path.join(this.opts.artifactsDir, file), type: 'jpeg', quality: 45, timeout: 3000 });
        a.metadata.screenshot = file;
        this.emitActions();
      } catch { /* page navigating / closed */ }
    }, 400);
  }

  // ---------------------------------------------------------------------------
  // Commands from the studio
  // ---------------------------------------------------------------------------
  async navigate(url: string) {
    if (!/^https?:|^about:|^file:|^data:/.test(url)) url = 'https://' + url;
    if (!this.page) {
      // Live window closed by the user: open a fresh one that continues as the main tab.
      if (!this.live || this.closed) throw new Error('No open tab');
      this.nextAlias = this.activeAlias;
      await this.context.newPage();
    }
    const page = this.page;
    this.expectingNav = true;
    try {
      if (this.mode === 'record') this.push({ id: newId('step'), type: 'navigate', url, timestamp: Date.now(), pageAlias: this.activeAlias, metadata: { url } });
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => this.log('error', `Navigation failed: ${e.message}`));
    } finally { this.expectingNav = false; }
  }

  async history(kind: 'goBack' | 'goForward' | 'reload') {
    const page = this.page;
    this.expectingNav = true;
    try {
      if (this.mode === 'record') this.push({ id: newId('step'), type: kind, timestamp: Date.now(), pageAlias: this.activeAlias, metadata: { url: page.url() } });
      if (kind === 'goBack') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (kind === 'goForward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
    } catch (e) { this.log('warn', String(e)); } finally { this.expectingNav = false; }
  }

  async setMode(mode: RecorderMode) {
    this.mode = mode;
    for (const p of this.pages.values()) {
      for (const f of p.frames()) await f.evaluate((m) => (window as any).__rp?.setMode(m), mode).catch(() => {});
    }
    this.emit('mode', mode);
  }

  /**
   * @param userInitiated record a switchTab step (true when the user picked a tab).
   * @param focus bring the tab to the front (false when the user already did, in the live window).
   */
  async switchTab(alias: string, userInitiated = true, focus = true) {
    const p = this.pages.get(alias);
    if (!p || this.closed) return;
    const prev = this.activeAlias;
    this.activeAlias = alias;
    if (userInitiated && prev !== alias && this.mode === 'record') {
      this.push({ id: newId('step'), type: 'switchTab', timestamp: Date.now(), pageAlias: alias, metadata: { url: p.url() } });
    }
    if (focus) await p.bringToFront().catch(() => {});
    await this.startScreencast();
    this.emit('url', p.url());
    this.emitTabs();
  }

  addAction(a: Action, index?: number) {
    if (index === undefined) this.actions.push(a); else this.actions.splice(index, 0, a);
    this.emitActions();
  }

  /**
   * Option chosen in the studio's own dropdown overlay. Playwright's selectOption
   * dispatches untrusted events which the recorder ignores, so the step is
   * recorded here explicitly.
   */
  async chooseOption(target: ElementTarget, values: string[], pageAlias = this.activeAlias) {
    const page = this.pages.get(pageAlias);
    if (!page) throw new Error('Tab closed');
    const loc = buildLocator(frameRoot(page, target.framePath), target.selectors[0]);
    const chosen = await loc.selectOption(values);
    const labels = await loc.evaluate((el: HTMLSelectElement) => [...el.selectedOptions].map((o) => (o.label || o.textContent || '').trim()));
    if (this.mode === 'record') {
      this.push({ id: newId('step'), type: 'select', target, values: chosen, labels, timestamp: Date.now(), pageAlias, metadata: { url: page.url(), title: await page.title() } });
    }
  }

  registerUpload(name: string, serverPath: string) { this.uploads.set(name, serverPath); }

  async resolveFileChooser(id: string, files: { name: string; path: string }[]) {
    const fc = this.pendingChoosers.get(id);
    if (!fc) throw new Error('File chooser expired');
    this.pendingChoosers.delete(id);
    for (const f of files) this.registerUpload(f.name, f.path);
    await fc.setFiles(files.map((f) => f.path));
  }

  // ---------------------------------------------------------------------------
  // Live view: CDP screencast out, synthetic-but-trusted input in
  // ---------------------------------------------------------------------------
  async startScreencast() {
    if (this.opts.screencast === false) return;
    if (this.cdp) { await this.cdp.send('Page.stopScreencast').catch(() => {}); await this.cdp.detach().catch(() => {}); }
    const alias = this.activeAlias;
    const page = this.page;
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      this.emit('frame', { data: f.data, alias });
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 });
  }

  private inputQueue: Promise<void> = Promise.resolve();

  /** Input from the live view. Serialized so key/mouse order is preserved exactly. */
  input(ev: InputEvent): Promise<void> {
    this.inputQueue = this.inputQueue.then(() => this.dispatchInput(ev)).catch((e) => this.log('warn', `input failed: ${(e as Error).message}`));
    return this.inputQueue;
  }

  private async dispatchInput(ev: InputEvent) {
    const page = this.page;
    if (!page) return;
    switch (ev.type) {
      case 'mousemove': await page.mouse.move(ev.x, ev.y); break;
      case 'mousedown': await page.mouse.move(ev.x, ev.y); await page.mouse.down({ button: ev.button ?? 'left', clickCount: ev.clickCount ?? 1 }); break;
      case 'mouseup': await page.mouse.move(ev.x, ev.y); await page.mouse.up({ button: ev.button ?? 'left', clickCount: ev.clickCount ?? 1 }); break;
      case 'wheel': await page.mouse.move(ev.x, ev.y); await page.mouse.wheel(ev.deltaX ?? 0, ev.deltaY ?? 0); break;
      case 'keydown': await page.keyboard.down(ev.key); break;
      case 'keyup': await page.keyboard.up(ev.key); break;
      case 'text': await page.keyboard.insertText(ev.text); break;
    }
  }

  // ---------------------------------------------------------------------------
  private emitActions() { this.emit('actions', this.actions); }
  private emitTabs() { this.emit('tabs', { tabs: [...this.pages.entries()].map(([alias, p]) => ({ alias, url: p.url() })), active: this.activeAlias }); }
  log(level: 'info' | 'warn' | 'error', message: string) { this.emit('log', { ts: Date.now(), level, message }); }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.shotTimer);
    await this.queue.catch(() => {});
    await this.context?.close().catch(() => {});
    this.emit('closed');
  }
}

export type InputEvent =
  | { type: 'mousemove' | 'mousedown' | 'mouseup'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; deltaX?: number; deltaY?: number }
  | { type: 'keydown' | 'keyup'; key: string }
  | { type: 'text'; text: string };

export function sameTarget(a: ElementTarget, b: ElementTarget): boolean {
  const sel = (x?: SelectorCandidate): unknown => x && [x.strategy, x.value, x.options ?? null, sel(x.parent) ?? null];
  // Compare by full candidate set (order-insensitive) so a re-ranked copy still matches.
  const k = (t: ElementTarget) => JSON.stringify([t.selectors.map((x) => JSON.stringify(sel(x))).sort(), t.framePath?.map((h) => sel(h.selectors[0]))]);
  return k(a) === k(b);
}
