import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import { expect } from '@playwright/test';
import { getBrowser } from '../recorder/browser.js';
import {
  newId, describeAction, type Action, type ElementTarget, type Execution, type ExecutionOptions,
  type SelectorCandidate, type StepResult, type TestCase,
} from '../model/actions.js';
import { buildLocator, frameRoot, selectorLabel } from '../selectors/locator.js';
import type { SecretVault } from '../recorder/secrets.js';
import { INJECTED } from '../recorder/RecorderSession.js';
import type { AiModel } from '../ai/types.js';
import { AiHealer, HealRejected } from '../ai/heal.js';
import type { HealProposal } from '../model/actions.js';

export interface ReplayDeps {
  artifactsDir: string;
  vault?: SecretVault;
  /** Run against an existing page (live recording session) instead of a fresh context. */
  livePages?: Map<string, Page>;
  /** Enables stage-2 (AI) healing when set. */
  ai?: AiModel;
}

const DEFAULTS: Required<Omit<ExecutionOptions, 'onlyStep' | 'fromStep' | 'variables' | 'aiHealing'>> = {
  stepTimeoutMs: 10_000,
  stepRetries: 1,
  continueOnFailure: false,
  screenshots: 'every-step',
  settle: 'domcontentloaded',
  headless: true,
};

class ResolveError extends Error {}

/**
 * Executes the action model directly with Playwright (no code generation
 * round-trip), so it can report per-step status, use fallback selectors, and
 * start from any step.
 *
 * Events: 'update' (Execution) after every state change.
 */
export class ReplayEngine extends EventEmitter {
  private stopped = false;
  private context?: BrowserContext;
  private pages = new Map<string, Page>();
  readonly execution: Execution;

  constructor(private test: TestCase, private options: ExecutionOptions, private deps: ReplayDeps) {
    super();
    this.execution = {
      id: newId('exec'),
      testId: test.id,
      status: 'queued',
      startedAt: Date.now(),
      options,
      steps: test.actions.map((a, i) => ({ actionId: a.id, index: i, status: 'pending' })),
      logs: [],
      healProposals: [],
    };
  }

  private get o() { return { ...DEFAULTS, ...this.options }; }
  private get aiHealing() { return this.deps.ai ? (this.options.aiHealing ?? 'suggest') : 'off'; }
  private healer?: AiHealer;

  stop() {
    this.stopped = true;
    this.log('warn', 'Execution stopped by user');
    if (!this.deps.livePages) void this.context?.close().catch(() => {});
  }

  private log(level: 'info' | 'warn' | 'error', message: string) {
    const masked = this.deps.vault ? this.deps.vault.mask(message) : message;
    this.execution.logs.push({ ts: Date.now(), level, message: masked });
    this.emitUpdate();
  }
  private emitUpdate() { this.emit('update', this.execution); }

  async run(): Promise<Execution> {
    const ex = this.execution;
    const dir = path.join(this.deps.artifactsDir, ex.id);
    mkdirSync(dir, { recursive: true });
    ex.status = 'running';
    this.emitUpdate();

    const actions = this.test.actions;
    const indices = this.selectIndices();
    try {
      if (this.deps.livePages) {
        this.pages = new Map(this.deps.livePages);
      } else {
        const browser = await getBrowser();
        this.context = await browser.newContext({ viewport: this.test.viewport, acceptDownloads: true });
        this.context.setDefaultTimeout(this.o.stepTimeoutMs);
        // The recorder script is loaded only for its selector engine (used by AI healing);
        // without the recording binding it captures nothing.
        if (this.aiHealing !== 'off') await this.context.addInitScript({ content: INJECTED });
        const page = await this.context.newPage();
        this.attach('page', page);
        // Replay from a step (or a single step) starts at the URL the step was recorded on.
        const first = actions[indices[0]];
        if (first && first.type !== 'navigate' && (this.options.fromStep !== undefined || this.options.onlyStep !== undefined)) {
          this.log('info', `Opening ${first.metadata.url} to start from step ${indices[0] + 1}`);
          await page.goto(first.metadata.url, { waitUntil: 'domcontentloaded' });
        }
      }
      let failed = false;
      for (let i = 0; i < actions.length; i++) {
        const step = ex.steps[i];
        if (!indices.includes(i) || actions[i].disabled) { step.status = 'skipped'; continue; }
        if (this.stopped) { step.status = 'skipped'; continue; }
        if (failed && !this.o.continueOnFailure) { step.status = 'skipped'; continue; }
        const ok = await this.runStep(actions[i], step, dir);
        if (!ok && !actions[i].optional) failed = true;
      }
      this.emitUpdate();
      ex.status = this.stopped ? 'stopped' : failed ? 'failed' : 'passed';
    } catch (e) {
      ex.status = this.stopped ? 'stopped' : 'failed';
      this.log('error', `Execution error: ${(e as Error).message}`);
    } finally {
      ex.finishedAt = Date.now();
      if (!this.deps.livePages) await this.context?.close().catch(() => {});
      this.log('info', `Execution ${ex.status} in ${ex.finishedAt - ex.startedAt}ms`);
    }
    return ex;
  }

  private selectIndices(): number[] {
    const n = this.test.actions.length;
    if (this.options.onlyStep !== undefined) return [this.options.onlyStep];
    const from = this.options.fromStep ?? 0;
    return Array.from({ length: n - from }, (_, k) => k + from);
  }

  private attach(alias: string, page: Page) {
    this.pages.set(alias, page);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') this.log('warn', `[${alias} console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => this.log('error', `[${alias} page error] ${e.message}`));
    page.on('requestfailed', (r) => this.log('warn', `[${alias} request failed] ${r.method()} ${r.url().split('?')[0]} ${r.failure()?.errorText ?? ''}`));
  }

  private async runStep(a: Action, step: StepResult, dir: string): Promise<boolean> {
    const attempts = 1 + Math.max(0, this.o.stepRetries);
    step.status = 'running';
    step.startedAt = Date.now();
    step.logs = [];
    this.emitUpdate();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      step.attempts = attempt;
      try {
        await this.perform(a, step);
        step.status = 'passed';
        step.error = undefined;
        break;
      } catch (e) {
        step.error = this.deps.vault ? this.deps.vault.mask(cleanError(e)) : cleanError(e);
        step.logs.push(`attempt ${attempt} failed: ${step.error.split('\n')[0]}`);
        if (this.stopped) break;
        if (attempt < attempts) this.log('warn', `Step ${step.index + 1} attempt ${attempt} failed, retrying`);
        else step.status = 'failed';
      }
    }
    if (step.status === 'running') step.status = 'failed';
    step.durationMs = Date.now() - step.startedAt!;
    const page = this.pages.get(a.pageAlias) ?? this.pages.get('page');
    const shot = this.o.screenshots === 'every-step' || (this.o.screenshots === 'on-failure' && step.status === 'failed');
    if (page && shot && !page.isClosed()) {
      const file = `${step.index + 1}.${step.status === 'failed' ? 'png' : 'jpg'}`;
      await page.screenshot({ path: path.join(dir, file), type: step.status === 'failed' ? 'png' : 'jpeg', quality: step.status === 'failed' ? undefined : 50, timeout: 5000 })
        .then(() => { step.screenshot = `${this.execution.id}/${file}`; })
        .catch(() => {});
    }
    this.log(step.status === 'passed' ? 'info' : 'error', `Step ${step.index + 1} ${step.status} (${step.durationMs}ms): ${describeAction(a)}${step.healed ? ' [healed selector]' : ''}`);
    return step.status === 'passed';
  }

  /** Resolve a target to a unique locator, trying fallbacks in score order. */
  async resolve(page: Page, t: ElementTarget, step: StepResult, timeoutMs: number, a?: Action, field: 'target' | 'destination' = 'target'): Promise<Locator> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    // Grace period: during page transitions a weaker fallback (e.g. css 'h1') can match the
    // *previous* page's element. Fallbacks are only considered once the primary has had time.
    const graceUntil = start + Math.min(2000, timeoutMs / 2);
    const cands = t.selectors;
    let delay = 50;
    let lastCounts: string[] = [];
    while (true) {
      lastCounts = [];
      let ambiguous: { loc: Locator; sel: SelectorCandidate; idx: number } | null = null;
      const hopCount = t.framePath?.length ?? 0;
      const hopChoices: number[][] = hopCount ? frameHopChoices(t) : [[]];
      const inGrace = Date.now() < graceUntil;
      for (const hopChoice of inGrace ? hopChoices.slice(0, 1) : hopChoices) {
        const root = frameRoot(page, t.framePath, hopChoice);
        for (let idx = 0; idx < (inGrace ? 1 : cands.length); idx++) {
          const sel = cands[idx];
          const loc = buildLocator(root, sel);
          let n = 0;
          try { n = await loc.count(); } catch { n = 0; }
          lastCounts.push(`${selectorLabel(sel)} -> ${n}`);
          if (n === 1) {
            step.usedSelector = sel;
            step.healed = idx > 0 || hopChoice.some((c) => c > 0);
            if (step.healed) {
              step.logs?.push(`primary selector failed; healed with ${selectorLabel(sel)}`);
              if (a && idx > 0) this.propose({ actionId: a.id, stepIndex: step.index, field, source: 'fallback', selectors: [sel, ...cands.filter((c) => c !== sel)], previousPrimary: cands[0], reasoning: `Recorded fallback locator ${selectorLabel(sel)} still matches exactly one element; the primary did not.` });
            }
            return loc;
          }
          if (n > 1 && !ambiguous) ambiguous = { loc, sel, idx };
        }
      }
      if (Date.now() > deadline) {
        const failure = ambiguous
          ? `No recorded locator matches exactly one element (first ambiguous: ${selectorLabel(ambiguous.sel)}).`
          : `No recorded locator matches. Tried: ${lastCounts.join('; ')}`;
        if (a && this.aiHealing !== 'off') {
          const healed = await this.aiHeal(page, t, step, a, field, failure);
          if (healed) return healed;
        }
        if (ambiguous) {
          step.usedSelector = ambiguous.sel;
          step.healed = true;
          step.logs?.push(`no unique match; using first of ${selectorLabel(ambiguous.sel)}`);
          return ambiguous.loc.first();
        }
        throw new ResolveError(`Element not found: ${describeTarget(t)}. Tried:\n  ${lastCounts.join('\n  ')}`);
      }
      if (this.stopped) throw new Error('stopped');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
  }

  private async aiHeal(page: Page, t: ElementTarget, step: StepResult, a: Action, field: 'target' | 'destination', failure: string): Promise<Locator | null> {
    this.healer ??= new AiHealer(this.deps.ai!);
    this.log('info', `Step ${step.index + 1}: asking ${this.deps.ai!.name} to locate the element`);
    try {
      const out = await this.healer.heal(page, t, { step: describeAction(a), actionType: a.type, failure, recordedUrl: a.metadata.url });
      step.usedSelector = out.chosen;
      step.healed = true;
      step.ai = { model: this.deps.ai!.name, confidence: out.response.confidence, reasoning: out.response.reasoning };
      step.logs?.push(`AI healed (${Math.round(out.response.confidence * 100)}%): ${selectorLabel(out.chosen)} - ${out.response.reasoning}`);
      this.propose({
        actionId: a.id, stepIndex: step.index, field, source: 'ai',
        // new verified locators first, the old ones kept as last-resort fallbacks
        selectors: [...out.selectors, ...t.selectors.map((s) => ({ ...s, notes: [...(s.notes ?? []), 'failed during replay'] }))].slice(0, 10),
        previousPrimary: t.selectors[0], reasoning: out.response.reasoning, confidence: out.response.confidence, model: this.deps.ai!.name,
      });
      return out.locator;
    } catch (e) {
      const msg = e instanceof HealRejected ? e.message : `AI healing failed: ${(e as Error).message}`;
      step.logs?.push(msg);
      if (e instanceof HealRejected && e.response) step.ai = { model: this.deps.ai!.name, confidence: e.response.confidence, reasoning: e.response.reasoning };
      this.log('warn', `Step ${step.index + 1}: ${msg}`);
      return null;
    }
  }

  private propose(p: Omit<HealProposal, 'id' | 'status'>) {
    const list = this.execution.healProposals!;
    if (list.some((x) => x.actionId === p.actionId && x.field === p.field)) return;
    list.push({ ...p, id: newId('heal'), status: 'pending' });
    this.emitUpdate();
  }

  private value(v: string): string {
    const vars = { ...this.test.variables, ...this.options.variables };
    return v.replace(/\$\{([\w.]+)\}/g, (m, n) => (n in vars ? vars[n] : m));
  }

  private async perform(a: Action, step: StepResult) {
    const timeout = a.timeoutMs ?? this.o.stepTimeoutMs;
    const page = this.pages.get(a.pageAlias);
    if (!page) throw new Error(`Tab "${a.pageAlias}" is not open`);
    const L = (t: ElementTarget) => this.resolve(page, t, step, timeout, a, t === (a as { destination?: ElementTarget }).destination ? 'destination' : 'target');

    // Arm listeners for side-effects observed during recording.
    if (a.signals?.dialog) {
      const d = a.signals.dialog;
      page.once('dialog', (dlg) => void (d.response === 'accept' ? dlg.accept(d.promptText) : dlg.dismiss()).catch(() => {}));
    }
    const popup = a.signals?.popup && this.context ? this.context.waitForEvent('page', { timeout }) : null;
    const download = a.signals?.download ? page.waitForEvent('download', { timeout }) : null;

    switch (a.type) {
      case 'navigate': await page.goto(a.url, { timeout, waitUntil: 'domcontentloaded' }); break;
      case 'goBack': await page.goBack({ timeout, waitUntil: 'domcontentloaded' }); break;
      case 'goForward': await page.goForward({ timeout, waitUntil: 'domcontentloaded' }); break;
      case 'reload': await page.reload({ timeout, waitUntil: 'domcontentloaded' }); break;
      case 'click': await (await L(a.target)).click({ timeout, modifiers: a.modifiers }); break;
      case 'dblclick': await (await L(a.target)).dblclick({ timeout }); break;
      case 'rightClick': await (await L(a.target)).click({ timeout, button: 'right' }); break;
      case 'hover': await (await L(a.target)).hover({ timeout }); break;
      case 'fill': {
        let v = a.value;
        if (a.secretVariable) {
          const s = this.deps.vault?.get(a.secretVariable) ?? process.env[a.secretVariable];
          if (s === undefined) throw new Error(`Secret ${a.secretVariable} is not available. Set the environment variable ${a.secretVariable}.`);
          v = s;
        }
        await (await L(a.target)).fill(this.value(v), { timeout });
        break;
      }
      case 'clear': await (await L(a.target)).clear({ timeout }); break;
      case 'press':
        if (a.target) await (await L(a.target)).press(a.key, { timeout });
        else await page.keyboard.press(a.key);
        break;
      case 'select': await (await L(a.target)).selectOption(a.values, { timeout }); break;
      case 'check': await (await L(a.target)).check({ timeout }); break;
      case 'uncheck': await (await L(a.target)).uncheck({ timeout }); break;
      case 'setInputFiles': {
        if (!a.filePaths?.length) throw new Error(`No server-side file stored for ${a.files.join(', ')}; re-attach the file in the step editor.`);
        await (await L(a.target)).setInputFiles(a.filePaths, { timeout });
        break;
      }
      case 'scroll':
        if (a.target) await (await L(a.target)).evaluate((el, [x, y]) => el.scrollTo(x, y), [a.x, a.y] as const);
        else await page.evaluate(([x, y]) => window.scrollTo(x, y), [a.x, a.y] as const);
        break;
      case 'dragTo': {
        const src = await L(a.target);
        const dst = await L(a.destination);
        await src.dragTo(dst, { timeout });
        break;
      }
      case 'wait':
        if (a.wait === 'timeout') await page.waitForTimeout(a.ms ?? 1000);
        else if (a.wait === 'loadState') await page.waitForLoadState(a.loadState ?? 'load', { timeout });
        else if (a.wait === 'url') await page.waitForURL(new RegExp(a.urlPattern ?? '.*'), { timeout });
        else if (a.target) await (await L(a.target)).waitFor({ state: a.wait === 'elementHidden' ? 'hidden' : 'visible', timeout });
        break;
      case 'assert': await this.assert(a, page, step, timeout); break;
      case 'switchTab': await page.bringToFront(); break;
      case 'closeTab': await page.close(); this.pages.delete(a.pageAlias); break;
    }

    if (popup) {
      const p = await popup;
      this.attach(a.signals!.popup!, p);
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      this.log('info', `Popup opened as ${a.signals!.popup}`);
    }
    if (download) {
      const d = await download;
      step.logs?.push(`download: ${d.suggestedFilename()}`);
    }
    if (a.signals?.navigation && a.type !== 'navigate') {
      // The recorded action navigated: wait for the same path before the next step.
      const want = safeUrl(a.signals.navigation.url);
      if (want) {
        await page.waitForURL((u) => u.pathname === want.pathname, { timeout, waitUntil: 'commit' })
          .catch(() => step.logs?.push(`expected navigation to ${want.pathname} did not happen`));
      }
    }
    if (this.o.settle !== 'none' && (a.signals?.navigation || ['navigate', 'goBack', 'goForward', 'reload'].includes(a.type))) {
      await page.waitForLoadState(this.o.settle, { timeout }).catch(() => {});
    }
  }

  private async assert(a: Extract<Action, { type: 'assert' }>, page: Page, step: StepResult, timeout: number) {
    const as = a.assertion;
    const val = (s?: string) => (as.regex ? new RegExp(s ?? '') : this.value(s ?? ''));
    if (as.kind === 'url') { const m = expect.configure({ timeout })(page); await (as.negate ? m.not : m).toHaveURL(val(as.expected)); return; }
    if (as.kind === 'title') { const m = expect.configure({ timeout })(page); await (as.negate ? m.not : m).toHaveTitle(val(as.expected)); return; }
    if (!a.target) throw new Error('Assertion has no target element');
    // For "hidden"/negated checks the element may legitimately be gone: do not fail resolution.
    let loc: Locator;
    if (as.kind === 'hidden' || as.negate || as.kind === 'count') {
      loc = buildLocator(frameRoot(page, a.target.framePath), a.target.selectors[0]);
      step.usedSelector = a.target.selectors[0];
    } else loc = await this.resolve(page, a.target, step, timeout, a);
    const base = expect.configure({ timeout })(loc);
    const m = as.negate ? base.not : base;
    switch (as.kind) {
      case 'visible': await m.toBeVisible(); break;
      case 'hidden': await m.toBeHidden(); break;
      case 'enabled': await m.toBeEnabled(); break;
      case 'disabled': await m.toBeDisabled(); break;
      case 'checked': await m.toBeChecked(); break;
      case 'containsText': await m.toContainText(val(as.expected)); break;
      case 'hasText': await m.toHaveText(val(as.expected)); break;
      case 'value': await m.toHaveValue(val(as.expected)); break;
      case 'attribute': await m.toHaveAttribute(as.attribute ?? '', val(as.expected)); break;
      case 'count': await m.toHaveCount(Number(as.expected ?? 0)); break;
    }
  }
}

function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

function frameHopChoices(t: ElementTarget): number[][] {
  // Primary choice for every hop first, then try each hop's fallbacks one at a time.
  const hops = t.framePath ?? [];
  const out: number[][] = [hops.map(() => 0)];
  hops.forEach((h, i) => { for (let k = 1; k < Math.min(h.selectors.length, 3); k++) { const c = hops.map(() => 0); c[i] = k; out.push(c); } });
  return out;
}

function describeTarget(t: ElementTarget) {
  return `${t.role ?? t.tagName.toLowerCase()}${t.accessibleName ? ` "${t.accessibleName}"` : ''}`;
}

function cleanError(e: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String((e as Error)?.message ?? e).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2000);
}
