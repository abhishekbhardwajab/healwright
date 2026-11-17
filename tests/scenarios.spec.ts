/**
 * Recording → model → codegen → replay, end to end, against real Chromium.
 *
 * Every scenario:
 *   1. records real user input (Playwright mouse/keyboard = the same CDP input
 *      the studio forwards from its live view; the recorder only accepts trusted events),
 *   2. asserts the recorded step sequence (recording accuracy),
 *   3. replays the action model with the ReplayEngine in a fresh context,
 *   4. writes the generated spec, which is executed by the real Playwright Test
 *      runner in the final test of this file.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  bootServer, record, pickAssert, toTest, replay, types, primaries, saveMetrics, writeGenerated, runGenerated, settle, TMP,
} from './helpers.js';
import type { Action, Execution, TestCase } from '../src/model/actions.js';
import type { RecorderSession } from '../src/recorder/RecorderSession.js';


let ctx: Awaited<ReturnType<typeof bootServer>>;
const generated: { name: string; expect: 'passed' | 'failed'; file: string }[] = [];
const metricsByName = new Map<string, Parameters<typeof saveMetrics>[0]>();

test.beforeAll(async () => { ctx = await bootServer('scenarios'); });
test.afterAll(async () => { await ctx.server.close(); });

function finish(name: string, expected: string[], s: RecorderSession, t: TestCase, ex: Execution, opts: { expectGenerated?: 'passed' | 'failed'; note?: string; skipGenerated?: boolean } = {}) {
  const prim = primaries(t.actions);
  const m = {
    scenario: name,
    expectedSteps: expected,
    recordedSteps: types(s.actions),
    recordingAccurate: JSON.stringify(expected) === JSON.stringify(types(s.actions)),
    primaryStrategies: prim.map((p) => p.strategy + (p.parent ? '(scoped)' : '')),
    uniquePrimaries: prim.filter((p) => p.matchCount === 1).length,
    targetSteps: prim.length,
    replayStatus: ex.status,
    replayMs: (ex.finishedAt ?? 0) - ex.startedAt,
    healedSteps: ex.steps.filter((x) => x.healed).length,
    note: opts.note,
  };
  // Primary locators must work on their own; healing is only expected where the app was changed on purpose.
  if (!opts.note?.includes('heals')) expect(m.healedSteps, `${name}: steps needed a fallback selector`).toBe(0);
  metricsByName.set(name, m);
  saveMetrics(m);
  if (!opts.skipGenerated) generated.push({ name, expect: opts.expectGenerated ?? 'passed', file: writeGenerated(name, t) });
}

const failMsg = (ex: Execution) => ex.steps.filter((s) => s.status === 'failed').map((s) => `#${s.index + 1}: ${s.error}`).join('\n');

test('01 simple login (secret masking + assertion picked in the page)', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/login.html`);
    await page.getByLabel('Username').click();
    await page.keyboard.type('test-user');
    await page.getByLabel('Password').click();
    await page.keyboard.type('s3cret!');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(/dashboard/);
    await settle(s);
    await pickAssert(s, page.getByRole('heading', { name: 'Dashboard' }), { kind: 'visible' });
  });
  const expected = ['navigate', 'fill', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const pw = s.actions[2] as Extract<Action, { type: 'fill' }>;
  expect(pw.secretVariable).toBe('TEST_PASSWORD');
  expect(pw.value).toBe('');
  expect(JSON.stringify(s.actions)).not.toContain('s3cret!');
  expect(s.actions[3].target!.selectors[0]).toMatchObject({ strategy: 'role', value: 'button', options: { name: 'Login' } });
  const t = toTest('login', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('01 simple login', expected, s, t, ex);
});

test('02 search with async results and ambiguous buttons', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/search.html`);
    await page.getByPlaceholder('Search products').click();
    await page.keyboard.type('shoe');
    await page.keyboard.press('Enter');
    // two identical "Add to cart" buttons: the recorder must disambiguate
    await page.getByRole('listitem').filter({ hasText: 'Blue shoe' }).getByRole('button').click();
    await settle(s);
    await pickAssert(s, page.getByTestId('cart-count'), { kind: 'hasText', expected: '1' });
  });
  const expected = ['navigate', 'fill', 'press', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const add = s.actions[3].target!.selectors[0];
  expect(add.matchCount).toBe(1);
  expect(add.parent, 'ambiguous button should be scoped to its unique container').toBeTruthy();
  expect(s.actions[4].target!.selectors[0].strategy).toBe('testid');
  const t = toTest('search', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('02 search', expected, s, t, ex);
});

test('03 form submission (text, email, textarea, submit)', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/form.html`);
    await page.getByLabel('Full name').click(); await page.keyboard.type('Ada Lovelace');
    await page.getByLabel('Email').click(); await page.keyboard.type('ada@example.com');
    await page.getByLabel('Bio').click(); await page.keyboard.type('Analyst');
    await page.getByRole('button', { name: 'Create account' }).click();
    await settle(s);
    await pickAssert(s, page.getByTestId('summary'), { kind: 'containsText', expected: '"email":"ada@example.com"' });
  });
  const expected = ['navigate', 'fill', 'fill', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('form', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('03 form submission', expected, s, t, ex);
});

test('04 dropdown selection via the studio option overlay', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/form.html`);
    const opened = new Promise<any>((r) => s.once('selectOpen', r));
    await page.getByLabel('Country').click(); // mousedown -> selectOpen
    const so = await opened;
    expect(so.options.map((o: any) => o.label)).toContain('India');
    await s.chooseOption(so.target, ['in'], so.pageAlias);
    await page.getByRole('button', { name: 'Create account' }).click();
    await settle(s);
    await pickAssert(s, page.getByTestId('summary'), { kind: 'containsText', expected: '"country":"in"' });
  });
  const expected = ['navigate', 'select', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect((s.actions[1] as any).labels).toEqual(['India']);
  const t = toTest('dropdown', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('04 dropdown selection', expected, s, t, ex);
});

test('05 checkbox and radio interactions (clicking labels and inputs)', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/form.html`);
    await page.getByText('Pro', { exact: true }).click();       // click the label text
    await page.getByLabel('I accept the terms').click();         // click the checkbox
    await page.getByText('Send me news').click();                // uncheck via label
    await page.getByRole('button', { name: 'Create account' }).click();
    await settle(s);
    await pickAssert(s, page.getByTestId('summary'), { kind: 'hasText', expected: '{"fullName":"","email":"","country":"","plan":"pro","terms":"on","bio":"","resume":""}' });
  });
  const expected = ['navigate', 'check', 'check', 'uncheck', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('checkbox-radio', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('05 checkbox and radio', expected, s, t, ex);
});

test('06 modal dialog and confirm() browser dialog', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/modal.html`);
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByLabel('Nickname').click(); await page.keyboard.type('Neo');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Delete account' }).click(); // confirm() auto-accepted and recorded
    await settle(s);
    await pickAssert(s, page.getByRole('status'), { kind: 'hasText', expected: 'Deleted' });
  });
  const expected = ['navigate', 'click', 'fill', 'click', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect(s.actions[4].signals?.dialog).toMatchObject({ type: 'confirm', response: 'accept' });
  const t = toTest('modal', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('06 modal interaction', expected, s, t, ex);
});

test('07 multi-page navigation with back/forward', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/index.html`);
    await page.getByRole('link', { name: 'Login' }).click();
    await page.waitForURL(/login/);
    await s.history('goBack');
    await page.getByRole('link', { name: 'Search' }).click();
    await page.waitForURL(/search/);
    await s.history('goBack');
    await s.history('goForward');
    await settle(s);
    await pickAssert(s, page.getByRole('heading'), { kind: 'hasText', expected: 'Product search' });
  });
  const expected = ['navigate', 'click', 'goBack', 'click', 'goBack', 'goForward', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect(s.actions[1].signals?.navigation?.url).toMatch(/login\.html/);
  const t = toTest('multipage', s.actions);
  t.actions.push({ id: 'url-check', type: 'assert', assertion: { kind: 'url', expected: 'search\\.html$', regex: true }, timestamp: Date.now(), pageAlias: 'page', metadata: { url: '' } } as Action);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('07 multi-page navigation', expected, s, t, ex);
});

test('08 SPA navigation (pushState) with re-rendered views and generated ids', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/spa.html`);
    await page.getByRole('link', { name: 'About' }).click();
    await page.getByRole('button', { name: 'Load team' }).click();
    await page.getByText('Ada').waitFor();
    await settle(s);
    await pickAssert(s, page.getByText('Ada'), { kind: 'hasText', expected: 'Ada' });
    await page.getByRole('link', { name: 'Contact' }).click();
    await page.getByLabel('Message').click(); await page.keyboard.type('Hi there');
    await page.getByRole('button', { name: 'Send message' }).click();
    await settle(s);
    await pickAssert(s, page.getByText('Thanks!'), { kind: 'visible' });
  });
  const expected = ['navigate', 'click', 'click', 'assert', 'click', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  // the "Load team" button has a random id and hashed class: must not be the primary locator
  expect(s.actions[2].target!.selectors[0].strategy).toBe('role');
  const t = toTest('spa', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('08 SPA navigation', expected, s, t, ex);
});

test('09 dynamic elements appearing after a delay', async () => {
  // Results render 400 ms after Enter; replay must wait via locator resolution, not sleeps.
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/search.html`);
    await page.getByPlaceholder('Search products').click();
    await page.keyboard.type('hat');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('heading', { name: 'Red hat' }).click();
    await settle(s);
    await pickAssert(s, page.locator('#count'), { kind: 'hasText', expected: '2 results' });
  });
  const expected = ['navigate', 'fill', 'click', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('dynamic-delay', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  expect(t.actions.some((a) => a.type === 'wait')).toBe(false);
  finish('09 dynamic element', expected, s, t, ex);
});

test('10 iframe interaction', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/iframe.html`);
    const f = page.frameLocator('iframe[name="payment"]');
    await f.getByLabel('Card holder').click(); await page.keyboard.type('Grace Hopper');
    await f.getByRole('button', { name: 'Pay now' }).click();
    await settle(s);
    await pickAssert(s, f.getByRole('status'), { kind: 'hasText', expected: 'Paid by Grace Hopper' });
  });
  const expected = ['navigate', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect(s.actions[1].target!.framePath?.length).toBe(1);
  const t = toTest('iframe', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('10 iframe interaction', expected, s, t, ex);
});

test('11 file upload through the file chooser', async () => {
  const file = path.join(TMP, 'resume.txt');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(file, 'Ada Lovelace CV');
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/form.html`);
    const fc = new Promise<any>((r) => s.once('fileChooser', r));
    await page.getByLabel('Resume').click();
    const { id } = await fc;
    await s.resolveFileChooser(id, [{ name: 'resume.txt', path: file }]);
    await page.getByRole('button', { name: 'Create account' }).click();
    await settle(s);
    await pickAssert(s, page.getByTestId('summary'), { kind: 'containsText', expected: '"resume":"resume.txt"' });
  });
  const expected = ['navigate', 'setInputFiles', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect((s.actions[1] as any).filePaths).toEqual([file]);
  const t = toTest('upload', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('11 file upload', expected, s, t, ex);
});

test('12 assertion failure is reported with error, screenshot and skipped steps', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/login.html`);
    await page.getByLabel('Username').click(); await page.keyboard.type('wrong');
    await page.getByRole('button', { name: 'Login' }).click();
    await settle(s);
    await pickAssert(s, page.getByRole('alert'), { kind: 'hasText', expected: 'Welcome back' }); // deliberately wrong
    await page.getByLabel('Username').click(); await page.keyboard.press('Tab');
  });
  // the user clicked into the field before pressing Tab: both are recorded
  const expected = ['navigate', 'fill', 'click', 'assert', 'click', 'press'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('assert-fail', s.actions);
  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1500 });
  expect(ex.status).toBe('failed');
  expect(ex.steps[3].status).toBe('failed');
  expect(ex.steps[3].error).toContain('Welcome back');
  expect(ex.steps[3].error).toContain('Invalid username or password');
  expect(ex.steps[3].screenshot).toMatch(/\.png$/);
  expect(ex.steps[4].status).toBe('skipped');
  expect(ex.steps[5].status).toBe('skipped');
  finish('12 assertion failure', expected, s, t, ex, { expectGenerated: 'failed', note: 'failure expected and correctly reported' });
});

test('13 selector fallback when the primary locator breaks (self-healing)', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('ops@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
  });
  const expected = ['navigate', 'fill', 'click'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('fallback', s.actions);
  // App changed: button text renamed, so getByRole('button', { name: 'Sign in' }) no longer matches.
  (t.actions[0] as any).url = `${ctx.base}/dynamic.html?v=3`;
  t.actions.push({ id: 'chk', type: 'assert', assertion: { kind: 'hasText', expected: 'Hello ops@example.com' }, target: { tagName: 'P', selectors: [{ strategy: 'css', value: '#msg', score: 60 }] }, timestamp: Date.now(), pageAlias: 'page', metadata: { url: '' } } as Action);
  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1500 });
  expect(ex.status, failMsg(ex)).toBe('passed');
  expect(ex.steps[2].healed).toBe(true);
  expect(ex.steps[2].usedSelector?.strategy).not.toBe('role');
  // The exported spec only carries the primary locator, so it must fail on the changed app.
  finish('13 selector fallback', expected, s, t, ex, { expectGenerated: 'failed', note: 'replay engine heals; exported spec (primary locator only) fails as expected' });
});

test('14 replay after page refresh', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('first@example.com');
    await s.history('reload');
    await page.getByLabel('Work email').click(); await page.keyboard.type('second@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
    await pickAssert(s, page.locator('#msg'), { kind: 'hasText', expected: 'Hello second@example.com' });
  });
  const expected = ['navigate', 'fill', 'reload', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('refresh', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('14 replay after refresh', expected, s, t, ex);
});

test('15 replay after DOM restructuring', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('dom@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
    await pickAssert(s, page.locator('#msg'), { kind: 'hasText', expected: 'Hello dom@example.com' });
  });
  const expected = ['navigate', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('dom-change', s.actions);
  (t.actions[0] as any).url = `${ctx.base}/dynamic.html?v=2`; // wrappers added, order swapped, input id changed
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('15 replay after DOM changes', expected, s, t, ex);
});

test('16 shadow DOM widget', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/shadow.html`);
    await page.getByPlaceholder('Your email').click(); await page.keyboard.type('sub@example.com');
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await settle(s);
    await pickAssert(s, page.getByRole('status'), { kind: 'hasText', expected: 'Subscribed sub@example.com' });
  });
  const expected = ['navigate', 'fill', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect(s.actions[1].target!.inShadowDom).toBe(true);
  const t = toTest('shadow', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('16 shadow DOM', expected, s, t, ex);
});

test('17 HTML5 drag and drop', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dnd.html`);
    const chip = await page.getByText('Write tests').boundingBox();
    const done = await page.getByRole('region', { name: 'Done' }).boundingBox();
    await page.mouse.move(chip!.x + 10, chip!.y + 5);
    await page.mouse.down();
    await page.mouse.move(done!.x + 40, done!.y + 30, { steps: 8 });
    await page.mouse.up();
    await settle(s);
    await pickAssert(s, page.getByRole('region', { name: 'Done' }), { kind: 'containsText', expected: 'Write tests' });
  });
  const expected = ['navigate', 'dragTo', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  const t = toTest('dnd', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('17 drag and drop', expected, s, t, ex);
});

test('18 new tab (popup) and tab switching', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/popup.html`);
    const popupP = page.context().waitForEvent('page');
    await page.getByRole('link', { name: 'Open help center' }).click();
    const popup = await popupP;
    await popup.waitForLoadState();
    await settle(s);
    await popup.getByRole('button', { name: 'Was this helpful?' }).click();
    await settle(s);
    await pickAssert(s, popup.getByRole('button'), { kind: 'hasText', expected: 'Thanks for your feedback' });
  });
  const expected = ['navigate', 'click', 'click', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect(s.actions[1].signals?.popup).toBe('page1');
  expect(s.actions[2].pageAlias).toBe('page1');
  const t = toTest('popup', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('18 new tab', expected, s, t, ex);
});

test('19 keyboard, shortcuts, right-click, double-click and scroll', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/keyboard.html`);
    await page.getByLabel('New todo').click(); await page.keyboard.type('Buy milk'); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Options' }).click({ button: 'right' });
    await page.getByRole('button', { name: 'Double me' }).dblclick();
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1100);
    await page.getByRole('button', { name: 'Bottom button' }).click();
    await page.mouse.click(5, 5); // click empty page area (no auto-scroll) so the shortcut targets the page
    await page.keyboard.press('Control+k');
    await settle(s);
    await pickAssert(s, page.locator('#ctx'), { kind: 'hasText', expected: 'Shortcut used' });
  });
  const expected = ['navigate', 'fill', 'press', 'rightClick', 'dblclick', 'scroll', 'click', 'click', 'press', 'assert'];
  expect(types(s.actions)).toEqual(expected);
  expect((s.actions[8] as any).key).toBe('Control+k');
  const t = toTest('keyboard', s.actions);
  const ex = await replay(ctx.dataDir, t, s);
  expect(ex.status, failMsg(ex)).toBe('passed');
  finish('19 keyboard/mouse variety', expected, s, t, ex);
});

test('20 replay single step and replay from a selected step', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('x@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
    await pickAssert(s, page.locator('#msg'), { kind: 'containsText', expected: 'Hello' });
  });
  const t = toTest('partial', s.actions);
  const from = await replay(ctx.dataDir, t, s, { fromStep: 1 });
  expect(from.status, failMsg(from)).toBe('passed');
  expect(from.steps.map((x) => x.status)).toEqual(['skipped', 'passed', 'passed', 'passed']);
  const only = await replay(ctx.dataDir, t, s, { onlyStep: 1 });
  expect(only.status, failMsg(only)).toBe('passed');
  expect(only.steps.map((x) => x.status)).toEqual(['skipped', 'passed', 'skipped', 'skipped']);
});

test('ZZ generated Playwright specs run green under the real Playwright Test runner', async () => {
  test.setTimeout(240_000);
  const res = await runGenerated({ TEST_PASSWORD: 's3cret!' });
  expect(res.report, res.stderr).toBeTruthy();
  const outcomes = new Map<string, string>();
  const walk = (suite: any) => {
    for (const spec of suite.specs ?? []) outcomes.set(path.basename(suite.file ?? spec.file ?? ''), spec.tests?.[0]?.results?.[0]?.status ?? 'unknown');
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of res.report.suites) walk(s);
  const summary: string[] = [];
  for (const g of generated) {
    const status = outcomes.get(path.basename(g.file)) ?? 'missing';
    summary.push(`${g.name}: ${status} (expected ${g.expect})`);
    const m = metricsByName.get(g.name);
    if (m) { m.generatedCodeStatus = status; saveMetrics(m); }
  }
  console.log(summary.join('\n'));
  for (const g of generated) {
    const status = outcomes.get(path.basename(g.file));
    if (g.expect === 'passed') expect(status, g.name).toBe('passed');
    else expect(['failed', 'timedOut'], g.name).toContain(status);
  }
});
