import { chromium, type Browser, type BrowserContext } from 'playwright';

export type BrowserProviderName = 'local' | 'agentcore';

/**
 * Where browsers come from:
 * - local (default): Chromium processes on the machine running the studio.
 * - agentcore: Amazon Bedrock AgentCore Browser sessions (see src/cloud/agentcore-browser.ts).
 */
export function browserProvider(): BrowserProviderName {
  return process.env.BROWSER_PROVIDER === 'agentcore' ? 'agentcore' : 'local';
}

export interface LeaseOptions {
  headed?: boolean;
  viewport?: { width: number; height: number };
  /** Shown in the provider's console (AgentCore session name). */
  label?: string;
}

/** An isolated browser context for one recording session or one execution. Always close it. */
export interface BrowserLease {
  context: BrowserContext;
  provider: BrowserProviderName;
  /** AgentCore browser session id, when the provider is agentcore. */
  sessionId?: string;
  /** Presigned AgentCore live-view URL (AgentCore only). */
  liveViewUrl?: () => Promise<string>;
  close(): Promise<void>;
}

export async function openContext(opts: LeaseOptions = {}): Promise<BrowserLease> {
  if (browserProvider() === 'agentcore') {
    if (opts.headed) throw new Error('Live browser windows are not available with AgentCore Browser; use the studio browser view.');
    const { openAgentCoreContext } = await import('../cloud/agentcore-browser.js');
    return openAgentCoreContext(opts);
  }
  const browser = await getBrowser({ headed: opts.headed });
  const context = await browser.newContext({ viewport: opts.viewport, acceptDownloads: true });
  return { context, provider: 'local', close: () => context.close().catch(() => {}) };
}

const browsers = new Map<'headless' | 'headed', Promise<Browser>>();

/**
 * One local Chromium process per kind per server; isolation is per BrowserContext
 * (separate cookies, storage, cache) which is created per recording session
 * and per execution and always closed afterwards.
 *
 * - headless: the default. The studio streams it into its own browser view.
 * - headed:   a real, visible Chromium window on the machine running the studio
 *             ("live browser" mode). Used when a session or run asks for it, or
 *             for everything when HEADED is set.
 */
export function getBrowser(opts: { headed?: boolean } = {}): Promise<Browser> {
  const kind = opts.headed || process.env.HEADED ? 'headed' : 'headless';
  let p = browsers.get(kind);
  if (!p) {
    p = launch(kind === 'headed').then((b) => {
      b.on('disconnected', () => { if (browsers.get(kind) === p) browsers.delete(kind); });
      return b;
    });
    p.catch(() => { if (browsers.get(kind) === p) browsers.delete(kind); });
    browsers.set(kind, p);
  }
  return p;
}

/** A visible window can be opened (always on macOS/Windows; on Linux only with a display). Never with AgentCore. */
export function liveBrowserAvailable(): boolean {
  if (browserProvider() === 'agentcore') return false;
  return process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

async function launch(headed: boolean): Promise<Browser> {
  if (headed && !liveBrowserAvailable()) {
    throw new Error('Live browser needs a display. Run the studio on your desktop, or start it with "xvfb-run npm start" on a server.');
  }
  return chromium.launch({
    headless: !headed,
    args: ['--disable-dev-shm-usage'],
  });
}

export async function closeBrowser() {
  const all = [...browsers.values()];
  browsers.clear();
  for (const p of all) {
    const b = await p.catch(() => null);
    await b?.close().catch(() => {});
  }
}
