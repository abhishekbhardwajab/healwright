import { z } from 'zod/v4';
import { createTwoFilesPatch } from 'diff';
import { newId, describeAction, type Action, type HealProposal, type TestCase } from '../model/actions.js';
import { generatePlaywrightTest } from '../codegen/playwright.js';
import type { AiModel, EditOperation, EditResponse, SnapshotElement } from './types.js';

// ---------------------------------------------------------------------------
// Validation of model-authored steps. The model only proposes; nothing it
// returns reaches a test without passing this schema and the user's review.
// ---------------------------------------------------------------------------
const Selector: z.ZodType<any> = z.lazy(() => z.looseObject({
  strategy: z.enum(['testid', 'role', 'label', 'placeholder', 'alt', 'title', 'text', 'css', 'xpath']),
  value: z.string().min(1),
  options: z.looseObject({ name: z.string().optional(), exact: z.boolean().optional(), nth: z.number().int().optional(), hasText: z.string().optional() }).optional(),
  parent: Selector.optional(),
  score: z.number().default(70),
}));
const Target = z.looseObject({
  tagName: z.string().default('*'),
  selectors: z.array(Selector).min(1),
});
const base = { pageAlias: z.string().default('page'), name: z.string().optional(), disabled: z.boolean().optional(), optional: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() };
const ActionSchema = z.discriminatedUnion('type', [
  z.looseObject({ ...base, type: z.literal('navigate'), url: z.string().min(1) }),
  z.looseObject({ ...base, type: z.enum(['goBack', 'goForward', 'reload', 'switchTab', 'closeTab']) }),
  z.looseObject({ ...base, type: z.enum(['click', 'dblclick', 'rightClick', 'hover']), target: Target }),
  z.looseObject({ ...base, type: z.literal('fill'), target: Target, value: z.string() }),
  z.looseObject({ ...base, type: z.literal('clear'), target: Target }),
  z.looseObject({ ...base, type: z.literal('press'), key: z.string().min(1), target: Target.optional() }),
  z.looseObject({ ...base, type: z.literal('select'), target: Target, values: z.array(z.string()).min(1) }),
  z.looseObject({ ...base, type: z.enum(['check', 'uncheck']), target: Target }),
  z.looseObject({ ...base, type: z.literal('setInputFiles'), target: Target, files: z.array(z.string()) }),
  z.looseObject({ ...base, type: z.literal('scroll'), x: z.number(), y: z.number(), target: Target.optional() }),
  z.looseObject({ ...base, type: z.literal('dragTo'), target: Target, destination: Target }),
  z.looseObject({ ...base, type: z.literal('wait'), wait: z.enum(['timeout', 'loadState', 'elementVisible', 'elementHidden', 'url']), target: Target.optional() }),
  z.looseObject({
    ...base, type: z.literal('assert'), target: Target.optional(),
    assertion: z.looseObject({ kind: z.enum(['visible', 'hidden', 'containsText', 'hasText', 'url', 'title', 'enabled', 'disabled', 'checked', 'value', 'attribute', 'count']), expected: z.string().optional(), attribute: z.string().optional(), regex: z.boolean().optional(), negate: z.boolean().optional() }),
  }),
]);

const ELEMENT_ASSERTIONS = new Set(['visible', 'hidden', 'containsText', 'hasText', 'enabled', 'disabled', 'checked', 'value', 'attribute', 'count']);

function validateAction(a: unknown, where: string): Action {
  const r = ActionSchema.safeParse(a);
  if (!r.success) throw new Error(`${where}: invalid step: ${r.error.issues.map((i) => `${i.path.join('.') || 'step'} ${i.message}`).join('; ')}`);
  const out = r.data as unknown as Action;
  if (out.type === 'assert' && ELEMENT_ASSERTIONS.has(out.assertion.kind) && !out.target) throw new Error(`${where}: "${out.assertion.kind}" assertion needs a target element`);
  if (out.type === 'wait' && (out.wait === 'elementVisible' || out.wait === 'elementHidden') && !out.target) throw new Error(`${where}: element wait needs a target`);
  return out;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------
/** Steps as the model sees them: no ids, screenshots, timestamps or bulky metadata. */
export function compactSteps(actions: Action[]): unknown[] {
  return actions.map((a, index) => {
    const { id, timestamp, metadata, signals, ...rest } = a as Action & Record<string, unknown>;
    const strip = (t?: Action['target']) => t && {
      tagName: t.tagName, role: t.role, accessibleName: t.accessibleName, text: t.text, framePath: t.framePath ? `${t.framePath.length} iframe(s)` : undefined,
      selectors: t.selectors.slice(0, 3).map(({ strategy, value, options, parent, score }) => ({ strategy, value, options, parent, score })),
    };
    return {
      index, description: describeAction(a), ...rest,
      target: strip(a.target), ...(a.type === 'dragTo' ? { destination: strip(a.destination) } : {}),
      url: metadata.url, ...(signals ? { signals: Object.keys(signals) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Applying operations
// ---------------------------------------------------------------------------
export interface EditProposal {
  id: string;
  testId: string;
  instruction: string;
  model: string;
  summary: string;
  notes: string[];
  operations: Array<EditOperation & { error?: string }>;
  before: Pick<TestCase, 'name' | 'actions' | 'variables'>;
  after: Pick<TestCase, 'name' | 'actions' | 'variables'>;
  codeBefore: string;
  codeAfter: string;
  diff: string;
  createdAt: number;
  /** Based on this test version; accepting is refused if the test changed since. */
  baseUpdatedAt: number;
}

export function applyOperations(test: Pick<TestCase, 'name' | 'actions' | 'variables'>, ops: EditOperation[]) {
  const next = structuredClone(test);
  const applied: Array<EditOperation & { error?: string }> = [];
  for (const op of ops) {
    const where = `${op.op} at ${op.index + 1}`;
    try {
      const json = op.json?.trim() ? JSON.parse(op.json) : {};
      const inRange = (i: number, max = next.actions.length - 1) => { if (!Number.isInteger(i) || i < 0 || i > max) throw new Error(`${where}: index out of range`); };
      switch (op.op) {
        case 'update': {
          inRange(op.index);
          const cur = next.actions[op.index];
          delete json.id;
          if (cur.type === 'fill' && cur.secretVariable && 'value' in json) throw new Error(`${where}: secret values cannot be edited by AI`);
          const merged = { ...cur, ...json, id: cur.id, metadata: cur.metadata, timestamp: cur.timestamp };
          if (json.target) merged.target = markAuthored(json.target);
          next.actions[op.index] = { ...validateAction(merged, where), id: cur.id, metadata: cur.metadata, timestamp: cur.timestamp } as Action;
          break;
        }
        case 'insert': {
          inRange(op.index, next.actions.length);
          const prev = next.actions[Math.max(0, op.index - 1)];
          const raw = { ...json, id: newId('step'), timestamp: Date.now(), metadata: { url: prev?.metadata.url ?? '' } };
          if (raw.target) raw.target = markAuthored(raw.target);
          if (raw.destination) raw.destination = markAuthored(raw.destination);
          const a = validateAction(raw, where);
          next.actions.splice(op.index, 0, { ...a, id: raw.id, timestamp: raw.timestamp, metadata: raw.metadata } as Action);
          break;
        }
        case 'delete': inRange(op.index); next.actions.splice(op.index, 1); break;
        case 'move': {
          inRange(op.index); inRange(op.to);
          const [x] = next.actions.splice(op.index, 1);
          next.actions.splice(op.to, 0, x);
          break;
        }
        case 'setVariable':
          if (typeof json.name !== 'string' || !/^\w+$/.test(json.name)) throw new Error(`${where}: variable name must be a word`);
          next.variables = { ...next.variables, [json.name]: String(json.value ?? '') };
          break;
        case 'rename':
          if (typeof json.name !== 'string' || !json.name.trim()) throw new Error(`${where}: name required`);
          next.name = json.name.trim();
          break;
      }
      applied.push(op);
    } catch (e) {
      applied.push({ ...op, error: (e as Error).message });
    }
  }
  return { next, applied };
}

function markAuthored(t: any) {
  return { ...t, tagName: t.tagName ?? '*', selectors: (t.selectors ?? []).map((s: any) => ({ score: 70, ...s, verified: false, notes: [...(s.notes ?? []), 'AI-authored: not yet verified on the page'] })) };
}

export async function proposeEdit(ai: AiModel, test: TestCase, instruction: string, pageElements?: SnapshotElement[]): Promise<EditProposal> {
  const codeBefore = generatePlaywrightTest(test);
  const res: EditResponse = await ai.edit({ instruction, testName: test.name, variables: test.variables, steps: compactSteps(test.actions), code: codeBefore, pageElements });
  const before = { name: test.name, actions: test.actions, variables: test.variables };
  const { next, applied } = applyOperations(before, res.operations);
  const codeAfter = generatePlaywrightTest(next);
  return {
    id: newId('edit'), testId: test.id, instruction, model: ai.name, summary: res.summary, notes: res.notes,
    operations: applied, before, after: next, codeBefore, codeAfter,
    diff: createTwoFilesPatch(`${slug(test.name)}.spec.ts`, `${slug(next.name)}.spec.ts`, codeBefore, codeAfter, 'current', 'proposed', { context: 3 }),
    createdAt: Date.now(), baseUpdatedAt: test.updatedAt,
  };
}

const slug = (s: string) => s.replace(/\W+/g, '-').toLowerCase();

// ---------------------------------------------------------------------------
// Heal proposals
// ---------------------------------------------------------------------------
export function applyHealProposal(test: TestCase, p: HealProposal): TestCase {
  const next = structuredClone(test);
  const a = next.actions.find((x) => x.id === p.actionId);
  if (!a) throw new Error('The healed step no longer exists in this test');
  const t = p.field === 'destination' && a.type === 'dragTo' ? a.destination : a.target;
  if (!t) throw new Error('The healed step has no element');
  const seen = new Set<string>();
  t.selectors = p.selectors.filter((s) => { const k = JSON.stringify([s.strategy, s.value, s.options, s.parent]); if (seen.has(k)) return false; seen.add(k); return true; });
  return next;
}
