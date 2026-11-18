import type { Action, Execution, ExecutionOptions, TestCase } from '@model/actions';

export interface EditOp { op: string; index: number; to: number; json: string; explanation: string; error?: string }
export interface EditProposal {
  id: string; testId: string; instruction: string; model: string; summary: string; notes: string[];
  operations: EditOp[]; codeBefore: string; codeAfter: string; diff: string;
  after: Pick<TestCase, 'name' | 'actions' | 'variables'>;
}

const token = new URLSearchParams(location.search).get('token') ?? localStorage.getItem('studioToken') ?? undefined;
if (token) localStorage.setItem('studioToken', token);

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

export const api = {
  startSession: (url: string, testId?: string, live?: boolean) => call<{ id: string; viewport: { width: number; height: number }; live: boolean }>('POST', '/api/sessions', { url, testId, live }),
  status: () => call<{ liveBrowser: boolean; ai: { enabled: boolean; model: string | null } }>('GET', '/api/status'),
  navigate: (id: string, url: string) => call('POST', `/api/sessions/${id}/navigate`, { url }),
  history: (id: string, kind: 'goBack' | 'goForward' | 'reload') => call('POST', `/api/sessions/${id}/history`, { kind }),
  mode: (id: string, mode: string) => call('POST', `/api/sessions/${id}/mode`, { mode }),
  tab: (id: string, alias: string) => call('POST', `/api/sessions/${id}/tab`, { alias }),
  setSessionActions: (id: string, actions: Action[]) => call('PUT', `/api/sessions/${id}/actions`, { actions }),
  addSessionAction: (id: string, action: Partial<Action>, index?: number) => call<Action>('POST', `/api/sessions/${id}/actions`, { action, index }),
  select: (id: string, target: unknown, values: string[], pageAlias: string) => call('POST', `/api/sessions/${id}/select`, { target, values, pageAlias }),
  fileChooser: (id: string, chooserId: string, files: { name: string; dataBase64: string }[]) => call('POST', `/api/sessions/${id}/filechooser`, { id: chooserId, files }),
  saveSession: (id: string, name?: string, testId?: string) => call<TestCase>('POST', `/api/sessions/${id}/save`, { name, testId }),
  stopSession: (id: string) => call('POST', `/api/sessions/${id}/stop`),
  tests: () => call<TestCase[]>('GET', '/api/tests'),
  test: (id: string) => call<TestCase>('GET', `/api/tests/${id}`),
  createTest: (t: Partial<TestCase>) => call<TestCase>('POST', '/api/tests', t),
  updateTest: (id: string, t: Partial<TestCase>) => call<TestCase>('PUT', `/api/tests/${id}`, t),
  deleteTest: (id: string) => call('DELETE', `/api/tests/${id}`),
  cloneTest: (id: string) => call<TestCase>('POST', `/api/tests/${id}/clone`),
  codegen: (test: Partial<TestCase>) => call<{ code: string }>('POST', '/api/codegen', { test }),
  run: (id: string, options: ExecutionOptions, liveSessionId?: string) => call<{ executionId: string }>('POST', `/api/tests/${id}/run`, { options, liveSessionId }),
  stopRun: (id: string) => call('POST', `/api/executions/${id}/stop`),
  executions: (testId: string) => call<Execution[]>('GET', `/api/tests/${testId}/executions`),
  aiStatus: () => call<{ enabled: boolean; model: string | null }>('GET', '/api/ai/status'),
  decideHeal: (execId: string, healId: string, accept: boolean) => call<{ test: TestCase; execution: Execution }>('POST', `/api/executions/${execId}/heals/${healId}/${accept ? 'accept' : 'reject'}`),
  acceptAllHeals: (execId: string) => call<{ test: TestCase; execution: Execution }>('POST', `/api/executions/${execId}/heals/accept-all`),
  aiEdit: (testId: string, instruction: string, sessionId?: string) => call<EditProposal>('POST', `/api/tests/${testId}/ai/edit`, { instruction, sessionId }),
  acceptEdit: (id: string) => call<TestCase>('POST', `/api/ai/edits/${id}/accept`),
  rejectEdit: (id: string) => call('POST', `/api/ai/edits/${id}/reject`),
};

export function connectWs(onMessage: (m: any) => void): { send: (m: unknown) => void; close: () => void } {
  let ws: WebSocket;
  let closed = false;
  const queue: string[] = [];
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onopen = () => { while (queue.length) ws.send(queue.shift()!); };
    ws.onclose = () => { if (!closed) setTimeout(open, 1000); };
  };
  open();
  return {
    send: (m) => { const s = JSON.stringify(m); if (ws.readyState === WebSocket.OPEN) ws.send(s); else queue.push(s); },
    close: () => { closed = true; ws.close(); },
  };
}
