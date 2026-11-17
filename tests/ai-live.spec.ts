/**
 * The same AI flows against the real Claude API. Skipped unless credentials are
 * configured (ANTHROPIC_API_KEY or the other variables aiFromEnv accepts), so the
 * default suite never spends tokens. Run with:
 *   ANTHROPIC_API_KEY=... npx playwright test tests/ai-live.spec.ts
 * Model answers vary, so these assert outcomes (the run passes, the diff is valid
 * and replays), not exact wording.
 */
import { test, expect } from '@playwright/test';
import { bootServer, record, settle, toTest, replay, types } from './helpers.js';
import { aiFromEnv } from '../src/ai/claude.js';
import { applyHealProposal, proposeEdit } from '../src/ai/edit.js';
import type { Action } from '../src/model/actions.js';

const ai = aiFromEnv();
test.skip(!ai, 'No Claude credentials configured (set ANTHROPIC_API_KEY)');
test.describe.configure({ timeout: 180_000 });

let ctx: Awaited<ReturnType<typeof bootServer>>;
test.beforeAll(async () => { ctx = await bootServer('ai-live', ai!); });
test.afterAll(async () => { await ctx?.server.close(); });

async function recordSignIn() {
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('live@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
  });
  expect(types(s.actions)).toEqual(['navigate', 'fill', 'click']);
  return s;
}

test('live Claude heals a renamed button and the accepted locator replays without healing', async () => {
  const s = await recordSignIn();
  const t = toTest('live-heal', s.actions);
  t.actions[2].target!.selectors = [{ strategy: 'role', value: 'button', options: { name: 'Sign in' }, score: 90 }];
  (t.actions[0] as Extract<Action, { type: 'navigate' }>).url = `${ctx.base}/dynamic.html?v=3`;

  const ex = await replay(ctx.dataDir, t, s, { stepTimeoutMs: 1500 }, ai);
  expect(ex.status, JSON.stringify(ex.steps[2])).toBe('passed');
  expect(ex.steps[2].ai?.confidence).toBeGreaterThanOrEqual(0.7);
  console.log('Claude reasoning:', ex.steps[2].ai?.reasoning);
  const fixed = applyHealProposal(t, ex.healProposals![0]);
  const again = await replay(ctx.dataDir, fixed, s, { stepTimeoutMs: 1500 });
  expect(again.status).toBe('passed');
  expect(again.steps.some((x) => x.healed)).toBe(false);
});

test('live Claude turns a plain-English change into valid operations that replay', async () => {
  const s = await recordSignIn();
  const t = toTest('live-edit', s.actions);
  const p = await proposeEdit(ai!, t, 'Put the email address in a variable called email, and after clicking Sign in check that the #msg paragraph contains "Hello".');
  console.log(p.summary, '\n', p.diff);
  expect(p.operations.filter((o) => o.error)).toEqual([]);
  expect(p.after.variables.email).toBe('live@example.com');
  expect(p.after.actions.at(-1)?.type).toBe('assert');
  const ex = await replay(ctx.dataDir, { ...t, ...p.after }, s);
  expect(ex.status, JSON.stringify(ex.steps.find((x) => x.status === 'failed'))).toBe('passed');
});
