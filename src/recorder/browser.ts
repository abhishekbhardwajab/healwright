import { chromium, type Browser } from 'playwright';

const browsers = new Map<'headless' | 'headed', Promise<Browser>>();

/**
 * One Chromium process per kind per server; isolation is per BrowserContext
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

/** A visible window can be opened (always on macOS/Windows; on Linux only with a display). */
export function liveBrowserAvailable(): boolean {
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
