import { describe, expect, it, vi } from 'vitest';
import { Node as NodeSchema, textTag } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { createValueStore } from '../engine/value-store.js';
import { createTransformExecution } from './transform-execution.js';
import type { ContentValue, Node } from '@hushbox/shared';
import type { TransformCompute } from '../../media/index.js';
import type { NodeRunContext } from '../engine/execution-registry.js';

function transformNode(): Extract<Node, { type: 'transform' }> {
  return NodeSchema.parse({
    id: 'echo',
    type: 'transform',
    version: 1,
    out: 'out',
    transform: 'echo',
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'transform' }>;
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
const ports = { in: [textTag()], out: textTag() };

describe('createTransformExecution', () => {
  it('is not a streaming execution', () => {
    const compute = { execute: vi.fn(), resolvePorts: vi.fn() } as unknown as TransformCompute;
    expect(createTransformExecution({ compute, ports, schemas }).streaming).toBe(false);
  });

  it('materializes inputs, runs the compute, and returns the channel value with zero cost', async () => {
    const execute = vi.fn(() => okAsync<ContentValue>({ kind: 'text', text: 'ECHO' }));
    const compute = { execute, resolvePorts: vi.fn() } as unknown as TransformCompute;
    const exec = createTransformExecution({ compute, ports, schemas });
    const result = await exec.run(transformNode(), ['x'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({ value: 'ECHO', costNanoUsd: 0n });
    expect(execute).toHaveBeenCalledWith('echo', 1, [{ kind: 'text', text: 'x' }]);
  });

  it('returns a node failure when the transform compute errors', async () => {
    const execute = vi.fn(() => errAsync(validationError('bad transform')));
    const compute = { execute, resolvePorts: vi.fn() } as unknown as TransformCompute;
    const exec = createTransformExecution({ compute, ports, schemas });
    const result = await exec.run(transformNode(), ['x'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('re-validates the resolved input against the declared ports', async () => {
    const execute = vi.fn(() => okAsync<ContentValue>({ kind: 'text', text: 'unused' }));
    const compute = { execute, resolvePorts: vi.fn() } as unknown as TransformCompute;
    const exec = createTransformExecution({ compute, ports, schemas });
    const result = await exec.run(transformNode(), [42], makeCtx());
    expect(result.isErr()).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
