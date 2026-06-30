import type {
  NamedConstraintRegistry,
  Node,
  NodePortDeclaration,
  NodeType,
  TypeTag,
} from '@hushbox/shared';

/** Node variants whose ports come from the node registry, not graph context. */
export type ValueNode = Extract<Node, { type: 'modelCall' | 'transform' | 'subWorkflow' }>;

/**
 * The lookup contract the compiler validates against. The live node registry
 * lives elsewhere in this slice; tests and the builder inject fakes.
 * Structural nodes (fanOut, fanIn, branch, loop) only need `hasNode` — their
 * ports are computed from the constraint registry and graph context.
 */
export interface NodeRegistryContext {
  /** (type, version) existence — the dangling-version check. */
  hasNode(type: NodeType, version: number): boolean;
  /**
   * Declared ports for value nodes. `undefined` means the node's own config
   * does not resolve (unknown model, transform, or sub-workflow ref) —
   * reported as `node_config_unresolved`.
   */
  resolveValuePorts(node: ValueNode): NodePortDeclaration | undefined;
}

/**
 * Compile-time ceilings on the per-node declared bounds admission prices
 * (hold estimate = max width × max steps × max iterations). Injected so the
 * save-path and engine can tighten them without a code change.
 */
export interface CompileLimits {
  readonly maxNodes: number;
  readonly maxFanOutWidth: number;
  readonly maxLoopIterations: number;
  readonly maxModelCallSteps: number;
}

/**
 * maxFanOutWidth default mirrors the platform's 6-simultaneous-outbound-
 * connections cap (wider declared fan-out only queues at the socket layer
 * while admission still prices full width). The remaining defaults are
 * compile-policy bounds on admission exposure, not platform facts.
 */
export const DEFAULT_COMPILE_LIMITS: CompileLimits = {
  maxNodes: 64,
  maxFanOutWidth: 6,
  maxLoopIterations: 32,
  maxModelCallSteps: 16,
};

export interface CompileContext {
  readonly nodes: NodeRegistryContext;
  readonly constraints: NamedConstraintRegistry;
  /**
   * The declared workflow inputs: named ports on the reserved 'input' source
   * node. The definition format carries no input declarations of its own, so
   * the caller (builder, save-path, engine binder) supplies them here.
   */
  readonly workflowInputs: Readonly<Record<string, TypeTag>>;
  readonly limits?: CompileLimits;
}
