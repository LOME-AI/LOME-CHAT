import { err, ok } from '../../../lib/result/index.js';
import { channelValueOf, contentValueOf } from '../engine/channel-values.js';
import { validateNodeInput } from './node-input.js';
import type { Node, NodePortDeclaration, SchemaNameRegistry } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { NodeExecution, NodeRunError, NodeRunSuccess } from '../engine/execution-registry.js';

/**
 * The `transform` capability execution: a pure, server-locus media/data
 * transform over the `TransformCompute` port. Inputs arrive as in-memory
 * channel values and are projected to `ContentValue`s for the port (mid-flow
 * content never rests anywhere); the result projects back to a channel value.
 * Transforms consume no gateway spend, so the reported cost is always zero.
 */

type TransformNode = Extract<Node, { type: 'transform' }>;

export interface TransformExecutionDeps {
  readonly compute: TransformCompute;
  readonly ports: NodePortDeclaration;
  readonly schemas: SchemaNameRegistry;
}

export function createTransformExecution(deps: TransformExecutionDeps): NodeExecution {
  return {
    streaming: false,
    run: (node, input, _ctx) => runTransform(deps, node as TransformNode, input),
  };
}

async function runTransform(
  deps: TransformExecutionDeps,
  node: TransformNode,
  input: readonly unknown[]
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(deps.ports, deps.schemas, input);
  if (validated.isErr()) return err(validated.error);
  const inputs = input.map((value) => contentValueOf(value));
  const result = await deps.compute.execute(node.transform, node.version, inputs);
  if (result.isErr()) return err({});
  return ok({ value: channelValueOf(result.value), costNanoUsd: 0n });
}
