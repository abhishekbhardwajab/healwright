import { chromium, type Browser } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

/**
 * One Chromium process per server; isolation is per BrowserContext
 * (separate cookies, storage, cache) which is created per recording session
 * and per execution and always closed afterwards.
 */
export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const headless = process.env.HEADED ? false : true;
    browserPromise = chromium.launch({ headless, args: ['--disable-dev-shm-usage'] }).then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close().catch(() => {});
  }
}
