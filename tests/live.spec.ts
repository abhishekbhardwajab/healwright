/**
 * Live browser mode: recording and replay in a real, visible (headed) Chromium
 * window. Needs a display; on a headless Linux box run `xvfb-run npm test`.
 *
 * Browser-UI actions (address bar, back/forward, reload, bringing a tab to the
 * front) are driven through CDP exactly as Chromium reports them when a person
 * uses the window: Page.navigate with transitionType 'typed' is what the
 * address bar does.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Page } from 'playwright';
import { bootServer, settle, toTest, replay, types, ROOT } from './helpers.js';
import { RecorderSession } from '../src/recorder/RecorderSession.js';
import { liveBrowserAvailable } from '../src/recorder/browser.js';
import type { Action } from '../src/model/actions.js';

let ctx: Awaited<ReturnType<typeof bootServer>>;
test.beforeAll(async () => { ctx = await bootServer('live'); });
test.afterAll(async () => { await ctx.server.close(); });

const needsDisplay = () => test.skip(!liveBrowserAvailable(), 'Live browser mode needs a display (run with xvfb-run)');

function liveSession() {
  return new RecorderSession({ artifactsDir: path.join(ctx.dataDir, 'artifacts'), uploadsDir: path.join(ctx.dataDir, 'uploads'), screencast: false, screenshots: false, live: true });
}

/** What the address bar does when a URL is typed and Enter pressed. */
async function typeInAddressBar(s: RecorderSession, page: Page, url: string) {
  const cdp = await s.context.newCDPSession(page);
  const done = page.waitForURL(url);
  await cdp.send('Page.navigate', { url, transitionType: 'typed' });
  await done;
  await cdp.detach();
}

async function historyStep(s: RecorderSession, page: Page, delta: -1 | 1) {
  const cdp = await s.context.newCDPSession(page);
  const h = await cdp.send('Page.getNavigationHistory');
  const target = h.entries[h.currentIndex + delta];
  const done = page.waitForURL(target.url);
  await cdp.send('Page.navigateToHistoryEntry', { entryId: target.id });
  await done;
  await cdp.detach();
}

test('records in a live window: page input, address bar, back/forward, reload and a native dropdown', async () => {
  needsDisplay();
  const s = liveSession();
  const selectOpens: unknown[] = [];
  s.on('selectOpen', (e) => selectOpens.push(e));
  await s.start();
  try {
    expect(s.live).toBe(true);
    const browser = s.context.browser()!;
    // The window is real: Chromium was launched headed.
    expect(await s.page.evaluate(() => navigator.userAgent)).not.toContain('Headless');
    expect(browser.isConnected()).toBe(true);

    await s.navigate(`${ctx.base}/login.html`);
    const page = s.page;
    await page.getByLabel('Username').click();
    await page.keyboard.type('live-user');
    await settle(s);

    // The user types a different URL into the window's address bar.
    await typeInAddressBar(s, page, `${ctx.base}/form.html`);
    await settle(s);
    // Native dropdown: in a live window the browser's own popup is used, the studio overlay is not.
    await page.getByLabel('Country').focus();
    await page.keyboard.press('ArrowDown');
    await settle(s);

    await historyStep(s, page, -1); // browser Back button
    await settle(s);
    await historyStep(s, page, 1); // browser Forward button
    await settle(s);
    const cdp = await s.context.newCDPSession(page);
    const reloaded = page.waitForEvent('load');
    await cdp.send('Page.reload', {}); // browser Reload button
    await reloaded;
    await settle(s, 500);

    expect(types(s.actions)).toEqual(['navigate', 'fill', 'navigate', 'select', 'goBack', 'goForward', 'reload']);
    const typed = s.actions[2] as Extract<Action, { type: 'navigate' }>;
    expect(typed.url).toBe(`${ctx.base}/form.html`);
    expect(selectOpens).toHaveLength(0);

    // The recording replays in a live window too.
    const ex = await replay(ctx.dataDir, toTest('live-browser-ui', s.actions), s, { headless: false, stepDelayMs: 50 });
    expect(ex.status, ex.steps.map((x) => `${x.index + 1} ${x.status} ${x.error ?? ''}`).join('\n')).toBe('passed');
    expect(ex.logs.some((l) => l.message.includes('live browser window'))).toBe(true);
  } finally {
    await s.stop();
  }
});

test('follows the tab the user switches to in the live window', async () => {
  needsDisplay();
  const s = liveSession();
  await s.start();
  try {
    await s.navigate(`${ctx.base}/popup.html`);
    const popup = s.context.waitForEvent('page');
    await s.page.getByRole('link', { name: 'Open help center' }).click();
    await (await popup).waitForLoadState();
    await settle(s, 500);
    expect(s.activeAlias).toBe('page1');

    // The user goes back to the first tab with the browser's tab strip and clicks in it.
    const first = s.pages.get('page')!;
    await first.bringToFront();
    await first.getByRole('heading', { name: 'Help' }).click();
    await settle(s);
    expect(s.activeAlias).toBe('page');
    expect(types(s.actions).slice(-2)).toEqual(['switchTab', 'click']);
    expect(s.actions[s.actions.length - 2].pageAlias).toBe('page');
  } finally {
    await s.stop();
  }
});

test('closing the live window keeps the recording; entering a URL opens it again as the main tab', async () => {
  needsDisplay();
  const s = liveSession();
  await s.start();
  try {
    await s.navigate(`${ctx.base}/login.html`);
    await s.page.getByLabel('Username').click();
    await s.page.keyboard.type('x');
    await settle(s);
    const closed = new Promise((r) => s.once('windowClosed', r));
    await s.page.close();
    await closed;
    expect(s.pages.size).toBe(0);
    expect(types(s.actions)).toEqual(['navigate', 'fill']);

    await s.navigate(`${ctx.base}/form.html`);
    expect(s.activeAlias).toBe('page');
    expect(s.page.url()).toBe(`${ctx.base}/form.html`);
    expect(types(s.actions)).toEqual(['navigate', 'fill', 'navigate']);
    expect(s.actions[2].pageAlias).toBe('page');
  } finally {
    await s.stop();
  }
});

test('studio API: live sessions and live runs', async () => {
  needsDisplay();
  const api = `http://localhost:${ctx.server.port}/api`;
  const status = await (await fetch(`${api}/status`)).json();
  expect(status.liveBrowser).toBe(true);
  const res = await (await fetch(`${api}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${ctx.base}/login.html`, live: true }) })).json();
  expect(res.live).toBe(true);
  const s = ctx.server.sessions.get(res.id)!;
  expect(s.live).toBe(true);
  await s.page.getByLabel('Username').click();
  await s.page.keyboard.type('api-user');
  await settle(s);
  const saved = await (await fetch(`${api}/sessions/${res.id}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'live api' }) })).json();
  await fetch(`${api}/sessions/${res.id}/stop`, { method: 'POST' });
  const { executionId } = await (await fetch(`${api}/tests/${saved.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options: { headless: false } }) })).json();
  await expect.poll(async () => (await (await fetch(`${api}/executions/${executionId}`)).json()).status, { timeout: 20_000 }).toBe('passed');
});

test('AI page snapshot works when the studio runs under tsx (npm start)', async () => {
  // Regression: esbuild keepNames (used by tsx) injected __name() calls into code sent to the page.
  const script = `
    import { chromium } from 'playwright';
    import { snapshotFrame } from './src/ai/heal.ts';
    const b = await chromium.launch();
    const p = await b.newPage();
    await p.setContent('<button>Go</button><label>Name <input></label>');
    const els = await snapshotFrame(p.mainFrame(), 't');
    await b.close();
    console.log(JSON.stringify(els.map((e) => e.tag)));
  `;
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile('npx', ['tsx', '--input-type=module', '-e', script], { cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr }));
  });
  expect(out.stderr).not.toContain('__name is not defined');
  expect(out.code, out.stderr).toBe(0);
  expect(JSON.parse(out.stdout.trim().split('\n').pop()!)).toEqual(expect.arrayContaining(['button', 'input']));
});
