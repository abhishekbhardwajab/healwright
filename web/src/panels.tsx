import { useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { Action, AssertionKind, ElementTarget, Execution, HealProposal, SelectorCandidate, StepResult } from '@model/actions';
import type { EditProposal } from './api';
import { describeAction } from '@model/actions';

export const selectorText = (s?: SelectorCandidate): string => {
  if (!s) return '';
  const o = s.options ?? {};
  const q = (v: string) => `'${v}'`;
  const parent = s.parent ? selectorText(s.parent) + '.' : '';
  let code = '';
  switch (s.strategy) {
    case 'testid': code = `getByTestId(${q(s.value)})`; break;
    case 'role': code = `getByRole(${q(s.value)}${o.name !== undefined ? `, { name: ${q(o.name)}${o.exact ? ', exact: true' : ''} }` : ''})`; break;
    case 'label': code = `getByLabel(${q(s.value)})`; break;
    case 'placeholder': code = `getByPlaceholder(${q(s.value)})`; break;
    case 'alt': code = `getByAltText(${q(s.value)})`; break;
    case 'title': code = `getByTitle(${q(s.value)})`; break;
    case 'text': code = `getByText(${q(s.value)})`; break;
    case 'css': code = `locator(${q(s.value)})`; break;
    case 'xpath': code = `locator('xpath=${s.value}')`; break;
  }
  return parent + code + (o.hasText !== undefined ? `.filter({ hasText: ${q(o.hasText)} })` : '') + (o.nth !== undefined ? `.nth(${o.nth})` : '');
};

const STATUS_STYLE: Record<string, string> = {
  passed: 'bg-emerald-100 text-emerald-800', failed: 'bg-red-100 text-red-800', running: 'bg-blue-100 text-blue-800 animate-pulse',
  skipped: 'bg-slate-100 text-slate-500', pending: 'bg-slate-100 text-slate-500',
};
const TYPE_ICON: Record<string, string> = {
  navigate: '🌐', click: '👆', dblclick: '✌️', rightClick: '🖱️', fill: '⌨️', clear: '🧹', press: '⏎', select: '☰', check: '☑️', uncheck: '⬜',
  setInputFiles: '📎', scroll: '↕️', dragTo: '✋', wait: '⏱️', assert: '✔️', hover: '🎯', goBack: '◀', goForward: '▶', reload: '⟳', switchTab: '🗂️', closeTab: '✖',
};

export function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  return <span className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded ${STATUS_STYLE[status] ?? ''}`}>{status}</span>;
}

interface StepsProps {
  actions: Action[];
  results?: StepResult[];
  onChange: (actions: Action[]) => void;
  onEdit: (index: number) => void;
  onReplay: (opts: { onlyStep?: number; fromStep?: number }) => void;
  onAssertOn: (index: number) => void;
  canReplay: boolean;
}

export function StepsPanel({ actions, results, onChange, onEdit, onReplay, onAssertOn, canReplay }: StepsProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= actions.length || from === to) return;
    const next = [...actions];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  if (!actions.length) return <p className="text-sm text-slate-500 p-4">No steps yet. Start recording and interact with the page.</p>;
  return (
    <ol className="divide-y divide-slate-100" data-testid="steps">
      {actions.map((a, i) => {
        const r = results?.[i];
        return (
          <li
            key={a.id}
            data-testid="step"
            draggable
            onDragStart={() => setDragFrom(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); }}
            className={`group flex gap-2 px-3 py-2 text-sm hover:bg-slate-50 ${a.disabled ? 'opacity-50' : ''}`}
          >
            <span className="w-6 text-right text-slate-400 font-mono text-xs pt-0.5 cursor-grab" title="Drag to reorder">{i + 1}</span>
            <span className="pt-0.5">{TYPE_ICON[a.type] ?? '•'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800 truncate" data-testid="step-title">{a.name || describeAction(a)}</span>
                <StatusBadge status={r?.status} />
                {r?.healed && <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-800" title={r.usedSelector ? selectorText(r.usedSelector) : ''}>healed</span>}
                {a.signals?.popup && <span className="text-[10px] px-1 rounded bg-violet-100 text-violet-800">opens {a.signals.popup}</span>}
                {a.signals?.dialog && <span className="text-[10px] px-1 rounded bg-violet-100 text-violet-800">dialog</span>}
              </div>
              {a.target && <code className="block text-xs text-indigo-700 truncate" title={selectorText(a.target.selectors[0])}>{a.target.framePath ? '⧉ iframe › ' : ''}{selectorText(a.target.selectors[0])}</code>}
              {r?.error && <pre className="text-xs text-red-700 whitespace-pre-wrap mt-1 max-h-24 overflow-auto">{r.error}</pre>}
              {r?.durationMs !== undefined && <span className="text-[11px] text-slate-400">{r.durationMs} ms{r.attempts && r.attempts > 1 ? ` · ${r.attempts} attempts` : ''}</span>}
              <div className="hidden group-hover:flex flex-wrap gap-1 mt-1">
                <Btn onClick={() => onEdit(i)}>Edit</Btn>
                <Btn onClick={() => onChange(actions.filter((_, k) => k !== i))}>Delete</Btn>
                <Btn onClick={() => { const c = { ...structuredClone(a), id: `${a.id}-copy-${Date.now().toString(36)}` }; const n = [...actions]; n.splice(i + 1, 0, c); onChange(n); }}>Duplicate</Btn>
                <Btn onClick={() => move(i, i - 1)}>↑</Btn>
                <Btn onClick={() => move(i, i + 1)}>↓</Btn>
                <Btn onClick={() => onChange(actions.map((x, k) => (k === i ? { ...x, disabled: !x.disabled } : x)))}>{a.disabled ? 'Enable' : 'Disable'}</Btn>
                {a.target && <Btn onClick={() => onAssertOn(i)}>Assert on element</Btn>}
                <Btn disabled={!canReplay} onClick={() => onReplay({ onlyStep: i })}>Replay step</Btn>
                <Btn disabled={!canReplay} onClick={() => onReplay({ fromStep: i })}>Replay from here</Btn>
              </div>
            </div>
            {(r?.screenshot || a.metadata.screenshot) && (
              <a href={`/artifacts/${r?.screenshot ?? a.metadata.screenshot}`} target="_blank" rel="noreferrer">
                <img src={`/artifacts/${r?.screenshot ?? a.metadata.screenshot}`} alt="" className="w-20 h-12 object-cover object-top rounded border border-slate-200" />
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' }) {
  const { variant = 'ghost', className = '', ...rest } = props;
  const v = variant === 'primary' ? 'bg-indigo-600 text-white hover:bg-indigo-700' : variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100';
  return <button {...rest} className={`text-xs px-2 py-1 rounded disabled:opacity-40 ${v} ${className}`} />;
}

// ------------------------------------------------------------------------------------
export function StepEditor({ action, onSave, onClose }: { action: Action; onSave: (a: Action) => void; onClose: () => void }) {
  const [a, setA] = useState<Action>(structuredClone(action));
  const set = (patch: Partial<Action> | Record<string, unknown>) => setA({ ...a, ...patch } as Action);
  const t = a.target;
  const setPrimary = (idx: number) => {
    if (!t) return;
    const sels = [...t.selectors];
    const [s] = sels.splice(idx, 1);
    set({ target: { ...t, selectors: [s, ...sels] } });
  };
  const [custom, setCustom] = useState<SelectorCandidate>({ strategy: 'css', value: '', score: 50 });
  return (
    <Modal title={`Edit step: ${describeAction(action)}`} onClose={onClose}>
      <Field label="Step name"><input className="inp" value={a.name ?? ''} placeholder={describeAction(a)} onChange={(e) => set({ name: e.target.value || undefined })} /></Field>
      {a.type === 'navigate' && <Field label="URL"><input className="inp" value={a.url} onChange={(e) => set({ url: e.target.value })} /></Field>}
      {a.type === 'fill' && !a.secretVariable && <Field label="Value (use ${name} for test data)"><input className="inp" value={a.value} onChange={(e) => set({ value: e.target.value })} /></Field>}
      {a.type === 'fill' && a.secretVariable && <p className="text-xs text-slate-600">Sensitive value. Read from env var <code>{a.secretVariable}</code> (or the in-memory vault for this session).</p>}
      {a.type === 'press' && <Field label="Key (Playwright syntax, e.g. Enter, Control+a)"><input className="inp" value={a.key} onChange={(e) => set({ key: e.target.value })} /></Field>}
      {a.type === 'select' && <Field label="Option values (comma separated)"><input className="inp" value={a.values.join(',')} onChange={(e) => set({ values: e.target.value.split(',').map((s) => s.trim()) })} /></Field>}
      {a.type === 'wait' && (
        <div className="flex gap-2">
          <Field label="Wait for"><select className="inp" value={a.wait} onChange={(e) => set({ wait: e.target.value })}>{['timeout', 'loadState', 'url', 'elementVisible', 'elementHidden'].map((k) => <option key={k}>{k}</option>)}</select></Field>
          {a.wait === 'timeout' && <Field label="ms"><input className="inp" type="number" value={a.ms ?? 1000} onChange={(e) => set({ ms: Number(e.target.value) })} /></Field>}
          {a.wait === 'loadState' && <Field label="state"><select className="inp" value={a.loadState ?? 'load'} onChange={(e) => set({ loadState: e.target.value })}>{['load', 'domcontentloaded', 'networkidle'].map((k) => <option key={k}>{k}</option>)}</select></Field>}
          {a.wait === 'url' && <Field label="URL regex"><input className="inp" value={a.urlPattern ?? ''} onChange={(e) => set({ urlPattern: e.target.value })} /></Field>}
        </div>
      )}
      {a.type === 'assert' && <AssertionFields value={a.assertion} hasTarget={!!a.target} onChange={(assertion) => set({ assertion })} />}
      {t && (
        <Field label="Locator (first = primary; others are fallbacks used by self-healing replay)">
          <div className="space-y-1 max-h-48 overflow-auto">
            {t.selectors.map((s, i) => (
              <label key={i} className="flex items-center gap-2 text-xs">
                <input type="radio" checked={i === 0} onChange={() => setPrimary(i)} />
                <code className="flex-1 truncate">{selectorText(s)}</code>
                <span className="text-slate-400">score {s.score}{s.matchCount !== undefined ? ` · ${s.matchCount} match` : ''}</span>
                <button className="text-red-600" onClick={() => set({ target: { ...t, selectors: t.selectors.filter((_, k) => k !== i) } })}>✕</button>
              </label>
            ))}
          </div>
          <div className="flex gap-1 mt-2">
            <select className="inp w-28" value={custom.strategy} onChange={(e) => setCustom({ ...custom, strategy: e.target.value as SelectorCandidate['strategy'] })}>
              {['css', 'xpath', 'testid', 'role', 'label', 'placeholder', 'text'].map((k) => <option key={k}>{k}</option>)}
            </select>
            <input className="inp flex-1" placeholder={custom.strategy === 'role' ? 'role e.g. button' : 'value'} value={custom.value} onChange={(e) => setCustom({ ...custom, value: e.target.value })} />
            {custom.strategy === 'role' && <input className="inp w-32" placeholder="name" value={custom.options?.name ?? ''} onChange={(e) => setCustom({ ...custom, options: { name: e.target.value } })} />}
            <Btn onClick={() => { if (custom.value) set({ target: { ...t, selectors: [{ ...custom, score: 100, notes: ['user defined'] }, ...t.selectors] } as ElementTarget }); }}>Add as primary</Btn>
          </div>
        </Field>
      )}
      <div className="flex gap-4 text-xs">
        <Field label="Timeout (ms)"><input className="inp w-28" type="number" value={a.timeoutMs ?? ''} placeholder="default" onChange={(e) => set({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })} /></Field>
        <label className="flex items-center gap-1 mt-5"><input type="checkbox" checked={!!a.optional} onChange={(e) => set({ optional: e.target.checked })} /> Optional (failure does not fail the test)</label>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => onSave(a)}>Save step</Btn>
      </div>
    </Modal>
  );
}

const ELEMENT_KINDS: AssertionKind[] = ['visible', 'hidden', 'containsText', 'hasText', 'value', 'enabled', 'disabled', 'checked', 'attribute', 'count'];
const PAGE_KINDS: AssertionKind[] = ['url', 'title'];

export function AssertionFields({ value, onChange, hasTarget }: { value: { kind: AssertionKind; expected?: string; attribute?: string; negate?: boolean; regex?: boolean }; onChange: (v: any) => void; hasTarget: boolean }) {
  const kinds = hasTarget ? ELEMENT_KINDS : PAGE_KINDS;
  const needsExpected = !['visible', 'hidden', 'enabled', 'disabled', 'checked'].includes(value.kind);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Field label="Assertion"><select data-testid="assert-kind" className="inp" value={value.kind} onChange={(e) => {
          const kind = e.target.value as AssertionKind;
          const { expected, ...rest } = value;
          onChange(['visible', 'hidden', 'enabled', 'disabled', 'checked'].includes(kind) ? { ...rest, kind } : { ...value, kind });
        }}>{kinds.map((k) => <option key={k}>{k}</option>)}</select></Field>
        {value.kind === 'attribute' && <Field label="Attribute"><input className="inp" value={value.attribute ?? ''} onChange={(e) => onChange({ ...value, attribute: e.target.value })} /></Field>}
        {needsExpected && <Field label="Expected"><input data-testid="assert-expected" className="inp" value={value.expected ?? ''} onChange={(e) => onChange({ ...value, expected: e.target.value })} /></Field>}
      </div>
      <div className="flex gap-4 text-xs">
        <label className="flex items-center gap-1"><input type="checkbox" checked={!!value.negate} onChange={(e) => onChange({ ...value, negate: e.target.checked })} /> Negate (not)</label>
        {needsExpected && <label className="flex items-center gap-1"><input type="checkbox" checked={!!value.regex} onChange={(e) => onChange({ ...value, regex: e.target.checked })} /> Regex</label>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs text-slate-600 space-y-1"><span>{label}</span>{children}</label>;
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onMouseDown={onClose}>
      <div role="dialog" aria-label={title} className="bg-white rounded-lg shadow-xl w-[640px] max-h-[90vh] overflow-auto p-4 space-y-3" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="font-semibold text-slate-800 truncate">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------
export function CodePanel({ code, fileName }: { code: string; fileName: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 p-2 border-b border-slate-200">
        <Btn onClick={() => { void navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? 'Copied' : 'Copy code'}</Btn>
        <Btn onClick={() => { const b = new Blob([code], { type: 'text/plain' }); const u = URL.createObjectURL(b); const l = document.createElement('a'); l.href = u; l.download = fileName; l.click(); URL.revokeObjectURL(u); }}>Download .spec.ts</Btn>
      </div>
      <div className="flex-1 min-h-0" data-testid="code">
        <Editor language="typescript" value={code} theme="vs" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: 'on' }}
          loading={<pre className="p-2 text-xs">{code}</pre>} />
      </div>
      <pre className="sr-only" data-testid="code-text">{code}</pre>
    </div>
  );
}

// ------------------------------------------------------------------------------------
export function ResultsPanel({ execution, actions, onStop, onHeal, onAcceptAll }: { execution?: Execution; actions: Action[]; onStop: () => void; onHeal?: (p: HealProposal, accept: boolean) => void; onAcceptAll?: () => void }) {
  if (!execution) return <p className="text-sm text-slate-500 p-4">No runs yet. Press Run test.</p>;
  const done = execution.steps.filter((s) => ['passed', 'failed', 'skipped'].includes(s.status)).length;
  const pct = Math.round((done / Math.max(1, execution.steps.length)) * 100);
  const failed = execution.steps.find((s) => s.status === 'failed');
  return (
    <div className="p-3 space-y-3 text-sm" data-testid="results">
      <div className="flex items-center gap-2">
        <StatusBadge status={execution.status} />
        <span className="text-slate-500 text-xs">{execution.finishedAt ? `${execution.finishedAt - execution.startedAt} ms` : 'running…'}</span>
        {execution.status === 'running' && <Btn variant="danger" onClick={onStop}>Stop</Btn>}
      </div>
      <div className="h-2 bg-slate-200 rounded"><div className={`h-2 rounded ${execution.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} /></div>
      {failed && (
        <div className="border border-red-200 bg-red-50 rounded p-2">
          <div className="font-medium text-red-800">Step {failed.index + 1} failed: {actions[failed.index] ? describeAction(actions[failed.index]) : ''}</div>
          <pre className="text-xs text-red-700 whitespace-pre-wrap">{failed.error}</pre>
          {failed.screenshot && <img src={`/artifacts/${failed.screenshot}`} alt="failure screenshot" className="mt-2 border rounded max-h-64" />}
        </div>
      )}
      {!!execution.healProposals?.length && <HealProposals execution={execution} actions={actions} onDecide={onHeal} onAcceptAll={onAcceptAll} />}
      <table className="w-full text-xs">
        <tbody>
          {execution.steps.map((s) => (
            <tr key={s.actionId} className="border-b border-slate-100">
              <td className="py-1 pr-2 text-slate-400">{s.index + 1}</td>
              <td className="pr-2"><StatusBadge status={s.status} /></td>
              <td className="pr-2 truncate max-w-[220px]">{actions[s.index] ? describeAction(actions[s.index]) : s.actionId}</td>
              <td className="pr-2 text-slate-500">{s.durationMs !== undefined ? `${s.durationMs}ms` : ''}</td>
              <td>{s.ai ? <span data-testid="ai-healed" className="text-violet-700" title={`${s.ai.model} (${Math.round(s.ai.confidence * 100)}%): ${s.ai.reasoning}`}>AI-healed</span>
                : s.healed && <span className="text-amber-700" title={selectorText(s.usedSelector)}>healed</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="cursor-pointer text-xs text-slate-600">Execution log ({execution.logs.length})</summary>
        <pre className="text-[11px] bg-slate-900 text-slate-100 p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap">
          {execution.logs.map((l) => `${new Date(l.ts).toLocaleTimeString()} ${l.level.toUpperCase()} ${l.message}`).join('\n')}
        </pre>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------------------------
function HealProposals({ execution, actions, onDecide, onAcceptAll }: { execution: Execution; actions: Action[]; onDecide?: (p: HealProposal, accept: boolean) => void; onAcceptAll?: () => void }) {
  const props = execution.healProposals ?? [];
  const pending = props.filter((p) => p.status === 'pending').length;
  return (
    <div className="border border-violet-200 bg-violet-50 rounded p-2 space-y-2" data-testid="heal-proposals">
      <div className="flex items-center gap-2">
        <span className="font-medium text-violet-900">Locator fixes found during this run ({props.length})</span>
        <div className="flex-1" />
        {pending > 1 && onAcceptAll && <Btn data-testid="heal-accept-all" onClick={onAcceptAll}>Accept all</Btn>}
      </div>
      <p className="text-[11px] text-violet-800">Accepting saves the new locator as the step's primary (old ones stay as fallbacks) and updates the generated code. Check each one: a healed locator can hide a real bug.</p>
      {props.map((p) => {
        const a = actions.find((x) => x.id === p.actionId);
        return (
          <div key={p.id} className="bg-white border border-violet-100 rounded p-2 text-xs space-y-1" data-testid="heal-proposal">
            <div className="flex items-center gap-2">
              <b>Step {p.stepIndex + 1}</b>
              <span className="truncate">{a ? describeAction(a) : '(step removed)'}</span>
              <span className={`ml-auto px-1 rounded ${p.source === 'ai' ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-800'}`}>{p.source === 'ai' ? `AI ${Math.round((p.confidence ?? 0) * 100)}%` : 'fallback'}</span>
            </div>
            {p.previousPrimary && <div className="font-mono text-red-700 line-through truncate" title={selectorText(p.previousPrimary)}>{selectorText(p.previousPrimary)}</div>}
            <div className="font-mono text-emerald-700 truncate" title={selectorText(p.selectors[0])}>{selectorText(p.selectors[0])}</div>
            {p.reasoning && <div className="text-slate-600">{p.reasoning}</div>}
            <div className="flex gap-2">
              {p.status === 'pending' && onDecide ? (<>
                <Btn variant="primary" data-testid="heal-accept" onClick={() => onDecide(p, true)}>Accept</Btn>
                <Btn data-testid="heal-reject" onClick={() => onDecide(p, false)}>Reject</Btn>
              </>) : <span className={p.status === 'accepted' ? 'text-emerald-700' : 'text-slate-500'} data-testid="heal-status">{p.status}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------------------
export function AiPanel({ enabled, model, busy, proposal, onAsk, onAccept, onReject }: {
  enabled: boolean; model: string | null; busy: boolean; proposal: EditProposal | null;
  onAsk: (instruction: string) => void; onAccept: () => void; onReject: () => void;
}) {
  const [text, setText] = useState('');
  const bad = proposal?.operations.some((o) => o.error);
  if (!enabled) return (
    <div className="p-4 text-sm text-slate-600 space-y-2" data-testid="ai-panel">
      <p><b>AI is not configured.</b> Set <code>ANTHROPIC_API_KEY</code> (and optionally <code>AI_MODEL</code>) and restart the studio to enable prompt editing and AI self-healing.</p>
    </div>
  );
  return (
    <div className="flex flex-col h-full" data-testid="ai-panel">
      <div className="p-3 space-y-2 border-b border-slate-200">
        <label className="text-xs text-slate-600" htmlFor="ai-instruction">Describe the change you want ({model})</label>
        <textarea id="ai-instruction" data-testid="ai-instruction" className="inp h-20 font-sans" value={text} maxLength={4000}
          placeholder={'e.g. "Use a variable for the username, drop the Remember me step and check the heading says Welcome"'}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) onAsk(text); }} />
        <div className="flex gap-2 items-center">
          <Btn variant="primary" data-testid="ai-ask" disabled={busy || !text.trim()} onClick={() => onAsk(text)}>{busy ? 'Thinking…' : 'Propose change'}</Btn>
          <span className="text-[11px] text-slate-500">Nothing is saved until you accept the diff.</span>
        </div>
      </div>
      {proposal && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="p-3 space-y-2 text-xs">
            <div className="text-sm" data-testid="ai-summary">{proposal.summary}</div>
            <ul className="space-y-0.5">
              {proposal.operations.map((o, i) => (
                <li key={i} className={o.error ? 'text-red-700' : 'text-slate-700'}>
                  <b>{o.op}</b> {o.op === 'setVariable' || o.op === 'rename' ? '' : `step ${o.index + 1}`}{o.op === 'move' ? ` → ${o.to + 1}` : ''}: {o.explanation}{o.error && <span data-testid="ai-op-error"> ({o.error})</span>}
                </li>
              ))}
            </ul>
            {proposal.notes.length > 0 && <div className="text-amber-800 bg-amber-50 rounded p-1">{proposal.notes.map((n, i) => <div key={i}>• {n}</div>)}</div>}
            <div className="flex gap-2">
              <Btn variant="primary" data-testid="ai-accept" disabled={bad} title={bad ? 'Some operations are invalid' : undefined} onClick={onAccept}>Accept change</Btn>
              <Btn data-testid="ai-reject" onClick={onReject}>Reject</Btn>
            </div>
          </div>
          <div className="flex-1 min-h-[260px] border-t border-slate-200" data-testid="ai-diff">
            <DiffEditor language="typescript" original={proposal.codeBefore} modified={proposal.codeAfter} theme="vs"
              options={{ readOnly: true, renderSideBySide: false, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false }}
              loading={<pre className="p-2 text-[11px]">{proposal.diff}</pre>} />
          </div>
          <pre className="sr-only" data-testid="ai-diff-text">{proposal.diff}</pre>
        </div>
      )}
    </div>
  );
}
