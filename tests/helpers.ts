import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Locator, Page } from 'playwright';
import { startServer } from '../src/server/index.js';
import { RecorderSession } from '../src/recorder/RecorderSession.js';
import { ReplayEngine } from '../src/replay/ReplayEngine.js';
import { generatePlaywrightTest } from '../src/codegen/playwright.js';
import type { Action, Assertion, ExecutionOptions, TestCase } from '../src/model/actions.js';
import type { AiModel } from '../src/ai/types.js';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const TMP = path.join(ROOT, '.tmp');

export type Server = Awaited<ReturnType<typeof startServer>>;

export async function bootServer(name: string, ai: AiModel | null = null) {
  const dataDir = path.join(TMP, 'data-' + name);
  rmSync(dataDir, { recursive: true, force: true });
  const server = await startServer({ port: 0, dataDir, ai });
  return { server, dataDir, base: `http://localhost:${server.port}/fixtures` };
}

/** Starts a real recording session. `act` drives the page with real (CDP) input, like the studio UI does. */
export async function record(dataDir: string, act: (page: Page, s: RecorderSession) => Promise<void>) {
  const s = new RecorderSession({ artifactsDir: path.join(dataDir, 'artifacts'), uploadsDir: path.join(dataDir, 'uploads'), screencast: false });
  await s.start();
  try {
    await act(s.page, s);
    await settle(s);
  } finally {
    await s.stop();
  }
  return s;
}

/** Let in-flight binding calls reach the queue. */
export async function settle(s: RecorderSession, ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
  await (s as unknown as { queue: Promise<void> }).queue;
}

/** Real assertion flow: enter pick mode, click the element, turn the pick into an assert step. */
export async function pickAssert(s: RecorderSession, loc: Locator, assertion: Omit<Assertion, 'kind'> & { kind: Assertion['kind'] }) {
  await s.setMode('assert');
  const picked = new Promise<{ target: Action['target']; pageAlias: string; url: string }>((r) => s.once('pick', r));
  await loc.click();
  const p = await picked;
  s.addAction({ id: `assert-${Date.now()}`, type: 'assert', assertion, target: p.target, timestamp: Date.now(), pageAlias: p.pageAlias, metadata: { url: p.url } } as Action);
  await s.setMode('record');
}

export function toTest(name: string, actions: Action[], variables: Record<string, string> = {}): TestCase {
  return { id: 'test-' + name, name, projectId: 'tests', createdAt: Date.now(), updatedAt: Date.now(), viewport: { width: 1280, height: 800 }, variables, actions: structuredClone(actions) };
}

export async function replay(dataDir: string, test: TestCase, s?: RecorderSession, opts: ExecutionOptions = {}, ai?: AiModel) {
  const engine = new ReplayEngine(test, { stepTimeoutMs: 5000, stepRetries: 0, ...opts }, { artifactsDir: path.join(dataDir, 'artifacts'), vault: s?.vault, ai });
  return engine.run();
}

export const types = (actions: Action[]) => actions.map((a) => a.type);
export const primaries = (actions: Action[]) => actions.filter((a) => a.target).map((a) => a.target!.selectors[0]);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export interface ScenarioMetrics {
  scenario: string;
  expectedSteps: string[];
  recordedSteps: string[];
  recordingAccurate: boolean;
  primaryStrategies: string[];
  uniquePrimaries: number;
  targetSteps: number;
  replayStatus: string;
  replayMs: number;
  healedSteps: number;
  generatedCodeStatus?: string;
  note?: string;
}

export function saveMetrics(m: ScenarioMetrics) {
  const dir = path.join(TMP, 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, m.scenario.replace(/\W+/g, '_') + '.json'), JSON.stringify(m, null, 2));
}

// ---------------------------------------------------------------------------
// Generated code: write specs and run them with the real Playwright Test runner
// ---------------------------------------------------------------------------
export const GEN_DIR = path.join(TMP, 'generated');

export function writeGenerated(name: string, test: TestCase) {
  mkdirSync(GEN_DIR, { recursive: true });
  const file = path.join(GEN_DIR, name.replace(/\W+/g, '-') + '.spec.ts');
  writeFileSync(file, generatePlaywrightTest(test));
  return file;
}

export function runGenerated(env: Record<string, string> = {}): Promise<{ code: number; report: any; stderr: string }> {
  writeFileSync(path.join(GEN_DIR, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.', timeout: 30000, workers: 4, reporter: [['json', { outputFile: 'report.json' }]], use: { trace: 'off' } });\n`);
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(TEST_|PW_TEST|PLAYWRIGHT_TEST|TEST_WORKER)/.test(k)) cleanEnv[k] = v;
  return new Promise((resolve) => {
    execFile('npx', ['playwright', 'test', '-c', path.join(GEN_DIR, 'playwright.config.ts')], { cwd: ROOT, env: { ...cleanEnv, ...env }, timeout: 180_000 }, async (err, _stdout, stderr) => {
      const { readFileSync } = await import('node:fs');
      let report: any = null;
      try { report = JSON.parse(readFileSync(path.join(GEN_DIR, 'report.json'), 'utf8')); } catch { /* none */ }
      resolve({ code: err ? (err as any).code ?? 1 : 0, report, stderr });
    });
  });
}
