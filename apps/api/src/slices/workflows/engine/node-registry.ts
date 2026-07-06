import { MODEL_CALL_IMPL_VERSION } from './live-execution-registry.js';
import type { NodePortDeclaration, NodeType } from '@hushbox/shared';
import type { TransformCompute } from '../../media/index.js';
import type { NodeRegistryContext, ValueNode } from '../compile/context.js';
import type { ModelResolver } from './live-execution-registry.js';

/**
 * The production compile-time node registry the graph compiler validates
 * against: the closed node set at its pinned implementation versions, and the
 * declared ports of each value node. It reads model ports through the SAME
 * `ModelResolver` the runtime execution registry binds, so a model that
 * compiles is exactly a model that can run — the two never diverge.
 */

/**
 * Control-flow nodes (fanOut/fanIn/branch/loop) are interpreted inline by the
 * engine at this single version; there is no per-name registry for them, so a
 * definition pins them here.
 */
const CONTROL_FLOW_IMPL_VERSION = 1;

export interface NodeRegistryDeps {
  readonly models: ModelResolver;
  readonly compute: TransformCompute;
}

export function createNodeRegistry(deps: NodeRegistryDeps): NodeRegistryContext {
  return {
    hasNode: (type, version) => hasNode(type, version),
    resolveValuePorts: (node) => resolveValuePorts(deps, node),
  };
}

function hasNode(type: NodeType, version: number): boolean {
  switch (type) {
    case 'modelCall': {
      return version === MODEL_CALL_IMPL_VERSION;
    }
    case 'fanOut':
    case 'fanIn':
    case 'branch':
    case 'loop': {
      return version === CONTROL_FLOW_IMPL_VERSION;
    }
    case 'transform':
    case 'subWorkflow': {
      // The (name, version) pin lives in resolveValuePorts — transform through
      // the media compute registry, subWorkflow through a (deferred) catalog —
      // so the type-level gate only confirms membership in the closed node set.
      return true;
    }
  }
}

function resolveValuePorts(
  deps: NodeRegistryDeps,
  node: ValueNode
): NodePortDeclaration | undefined {
  switch (node.type) {
    case 'modelCall': {
      return deps.models.resolve(node.model)?.ports;
    }
    case 'transform': {
      return deps.compute.resolvePorts(node.transform, node.version);
    }
    case 'subWorkflow': {
      // Deferred: no sub-workflow catalog exists yet, so every subWorkflow
      // fails closed to node_config_unresolved. Wiring a resolver here is the
      // only change needed to enable it.
      return undefined;
    }
  }
}
