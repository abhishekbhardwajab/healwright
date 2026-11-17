/**
 * The success criterion, end to end through the studio UI:
 * open the app → start recording → interact with the *live view* (mouse and
 * keyboard forwarded over WebSocket to the remote Chromium) → stop → inspect
 * steps and generated code → replay → see results.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { bootServer, ROOT } from './helpers.js';

let ctx: Awaited<ReturnType<typeof bootServer>>;
test.beforeAll(async () => {
  if (!existsSync(path.join(ROOT, 'web/dist/index.html'))) execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  ctx = await bootServer('ui');
});
test.afterAll(async () => { await ctx.server.close(); });

/** Click on the studio's live view at the position of an element inside the remote page. */
async function clickRemote(studio: Page, selector: (p: import('playwright').Page) => import('playwright').Locator, opts: { clickCount?: number } = {}) {
  const session = [...ctx.server.sessions.values()][0];
  const box = await selector(session.page).boundingBox();
  if (!box) throw new Error('remote element not visible');
  const img = studio.getByRole('img', { name: 'Remote browser' });
  const ib = (await img.boundingBox())!;
  const vp = session.viewport;
  const x = ib.x + ((box.x + box.width / 2) * ib.width) / vp.width;
  const y = ib.y + ((box.y + box.height / 2) * ib.height) / vp.height;
  await studio.mouse.click(x, y, { clickCount: opts.clickCount });
}

test('record, inspect code and replay entirely through the studio UI', async ({ page: studio }) => {
  test.setTimeout(90_000);
  await studio.setViewportSize({ width: 1600, height: 1000 });
  await studio.goto(`http://localhost:${ctx.server.port}/`);
  await studio.getByLabel('Test name').fill('UI recorded login');
  await studio.getByLabel('URL').fill(`${ctx.base}/login.html`);
  await studio.getByTestId('record').click();
  await expect(studio.getByTestId('rec-status')).toHaveText('Recording');

  // wait until the screencast shows the page
  await expect.poll(async () => (await studio.getByRole('img', { name: 'Remote browser' }).getAttribute('src'))?.length ?? 0).toBeGreaterThan(1000);
  await expect(studio.getByTestId('step')).toHaveCount(1); // navigate

  await clickRemote(studio, (p) => p.getByLabel('Username'));
  await studio.keyboard.type('test-user', { delay: 20 });
  await clickRemote(studio, (p) => p.getByLabel('Password'));
  await studio.keyboard.type('s3cret!', { delay: 20 });
  await clickRemote(studio, (p) => p.getByText('Remember me'));
  await clickRemote(studio, (p) => p.getByRole('button', { name: 'Login' }));
  await expect.poll(() => [...ctx.server.sessions.values()][0].page.url()).toContain('dashboard.html');

  // assertion via picker in the live view
  await studio.getByTestId('assert-mode').click();
  await expect(studio.getByTestId('rec-status')).toHaveText('Picking element');
  await clickRemote(studio, (p) => p.getByRole('heading', { name: 'Dashboard' }));
  await studio.getByTestId('assert-kind').selectOption('visible');
  await studio.getByTestId('assert-add').click();

  await expect(studio.getByTestId('step-title')).toHaveText([
    /^Open .*login\.html/,
    'Type "test-user" into textbox "Username"',
    'Type •••••• into input "Password"',
    'Check checkbox "Remember me"',
    'Click button "Login"',
    'Assert visible on heading "Dashboard"',
  ]);

  await studio.screenshot({ path: path.join(ROOT, 'docs/screenshots/studio-recording.png') });
  await studio.getByTestId('stop').click();
  await expect(studio.getByTestId('rec-status')).toHaveText('Idle');

  // generated code
  await studio.getByTestId('tab-code').click();
  const code = studio.getByTestId('code-text');
  await expect(code).toContainText("await page.getByRole('button', { name: 'Login' }).click();");
  await expect(code).toContainText("fill(process.env.TEST_PASSWORD ?? '')");
  await expect(code).toContainText("await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();");
  await expect(code).not.toContainText('s3cret!');

  // replay
  await studio.screenshot({ path: path.join(ROOT, 'docs/screenshots/studio-code.png') });
  await studio.getByTestId('run').click();
  await expect(studio.getByTestId('results')).toBeVisible();
  await expect(studio.getByTestId('results').locator('span', { hasText: /^passed$/ }).first()).toBeVisible({ timeout: 30_000 });
  await studio.getByTestId('tab-steps').click();
  await expect(studio.getByTestId('step').filter({ hasText: 'passed' })).toHaveCount(6);
  await expect(studio.getByTestId('step').filter({ hasText: 'healed' })).toHaveCount(0);
  await studio.screenshot({ path: path.join(ROOT, 'docs/screenshots/studio-after-replay.png') });

  // persisted
  const tests = ctx.server.store.listTests();
  expect(tests.map((t) => t.name)).toContain('UI recorded login');
  expect(JSON.stringify(tests)).not.toContain('s3cret!');
});

test('editing steps in the UI updates the code: delete, reorder, edit value', async ({ page: studio }) => {
  const t = ctx.server.store.listTests().find((x) => x.name === 'UI recorded login');
  test.skip(!t, 'depends on the recording test');
  await studio.setViewportSize({ width: 1600, height: 1000 });
  await studio.goto(`http://localhost:${ctx.server.port}/`);
  await studio.getByTestId('test-select').selectOption({ label: 'UI recorded login' });
  await expect(studio.getByTestId('step')).toHaveCount(6);

  // edit the username value
  const userStep = studio.getByTestId('step').nth(1);
  await userStep.hover();
  await userStep.getByRole('button', { name: 'Edit' }).click();
  await studio.getByRole('dialog').getByLabel(/^Value/).fill('${user}');
  await studio.getByRole('dialog').getByRole('button', { name: 'Save step' }).click();
  // delete "Remember me"
  const remember = studio.getByTestId('step').nth(3);
  await remember.hover();
  await remember.getByRole('button', { name: 'Delete' }).click();
  await expect(studio.getByTestId('step')).toHaveCount(5);

  await studio.getByTestId('tab-code').click();
  const code = studio.getByTestId('code-text');
  await expect(code).toContainText("fill('${user}')");
  await expect(code).not.toContainText('Remember me');
  await expect.poll(() => ctx.server.store.getTest(t!.id)?.actions.length).toBe(5);
});
