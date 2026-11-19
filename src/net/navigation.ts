/**
 * Navigation guard (security).
 *
 * The recording and replay browsers must only ever open ordinary web pages.
 * Without this, a recorded or replayed `navigate` step — which can be set by
 * anything that reaches the API or the WebSocket — could point the browser at
 * `file://` (local file disclosure) or other schemes. We allow only http(s),
 * plus `about:blank` for the recorder's own blank-tab bootstrap.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export function isNavigable(raw: string, opts: { allowAboutBlank?: boolean } = {}): boolean {
  if (opts.allowAboutBlank && raw.trim() === 'about:blank') return true;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return ALLOWED_SCHEMES.has(u.protocol);
}

export function assertNavigable(raw: string, opts?: { allowAboutBlank?: boolean }): void {
  if (!isNavigable(raw, opts)) {
    const scheme = raw.split(':', 1)[0];
    throw new Error(`Navigation to a "${scheme}:" URL is blocked for safety; only http(s) addresses are allowed.`);
  }
}
