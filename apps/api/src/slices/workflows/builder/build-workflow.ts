import { compileDefinition } from '../compile/compile-definition.js';
import type { DeadlineClass, PolicyHooks, TypeTag } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { CompiledDefinition } from '../compile/compile-definition.js';
import type { CompileContext } from '../compile/context.js';
import type { CompileError } from '../compile/errors.js';
import type { NodeHandle } from './ports.js';
import type { WorkflowInputsHandle } from './workflow-inputs.js';

/** Everything compile needs beyond what the builder assembled itself. */
export type BuildRegistries = Omit<CompileContext, 'workflowInputs'>;

export interface BuildWorkflowOptions {
  readonly version?: number;
  readonly deadlineClass: DeadlineClass;
  readonly hooks: PolicyHooks;
  readonly inputs: WorkflowInputsHandle<Readonly<Record<string, TypeTag>>>;
  /** Each handle exactly once; bodies ride along inside their parent handle. */
  readonly nodes: readonly NodeHandle[];
  readonly registries: BuildRegistries;
}

/**
 * Assembles the definition the handles describe and compiles it: every
 * wiring claim the builder's types could not express is settled here.
 */
export function buildWorkflow(
  options: BuildWorkflowOptions
): Result<CompiledDefinition, CompileError[]> {
  const definition = {
    version: options.version ?? 1,
    deadlineClass: options.deadlineClass,
    hooks: options.hooks,
    nodes: options.nodes.flatMap((handle) => handle.nodes),
    edges: options.nodes.flatMap((handle) => handle.edges),
  };
  return compileDefinition(definition, {
    ...options.registries,
    workflowInputs: options.inputs.declarations,
  });
}
