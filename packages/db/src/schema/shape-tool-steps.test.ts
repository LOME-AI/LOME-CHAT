import { describe, it, expect, expectTypeOf } from 'vitest';
import { PersistedToolStep } from '@hushbox/shared';

import type { llmCompletions } from './index';

/**
 * The persisted tool-step shape. The column's row type must accept
 * exactly what the shared PersistedToolStep contract emits — one gateway
 * generation per agentic step with that step's tool activity.
 */
describe('llm_completions.tool_steps aligns with PersistedToolStep', () => {
  const sample = PersistedToolStep.parse({
    step: 0,
    generationId: 'gen-abc',
    toolCalls: [{ id: 'call-1', name: 'search', args: { q: 'x' } }],
    toolResults: [{ id: 'call-1', name: 'search', result: { hits: 1 } }],
  });

  it('accepts a parsed PersistedToolStep list as the column insert value', () => {
    type ToolStepsInsert = NonNullable<(typeof llmCompletions.$inferInsert)['toolSteps']>;
    expectTypeOf<PersistedToolStep[]>().toExtend<ToolStepsInsert>();
  });

  it('mirrors the contract fields one-to-one', () => {
    type ToolStepRow = NonNullable<(typeof llmCompletions.$inferInsert)['toolSteps']>[number];
    expectTypeOf<keyof ToolStepRow>().toEqualTypeOf<keyof PersistedToolStep>();
    expect(Object.keys(sample).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'generationId',
      'step',
      'toolCalls',
      'toolResults',
    ]);
  });
});
