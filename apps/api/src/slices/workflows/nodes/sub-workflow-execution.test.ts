import { describe, expect, it, vi } from 'vitest';
import { Node as NodeSchema, textTag } from '@hushbox/shared';
import { ok } from '../../../lib/result/index.js';
import { createValueStore } from '../engine/value-store.js';
import { createSubWorkflowExecution } from './sub-workflow-execution.js';
import type { Node } from '@hushbox/shared';
import type { NodeRunContext } from '../engine/execution-registry.js';

function subWorkflowNode(): Extract<Node, { type: 'subWorkflow' }> {
  return NodeSchema.parse({
    id: 'summarize',
    type: 'subWorkflow',
    version: 1,
    out: 'out',
    ref: 'summarize',
  }) as Extract<Node, { type: 'subWorkflow' }>;
}

function makeCtx(): NodeRunContext {
  return {
    values: createValueStore(1_000_000),
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
  };
}

const schemas = { resolveSchema: vi.fn() };
const ports = { in: [textTag(), textTag()], out: textTag() };

describe('createSubWorkflowExecution', () => {
  it('is not a streaming execution', () => {
    const exec = createSubWorkflowExecution({ ports, schemas, run: vi.fn() });
    expect(exec.streaming).toBe(false);
  });

  it('validates the resolved input then delegates to the injected nested run', async () => {
    const run = vi.fn(() => Promise.resolve(ok({ value: 'nested', costNanoUsd: 7n })));
    const exec = createSubWorkflowExecution({ ports, schemas, run });
    const ctx = makeCtx();
    const result = await exec.run(subWorkflowNode(), ['a', 'b'], ctx);
    expect(result._unsafeUnwrap()).toEqual({ value: 'nested', costNanoUsd: 7n });
    expect(run).toHaveBeenCalledWith(['a', 'b'], ctx);
  });

  it('returns a node failure without running the sub-workflow on invalid input', async () => {
    const run = vi.fn();
    const exec = createSubWorkflowExecution({ ports, schemas, run });
    const result = await exec.run(subWorkflowNode(), ['only-one'], makeCtx());
    expect(result.isErr()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
