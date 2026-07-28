import { providerUsdToBillableNanoUsd } from '../../billing/index.js';
import { resolveToolRegistry } from '../../models/index.js';
import { createModelCallExecution } from '../nodes/model-call-execution.js';
import { createSmartModelExecution } from '../nodes/smart-model-execution.js';
import { createSubWorkflowExecution } from '../nodes/sub-workflow-execution.js';
import { createTransformExecution } from '../nodes/transform-execution.js';
import type { NodePortDeclaration, SchemaNameRegistry } from '@hushbox/shared';
import type { ModelProvider } from '../../models/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { ValueNode } from '../compile/context.js';
import type { ModelBinding } from '../nodes/model-call-execution.js';
import type { SubWorkflowRun } from '../nodes/sub-workflow-execution.js';
import type {
  EngineExecutionRegistry,
  NodeExecution,
  RegisteredPredicate,
  RegisteredReducer,
} from './execution-registry.js';

/**
 * The live production execution registry: it wires the capability-node
 * executions (modelCall/transform/subWorkflow) and the predicate/reducer code
 * the interpreter runs against. Resolution is version-pinned — a modelCall
 * only resolves at the registered impl version; transforms and sub-workflows
 * pin through their own `(name, version)` registries. A name that does not
 * resolve here after a clean compile is a wiring defect, which the interpreter
 * reports as such.
 */

/** The modelCall node implementation contract version. */
export const MODEL_CALL_IMPL_VERSION = 1;

/** The smartModel node implementation contract version. */
export const SMART_MODEL_IMPL_VERSION = 1;

export type { ModelBinding } from '../nodes/model-call-execution.js';
export type { SubWorkflowRun } from '../nodes/sub-workflow-execution.js';

export interface ModelResolver {
  resolve(modelId: string): ModelBinding | undefined;
}

export interface SubWorkflowBinding {
  readonly ports: NodePortDeclaration;
  readonly run: SubWorkflowRun;
}

export interface SubWorkflowResolver {
  resolve(ref: string, version: number): SubWorkflowBinding | undefined;
}

export interface LiveExecutionRegistryDeps {
  readonly provider: ModelProvider;
  readonly models: ModelResolver;
  readonly compute: TransformCompute;
  readonly subWorkflows: SubWorkflowResolver;
  readonly schemas: SchemaNameRegistry;
  readonly predicates: ReadonlyMap<string, RegisteredPredicate>;
  readonly reducers: ReadonlyMap<string, RegisteredReducer>;
  /** Best-effort alerting for the modelCall missing/absurd provider-cost path. */
  readonly telemetry?: Telemetry;
}

export function createLiveExecutionRegistry(
  deps: LiveExecutionRegistryDeps
): EngineExecutionRegistry {
  return {
    resolveExecution: (node) => resolveExecution(deps, node),
    resolvePredicate: (name) => deps.predicates.get(name),
    resolveReducer: (name) => deps.reducers.get(name),
  };
}

function resolveExecution(
  deps: LiveExecutionRegistryDeps,
  node: ValueNode
): NodeExecution | undefined {
  switch (node.type) {
    case 'modelCall': {
      return resolveModelCall(deps, node);
    }
    case 'smartModel': {
      return resolveSmartModel(deps, node);
    }
    case 'transform': {
      return resolveTransform(deps, node);
    }
    case 'subWorkflow': {
      return resolveSubWorkflow(deps, node);
    }
  }
}

/**
 * Resolves EVERY candidate binding up front — mirroring the compile-time
 * registry, so a definition that compiled always resolves here and any candidate
 * the turn's decision names can run.
 *
 * The declared classifier model is required to resolve without being bound to
 * anything: the node no longer calls it, but the compile-time port derivation
 * and the admission estimate both read it, so a node naming a model this
 * registry cannot resolve is a definition that must not run.
 */
function resolveSmartModel(
  deps: LiveExecutionRegistryDeps,
  node: Extract<ValueNode, { type: 'smartModel' }>
): NodeExecution | undefined {
  if (node.version !== SMART_MODEL_IMPL_VERSION) return undefined;
  if (deps.models.resolve(node.classifierModelId) === undefined) return undefined;
  const candidates = new Map<string, ModelBinding>();
  for (const candidate of node.candidates) {
    const binding = deps.models.resolve(candidate.id);
    if (binding === undefined) return undefined;
    candidates.set(candidate.id, binding);
  }
  return createSmartModelExecution({
    provider: deps.provider,
    candidates,
    schemas: deps.schemas,
    usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
    ...(deps.telemetry === undefined ? {} : { telemetry: deps.telemetry }),
  });
}

function resolveModelCall(
  deps: LiveExecutionRegistryDeps,
  node: Extract<ValueNode, { type: 'modelCall' }>
): NodeExecution | undefined {
  if (node.version !== MODEL_CALL_IMPL_VERSION) return undefined;
  const binding = deps.models.resolve(node.model);
  if (binding === undefined) return undefined;
  // Resolve the node's declared server-side tool names against the closed
  // registry into an agentic tool loop (registry + the node's step ceiling). A
  // non-empty selection naming an unknown tool is a wiring defect: it resolves
  // to undefined, and the modelCall stays unresolved for the interpreter to
  // surface — never a silently tool-less call.
  const registry = node.tools.length === 0 ? undefined : resolveToolRegistry(node.tools);
  if (node.tools.length > 0 && registry === undefined) return undefined;
  return createModelCallExecution({
    provider: deps.provider,
    binding,
    schemas: deps.schemas,
    usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
    ...(deps.telemetry === undefined ? {} : { telemetry: deps.telemetry }),
    ...(registry === undefined ? {} : { tools: { registry, maxSteps: node.maxSteps } }),
  });
}

function resolveTransform(
  deps: LiveExecutionRegistryDeps,
  node: Extract<ValueNode, { type: 'transform' }>
): NodeExecution | undefined {
  const ports = deps.compute.resolvePorts(node.transform, node.version);
  if (ports === undefined) return undefined;
  return createTransformExecution({ compute: deps.compute, ports, schemas: deps.schemas });
}

function resolveSubWorkflow(
  deps: LiveExecutionRegistryDeps,
  node: Extract<ValueNode, { type: 'subWorkflow' }>
): NodeExecution | undefined {
  const binding = deps.subWorkflows.resolve(node.ref, node.version);
  if (binding === undefined) return undefined;
  return createSubWorkflowExecution({
    ports: binding.ports,
    run: binding.run,
    schemas: deps.schemas,
  });
}
