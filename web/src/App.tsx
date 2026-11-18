import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, Assertion, ElementTarget, Execution, ExecutionOptions, HealProposal, TestCase } from '@model/actions';
import { api, connectWs, type EditProposal } from './api';
import { BrowserView } from './BrowserView';
import { AiPanel, AssertionFields, Btn, CodePanel, Field, Modal, ResultsPanel, StepEditor, StepsPanel } from './panels';

type Draft = Pick<TestCase, 'name' | 'actions' | 'variables'> & { id?: string };
const EMPTY: Draft = { name: 'Untitled test', actions: [], variables: {} };
const newStepId = () => `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function App() {
  const [tests, setTests] = useState<TestCase[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const [mode, setMode] = useState('off');
  // Live browser mode: record in a real, visible browser window instead of the streamed view.
  const [liveAvailable, setLiveAvailable] = useState(false);
  const [liveWanted, setLiveWanted] = useState(() => localStorage.getItem('liveBrowser') === '1');
  const [sessionLive, setSessionLive] = useState(false);
  const [windowClosed, setWindowClosed] = useState(false);
  const [url, setUrl] = useState(`${location.origin}/fixtures/login.html`);
  const [tabs, setTabs] = useState<{ alias: string; url: string }[]>([]);
  const [activeTab, setActiveTab] = useState('page');
  const [panel, setPanel] = useState<'steps' | 'code' | 'results' | 'ai'>('steps');
  const [aiStatus, setAiStatus] = useState<{ enabled: boolean; model: string | null }>({ enabled: false, model: null });
  const [aiBusy, setAiBusy] = useState(false);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [code, setCode] = useState('');
  const [executions, setExecutions] = useState<Record<string, Execution>>({});
  const [currentExec, setCurrentExec] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [pick, setPick] = useState<{ target: ElementTarget; snapshot: any; pageAlias: string; url: string; insertAt?: number } | null>(null);
  const [pageAssert, setPageAssert] = useState(false);
  const [selectOpen, setSelectOpen] = useState<{ target: ElementTarget; options: { value: string; label: string; selected: boolean; disabled: boolean }[]; multiple: boolean; pageAlias: string } | null>(null);
  const [chooser, setChooser] = useState<{ id: string; multiple: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runOpts, setRunOpts] = useState<ExecutionOptions>({ stepTimeoutMs: 10000, stepRetries: 1, continueOnFailure: false, screenshots: 'every-step' });
  const [log, setLog] = useState<string[]>([]);
  const frameSink = useRef<(d: string) => void>(() => {});
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = sessionId;

  const ws = useMemo(() => connectWs((m) => {
    const sid = sessionRef.current;
    if (m.t === 'frame' && m.sessionId === sid) frameSink.current(m.data);
    else if (m.t === 'actions' && m.sessionId === sid) setDraft((d) => ({ ...d, actions: m.actions }));
    else if (m.t === 'url' && m.sessionId === sid) setUrl(m.url);
    else if (m.t === 'tabs' && m.sessionId === sid) { setTabs(m.tabs); setActiveTab(m.active); if (m.tabs.length) setWindowClosed(false); }
    else if (m.t === 'mode' && m.sessionId === sid) setMode(m.mode);
    else if (m.t === 'pick' && m.sessionId === sid) setPick({ target: m.target, snapshot: m.snapshot, pageAlias: m.pageAlias, url: m.url });
    else if (m.t === 'selectOpen' && m.sessionId === sid) setSelectOpen(m);
    else if (m.t === 'fileChooser' && m.sessionId === sid) setChooser({ id: m.id, multiple: m.multiple });
    else if (m.t === 'log' && m.sessionId === sid) setLog((l) => [...l.slice(-200), `${m.level}: ${m.message}`]);
    else if (m.t === 'sessionClosed' && m.sessionId === sid) { setSessionId(null); setMode('off'); setSessionLive(false); }
    else if (m.t === 'windowClosed' && m.sessionId === sid) setWindowClosed(true);
    else if (m.t === 'testUpdated') setDraft((d) => (d.id === m.test.id && !sessionRef.current ? { ...m.test } : d));
    else if (m.t === 'execution') setExecutions((e) => ({ ...e, [m.execution.id]: m.execution }));
  }), []);
  useEffect(() => () => ws.close(), [ws]);

  const refreshTests = useCallback(() => api.tests().then(setTests).catch((e) => setError(e.message)), []);
  useEffect(() => {
    void refreshTests();
    api.status().then((s) => { setAiStatus(s.ai); setLiveAvailable(s.liveBrowser); }).catch(() => api.aiStatus().then(setAiStatus).catch(() => {}));
  }, [refreshTests]);
  useEffect(() => { localStorage.setItem('liveBrowser', liveWanted ? '1' : '0'); }, [liveWanted]);

  // live code generation from the action model
  useEffect(() => {
    const h = setTimeout(() => api.codegen(draft).then((r) => setCode(r.code)).catch(() => {}), 150);
    return () => clearTimeout(h);
  }, [draft]);

  const guard = (fn: () => Promise<unknown>) => () => { setError(null); fn().catch((e) => setError(e.message)); };

  // ----- persistence of edits -----
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const updateActions = (actions: Action[]) => {
    setDraft((d) => ({ ...d, actions }));
    if (sessionId) void api.setSessionActions(sessionId, actions);
    if (draft.id && !sessionId) {
      clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => void api.updateTest(draft.id!, { actions }).then(refreshTests), 300);
    }
  };
  const saveDraft = async (): Promise<string> => {
    if (sessionId) { const t = await api.saveSession(sessionId, draft.name, draft.id); setDraft({ ...t }); await refreshTests(); return t.id; }
    if (draft.id) { await api.updateTest(draft.id, { name: draft.name, actions: draft.actions, variables: draft.variables }); await refreshTests(); return draft.id; }
    const t = await api.createTest({ name: draft.name, actions: draft.actions, variables: draft.variables });
    setDraft({ ...t }); await refreshTests(); return t.id;
  };

  // ----- recording controls -----
  const startRecording = guard(async () => {
    const s = await api.startSession(url, draft.id, liveWanted && liveAvailable);
    setViewport(s.viewport); setSessionId(s.id); setSessionLive(s.live); setWindowClosed(false); setMode('record'); setPanel('steps');
  });
  const stopRecording = guard(async () => {
    if (!sessionId) return;
    const t = await api.saveSession(sessionId, draft.name, draft.id);
    await api.stopSession(sessionId);
    setDraft({ ...t }); setSessionId(null); setSessionLive(false); setMode('off'); await refreshTests();
  });
  const setRecMode = (m: string) => guard(async () => { if (sessionId) await api.mode(sessionId, m); })();

  const addAssertion = async (assertion: Assertion, target?: ElementTarget, insertAt?: number, pageAlias = activeTab) => {
    const a = { id: newStepId(), type: 'assert', assertion, target, timestamp: Date.now(), pageAlias, metadata: { url } } as Action;
    if (sessionId) {
      if (insertAt !== undefined) { const n = [...draft.actions]; n.splice(insertAt, 0, a); updateActions(n); }
      else await api.addSessionAction(sessionId, a);
      await api.mode(sessionId, 'record');
    } else {
      const n = [...draft.actions]; n.splice(insertAt ?? n.length, 0, a); updateActions(n);
    }
  };

  // ----- execution -----
  const run = (extra: ExecutionOptions = {}) => guard(async () => {
    const id = await saveDraft();
    const live = sessionId && (extra.onlyStep !== undefined) ? sessionId : undefined;
    const { executionId } = await api.run(id, { ...runOpts, ...extra }, live);
    setCurrentExec(executionId);
    if (extra.onlyStep === undefined) setPanel('results');
  })();
  const exec = currentExec ? executions[currentExec] : undefined;

  // ----- AI -----
  const decideHeal = (p: HealProposal, accept: boolean) => guard(async () => {
    if (!exec) return;
    const r = await api.decideHeal(exec.id, p.id, accept);
    setExecutions((e) => ({ ...e, [r.execution.id]: r.execution }));
    if (accept && !sessionId) setDraft({ ...r.test });
    await refreshTests();
  })();
  const acceptAllHeals = guard(async () => {
    if (!exec) return;
    const r = await api.acceptAllHeals(exec.id);
    setExecutions((e) => ({ ...e, [r.execution.id]: r.execution }));
    if (!sessionId) setDraft({ ...r.test });
    await refreshTests();
  });
  const askAi = (instruction: string) => guard(async () => {
    setAiBusy(true); setProposal(null);
    try {
      const id = await saveDraft();
      setProposal(await api.aiEdit(id, instruction, sessionId ?? undefined));
    } finally { setAiBusy(false); }
  })();
  const acceptAi = guard(async () => {
    if (!proposal) return;
    const t = await api.acceptEdit(proposal.id);
    setDraft({ ...t }); setProposal(null); await refreshTests();
  });
  const rejectAi = guard(async () => { if (proposal) await api.rejectEdit(proposal.id); setProposal(null); });

  const loadTest = (id: string) => guard(async () => {
    if (sessionId) throw new Error('Stop the current recording first');
    if (!id) { setDraft(EMPTY); return; }
    const t = await api.test(id);
    setDraft(t); setCurrentExec(null); setProposal(null);
    const ex = await api.executions(id);
    if (ex[0]) { setExecutions((e) => ({ ...e, [ex[0].id]: ex[0] })); setCurrentExec(ex[0].id); }
    const firstNav = t.actions.find((a) => a.type === 'navigate') as Extract<Action, { type: 'navigate' }> | undefined;
    if (firstNav) setUrl(firstNav.url);
  })();

  const importJson = (file: File) => guard(async () => {
    const t = await api.createTest(JSON.parse(await file.text()));
    await refreshTests(); setDraft(t);
  })();

  const recording = !!sessionId;
  return (
    <div className="h-full flex flex-col text-slate-800">
      {/* header */}
      <header className="flex items-center gap-3 px-4 py-2 bg-white border-b border-slate-200">
        <span className="font-semibold text-indigo-700 whitespace-nowrap">● healwright</span>
        <select data-testid="test-select" className="inp w-56" value={draft.id ?? ''} onChange={(e) => loadTest(e.target.value)}>
          <option value="">+ New test</option>
          {tests.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input data-testid="test-name" className="inp w-56" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Test name" />
        <Btn onClick={guard(async () => { await saveDraft(); })}>Save</Btn>
        <Btn disabled={!draft.id} onClick={guard(async () => { const c = await api.cloneTest(draft.id!); await refreshTests(); setDraft(c); })}>Clone</Btn>
        <Btn disabled={!draft.id || recording} onClick={guard(async () => { await api.deleteTest(draft.id!); setDraft(EMPTY); await refreshTests(); })}>Delete</Btn>
        <Btn disabled={!draft.id} onClick={() => window.open(`/api/tests/${draft.id}/export?format=json`)}>Export JSON</Btn>
        <label className="text-xs px-2 py-1 rounded border border-slate-300 bg-white cursor-pointer hover:bg-slate-100">Import<input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} /></label>
        <div className="flex-1" />
        {error && <span className="text-xs text-red-700 max-w-md truncate" title={error}>⚠ {error}</span>}
      </header>

      <div className="flex-1 min-h-0 flex gap-3 p-3">
        {/* browser preview */}
        <section className="flex-[3] min-w-0 flex flex-col gap-2 bg-white rounded-lg border border-slate-200 p-2">
          <div className="flex items-center gap-1">
            <Btn disabled={!recording} onClick={() => sessionId && api.history(sessionId, 'goBack')} title="Back">◀</Btn>
            <Btn disabled={!recording} onClick={() => sessionId && api.history(sessionId, 'goForward')} title="Forward">▶</Btn>
            <Btn disabled={!recording} onClick={() => sessionId && api.history(sessionId, 'reload')} title="Reload">⟳</Btn>
            <form className="flex-1 flex" onSubmit={(e) => { e.preventDefault(); if (sessionId) void api.navigate(sessionId, url); else startRecording(); }}>
              <input data-testid="url" className="inp font-mono" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="URL" />
            </form>
            {!recording && (
              <label className={`flex items-center gap-1 text-xs whitespace-nowrap px-1 ${liveAvailable ? '' : 'text-slate-400'}`}
                title={liveAvailable ? 'Record in a real browser window on this computer. Use it like a normal browser: address bar, tabs and back/forward are recorded too.' : 'Needs a display: run the studio on your desktop, or with xvfb-run on a server.'}>
                <input data-testid="live-toggle" type="checkbox" disabled={!liveAvailable} checked={liveWanted && liveAvailable} onChange={(e) => setLiveWanted(e.target.checked)} /> Live window
              </label>
            )}
            {!recording && <Btn data-testid="record" variant="danger" onClick={startRecording}>● Record</Btn>}
            {recording && mode === 'record' && <Btn onClick={() => setRecMode('paused')}>❚❚ Pause</Btn>}
            {recording && mode === 'paused' && <Btn onClick={() => setRecMode('record')}>● Resume</Btn>}
            {recording && <Btn data-testid="assert-mode" onClick={() => setRecMode(mode === 'assert' ? 'record' : 'assert')}>{mode === 'assert' ? 'Cancel pick' : '✔ Add assertion'}</Btn>}
            {recording && <Btn data-testid="stop" variant="primary" onClick={stopRecording}>■ Stop</Btn>}
          </div>
          {tabs.length > 1 && (
            <div className="flex gap-1">
              {tabs.map((t) => (
                <button key={t.alias} onClick={() => sessionId && api.tab(sessionId, t.alias)} className={`text-xs px-2 py-1 rounded-t border ${t.alias === activeTab ? 'bg-indigo-50 border-indigo-300' : 'bg-white border-slate-200'}`}>{t.alias}: {t.url.slice(-30)}</button>
              ))}
            </div>
          )}
          <BrowserView sessionId={sessionId} viewport={viewport} send={ws.send} mode={mode} live={sessionLive} windowClosed={windowClosed} registerFrameSink={useCallback((fn) => { frameSink.current = fn; }, [])} />
          <div className="text-[11px] text-slate-500 flex gap-3">
            <span>Status: <b data-testid="rec-status">{recording ? (mode === 'record' ? 'Recording' : mode === 'paused' ? 'Paused' : mode === 'assert' ? 'Picking element' : mode) : 'Idle'}</b>{recording && sessionLive ? ' in live window' : ''}</span>
            {log.length > 0 && <span className="truncate">{log[log.length - 1]}</span>}
          </div>
        </section>

        {/* side panel */}
        <section className="flex-[2] min-w-[380px] flex flex-col bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="flex items-center border-b border-slate-200">
            {(['steps', 'code', 'results', 'ai'] as const).map((p) => (
              <button key={p} data-testid={`tab-${p}`} onClick={() => setPanel(p)} className={`px-4 py-2 text-sm capitalize ${panel === p ? 'border-b-2 border-indigo-600 font-medium' : 'text-slate-500'}`}>
                {p === 'ai' ? '✨ AI' : p}{p === 'steps' ? ` (${draft.actions.length})` : ''}
              </button>
            ))}
            <div className="flex-1" />
            <Btn data-testid="run" variant="primary" className="mr-2" disabled={!draft.actions.length || exec?.status === 'running'} onClick={() => run()}>▶ Run test</Btn>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {panel === 'steps' && (
              <>
                <StepsPanel
                  actions={draft.actions}
                  results={exec?.testId === draft.id ? exec?.steps : undefined}
                  onChange={updateActions}
                  onEdit={setEditing}
                  canReplay={draft.actions.length > 0}
                  onReplay={(o) => run(o)}
                  onAssertOn={(i) => { const a = draft.actions[i]; setPick({ target: a.target!, snapshot: {}, pageAlias: a.pageAlias, url: a.metadata.url, insertAt: i + 1 }); }}
                />
                <div className="p-3 border-t border-slate-100 flex flex-wrap gap-2">
                  <Btn onClick={() => setPageAssert(true)}>+ Assert URL / title</Btn>
                  <Btn onClick={() => updateActions([...draft.actions, { id: newStepId(), type: 'wait', wait: 'loadState', loadState: 'networkidle', timestamp: Date.now(), pageAlias: activeTab, metadata: { url } } as Action])}>+ Wait for network idle</Btn>
                  <Btn onClick={() => updateActions([...draft.actions, { id: newStepId(), type: 'navigate', url, timestamp: Date.now(), pageAlias: 'page', metadata: { url } } as Action])}>+ Navigate</Btn>
                </div>
                <VariablesEditor value={draft.variables} onChange={(variables) => { setDraft({ ...draft, variables }); if (draft.id) void api.updateTest(draft.id, { variables }); }} />
                <RunOptions value={runOpts} onChange={setRunOpts} liveAvailable={liveAvailable} />
              </>
            )}
            {panel === 'code' && <CodePanel code={code} fileName={`${draft.name.replace(/\W+/g, '-').toLowerCase()}.spec.ts`} />}
            {panel === 'results' && <ResultsPanel execution={exec} actions={draft.actions} onStop={() => currentExec && api.stopRun(currentExec)} onHeal={decideHeal} onAcceptAll={acceptAllHeals} />}
            {panel === 'ai' && <AiPanel enabled={aiStatus.enabled} model={aiStatus.model} busy={aiBusy} proposal={proposal} onAsk={askAi} onAccept={acceptAi} onReject={rejectAi} />}
          </div>
        </section>
      </div>

      {editing !== null && draft.actions[editing] && (
        <StepEditor action={draft.actions[editing]} onClose={() => setEditing(null)} onSave={(a) => { updateActions(draft.actions.map((x, i) => (i === editing ? a : x))); setEditing(null); }} />
      )}
      {pick && <PickAssertion pick={pick} onClose={() => { setPick(null); if (sessionId) void api.mode(sessionId, 'record'); }} onAdd={(as) => { void addAssertion(as, pick.target, pick.insertAt, pick.pageAlias); setPick(null); }} />}
      {pageAssert && <PageAssertion url={url} onClose={() => setPageAssert(false)} onAdd={(as) => { void addAssertion(as); setPageAssert(false); }} />}
      {selectOpen && sessionId && (
        <Modal title={`Choose an option: ${selectOpen.target.accessibleName ?? 'dropdown'}`} onClose={() => setSelectOpen(null)}>
          <SelectOptions sel={selectOpen} onPick={(values) => { void api.select(sessionId, selectOpen.target, values, selectOpen.pageAlias).catch((e) => setError(e.message)); setSelectOpen(null); }} />
        </Modal>
      )}
      {chooser && sessionId && <FileChooserDialog onCancel={() => setChooser(null)} multiple={chooser.multiple} onFiles={async (files) => {
        const payload = await Promise.all(files.map(async (f) => ({ name: f.name, dataBase64: await toBase64(f) })));
        await api.fileChooser(sessionId, chooser.id, payload).catch((e) => setError(e.message));
        setChooser(null);
      }} />}
    </div>
  );
}

function SelectOptions({ sel, onPick }: { sel: { options: { value: string; label: string; selected: boolean; disabled: boolean }[]; multiple: boolean }; onPick: (values: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>(sel.options.filter((o) => o.selected).map((o) => o.value));
  if (!sel.multiple) {
    return (
      <ul className="divide-y border rounded" data-testid="select-options">
        {sel.options.map((o) => (
          <li key={o.value}><button disabled={o.disabled} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 ${o.selected ? 'font-semibold' : ''}`} onClick={() => onPick([o.value])}>{o.label || '(empty)'}</button></li>
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-2">
      {sel.options.map((o) => (
        <label key={o.value} className="flex gap-2 text-sm"><input type="checkbox" checked={chosen.includes(o.value)} onChange={(e) => setChosen(e.target.checked ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))} />{o.label}</label>
      ))}
      <Btn variant="primary" onClick={() => onPick(chosen)}>Apply</Btn>
    </div>
  );
}

function PickAssertion({ pick, onAdd, onClose }: { pick: { target: ElementTarget; snapshot: any }; onAdd: (a: Assertion) => void; onClose: () => void }) {
  const s = pick.snapshot ?? {};
  const initial: Assertion = s.value !== undefined && s.value !== '' ? { kind: 'value', expected: s.value } : s.text ? { kind: 'containsText', expected: s.text.slice(0, 80) } : { kind: 'visible' };
  const [as, setAs] = useState<Assertion>(initial);
  return (
    <Modal title={`Add assertion on ${pick.target.role ?? pick.target.tagName.toLowerCase()} "${pick.target.accessibleName ?? pick.target.text ?? ''}"`} onClose={onClose}>
      <AssertionFields value={as} hasTarget onChange={setAs} />
      <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn data-testid="assert-add" variant="primary" onClick={() => onAdd(as)}>Add assertion</Btn></div>
    </Modal>
  );
}

function PageAssertion({ url, onAdd, onClose }: { url: string; onAdd: (a: Assertion) => void; onClose: () => void }) {
  const [as, setAs] = useState<Assertion>({ kind: 'url', expected: url });
  return (
    <Modal title="Add page assertion" onClose={onClose}>
      <AssertionFields value={as} hasTarget={false} onChange={setAs} />
      <div className="flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={() => onAdd(as)}>Add assertion</Btn></div>
    </Modal>
  );
}

function FileChooserDialog({ onFiles, onCancel, multiple }: { onFiles: (f: File[]) => void; onCancel: () => void; multiple: boolean }) {
  return (
    <Modal title="The page asked for a file" onClose={onCancel}>
      <p className="text-sm text-slate-600">Choose the file(s) to upload into the remote browser. They are stored in the session's sandboxed upload folder and reused on replay.</p>
      <input type="file" multiple={multiple} onChange={(e) => e.target.files && onFiles([...e.target.files])} />
      <div className="flex justify-end"><Btn onClick={onCancel}>Cancel</Btn></div>
    </Modal>
  );
}

function VariablesEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [text, setText] = useState(Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n'));
  useEffect(() => { setText(Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n')); }, [JSON.stringify(value)]);
  return (
    <details className="px-3 py-2 border-t border-slate-100">
      <summary className="text-xs text-slate-600 cursor-pointer">Test data variables ({Object.keys(value).length})</summary>
      <p className="text-[11px] text-slate-500 my-1">One <code>name=value</code> per line. Use <code>{'${name}'}</code> inside typed values. Exported code reads <code>process.env.NAME</code> first.</p>
      <textarea className="inp font-mono text-xs h-20" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(Object.fromEntries(text.split('\n').map((l) => l.split('=')).filter((p) => p[0]?.trim()).map(([k, ...v]) => [k.trim(), v.join('=')])))} />
    </details>
  );
}

function RunOptions({ value, onChange, liveAvailable }: { value: ExecutionOptions; onChange: (v: ExecutionOptions) => void; liveAvailable: boolean }) {
  return (
    <details className="px-3 py-2 border-t border-slate-100">
      <summary className="text-xs text-slate-600 cursor-pointer">Run settings</summary>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <Field label="Step timeout (ms)"><input className="inp" type="number" value={value.stepTimeoutMs} onChange={(e) => onChange({ ...value, stepTimeoutMs: Number(e.target.value) })} /></Field>
        <Field label="Retries per step"><input className="inp" type="number" min={0} max={5} value={value.stepRetries} onChange={(e) => onChange({ ...value, stepRetries: Number(e.target.value) })} /></Field>
        <Field label="Screenshots"><select className="inp" value={value.screenshots} onChange={(e) => onChange({ ...value, screenshots: e.target.value as ExecutionOptions['screenshots'] })}><option>every-step</option><option>on-failure</option><option>off</option></select></Field>
        <Field label="Sync after navigation"><select className="inp" value={value.settle ?? 'domcontentloaded'} onChange={(e) => onChange({ ...value, settle: e.target.value as ExecutionOptions['settle'] })}><option>none</option><option>domcontentloaded</option><option>load</option><option>networkidle</option></select></Field>
        <Field label="AI self-healing"><select data-testid="ai-healing" className="inp" value={value.aiHealing ?? 'suggest'} onChange={(e) => onChange({ ...value, aiHealing: e.target.value as ExecutionOptions['aiHealing'] })}><option value="suggest">suggest fixes for review</option><option value="auto">apply fixes automatically</option><option value="off">off</option></select></Field>
        <Field label="Pause between steps (ms)"><input data-testid="step-delay" className="inp" type="number" min={0} step={100} value={value.stepDelayMs ?? 0} onChange={(e) => onChange({ ...value, stepDelayMs: Math.max(0, Number(e.target.value)) })} /></Field>
        <label className={`flex items-center gap-1 text-xs ${liveAvailable ? '' : 'text-slate-400'}`} title={liveAvailable ? 'Watch the replay in a real browser window' : 'Needs a display'}>
          <input data-testid="run-live" type="checkbox" disabled={!liveAvailable} checked={value.headless === false && liveAvailable} onChange={(e) => onChange({ ...value, headless: e.target.checked ? false : undefined })} /> Run in a live browser window
        </label>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!value.continueOnFailure} onChange={(e) => onChange({ ...value, continueOnFailure: e.target.checked })} /> Continue on failure</label>
      </div>
    </details>
  );
}

function toBase64(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
}
