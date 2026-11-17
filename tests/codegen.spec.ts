/** Pure unit tests: action model -> Playwright source. No browser needed. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generatePlaywrightTest } from '../src/codegen/playwright.js';
import type { Action, ElementTarget } from '../src/model/actions.js';
import { ROOT, TMP } from './helpers.js';

const t = (sel: ElementTarget['selectors'][0], extra: Partial<ElementTarget> = {}): ElementTarget => ({ tagName: 'BUTTON', selectors: [sel], ...extra });
const base = (type: string, extra: object = {}) => ({ id: `s-${type}-${Math.random()}`, type, timestamp: 0, pageAlias: 'page', metadata: { url: 'https://example.com' }, ...extra }) as unknown as Action;
const login = t({ strategy: 'role', value: 'button', options: { name: 'Login' }, score: 90 }, { role: 'button', accessibleName: 'Login' });

const ALL: Action[] = [
  base('navigate', { url: 'https://example.com/login' }),
  base('fill', { target: t({ strategy: 'label', value: 'Username', score: 86 }, { tagName: 'INPUT', accessibleName: 'Username' }), value: '${user}' }),
  base('fill', { target: t({ strategy: 'label', value: 'Password', score: 86 }, { tagName: 'INPUT' }), value: '', secretVariable: 'TEST_PASSWORD' }),
  base('click', { target: login }),
  base('dblclick', { target: login }),
  base('rightClick', { target: login }),
  base('hover', { target: t({ strategy: 'text', value: 'Menu', options: { exact: true }, score: 70 }) }),
  base('clear', { target: t({ strategy: 'placeholder', value: 'Search', score: 80 }) }),
  base('press', { key: 'Control+k' }),
  base('select', { target: t({ strategy: 'testid', value: 'country', score: 100 }), values: ['in'] }),
  base('check', { target: t({ strategy: 'css', value: '#terms', score: 68 }) }),
  base('uncheck', { target: t({ strategy: 'xpath', value: '/html/body/input[2]', score: 10 }) }),
  base('setInputFiles', { target: t({ strategy: 'label', value: 'CV', score: 86 }), files: ['cv.pdf'], filePaths: ['/tmp/cv.pdf'] }),
  base('scroll', { x: 0, y: 500 }),
  base('dragTo', { target: t({ strategy: 'text', value: 'Card', score: 70 }), destination: t({ strategy: 'role', value: 'region', options: { name: 'Done' }, score: 90 }) }),
  base('wait', { wait: 'loadState', loadState: 'networkidle' }),
  base('assert', { assertion: { kind: 'url', expected: 'dashboard', regex: true } }),
  base('assert', { target: t({ strategy: 'role', value: 'heading', options: { name: 'Dashboard' }, score: 90 }), assertion: { kind: 'visible' } }),
  base('assert', { target: t({ strategy: 'css', value: '#msg', score: 68 }), assertion: { kind: 'hasText', expected: "It's done", negate: true } }),
  base('assert', { target: t({ strategy: 'role', value: 'textbox', options: { name: 'Email' }, score: 90 }), assertion: { kind: 'attribute', attribute: 'type', expected: 'email' } }),
  base('click', {
    target: t({ strategy: 'role', value: 'button', options: { name: 'Pay' }, score: 90 }, { framePath: [{ selectors: [{ strategy: 'css', value: 'iframe[name="pay"]', score: 60 }] }] }),
    signals: { popup: 'page1', dialog: { type: 'confirm', message: 'Sure?', response: 'accept' } },
  }),
  { ...base('click', { target: t({ strategy: 'role', value: 'button', options: { name: 'Add' }, score: 70, parent: { strategy: 'role', value: 'listitem', options: { hasText: 'Blue shoe' }, score: 75 } }) }), pageAlias: 'page1' } as Action,
  base('goBack'),
  base('reload'),
  { ...base('click', { target: login }), disabled: true } as Action,
];

const code = generatePlaywrightTest({ name: "Everything's covered", actions: ALL, variables: { user: 'test-user' } });

test('emits idiomatic Playwright for every action type', () => {
  for (const line of [
    "import { test, expect } from '@playwright/test';",
    "user: process.env.TEST_USER ?? 'test-user',",
    "test('Everything\\'s covered', async ({ page }) => {",
    "await page.goto('https://example.com/login');",
    'fill(`${testData.user}`);',
    "await page.getByLabel('Password').fill(process.env.TEST_PASSWORD ?? '');",
    'await loginButton.click();',
    'await loginButton.dblclick();',
    "await loginButton.click({ button: 'right' });",
    "await page.getByText('Menu', { exact: true }).hover();",
    "await page.getByPlaceholder('Search').clear();",
    "await page.keyboard.press('Control+k');",
    "await page.getByTestId('country').selectOption('in');",
    "await page.locator('#terms').check();",
    "await page.locator('xpath=/html/body/input[2]').uncheck();",
    "await page.getByLabel('CV').setInputFiles('/tmp/cv.pdf');",
    'await page.evaluate(() => window.scrollTo(0, 500));',
    "await page.getByText('Card').dragTo(page.getByRole('region', { name: 'Done' }));",
    "await page.waitForLoadState('networkidle');",
    'await expect(page).toHaveURL(/dashboard/);',
    "await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();",
    "await expect(page.locator('#msg')).not.toHaveText('It\\'s done');",
    "await expect(page.getByRole('textbox', { name: 'Email' })).toHaveAttribute('type', 'email');",
    "page.once('dialog', (dialog) => dialog.accept());",
    "const page1Promise = page.waitForEvent('popup');",
    "await page.locator('iframe[name=\"pay\"]').contentFrame().getByRole('button', { name: 'Pay' }).click();",
    'const page1 = await page1Promise;',
    "await page1.getByRole('listitem').filter({ hasText: 'Blue shoe' }).getByRole('button', { name: 'Add' }).click();",
    'await page.goBack();',
    'await page.reload();',
  ]) expect(code).toContain(line);
  expect(code.match(/loginButton\.click\(\)/g)?.length, 'disabled step must not be emitted').toBe(1);
  expect(code).toContain('Provide them via environment variables: TEST_PASSWORD');
});

test('generated code type-checks against @playwright/test', () => {
  const dir = path.join(TMP, 'codegen-typecheck');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'all.spec.ts');
  writeFileSync(file, code);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'], skipLibCheck: true, typeRoots: [path.join(ROOT, 'node_modules/@types')], baseUrl: ROOT, paths: { '@playwright/test': [path.join(ROOT, 'node_modules/@playwright/test')] } }, files: ['all.spec.ts'] }));
  execFileSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['-p', path.join(dir, 'tsconfig.json')], { stdio: 'pipe' });
});

test('generation is deterministic and side-effect free', () => {
  const again = generatePlaywrightTest({ name: "Everything's covered", actions: ALL, variables: { user: 'test-user' } });
  expect(again).toBe(code);
});
