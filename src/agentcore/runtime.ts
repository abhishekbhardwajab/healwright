/**
 * healwright test-run worker for Amazon Bedrock AgentCore Runtime.
 *
 * Implements the AgentCore Runtime HTTP protocol contract: listens on 0.0.0.0:8080,
 * POST /invocations runs a recorded test, GET /ping reports health. AgentCore
 * authenticates every call (SigV4 or OAuth) before it reaches this container, and each
 * runtime session is its own microVM, so this server has no auth of its own and is not
 * meant to be exposed anywhere else. It has no UI and no persistence: the caller (the
 * studio, CI, a scheduler) sends the test and gets the execution back.
 *
 * Request body (JSON):
 *   { "action": "run", "tenantId": "acme", "test": TestCase, "options"?: ExecutionOptions,
 *     "secrets"?: { NAME: value }, "stream"?: boolean }
 *   { "action": "status" }
 * With "stream": true (or Accept: text/event-stream) progress is streamed as SSE
 * "update" events and the result arrives as a final "result" event.
 *
 * Multi-tenant SaaS: only the healwright control plane holds the IAM permission to
 * invoke this runtime; end users never call it directly. The control plane sets the
 * tenant (payload "tenantId", or the X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Id
 * header) and uses a runtime session id that starts with the tenant id, so one tenant's
 * runs never share a microVM with another's. Every run ends with a usage record (run
 * seconds, AI calls and tokens) logged in CloudWatch Embedded Metric Format under the
 * "Healwright" namespace with a TenantId dimension, which is what billing reads.
 * REQUIRE_TENANT=false allows runs without a tenant (single-tenant deployments).
 *
 * Browsers come from AgentCore Browser (BROWSER_PROVIDER=agentcore, the default here)
 * and Claude from Amazon Bedrock (AI_PROVIDER=bedrock, the default here), both via
 * the runtime's IAM execution role.
 */
import express, { type Request, type Response } from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayEngine } from '../replay/ReplayEngine.js';
import { SecretVault } from '../recorder/secrets.js';
import { aiFromEnv, ClaudeModel, type AiUsage } from '../ai/claude.js';
import { browserProvider, closeBrowser } from '../recorder/browser.js';
import type { Execution, ExecutionOptions, TestCase } from '../model/actions.js';
import type { AiModel } from '../ai/types.js';

const MAX_INLINE_SCREENSHOT = 1_000_000;

export interface RunPayload {
  action?: 'run' | 'status';
  tenantId?: string;
  test?: TestCase;
  options?: ExecutionOptions;
  secrets?: Record<string, string>;
  stream?: boolean;
}

/** Validates the shape we rely on; the replay engine checks every URL it opens. */
export function validateTest(t: unknown): TestCase {
  const test = t as TestCase;
  if (!test || typeof test !== 'object') throw new BadRequest('"test" is required');
  if (!Array.isArray(test.actions) || test.actions.length === 0) throw new BadRequest('"test.actions" must be a non-empty array');
  if (test.actions.length > 2000) throw new BadRequest('test has too many steps (max 2000)');
  return {
    id: String(test.id ?? 'agentcore-test'),
    name: String(test.name ?? 'AgentCore run'),
    projectId: String(test.projectId ?? 'agentcore'),
    createdAt: Number(test.createdAt ?? Date.now()),
    updatedAt: Number(test.updatedAt ?? Date.now()),
    startUrl: test.startUrl,
    viewport: test.viewport?.width && test.viewport?.height ? test.viewport : { width: 1280, height: 800 },
    variables: test.variables && typeof test.variables === 'object' ? test.variables : {},
    actions: test.actions,
  };
}

class BadRequest extends Error {}

const TENANT_HEADER = 'x-amzn-bedrock-agentcore-runtime-custom-tenant-id';
const TENANT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function resolveTenant(req: Request, body: RunPayload): string | undefined {
  const raw = req.get(TENANT_HEADER) ?? body.tenantId;
  if (raw === undefined || raw === '') {
    if (process.env.REQUIRE_TENANT === 'false') return undefined;
    throw new BadRequest('"tenantId" is required');
  }
  if (typeof raw !== 'string' || !TENANT_RE.test(raw)) throw new BadRequest('"tenantId" must be 1-64 letters, digits, "-" or "_"');
  return raw;
}

export interface RunUsage { tenantId?: string; executionId: string; status: string; runSeconds: number; aiCalls: number; aiInputTokens: number; aiOutputTokens: number }

/** One CloudWatch EMF line per run; CloudWatch turns it into per-tenant metrics without any API call. */
export function emitUsage(u: RunUsage, log: (line: string) => void = (l) => console.log(l)) {
  log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Healwright',
        Dimensions: [['TenantId']],
        Metrics: [
          { Name: 'Runs', Unit: 'Count' }, { Name: 'RunSeconds', Unit: 'Seconds' },
          { Name: 'AiCalls', Unit: 'Count' }, { Name: 'AiInputTokens', Unit: 'Count' }, { Name: 'AiOutputTokens', Unit: 'Count' },
        ],
      }],
    },
    TenantId: u.tenantId ?? 'none',
    ExecutionId: u.executionId,
    Status: u.status,
    Runs: 1,
    RunSeconds: u.runSeconds,
    AiCalls: u.aiCalls,
    AiInputTokens: u.aiInputTokens,
    AiOutputTokens: u.aiOutputTokens,
  }));
}

export function createRuntimeApp(opts: { executionTimeoutMs?: number; ai?: AiModel | null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  const ai = opts.ai === undefined ? aiFromEnv() : opts.ai ?? undefined;
  const running = new Set<ReplayEngine>();
  let lastStatusChange = Math.floor(Date.now() / 1000);
  const markChange = () => { lastStatusChange = Math.floor(Date.now() / 1000); };

  // HealthyBusy keeps the session alive while a run is in progress (AgentCore contract).
  app.get('/ping', (_req, res) => {
    res.json({ status: running.size ? 'HealthyBusy' : 'Healthy', time_of_last_update: lastStatusChange });
  });

  app.post('/invocations', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RunPayload;
    try {
      if (body.action === 'status') {
        res.json({ running: running.size, browserProvider: browserProvider(), ai: ai ? { model: ai.name } : null });
        return;
      }
      if (body.action && body.action !== 'run') throw new BadRequest(`unknown action "${body.action}"`);
      const tenantId = resolveTenant(req, body);
      const test = validateTest(body.test);
      const options: ExecutionOptions = { screenshots: 'on-failure', ...body.options, headless: true };
      const vault = new SecretVault();
      for (const [k, v] of Object.entries(body.secrets ?? {})) if (typeof v === 'string') vault.set(k, v);

      const artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'healwright-'));
      const usage = { aiCalls: 0, aiInputTokens: 0, aiOutputTokens: 0 };
      const onUsage = (u: AiUsage) => { usage.aiCalls++; usage.aiInputTokens += u.inputTokens; usage.aiOutputTokens += u.outputTokens; };
      const runAi = ai instanceof ClaudeModel ? ai.withUsageListener(onUsage) : ai;
      const engine = new ReplayEngine(test, options, { artifactsDir, vault, ai: runAi });
      running.add(engine); markChange();
      const stream = body.stream === true || (req.get('accept') ?? '').includes('text/event-stream');
      if (stream) {
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.flushHeaders();
        engine.on('update', (e: Execution) => res.write(`event: update\ndata: ${JSON.stringify(summarize(e))}\n\n`));
      }
      const timeout = setTimeout(() => engine.stop(), opts.executionTimeoutMs ?? Number(process.env.EXECUTION_TIMEOUT_MS ?? 15 * 60_000));
      // Caller went away (closed the stream or timed out): stop the run and free the browser.
      res.on('close', () => { if (!res.writableEnded) engine.stop(); });
      let result: Execution;
      try {
        result = await engine.run();
      } finally {
        clearTimeout(timeout);
        running.delete(engine); markChange();
      }
      const record: RunUsage = {
        tenantId, executionId: result.id, status: result.status,
        runSeconds: Math.round(((result.finishedAt ?? Date.now()) - result.startedAt) / 100) / 10, ...usage,
      };
      emitUsage(record);
      const payload = { execution: withInlineScreenshots(result, artifactsDir), usage: record };
      rmSync(artifactsDir, { recursive: true, force: true });
      if (stream) { res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`); res.end(); }
      else res.json(payload);
    } catch (e) {
      const status = e instanceof BadRequest ? 400 : 500;
      if (res.headersSent) { res.write(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`); res.end(); return; }
      res.status(status).json({ error: (e as Error).message });
    }
  });
  return app;
}

/** Progress events carry step statuses and logs, never screenshots. */
function summarize(e: Execution) {
  return { id: e.id, status: e.status, steps: e.steps.map((s) => ({ index: s.index, status: s.status, error: s.error })), logs: e.logs.slice(-5) };
}

/** Screenshots live in a temp dir that is deleted after the run, so failed-step shots are returned inline. */
function withInlineScreenshots(e: Execution, artifactsDir: string) {
  return {
    ...e,
    steps: e.steps.map((s) => {
      if (!s.screenshot) return s;
      const { screenshot, ...rest } = s;
      if (s.status !== 'failed') return rest;
      try {
        const buf = readFileSync(path.join(artifactsDir, screenshot));
        if (buf.length > MAX_INLINE_SCREENSHOT) return rest;
        return { ...rest, screenshotPng: buf.toString('base64') };
      } catch { return rest; }
    }),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('agentcore', 'runtime.ts'));
if (isMain) {
  // Defaults for the AgentCore deployment; override with the environment.
  process.env.BROWSER_PROVIDER ??= 'agentcore';
  process.env.AI_PROVIDER ??= 'bedrock';
  const port = Number(process.env.PORT ?? 8080);
  const app = createRuntimeApp();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`healwright AgentCore worker on :${port} (browsers: ${browserProvider()}, AI: ${process.env.AI_PROVIDER})`);
  });
  const shutdown = () => { server.close(); void closeBrowser().finally(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
