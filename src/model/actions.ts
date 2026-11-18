/**
 * Normalized action model.
 *
 * This is the single source of truth for a recorded test. It is deliberately
 * independent of Playwright: the recorder produces it, the step editor mutates
 * it, and separate back-ends (Playwright code generator, replay engine, and in
 * future other engines) consume it.
 */

export type SelectorStrategy =
  | 'testid'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'alt'
  | 'title'
  | 'text'
  | 'css'
  | 'xpath';

export interface SelectorCandidate {
  strategy: SelectorStrategy;
  /** testid value, role name, label text, placeholder, text, css or xpath. */
  value: string;
  options?: {
    /** Accessible name for role strategy. */
    name?: string;
    /** Exact (case-sensitive, full string) matching for text-like strategies. */
    exact?: boolean;
    /** Narrow matches to elements containing this text (Playwright locator.filter({ hasText })). */
    hasText?: string;
    /** Disambiguation index when nothing unique could be found. */
    nth?: number;
  };
  /** Optional scope: the locator is resolved inside this parent locator. */
  parent?: SelectorCandidate;
  /** 0-100. Higher is better (semantic + stable + unique). */
  score: number;
  /** How many elements matched at record time (1 = unique). */
  matchCount?: number;
  /** Result of re-checking the candidate with Playwright's own engine at record time. */
  verified?: boolean;
  /** Human-readable notes from the scorer, e.g. "dynamic id penalised". */
  notes?: string[];
}

/** One hop into an iframe: the selectors that identify the <iframe> element. */
export interface FrameHop {
  selectors: SelectorCandidate[];
  url?: string;
  name?: string;
}

export interface ElementTarget {
  tagName: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  inputType?: string;
  attributes?: Record<string, string>;
  /** Ordered best-first. The first is the primary; the rest are fallbacks. */
  selectors: SelectorCandidate[];
  /** Iframe chain from the top page down to the element's frame. */
  framePath?: FrameHop[];
  /** True if the element lives inside (open) shadow DOM. */
  inShadowDom?: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export type ActionType =
  | 'navigate'
  | 'goBack'
  | 'goForward'
  | 'reload'
  | 'click'
  | 'dblclick'
  | 'rightClick'
  | 'hover'
  | 'fill'
  | 'clear'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'setInputFiles'
  | 'scroll'
  | 'dragTo'
  | 'wait'
  | 'assert'
  | 'switchTab'
  | 'closeTab';

export type AssertionKind =
  | 'visible'
  | 'hidden'
  | 'containsText'
  | 'hasText'
  | 'url'
  | 'title'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'value'
  | 'attribute'
  | 'count';

export interface Assertion {
  kind: AssertionKind;
  expected?: string;
  /** attribute name for kind = 'attribute'. */
  attribute?: string;
  /** For url/title/text kinds: treat expected as a regex. */
  regex?: boolean;
  negate?: boolean;
}

export type WaitKind = 'timeout' | 'loadState' | 'elementVisible' | 'elementHidden' | 'url';

/** Side-effects observed while recording, which replay/codegen must anticipate. */
export interface ActionSignals {
  /** Action opened a new tab/popup; alias of the new page (e.g. "page1"). */
  popup?: string;
  /** Action triggered a JS dialog. */
  dialog?: { type: string; message: string; response: 'accept' | 'dismiss'; promptText?: string };
  /** Action triggered a download. */
  download?: { suggestedFilename: string };
  /** Action caused a top-level navigation (informational: Playwright auto-waits). */
  navigation?: { url: string };
}

export interface ActionBase {
  id: string;
  type: ActionType;
  /** User-editable label shown in the step list. */
  name?: string;
  timestamp: number;
  /** Which tab the action happens in. "page" is the first tab. */
  pageAlias: string;
  target?: ElementTarget;
  signals?: ActionSignals;
  /** Disabled steps are kept but skipped by replay and codegen. */
  disabled?: boolean;
  /** Per-step overrides. */
  timeoutMs?: number;
  optional?: boolean;
  metadata: {
    url: string;
    title?: string;
    /** Path (relative to artifacts dir) of the screenshot captured at record time. */
    screenshot?: string;
  };
}

export interface NavigateAction extends ActionBase { type: 'navigate'; url: string }
export interface HistoryAction extends ActionBase { type: 'goBack' | 'goForward' | 'reload' }
export interface PointerAction extends ActionBase {
  type: 'click' | 'dblclick' | 'rightClick' | 'hover';
  target: ElementTarget;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  /** Click position relative to element; only used when element is a canvas-like surface. */
  position?: { x: number; y: number };
}
export interface FillAction extends ActionBase {
  type: 'fill';
  target: ElementTarget;
  value: string;
  /**
   * If set, the value is sensitive and `value` holds a placeholder only.
   * The real value is looked up from variables / env at replay time.
   */
  secretVariable?: string;
}
export interface ClearAction extends ActionBase { type: 'clear'; target: ElementTarget }
export interface PressAction extends ActionBase {
  type: 'press';
  /** Playwright key syntax e.g. "Enter", "Control+A". */
  key: string;
  /** Absent = press on page.keyboard (focused element). */
  target?: ElementTarget;
}
export interface SelectAction extends ActionBase {
  type: 'select';
  target: ElementTarget;
  values: string[];
  labels?: string[];
}
export interface CheckAction extends ActionBase { type: 'check' | 'uncheck'; target: ElementTarget }
export interface FilesAction extends ActionBase {
  type: 'setInputFiles';
  target: ElementTarget;
  /** File names as seen by the page. */
  files: string[];
  /** Server-side paths (sandboxed uploads dir) used for replay. */
  filePaths?: string[];
}
export interface ScrollAction extends ActionBase {
  type: 'scroll';
  x: number;
  y: number;
  /** Absent = window scroll. */
  target?: ElementTarget;
}
export interface DragAction extends ActionBase {
  type: 'dragTo';
  target: ElementTarget;
  destination: ElementTarget;
}
export interface WaitAction extends ActionBase {
  type: 'wait';
  wait: WaitKind;
  ms?: number;
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  urlPattern?: string;
}
export interface AssertAction extends ActionBase { type: 'assert'; assertion: Assertion }
export interface TabAction extends ActionBase { type: 'switchTab' | 'closeTab' }

export type Action =
  | NavigateAction
  | HistoryAction
  | PointerAction
  | FillAction
  | ClearAction
  | PressAction
  | SelectAction
  | CheckAction
  | FilesAction
  | ScrollAction
  | DragAction
  | WaitAction
  | AssertAction
  | TabAction;

export interface TestCase {
  id: string;
  name: string;
  projectId: string;
  suiteId?: string;
  createdAt: number;
  updatedAt: number;
  startUrl?: string;
  viewport: { width: number; height: number };
  /** Non-secret test data, referenced from fill values as ${name}. */
  variables: Record<string, string>;
  actions: Action[];
}

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface StepResult {
  actionId: string;
  index: number;
  status: StepStatus;
  startedAt?: number;
  durationMs?: number;
  error?: string;
  /** Which selector was actually used; differs from primary when fallback kicked in. */
  usedSelector?: SelectorCandidate;
  healed?: boolean;
  attempts?: number;
  screenshot?: string;
  logs?: string[];
  /** Set when the element was found by the AI healer. */
  ai?: { model: string; confidence: number; reasoning: string };
}

/**
 * A locator fix found during a run, waiting for review. Accepting it rewrites
 * the step's selectors (new primary first, old ones kept as fallbacks), which
 * also changes the generated code.
 */
export interface HealProposal {
  id: string;
  actionId: string;
  stepIndex: number;
  field: 'target' | 'destination';
  source: 'fallback' | 'ai';
  selectors: SelectorCandidate[];
  previousPrimary?: SelectorCandidate;
  reasoning?: string;
  confidence?: number;
  model?: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ExecutionOptions {
  /** Run only this one step index. */
  onlyStep?: number;
  /** Start from this step index (navigates to that step's recorded URL first). */
  fromStep?: number;
  stepTimeoutMs?: number;
  /** Re-attempts per step (selector fallback is always attempted within one attempt). */
  stepRetries?: number;
  continueOnFailure?: boolean;
  screenshots?: 'every-step' | 'on-failure' | 'off';
  /** Wait strategy applied after navigation-like steps. */
  settle?: 'none' | 'load' | 'domcontentloaded' | 'networkidle';
  /** false = replay in a real, visible browser window (live browser mode). */
  headless?: boolean;
  /** Pause between steps, so a live replay can be followed by eye. */
  stepDelayMs?: number;
  variables?: Record<string, string>;
  /**
   * AI healing when every recorded locator fails: 'off'; 'suggest' (heal the run and
   * propose the fix for review); 'auto' (also apply the fix to the saved test).
   * Defaults to 'suggest' when an AI model is configured.
   */
  aiHealing?: 'off' | 'suggest' | 'auto';
}

export interface Execution {
  id: string;
  testId: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'stopped';
  startedAt: number;
  finishedAt?: number;
  options: ExecutionOptions;
  steps: StepResult[];
  logs: Array<{ ts: number; level: 'info' | 'warn' | 'error'; message: string }>;
  healProposals?: HealProposal[];
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Short human description of a step for UIs and logs. */
export function describeAction(a: Action): string {
  const t = a.target ? describeTarget(a.target) : '';
  switch (a.type) {
    case 'navigate': return `Open ${a.url}`;
    case 'goBack': return 'Go back';
    case 'goForward': return 'Go forward';
    case 'reload': return 'Reload page';
    case 'click': return `Click ${t}`;
    case 'dblclick': return `Double-click ${t}`;
    case 'rightClick': return `Right-click ${t}`;
    case 'hover': return `Hover ${t}`;
    case 'fill': return `Type ${a.secretVariable ? '••••••' : JSON.stringify(a.value)} into ${t}`;
    case 'clear': return `Clear ${t}`;
    case 'press': return `Press ${a.key}${t ? ` on ${t}` : ''}`;
    case 'select': return `Select ${(a.labels ?? a.values).join(', ')} in ${t}`;
    case 'check': return `Check ${t}`;
    case 'uncheck': return `Uncheck ${t}`;
    case 'setInputFiles': return `Upload ${a.files.join(', ')} to ${t}`;
    case 'scroll': return `Scroll ${t || 'page'} to ${a.x},${a.y}`;
    case 'dragTo': return `Drag ${t} to ${describeTarget(a.destination)}`;
    case 'wait': return a.wait === 'timeout' ? `Wait ${a.ms}ms` : `Wait for ${a.wait}${t ? ` ${t}` : ''}`;
    case 'assert': return `Assert ${a.assertion.negate ? 'not ' : ''}${a.assertion.kind}${a.assertion.expected !== undefined ? ` "${a.assertion.expected}"` : ''}${t ? ` on ${t}` : ''}`;
    case 'switchTab': return `Switch to tab ${a.pageAlias}`;
    case 'closeTab': return `Close tab ${a.pageAlias}`;
  }
}

export function describeTarget(t: ElementTarget): string {
  const name = t.accessibleName || t.text || t.attributes?.placeholder || t.attributes?.name || '';
  const role = t.role || t.tagName.toLowerCase();
  return name ? `${role} "${truncate(name, 40)}"` : role;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
