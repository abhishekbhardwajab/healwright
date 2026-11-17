/**
 * AI self-healing and prompt-driven editing, against real Chromium with a
 * scripted model (FakeAi) so results are deterministic. tests/ai-live.spec.ts
 * runs the same flows against Claude when credentials are available.
 */
import { test, expect } from '@playwright/test';
import { bootServer, record, pickAssert, settle, toTest, replay, types } from './helpers.js';
import { FakeAi, op } from './fake-ai.js';
import { applyHealProposal, applyOperations } from '../src/ai/edit.js';
import { generatePlaywrightTest } from '../src/codegen/playwright.js';
import type { Action, Execution, TestCase } from '../src/model/actions.js';

let ctx: Awaited<ReturnType<typeof bootServer>>;
const fake = new FakeAi();
test.beforeAll(async () => { ctx = await bootServer('ai', fake); });
test.afterAll(async () => { await ctx.server.close(); });

const failMsg = (ex: Execution) => ex.steps.filter((s) => s.status === 'failed').map((s) => `#${s.index + 1}: ${s.error}\n${s.logs?.join('\n')}`).join('\n');

/** Record "type email, click Sign in, check greeting" on the original app. */
async function recordSignIn() {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('ai@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
    await pickAssert(s, page.locator('#msg'), { kind: 'hasText', expected: 'Hello ai@example.com' });
  });
  expect(types(s.actions)).toEqual(['navigate', 'fill', 'click', 'assert']);
  const t = toTest('signin', s.actions);
  // Simulate a test whose only locators are content-based, then change the app (v=3 renames the button).
  // No recorded locator can match any more, so only AI healing can save the run.
  t.actions[2].target!.selectors = [
    { strategy: 'role', value: 'button', options: { name: 'Sign in' }, score: 90 },
    { strategy: 'text', value: 'Sign in', options: { exact: true }, score: 70 },
  ];
  (t.actions[0] as Extract<Action, { type: 'navigate' }>).url = `${ctx.base}/dynamic.html?v=3`;
  return { s, t };
}

test('AI healing finds a renamed button, proposes a verified locator, and the accepted fix replays without healing', async () => {
  const { s, t } = await recordSignIn();
  fake.onHeal = (req) => {
    const btn = req.elements.find((e) => e.tag === 'button' && e.visible);
    return { elementIndex: btn ? btn.index : -1, confidence: 0.93, reasoning: 'Same submit button in the same position; label changed from "Sign in" to "Log in now".' };
  };
  fake.healRequests = [];

  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1500 }, fake);
  expect(ex.status, failMsg(ex)).toBe('passed');

  // what the model was shown
  expect(fake.healRequests).toHaveLength(1);
  const req = fake.healRequests[0];
  expect(req.recorded.accessibleName).toBe('Sign in');
  expect(req.step).toBe('Click button "Sign in"');
  expect(req.failure).toContain('No recorded locator matches');
  expect(req.elements.some((e) => e.text === 'Log in now')).toBe(true);
  expect(JSON.stringify(req)).not.toContain('ai@example.com'.toUpperCase()); // sanity: no surprises

  // step result + proposal
  const step = ex.steps[2];
  expect(step.healed).toBe(true);
  expect(step.ai).toMatchObject({ model: 'fake-model', confidence: 0.93 });
  expect(ex.healProposals).toHaveLength(1);
  const p = ex.healProposals![0];
  expect(p).toMatchObject({ source: 'ai', field: 'target', status: 'pending', stepIndex: 2 });
  expect(p.selectors[0].verified).toBe(true);
  expect(p.selectors.at(-1)?.notes).toContain('failed during replay'); // old locators kept as last resort

  // accept -> model and generated code change; re-run needs no healing and no AI
  const fixed = applyHealProposal(t, p);
  expect(generatePlaywrightTest(fixed)).not.toContain("getByRole('button', { name: 'Sign in' }).click()");
  const again = await replay(ctx.dataDir, fixed, s, { stepTimeoutMs: 1500 });
  expect(again.status, failMsg(again)).toBe('passed');
  expect(again.steps.some((x) => x.healed)).toBe(false);
});

test('AI healing refuses low-confidence matches: the step fails with the model reasoning and nothing is proposed', async () => {
  const { s, t } = await recordSignIn();
  fake.onHeal = () => ({ elementIndex: 0, confidence: 0.4, reasoning: 'Several buttons could fit; not sure.' });
  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1000 }, fake);
  expect(ex.status).toBe('failed');
  expect(ex.steps[2].status).toBe('failed');
  expect(ex.steps[2].ai?.reasoning).toContain('not sure');
  expect(ex.steps[2].logs?.join('\n')).toContain('confidence 0.40');
  expect(ex.healProposals).toHaveLength(0);
});

test('AI healing is not used when the model says nothing matches (index -1)', async () => {
  const { s, t } = await recordSignIn();
  fake.onHeal = () => ({ elementIndex: -1, confidence: 0, reasoning: 'The sign-in button is gone.' });
  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1000 }, fake);
  expect(ex.status).toBe('failed');
  expect(ex.steps[2].logs?.join('\n')).toContain('The sign-in button is gone.');
});

test('aiHealing "off" never calls the model', async () => {
  const { s, t } = await recordSignIn();
  fake.healRequests = [];
  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 800, aiHealing: 'off' }, fake);
  expect(ex.status).toBe('failed');
  expect(fake.healRequests).toHaveLength(0);
});

test('rule-based fallback heals are proposed too and can be accepted', async () => {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByRole('button', { name: 'Sign in' }).click();
  });
  const t = toTest('fallback-proposal', s.actions);
  (t.actions[0] as any).url = `${ctx.base}/dynamic.html?v=3`;
  fake.healRequests = [];
  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1500 }, fake);
  expect(ex.status, failMsg(ex)).toBe('passed');
  expect(fake.healRequests).toHaveLength(0); // recorded fallbacks were enough
  const p = ex.healProposals![0];
  expect(p.source).toBe('fallback');
  const fixed = applyHealProposal(t, p);
  expect(fixed.actions[1].target!.selectors[0]).toEqual(ex.steps[1].usedSelector);
});

test('server: run with AI healing in "auto" mode applies the fix to the saved test', async ({ request }) => {
  const { t } = await recordSignIn();
  fake.onHeal = (req) => ({ elementIndex: req.elements.find((e) => e.tag === 'button')!.index, confidence: 0.9, reasoning: 'renamed button' });
  const api = `http://localhost:${ctx.server.port}/api`;
  const created: TestCase = await (await request.post(`${api}/tests`, { data: t })).json();
  const { executionId } = await (await request.post(`${api}/tests/${created.id}/run`, { data: { options: { stepTimeoutMs: 1500, aiHealing: 'auto' } } })).json();
  await expect.poll(async () => (await (await request.get(`${api}/executions/${executionId}`)).json()).status, { timeout: 30_000 }).toBe('passed');
  const ex: Execution = await (await request.get(`${api}/executions/${executionId}`)).json();
  expect(ex.healProposals?.[0].status).toBe('accepted');
  const saved: TestCase = await (await request.get(`${api}/tests/${created.id}`)).json();
  expect(saved.actions[2].target!.selectors[0].notes).toContain('AI-healed');
});

// ---------------------------------------------------------------------------
// Prompt-driven editing
// ---------------------------------------------------------------------------
async function loginTest(request: import('@playwright/test').APIRequestContext) {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/login.html`);
    await page.getByLabel('Username').click(); await page.keyboard.type('test-user');
    await page.getByLabel('Password').click(); await page.keyboard.type('s3cret!');
    await page.getByText('Remember me').click();
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(/dashboard/);
  });
  expect(types(s.actions)).toEqual(['navigate', 'fill', 'fill', 'check', 'click']);
  const api = `http://localhost:${ctx.server.port}/api`;
  const created: TestCase = await (await request.post(`${api}/tests`, { data: { name: 'Login', actions: s.actions } })).json();
  process.env.TEST_PASSWORD = 's3cret!'; // secret for replay, as in CI
  return { api, created };
}

test('prompt edit: the model proposes operations, the user sees a code diff, and accepting saves a test that replays', async ({ request }) => {
  const { api, created } = await loginTest(request);
  fake.onEdit = (req) => {
    expect(req.code).toContain("getByRole('button', { name: 'Login' })");
    expect(JSON.stringify(req.steps)).not.toContain('s3cret!');
    return {
      summary: 'Use a username variable, drop "Remember me" and check the dashboard heading.',
      notes: [],
      operations: [
        op({ op: 'setVariable', json: JSON.stringify({ name: 'user', value: 'test-user' }), explanation: 'add variable' }),
        op({ op: 'update', index: 1, json: JSON.stringify({ value: '${user}' }), explanation: 'use variable' }),
        op({ op: 'delete', index: 3, explanation: 'remove remember me' }),
        op({ op: 'insert', index: 4, json: JSON.stringify({ type: 'assert', assertion: { kind: 'visible' }, target: { tagName: 'H1', selectors: [{ strategy: 'role', value: 'heading', options: { name: 'Dashboard' } }] } }), explanation: 'verify dashboard' }),
        op({ op: 'rename', json: JSON.stringify({ name: 'Login lands on dashboard' }), explanation: 'rename' }),
      ],
    };
  };
  const res = await request.post(`${api}/tests/${created.id}/ai/edit`, { data: { instruction: 'Parameterise the username, remove remember me and assert the Dashboard heading' } });
  expect(res.ok(), await res.text()).toBe(true);
  const p = await res.json();
  expect(p.operations.every((o: any) => !o.error)).toBe(true);
  expect(p.diff).toContain("+  await page.getByRole('textbox', { name: 'Username' }).fill(`${testData.user}`);");
  expect(p.diff).toContain("-  await page.getByRole('checkbox', { name: 'Remember me' }).check();");
  expect(p.diff).toContain("+  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();");
  expect(p.diff).toContain("+test('Login lands on dashboard'");
  // nothing saved until accepted
  expect((await (await request.get(`${api}/tests/${created.id}`)).json()).actions).toHaveLength(5);

  const saved: TestCase = await (await request.post(`${api}/ai/edits/${p.id}/accept`)).json();
  expect(saved.name).toBe('Login lands on dashboard');
  expect(types(saved.actions)).toEqual(['navigate', 'fill', 'fill', 'click', 'assert']);
  expect(saved.variables).toEqual({ user: 'test-user' });

  const { executionId } = await (await request.post(`${api}/tests/${created.id}/run`, { data: { options: { stepTimeoutMs: 5000 } } })).json();
  await expect.poll(async () => (await (await request.get(`${api}/executions/${executionId}`)).json()).status, { timeout: 30_000 }).toBe('passed');
});

test('prompt edit: invalid operations are flagged and cannot be accepted; secrets cannot be edited', async ({ request }) => {
  const { api, created } = await loginTest(request);
  fake.onEdit = () => ({
    summary: 'bad', notes: [],
    operations: [
      op({ op: 'delete', index: 99 }),
      op({ op: 'insert', index: 1, json: JSON.stringify({ type: 'click' }) }), // no target
      op({ op: 'update', index: 2, json: JSON.stringify({ value: 'leaked' }) }), // secret step
      op({ op: 'insert', index: 1, json: 'not json' }),
    ],
  });
  const p = await (await request.post(`${api}/tests/${created.id}/ai/edit`, { data: { instruction: 'break things' } })).json();
  const errs = p.operations.map((o: any) => o.error ?? '');
  expect(errs[0]).toContain('index out of range');
  expect(errs[1]).toContain('target');
  expect(errs[2]).toContain('secret values cannot be edited');
  expect(errs[3]).toMatch(/JSON|Unexpected/);
  const acc = await request.post(`${api}/ai/edits/${p.id}/accept`);
  expect(acc.status()).toBe(400);
  expect((await acc.json()).error).toContain('invalid');
});

test('prompt edit: a proposal made before a manual change is refused (no silent overwrite)', async ({ request }) => {
  const { api, created } = await loginTest(request);
  fake.onEdit = () => ({ summary: 'delete last', notes: [], operations: [op({ op: 'delete', index: 4 })] });
  const p = await (await request.post(`${api}/tests/${created.id}/ai/edit`, { data: { instruction: 'remove the login click' } })).json();
  await new Promise((r) => setTimeout(r, 5));
  await request.put(`${api}/tests/${created.id}`, { data: { name: 'edited by hand' } });
  const acc = await request.post(`${api}/ai/edits/${p.id}/accept`);
  expect(acc.status()).toBe(400);
  expect((await acc.json()).error).toContain('changed after this proposal');
});

test('prompt edit: AI endpoints answer 503 with a clear message when no model is configured', async ({ request }) => {
  const off = await bootServer('ai-off', null);
  try {
    const api = `http://localhost:${off.server.port}/api`;
    expect(await (await request.get(`${api}/ai/status`)).json()).toEqual({ enabled: false, model: null });
    const t: TestCase = await (await request.post(`${api}/tests`, { data: { name: 'x', actions: [] } })).json();
    const res = await request.post(`${api}/tests/${t.id}/ai/edit`, { data: { instruction: 'anything' } });
    expect(res.status()).toBe(503);
    expect((await res.json()).error).toContain('ANTHROPIC_API_KEY');
  } finally { await off.server.close(); }
});

test('applyOperations: move and update keep ids and metadata stable', () => {
  const t = toTest('ops', [
    { id: 'a', type: 'navigate', url: 'https://x.test', timestamp: 1, pageAlias: 'page', metadata: { url: 'https://x.test' } },
    { id: 'b', type: 'press', key: 'Tab', timestamp: 2, pageAlias: 'page', metadata: { url: 'https://x.test' } },
    { id: 'c', type: 'reload', timestamp: 3, pageAlias: 'page', metadata: { url: 'https://x.test' } },
  ] as Action[]);
  const { next, applied } = applyOperations(t, [op({ op: 'move', index: 2, to: 1 }), op({ op: 'update', index: 2, json: JSON.stringify({ key: 'Enter', id: 'hijack' }) })]);
  expect(applied.every((o) => !o.error)).toBe(true);
  expect(next.actions.map((a) => a.id)).toEqual(['a', 'c', 'b']);
  expect((next.actions[2] as any).key).toBe('Enter');
  expect(next.actions[2].metadata.url).toBe('https://x.test');
});
