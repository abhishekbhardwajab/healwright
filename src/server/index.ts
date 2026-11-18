import express from 'express';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { RecorderSession, type InputEvent, type RecorderMode } from '../recorder/RecorderSession.js';
import { SecretVault } from '../recorder/secrets.js';
import { ReplayEngine } from '../replay/ReplayEngine.js';
import { generatePlaywrightTest } from '../codegen/playwright.js';
import { JsonFileStore } from '../store/Store.js';
import { newId, type Action, type ExecutionOptions, type TestCase } from '../model/actions.js';
import { closeBrowser, liveBrowserAvailable } from '../recorder/browser.js';
import type { AiModel } from '../ai/types.js';
import { AiUnavailableError } from '../ai/types.js';
import { aiFromEnv } from '../ai/claude.js';
import { proposeEdit, applyHealProposal, type EditProposal } from '../ai/edit.js';
import { snapshotFrame } from '../ai/heal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

export interface ServerConfig {
  port: number;
  dataDir: string;
  /** Optional bearer token required on API + WS. */
  token?: string;
  maxSessions?: number;
  maxExecutions?: number;
  executionTimeoutMs?: number;
  /** AI model for healing and prompt editing. undefined = from env (Claude if credentials exist); null = disabled. */
  ai?: AiModel | null;
}

export async function startServer(cfg: ServerConfig) {
  const artifactsDir = path.join(cfg.dataDir, 'artifacts');
  const uploadsDir = path.join(cfg.dataDir, 'uploads');
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  const store = new JsonFileStore(cfg.dataDir);
  const sessions = new Map<string, RecorderSession>();
  const runs = new Map<string, ReplayEngine>();
  const vaults = new Map<string, SecretVault>(); // testId -> in-memory secrets
  const ai = cfg.ai === undefined ? aiFromEnv() : cfg.ai ?? undefined;
  const edits = new Map<string, EditProposal>();

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: object) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
  };

  // --- auth (optional, for shared deployments) -------------------------------
  const authed = (h?: string) => !cfg.token || h === `Bearer ${cfg.token}` || h === cfg.token;
  app.use('/api', (req, res, next) => (authed(req.headers.authorization) ? next() : res.status(401).json({ error: 'unauthorized' })));

  wss.on('connection', (ws, req) => {
    const tok = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? undefined;
    if (!authed(tok)) { ws.close(4401, 'unauthorized'); return; }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      let msg: { t: string; sessionId: string; ev: InputEvent };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === 'input') sessions.get(msg.sessionId)?.input(msg.ev).catch(() => {});
    });
    // late joiners get current state
    for (const s of sessions.values()) {
      ws.send(JSON.stringify({ t: 'session', sessionId: s.id, mode: s.mode, live: s.live }));
      ws.send(JSON.stringify({ t: 'actions', sessionId: s.id, actions: s.actions }));
    }
  });

  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
    async (req: express.Request, res: express.Response) => {
      try { const r = await fn(req, res); if (!res.headersSent) res.json(r ?? { ok: true }); }
      catch (e) { res.status(e instanceof AiUnavailableError ? 503 : 400).json({ error: (e as Error).message }); }
    };
  const session = (id: string) => { const s = sessions.get(id); if (!s) throw new Error('No such recording session'); return s; };
  const test = (id: string) => { const t = store.getTest(id); if (!t) throw new Error('No such test'); return t; };

  // --- recording sessions -------------------------------------------------------
  app.post('/api/sessions', wrap(async (req) => {
    if (sessions.size >= (cfg.maxSessions ?? 3)) throw new Error('Too many active recording sessions');
    const { url, testId, viewport, live } = req.body as { url?: string; testId?: string; viewport?: { width: number; height: number }; live?: boolean };
    if (live && !liveBrowserAvailable()) throw new Error('Live browser needs a display. Run the studio on your desktop, or start it with "xvfb-run npm start" on a server.');
    const s = new RecorderSession({ artifactsDir, uploadsDir: path.join(uploadsDir, 'tmp'), viewport, live: !!live });
    sessions.set(s.id, s);
    if (testId) { const t = test(testId); s.testId = t.id; s.actions = JSON.parse(JSON.stringify(t.actions)); const v = vaults.get(testId); if (v) s.vault.mergeFrom(v); }
    s.on('frame', (f) => broadcast({ t: 'frame', sessionId: s.id, ...f }));
    s.on('actions', (actions) => broadcast({ t: 'actions', sessionId: s.id, actions }));
    s.on('url', (u) => broadcast({ t: 'url', sessionId: s.id, url: u }));
    s.on('tabs', (tabs) => broadcast({ t: 'tabs', sessionId: s.id, ...tabs }));
    s.on('pick', (p) => broadcast({ t: 'pick', sessionId: s.id, ...p }));
    s.on('fileChooser', (p) => broadcast({ t: 'fileChooser', sessionId: s.id, ...p }));
    s.on('selectOpen', (p) => broadcast({ t: 'selectOpen', sessionId: s.id, ...p }));
    s.on('log', (l) => broadcast({ t: 'log', sessionId: s.id, ...l }));
    s.on('mode', (m) => broadcast({ t: 'mode', sessionId: s.id, mode: m }));
    s.on('windowClosed', () => broadcast({ t: 'windowClosed', sessionId: s.id }));
    s.on('closed', () => { sessions.delete(s.id); broadcast({ t: 'sessionClosed', sessionId: s.id }); });
    try {
      await s.start();
    } catch (e) {
      await s.stop();
      throw e;
    }
    await s.startScreencast();
    if (url) await s.navigate(url);
    return { id: s.id, viewport: s.viewport, live: s.live };
  }));
  app.post('/api/sessions/:id/navigate', wrap((req) => session(req.params.id).navigate(String(req.body.url))));
  app.post('/api/sessions/:id/history', wrap((req) => session(req.params.id).history(req.body.kind)));
  app.post('/api/sessions/:id/mode', wrap((req) => session(req.params.id).setMode(req.body.mode as RecorderMode)));
  app.post('/api/sessions/:id/tab', wrap((req) => session(req.params.id).switchTab(String(req.body.alias))));
  app.put('/api/sessions/:id/actions', wrap((req) => { const s = session(req.params.id); s.actions = req.body.actions as Action[]; s.emit('actions', s.actions); }));
  app.post('/api/sessions/:id/actions', wrap((req) => { const s = session(req.params.id); const a = req.body.action as Action; a.id ||= newId('step'); s.addAction(a, req.body.index); return a; }));
  app.post('/api/sessions/:id/select', wrap((req) => session(req.params.id).chooseOption(req.body.target, req.body.values, req.body.pageAlias)));
  app.post('/api/sessions/:id/filechooser', wrap(async (req) => {
    const s = session(req.params.id);
    const dir = path.join(uploadsDir, s.id);
    mkdirSync(dir, { recursive: true });
    const files = (req.body.files as { name: string; dataBase64: string }[]).map((f) => {
      const name = path.basename(f.name).replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'upload.bin';
      const p = path.join(dir, name);
      writeFileSync(p, Buffer.from(f.dataBase64, 'base64'));
      return { name, path: p };
    });
    await s.resolveFileChooser(String(req.body.id), files);
  }));
  app.post('/api/sessions/:id/save', wrap((req) => {
    const s = session(req.params.id);
    const { name, testId } = req.body as { name?: string; testId?: string };
    const existing = testId ? store.getTest(testId) : undefined;
    const now = Date.now();
    const t: TestCase = existing
      ? { ...existing, actions: s.actions, name: name ?? existing.name }
      : { id: newId('test'), name: name || 'Recorded flow', projectId: 'default', createdAt: now, updatedAt: now, viewport: s.viewport, variables: {}, actions: s.actions, startUrl: s.actions.find((a) => a.type === 'navigate')?.metadata.url };
    store.saveTest(t);
    s.testId = t.id;
    const v = vaults.get(t.id) ?? new SecretVault();
    v.mergeFrom(s.vault);
    vaults.set(t.id, v);
    return t;
  }));
  app.post('/api/sessions/:id/stop', wrap(async (req) => { await session(req.params.id).stop(); }));

  // --- tests --------------------------------------------------------------------------
  app.get('/api/tests', wrap(() => store.listTests()));
  app.get('/api/tests/:id', wrap((req) => test(req.params.id)));
  app.post('/api/tests', wrap((req) => {
    // create or import (accepts an exported JSON test)
    const body = req.body as Partial<TestCase>;
    if (!Array.isArray(body.actions ?? [])) throw new Error('actions must be an array');
    const now = Date.now();
    return store.saveTest({
      id: newId('test'), name: body.name ?? 'Imported test', projectId: body.projectId ?? 'default', createdAt: now, updatedAt: now,
      viewport: body.viewport ?? { width: 1280, height: 800 }, variables: body.variables ?? {}, actions: body.actions ?? [], startUrl: body.startUrl,
    });
  }));
  app.put('/api/tests/:id', wrap((req) => {
    const t = test(req.params.id);
    const body = req.body as Partial<TestCase>;
    return store.saveTest({ ...t, ...body, id: t.id, createdAt: t.createdAt });
  }));
  app.delete('/api/tests/:id', wrap((req) => ({ deleted: store.deleteTest(req.params.id) })));
  app.post('/api/tests/:id/clone', wrap((req) => {
    const c = store.cloneTest(req.params.id);
    const v = vaults.get(req.params.id);
    if (c && v) vaults.set(c.id, v);
    return c;
  }));
  app.get('/api/tests/:id/export', (req, res) => {
    const t = store.getTest(req.params.id);
    if (!t) return res.status(404).end();
    const slug = t.name.replace(/[^\w]+/g, '-').toLowerCase();
    if (req.query.format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${slug}.json"`);
      return res.json(t);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.spec.ts"`);
    res.type('text/plain').send(generatePlaywrightTest(t));
  });
  app.post('/api/codegen', wrap((req) => ({ code: generatePlaywrightTest(req.body.test, req.body.options) })));

  // --- executions ---------------------------------------------------------------------
  app.post('/api/tests/:id/run', wrap(async (req) => {
    if (runs.size >= (cfg.maxExecutions ?? 2)) throw new Error('Execution capacity reached; try again shortly');
    if ((req.body as { options?: ExecutionOptions }).options?.headless === false && !liveBrowserAvailable()) {
      throw new Error('Live browser needs a display. Run the studio on your desktop, or start it with "xvfb-run npm start" on a server.');
    }
    const t = test(req.params.id);
    const { options = {}, liveSessionId } = req.body as { options?: ExecutionOptions; liveSessionId?: string };
    const live = liveSessionId ? session(liveSessionId) : undefined;
    const vault = new SecretVault();
    const tv = vaults.get(t.id); if (tv) vault.mergeFrom(tv);
    if (live) vault.mergeFrom(live.vault);
    const engine = new ReplayEngine(t, options, { artifactsDir, vault, livePages: live?.pages, ai });
    runs.set(engine.execution.id, engine);
    engine.on('update', (e) => broadcast({ t: 'execution', execution: e }));
    const prevMode = live?.mode;
    if (live) await live.setMode('off'); // never record our own replay
    const timeout = setTimeout(() => engine.stop(), cfg.executionTimeoutMs ?? 5 * 60_000);
    void engine.run().then((e) => {
      clearTimeout(timeout);
      runs.delete(e.id);
      if (ai && options.aiHealing === 'auto' && e.healProposals?.length) {
        let cur = store.getTest(t.id);
        for (const p of e.healProposals) {
          try { if (cur) { cur = applyHealProposal(cur, p); p.status = 'accepted'; } } catch { /* step removed meanwhile */ }
        }
        if (cur) { store.saveTest(cur); broadcast({ t: 'testUpdated', test: cur }); }
      }
      store.saveExecution(e);
      broadcast({ t: 'execution', execution: e });
      if (live && prevMode) void live.setMode(prevMode === 'off' ? 'record' : prevMode);
    });
    return { executionId: engine.execution.id };
  }));
  // --- AI: healing review -----------------------------------------------------------
  const execution = (id: string) => { const e = runs.get(id)?.execution ?? store.getExecution(id); if (!e) throw new Error('No such execution'); return e; };
  const decideHeal = (execId: string, healId: string, accept: boolean) => {
    const e = execution(execId);
    const p = e.healProposals?.find((x) => x.id === healId);
    if (!p) throw new Error('No such heal proposal');
    if (p.status !== 'pending') throw new Error(`Proposal already ${p.status}`);
    let t = test(e.testId);
    if (accept) { t = store.saveTest(applyHealProposal(t, p)); broadcast({ t: 'testUpdated', test: t }); }
    p.status = accept ? 'accepted' : 'rejected';
    store.saveExecution(e);
    broadcast({ t: 'execution', execution: e });
    return { test: t, execution: e };
  };
  app.post('/api/executions/:id/heals/:healId/accept', wrap((req) => decideHeal(req.params.id, req.params.healId, true)));
  app.post('/api/executions/:id/heals/:healId/reject', wrap((req) => decideHeal(req.params.id, req.params.healId, false)));
  app.post('/api/executions/:id/heals/accept-all', wrap((req) => {
    const e = execution(req.params.id);
    let out = { test: test(e.testId), execution: e };
    for (const p of e.healProposals ?? []) if (p.status === 'pending') out = decideHeal(e.id, p.id, true);
    return out;
  }));

  // --- AI: prompt-driven editing ---------------------------------------------------------
  app.get('/api/status', wrap(() => ({ liveBrowser: liveBrowserAvailable(), ai: { enabled: !!ai, model: ai?.name ?? null } })));
  app.get('/api/ai/status', wrap(() => ({ enabled: !!ai, model: ai?.name ?? null })));
  app.post('/api/tests/:id/ai/edit', wrap(async (req) => {
    if (!ai) throw new AiUnavailableError('AI is not configured. Set ANTHROPIC_API_KEY and restart the studio.');
    const t = test(req.params.id);
    const instruction = String(req.body.instruction ?? '').trim();
    if (!instruction) throw new Error('Describe the change you want');
    if (instruction.length > 4000) throw new Error('Instruction too long (max 4000 characters)');
    // With a live recording session, let the model see what is on the page.
    const live = req.body.sessionId ? sessions.get(String(req.body.sessionId)) : undefined;
    const pageElements = live?.page ? await snapshotFrame(live.page.mainFrame(), `e${Date.now().toString(36)}`).catch(() => undefined) : undefined;
    const p = await proposeEdit(ai, t, instruction, pageElements);
    edits.set(p.id, p);
    return p;
  }));
  app.post('/api/ai/edits/:id/accept', wrap((req) => {
    const p = edits.get(req.params.id);
    if (!p) throw new Error('This proposal expired; ask again');
    const t = test(p.testId);
    if (t.updatedAt !== p.baseUpdatedAt) throw new Error('The test changed after this proposal was made; ask again');
    if (p.operations.some((o) => o.error)) throw new Error('Some operations were invalid; ask again or edit manually');
    edits.delete(p.id);
    const saved = store.saveTest({ ...t, ...p.after });
    for (const s of sessions.values()) if (s.testId === saved.id) { s.actions = structuredClone(saved.actions); s.emit('actions', s.actions); }
    broadcast({ t: 'testUpdated', test: saved });
    return saved;
  }));
  app.post('/api/ai/edits/:id/reject', wrap((req) => { edits.delete(req.params.id); }));

  app.post('/api/executions/:id/stop', wrap((req) => { runs.get(req.params.id)?.stop(); }));
  app.get('/api/executions/:id', wrap((req) => runs.get(req.params.id)?.execution ?? store.getExecution(req.params.id)));
  app.get('/api/tests/:id/executions', wrap((req) => store.listExecutions(req.params.id)));

  // --- static -------------------------------------------------------------------------
  app.use('/artifacts', express.static(artifactsDir, { fallthrough: false }));
  app.use('/fixtures', express.static(path.join(ROOT, 'fixtures/site')));
  const web = path.join(ROOT, 'web/dist');
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get('*', (_req, res) => res.sendFile(path.join(web, 'index.html')));
  }

  await new Promise<void>((r) => server.listen(cfg.port, r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    store,
    sessions,
    async close() {
      for (const s of sessions.values()) await s.stop();
      for (const r of runs.values()) r.stop();
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  startServer({ port, dataDir: process.env.DATA_DIR ?? path.join(ROOT, 'data'), token: process.env.STUDIO_TOKEN }).then((s) => {
    console.log(`healwright studio on http://localhost:${s.port}`);
    console.log(`Demo site: http://localhost:${s.port}/fixtures/index.html`);
  });
  const shutdown = async () => { await closeBrowser(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
