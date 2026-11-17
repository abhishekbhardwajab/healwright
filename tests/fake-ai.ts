import type { AiModel, EditRequest, EditResponse, HealRequest, HealResponse } from '../src/ai/types.js';

/**
 * Deterministic stand-in for Claude. Tests script the answers, and every request
 * is recorded so tests can assert what the model would have been shown.
 */
export class FakeAi implements AiModel {
  readonly name = 'fake-model';
  healRequests: HealRequest[] = [];
  editRequests: EditRequest[] = [];
  constructor(
    public onHeal: (r: HealRequest) => HealResponse = () => ({ elementIndex: -1, confidence: 0, reasoning: 'no script' }),
    public onEdit: (r: EditRequest) => EditResponse = () => ({ summary: 'nothing', operations: [], notes: ['no script'] }),
  ) {}
  async heal(r: HealRequest) { this.healRequests.push(r); return this.onHeal(r); }
  async edit(r: EditRequest) { this.editRequests.push(r); return this.onEdit(r); }
}

export const op = (o: Partial<import('../src/ai/types.js').EditOperation> & { op: any }) =>
  ({ index: 0, to: o.index ?? 0, json: '{}', explanation: '', ...o });
