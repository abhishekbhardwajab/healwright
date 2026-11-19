/**
 * AgentCore deployment pieces, exercised locally without AWS:
 * - the Runtime worker's HTTP contract (/ping, /invocations, tenancy, metering),
 * - the AgentCore Browser provider, with the AgentCore client swapped for a local
 *   Chromium CDP endpoint (same connectOverCDP path, headers and session lifecycle),
 * - Claude on Amazon Bedrock, against a local stand-in for the Bedrock endpoint
 *   (checks SigV4 signing, the Bedrock model id and the request shape).
 */
import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { bootServer, record, pickAssert, settle, toTest, replay, types } from './helpers.js';
import { createRuntimeApp, emitUsage, validateTest } from '../src/agentcore/runtime.js';
import { tenantSessionId } from '../src/agentcore/invoke.js';
import { setAgentCoreClientFactory } from '../src/cloud/agentcore-browser.js';
import { ClaudeModel, DEFAULT_BEDROCK_MODEL, type AiUsage } from '../src/ai/claude.js';
import type { Execution, TestCase } from '../src/model/actions.js';

let ctx: Awaited<ReturnType<typeof bootServer>>;
let signIn: TestCase;

test.beforeAll(async () => {
  ctx = await bootServer('agentcore');
  const s = await record(ctx.dataDir, async (page, s) => {
    await s.navigate(`${ctx.base}/dynamic.html?v=1`);
    await page.getByLabel('Work email').click(); await page.keyboard.type('ac@example.com');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await settle(s);
    await pickAssert(s, page.locator('#msg'), { kind: 'hasText', expected: 'Hello ac@example.com' });
  });
  expect(types(s.actions)).toEqual(['navigate', 'fill', 'click', 'assert']);
  signIn = toTest('ac-signin', s.actions);
});
test.afterAll(async () => { await ctx.server.close(); });

async function listen(app: http.RequestListener) {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

test.describe('AgentCore Runtime worker', () => {
  test('ping reports Healthy in the contract shape', async () => {
    const rt = await listen(createRuntimeApp({ ai: null }));
    try {
      const r = await fetch(`${rt.url}/ping`);
      const body = await r.json();
      expect(r.headers.get('content-type')).toContain('application/json');
      expect(body.status).toBe('Healthy');
      expect(typeof body.time_of_last_update).toBe('number');
    } finally { await rt.close(); }
  });

  test('runs a test for a tenant and returns the execution with a usage record', async () => {
    const rt = await listen(createRuntimeApp({ ai: null }));
    const lines: string[] = [];
    const log = console.log;
    console.log = (l: unknown) => { lines.push(String(l)); };
    try {
      const r = await fetch(`${rt.url}/invocations`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run', tenantId: 'acme', test: signIn, options: { stepTimeoutMs: 5000 } }),
      });
      const body = await r.json() as { execution: Execution; usage: { tenantId: string; status: string; runSeconds: number } };
      expect(r.status).toBe(200);
      expect(body.execution.status).toBe('passed');
      expect(body.usage).toMatchObject({ tenantId: 'acme', status: 'passed', aiCalls: 0 });
      expect(body.usage.runSeconds).toBeGreaterThan(0);
      const emf = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?._aws);
      expect(emf.TenantId).toBe('acme');
      expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe('Healwright');
    } finally { console.log = log; await rt.close(); }
  });

  test('a failing run returns the failed step screenshot inline', async () => {
    const rt = await listen(createRuntimeApp({ ai: null }));
    const broken = structuredClone(signIn);
    broken.actions[0] = { ...broken.actions[0], url: `${ctx.base}/dynamic.html?v=2` } as typeof broken.actions[0];
    broken.actions[3] = { ...broken.actions[3], assertion: { kind: 'hasText', expected: 'not this text' } } as typeof broken.actions[3];
    try {
      const r = await fetch(`${rt.url}/invocations`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'acme', test: broken, options: { stepTimeoutMs: 1500, stepRetries: 0 } }),
      });
      const body = await r.json() as { execution: Execution & { steps: { status: string; screenshotPng?: string; screenshot?: string }[] } };
      expect(body.execution.status).toBe('failed');
      const failed = body.execution.steps.find((s) => s.status === 'failed') as { screenshotPng?: string };
      expect(failed.screenshotPng?.length).toBeGreaterThan(100);
      expect(body.execution.steps.every((s) => !s.screenshot)).toBe(true);
    } finally { await rt.close(); }
  });

  test('streams progress as server-sent events', async () => {
    const rt = await listen(createRuntimeApp({ ai: null }));
    try {
      const r = await fetch(`${rt.url}/invocations`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ tenantId: 'acme', test: signIn }),
      });
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      const text = await r.text();
      expect(text).toContain('event: update');
      const result = text.split('\n\n').find((e) => e.startsWith('event: result'))!;
      expect(JSON.parse(result.split('data: ')[1]).execution.status).toBe('passed');
    } finally { await rt.close(); }
  });

  test('rejects runs without a valid tenant, and bad tests', async () => {
    const rt = await listen(createRuntimeApp({ ai: null }));
    const post = (b: unknown, h: Record<string, string> = {}) => fetch(`${rt.url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
    try {
      expect((await post({ test: signIn })).status).toBe(400);
      expect((await post({ tenantId: '../etc', test: signIn })).status).toBe(400);
      expect((await post({ tenantId: 'acme', test: { actions: [] } })).status).toBe(400);
      expect((await post({ tenantId: 'acme', action: 'drop-tables' })).status).toBe(400);
      // The tenant header (set by the control plane) wins over the payload.
      const st = await post({ action: 'status' }, { 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Id': 'acme' });
      expect(st.status).toBe(200);
    } finally { await rt.close(); }
  });

  test('blocks non-http navigation inside a run', async () => {
    const rt = await listen(createRuntimeApp({ ai: null }));
    const evil = structuredClone(signIn);
    evil.actions = [{ ...evil.actions[0], url: 'file:///etc/hostname' } as typeof evil.actions[0]];
    try {
      const r = await fetch(`${rt.url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: 'acme', test: evil }) });
      const body = await r.json() as { execution: Execution };
      expect(body.execution.status).toBe('failed');
      expect(JSON.stringify(body.execution)).toContain('blocked for safety');
    } finally { await rt.close(); }
  });

  test('helpers: session ids are tenant-prefixed and long enough; EMF shape; validation defaults', () => {
    const id = tenantSessionId('acme');
    expect(id.startsWith('acme-')).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(33);
    const out: string[] = [];
    emitUsage({ tenantId: 't1', executionId: 'e', status: 'passed', runSeconds: 2, aiCalls: 1, aiInputTokens: 10, aiOutputTokens: 5 }, (l) => out.push(l));
    expect(JSON.parse(out[0])).toMatchObject({ TenantId: 't1', Runs: 1, AiInputTokens: 10 });
    expect(validateTest({ actions: [signIn.actions[0]] }).viewport).toEqual({ width: 1280, height: 800 });
  });
});

test.describe('AgentCore Browser provider', () => {
  test('replays through a CDP session and stops the AgentCore session afterwards', async () => {
    // Stand-in for an AgentCore browser session: a Chromium exposing CDP on a local port.
    const port = 9300 + Math.floor(Math.random() * 500);
    const remote = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    const calls: string[] = [];
    let seenHeaders: Record<string, string> = {};
    const restore = setAgentCoreClientFactory(() => ({
      startSession: async (p) => { calls.push(`start:${p?.viewport?.width}x${p?.viewport?.height}`); return { sessionId: 'sess-1', sessionName: p?.sessionName ?? '', createdAt: new Date() }; },
      generateWebSocketUrl: async () => {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
        seenHeaders = { Authorization: 'AWS4-HMAC-SHA256 test' };
        return { url: v.webSocketDebuggerUrl, headers: seenHeaders };
      },
      generateLiveViewUrl: async () => 'https://example.invalid/live',
      stopSession: async () => { calls.push('stop'); },
    }));
    const prev = process.env.BROWSER_PROVIDER;
    process.env.BROWSER_PROVIDER = 'agentcore';
    try {
      const ex = await replay(ctx.dataDir, signIn);
      expect(ex.status, JSON.stringify(ex.logs)).toBe('passed');
      expect(ex.logs.some((l) => l.message.includes('AgentCore Browser session sess-1'))).toBe(true);
      expect(calls).toEqual(['start:1280x800', 'stop']);
      expect(seenHeaders.Authorization).toContain('AWS4-HMAC-SHA256');
    } finally {
      process.env.BROWSER_PROVIDER = prev;
      restore();
      await remote.close();
    }
  });

  test('records through an AgentCore session too', async () => {
    const port = 9800 + Math.floor(Math.random() * 150);
    const remote = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    const calls: string[] = [];
    const restore = setAgentCoreClientFactory(() => ({
      startSession: async () => { calls.push('start'); return { sessionId: 'rec-1', sessionName: '', createdAt: new Date() }; },
      generateWebSocketUrl: async () => ({ url: ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl, headers: {} }),
      generateLiveViewUrl: async () => '',
      stopSession: async () => { calls.push('stop'); },
    }));
    const prev = process.env.BROWSER_PROVIDER;
    process.env.BROWSER_PROVIDER = 'agentcore';
    try {
      const s = await record(ctx.dataDir, async (page, s) => {
        await s.navigate(`${ctx.base}/dynamic.html?v=1`);
        await page.getByLabel('Work email').click(); await page.keyboard.type('rec@example.com');
        await page.getByRole('button', { name: 'Sign in' }).click();
      });
      expect(types(s.actions)).toEqual(['navigate', 'fill', 'click']);
      expect(calls).toEqual(['start', 'stop']);
    } finally { process.env.BROWSER_PROVIDER = prev; restore(); await remote.close(); }
  });

  test('a failed connection still stops the session', async () => {
    const calls: string[] = [];
    const restore = setAgentCoreClientFactory(() => ({
      startSession: async () => { calls.push('start'); return { sessionId: 's', sessionName: '', createdAt: new Date() }; },
      generateWebSocketUrl: async () => ({ url: 'ws://127.0.0.1:1/devtools/browser/x', headers: {} }),
      generateLiveViewUrl: async () => '',
      stopSession: async () => { calls.push('stop'); },
    }));
    const prev = process.env.BROWSER_PROVIDER;
    process.env.BROWSER_PROVIDER = 'agentcore';
    try {
      const ex = await replay(ctx.dataDir, signIn);
      expect(ex.status).toBe('failed');
      expect(ex.logs.map((l) => l.message).join('\n')).toContain('Could not connect to AgentCore Browser');
      expect(calls).toEqual(['start', 'stop']);
    } finally { process.env.BROWSER_PROVIDER = prev; restore(); }
  });
});

test.describe('Claude on Amazon Bedrock', () => {
  test('signs requests with SigV4, uses the Bedrock model id and reports usage', async () => {
    let seen: { path?: string; auth?: string; body?: Record<string, unknown> } = {};
    const fake = await listen((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        seen = { path: req.url, auth: String(req.headers.authorization ?? ''), body: JSON.parse(data) };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_BEDROCK_MODEL, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify({ elementIndex: 2, confidence: 0.9, reasoning: 'same button' }) }],
          usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
      });
    });
    const env = { ...process.env };
    Object.assign(process.env, {
      AI_PROVIDER: 'bedrock', AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret',
      ANTHROPIC_BEDROCK_MANTLE_BASE_URL: fake.url,
    });
    delete process.env.AI_MODEL;
    try {
      const usage: AiUsage[] = [];
      const model = new ClaudeModel().withUsageListener((u) => usage.push(u));
      expect(model.name).toBe('anthropic.claude-opus-5-5');
      const r = await model.heal({ step: { type: 'click', description: 'Click Sign in' }, recorded: {}, candidates: [] } as never);
      expect(r).toEqual({ elementIndex: 2, confidence: 0.9, reasoning: 'same button' });
      expect(seen.path).toContain('/v1/messages');
      expect(seen.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d+\/us-west-2\/bedrock-mantle\/aws4_request/);
      expect(seen.body?.model).toBe('anthropic.claude-opus-5-5');
      expect(seen.body?.fallbacks).toBeUndefined();
      expect(usage).toEqual([{ model: 'anthropic.claude-opus-5-5', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0 }]);
    } finally {
      process.env = env;
      await fake.close();
    }
  });
});
