import { z } from 'zod/v4';

/**
 * The AI port. The studio depends on this interface only, so the model
 * provider can be swapped (Claude by default, a scripted fake in tests).
 */

// ---------------------------------------------------------------------------
// Self-healing
// ---------------------------------------------------------------------------

/** One candidate element on the current page, as shown to the model. */
export interface SnapshotElement {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  attributes: Record<string, string>;
  /** Short path of landmark/container names, e.g. "form#login > fieldset 'Plan'". */
  context?: string;
  visible: boolean;
}

export interface HealRequest {
  /** Plain-English description of the step, e.g. 'Click button "Sign in"'. */
  step: string;
  actionType: string;
  /** What we knew about the element when it was recorded. */
  recorded: {
    tagName: string;
    role?: string;
    accessibleName?: string;
    text?: string;
    attributes?: Record<string, string>;
    selectors: string[];
    url: string;
  };
  /** Why the recorded locators failed now. */
  failure: string;
  page: { url: string; title: string };
  elements: SnapshotElement[];
}

export const HealResponseSchema = z.object({
  /** index from the snapshot, or -1 when no element is a confident match. */
  elementIndex: z.number().int(),
  confidence: z.number(),
  reasoning: z.string(),
});
export type HealResponse = z.infer<typeof HealResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt-driven editing
// ---------------------------------------------------------------------------

export const EditOperationSchema = z.object({
  op: z.enum(['update', 'insert', 'delete', 'move', 'setVariable', 'rename']),
  /** Step index (0-based) the operation applies to; for insert, the position to insert at. */
  index: z.number().int(),
  /** move: destination index. */
  to: z.number().int(),
  /**
   * JSON text. update: a partial step (fields to change). insert: a full step.
   * setVariable: {"name": "...", "value": "..."}. rename: {"name": "..."}. Otherwise "{}".
   */
  json: z.string(),
  /** One line, shown to the user. */
  explanation: z.string(),
});
export type EditOperation = z.infer<typeof EditOperationSchema>;

export const EditResponseSchema = z.object({
  summary: z.string(),
  operations: z.array(EditOperationSchema),
  /** Questions or caveats for the user, e.g. when the request is ambiguous. */
  notes: z.array(z.string()),
});
export type EditResponse = z.infer<typeof EditResponseSchema>;

export interface EditRequest {
  instruction: string;
  testName: string;
  variables: Record<string, string>;
  /** Steps as compact JSON (ids, screenshots and noisy metadata stripped). */
  steps: unknown[];
  /** The generated Playwright code, so the user can talk in terms of code. */
  code: string;
  /** Elements on the live page, when a recording session is open. */
  pageElements?: SnapshotElement[];
}

export interface AiModel {
  readonly name: string;
  heal(req: HealRequest): Promise<HealResponse>;
  edit(req: EditRequest): Promise<EditResponse>;
}

export class AiUnavailableError extends Error {}
