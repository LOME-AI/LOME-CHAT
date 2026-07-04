import { err } from '../../../lib/result/index.js';
import { validateNodeInput } from './node-input.js';
import type { NodePortDeclaration, SchemaNameRegistry } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type {
  NodeExecution,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';

/**
 * The `subWorkflow` capability execution: nests a workflow as a node. It owns
 * only the port re-validation and delegation; the nested run itself (compiling
 * the referenced definition and executing it through the interpreter) is
 * supplied by the registry, which holds the recursive binding to the executor.
 */

export type SubWorkflowRun = (
  input: readonly unknown[],
  ctx: NodeRunContext
) => Promise<Result<NodeRunSuccess, NodeRunError>>;

export interface SubWorkflowExecutionDeps {
  readonly ports: NodePortDeclaration;
  readonly schemas: SchemaNameRegistry;
  readonly run: SubWorkflowRun;
}

export function createSubWorkflowExecution(deps: SubWorkflowExecutionDeps): NodeExecution {
  return {
    streaming: false,
    run: (_node, input, ctx) => runSubWorkflow(deps, input, ctx),
  };
}

function runSubWorkflow(
  deps: SubWorkflowExecutionDeps,
  input: readonly unknown[],
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(deps.ports, deps.schemas, input);
  if (validated.isErr()) return Promise.resolve(err(validated.error));
  return deps.run(input, ctx);
}
