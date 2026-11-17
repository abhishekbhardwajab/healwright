/**
 * Both AI features through the studio UI, with the scripted model:
 * run a test whose button was renamed → review and accept the AI locator fix in
 * the Results panel → ask for a change in the AI panel → review the code diff →
 * accept → the saved test and the generated code reflect it.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bootServer, record, settle, types, ROOT } from './helpers.js';
import { FakeAi, op } from './fake-ai.js';
import type { Action, TestCase } from '../src/model/actions.js';

let ctx: Awaited<ReturnType<typeof bootServer>>;
const fake = new FakeAi();
test.beforeAll(async () => {
  if (!existsSync(path.join(ROOT, 'web/dist/index.html'))) execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  ctx = await bootServer('ui-ai', fake);
});
test.afterAll(async () => { await ctx.server.close(); });

test('studio UI: accept an AI-healed locator, then change the test by prompt and accept the diff', async ({ page: studio, request }) => {
  test.setTimeout(120_000);
  // A recorded sign-in whose button is renamed in the app under test (dynamic.html?v=3).
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('ui@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
  });
  expect(types(s.actions)).toEqual(['navigate', 'fill', 'click']);
  const actions = structuredClone(s.actions);
  (actions[0] as Extract<Action, { type: 'navigate' }>).url = `${ctx.base}/dynamic.html?v=3`;
  actions[2].target!.selectors = [{ strategy: 'role', value: 'button', options: { name: 'Sign in' }, score: 90 }];
  const api = `http://localhost:${ctx.server.port}/api`;
  const created: TestCase = await (await request.post(`${api}/tests`, { data: { name: 'UI AI sign in', actions } })).json();

  fake.onHeal = (req) => ({ elementIndex: req.elements.find((e) => e.tag === 'button' && e.visible)!.index, confidence: 0.91, reasoning: 'Same submit button; its label changed to "Log in now".' });

  await studio.setViewportSize({ width: 1600, height: 1000 });
  await studio.goto(`http://localhost:${ctx.server.port}/`);
  await studio.getByTestId('test-select').selectOption(created.id);
  await expect(studio.getByTestId('step')).toHaveCount(3);
  await studio.getByText('Run settings').click();
  await studio.getByLabel('Step timeout (ms)').fill('1500');
  await expect(studio.getByTestId('ai-healing')).toHaveValue('suggest');

  // 1) self-healing
  await studio.getByTestId('run').click();
  await expect(studio.getByTestId('results').getByText('passed').first()).toBeVisible({ timeout: 30_000 });
  await expect(studio.getByTestId('ai-healed')).toHaveCount(1);
  const proposal = studio.getByTestId('heal-proposal');
  await expect(proposal).toContainText('AI 91%');
  await expect(proposal).toContainText('label changed to "Log in now"');
  if (process.env.SCREENSHOTS) await studio.screenshot({ path: path.join(ROOT, 'docs/screenshots/ai-heal-review.png') });
  await studio.getByTestId('heal-accept').click();
  await expect(studio.getByTestId('heal-status')).toHaveText('accepted');
  const healed: TestCase = await (await request.get(`${api}/tests/${created.id}`)).json();
  expect(healed.actions[2].target!.selectors[0].notes).toContain('AI-healed');
  await studio.getByTestId('tab-code').click();
  await expect(studio.getByTestId('code-text')).not.toContainText("name: 'Sign in'");

  // 2) prompt-driven change
  fake.onEdit = () => ({
    summary: 'Check the greeting after signing in.',
    notes: ['The greeting text is assumed from the app; verify it on a run.'],
    operations: [
      op({ op: 'insert', index: 3, json: JSON.stringify({ type: 'assert', assertion: { kind: 'containsText', expected: 'Hello' }, target: { tagName: 'P', selectors: [{ strategy: 'css', value: '#msg' }] } }), explanation: 'assert greeting' }),
      op({ op: 'rename', json: JSON.stringify({ name: 'Sign in shows greeting' }), explanation: 'clearer name' }),
    ],
  });
  await studio.getByTestId('tab-ai').click();
  await studio.getByTestId('ai-instruction').fill('After signing in, check the greeting says Hello and give the test a clearer name');
  await studio.getByTestId('ai-ask').click();
  await expect(studio.getByTestId('ai-summary')).toHaveText('Check the greeting after signing in.');
  await expect(studio.getByTestId('ai-diff-text')).toContainText("+  await expect(page.locator('#msg')).toContainText('Hello');");
  await expect(studio.getByTestId('ai-diff-text')).toContainText("+test('Sign in shows greeting'");
  if (process.env.SCREENSHOTS) await studio.screenshot({ path: path.join(ROOT, 'docs/screenshots/ai-prompt-edit.png') });
  expect(fake.editRequests.at(-1)!.instruction).toContain('check the greeting');
  // nothing saved yet
  expect((await (await request.get(`${api}/tests/${created.id}`)).json()).actions).toHaveLength(3);

  await studio.getByTestId('ai-accept').click();
  await expect(studio.getByTestId('ai-summary')).toHaveCount(0);
  await expect(studio.getByTestId('test-name')).toHaveValue('Sign in shows greeting');
  await studio.getByTestId('tab-steps').click();
  await expect(studio.getByTestId('step')).toHaveCount(4);
  const saved: TestCase = await (await request.get(`${api}/tests/${created.id}`)).json();
  expect(types(saved.actions)).toEqual(['navigate', 'fill', 'click', 'assert']);

  // the accepted test runs green with no further healing
  await studio.getByTestId('run').click();
  await expect(studio.getByTestId('results').getByText('passed').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const ex = (await (await request.get(`${api}/tests/${created.id}/executions`)).json()) as import('../src/model/actions.js').Execution[];
    return ex.length === 2 && ex[0].finishedAt ? `${ex[0].status} healed=${ex[0].steps.some((x) => x.healed)} steps=${ex[0].steps.length}` : 'running';
  }, { timeout: 30_000 }).toBe('passed healed=false steps=4');
  await expect(studio.getByTestId('ai-healed')).toHaveCount(0);
});
