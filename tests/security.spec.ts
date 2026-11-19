/**
 * Security regressions for the default-hardening fixes (H1–H4, M1).
 * Each test asserts a previously-confirmed attack is now refused, while the
 * legitimate same-origin / non-browser paths still work.
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { bootServer, replay, toTest, ROOT } from './helpers.js';
import { isNavigable } from '../src/net/navigation.js';
import type { Action } from '../src/model/actions.js';

let ctx: Awaited<ReturnType<typeof bootServer>>;
let base: string;
test.beforeAll(async () => {
  // The header checks need the built studio; on a fresh checkout this file can run before the UI tests build it.
  if (!existsSync(path.join(ROOT, 'web/dist/index.html'))) execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  ctx = await bootServer('security'); base = `http://localhost:${ctx.server.port}`; });
test.afterAll(async () => { await ctx.server.close(); });

test('H2: a cross-origin state-changing request is refused, same-origin and tool clients still work', async ({ request }) => {
  // Foreign Origin on a POST → blocked.
  const evil = await request.post(`${base}/api/tests`, { headers: { origin: 'https://evil.example' }, data: { name: 'x', actions: [] } });
  expect(evil.status()).toBe(403);
  expect((await evil.json()).error).toContain('cross-origin');

  // Same-origin Origin (matches Host) → allowed.
  const ok = await request.post(`${base}/api/tests`, { headers: { origin: base }, data: { name: 'same-origin', actions: [] } });
  expect(ok.status()).toBe(200);

  // No Origin (curl / the test runner) → allowed.
  const tool = await request.post(`${base}/api/tests`, { data: { name: 'tool', actions: [] } });
  expect(tool.status()).toBe(200);
});

test('H1/rebinding: a foreign Host header is refused', async ({ request }) => {
  const res = await request.get(`${base}/api/tests`, { headers: { host: 'attacker.example' } });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toContain('host');
});

test('H3: a cross-origin WebSocket connection is closed before it can see or drive sessions', async () => {
  const WebSocket = (await import('ws')).default;
  const closeCode = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${ctx.server.port}/ws`, { headers: { origin: 'https://evil.example' } });
    const t = setTimeout(() => reject(new Error('socket neither opened nor closed')), 4000);
    ws.on('close', (code) => { clearTimeout(t); resolve(code); });
    ws.on('message', () => { clearTimeout(t); reject(new Error('attacker received session data')); });
  });
  expect(closeCode).toBe(4403);

  // A same-origin WebSocket still connects.
  const okCode = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${ctx.server.port}/ws`, { headers: { origin: base } });
    const t = setTimeout(() => resolve('no-open'), 3000);
    ws.on('open', () => { clearTimeout(t); ws.close(); resolve('open'); });
    ws.on('close', (c) => { if (c === 4403) { clearTimeout(t); resolve('rejected'); } });
  });
  expect(okCode).toBe('open');
});

test('M1: studio responses carry security headers; the demo target does not get CSP', async ({ request }) => {
  const app = await request.get(`${base}/`);
  expect(app.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(app.headers()['x-frame-options']).toBe('DENY');
  expect(app.headers()['x-content-type-options']).toBe('nosniff');
  expect(app.headers()['x-powered-by']).toBeUndefined();

  const fixture = await request.get(`${base}/fixtures/login.html`);
  expect(fixture.headers()['content-security-policy']).toBeUndefined(); // test target left alone
});

test('H4: the navigation guard allows http(s) and blocks file:/data:', () => {
  expect(isNavigable('https://example.com')).toBe(true);
  expect(isNavigable('http://localhost:3000/x')).toBe(true);
  expect(isNavigable('about:blank', { allowAboutBlank: true })).toBe(true);
  expect(isNavigable('file:///etc/passwd')).toBe(false);
  expect(isNavigable('data:text/html,<h1>x')).toBe(false);
  expect(isNavigable('about:blank')).toBe(false); // not allowed unless opted in
});

test('H4: replay refuses to open a file:// navigation step', async () => {
  const t = toTest('file-nav', [
    { id: 'n', type: 'navigate', url: 'file:///etc/hostname', pageAlias: 'page', timestamp: 1, metadata: { url: '' } } as Action,
  ]);
  const ex = await replay(ctx.dataDir, t, undefined, { stepTimeoutMs: 3000, stepRetries: 0 });
  expect(ex.status).toBe('failed');
  expect(ex.steps[0].status).toBe('failed');
  expect(ex.steps[0].error).toContain('blocked');
});
