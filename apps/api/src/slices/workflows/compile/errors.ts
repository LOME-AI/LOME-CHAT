/**
 * The closed CompileError code union for graph-compile validation.
 * Every error carries a deterministic code plus the node/edge it points at;
 * `compileDefinition` returns the full list, never throws for expected
 * definition defects.
 */
export const COMPILE_ERROR_CODES = [
  'invalid_definition',
  'invalid_type_tag',
  'reserved_node_id',
  'reserved_port_id',
  'duplicate_node_id',
  'unknown_node_ref',
  'unknown_node_version',
  'node_config_unresolved',
  'unknown_schema_name',
  'unknown_predicate',
  'unknown_reducer',
  'reducer_arity_mismatch',
  'unknown_workflow_input',
  'unknown_port',
  'type_mismatch',
  'missing_input',
  'duplicate_input_edge',
  'port_ref_mismatch',
  'body_type_mismatch',
  'fan_out_over_not_list',
  'cycle_detected',
  'node_count_exceeded',
  'fan_out_width_exceeded',
  'loop_iterations_exceeded',
  'model_steps_exceeded',
] as const;

export type CompileErrorCode = (typeof COMPILE_ERROR_CODES)[number];

/** Brand-free port reference for error payloads (display, not wiring). */
export interface PortRefLike {
  readonly node: string;
  readonly port: string;
}

export interface EdgeRefLike {
  readonly from: PortRefLike;
  readonly to: PortRefLike;
}

export interface CompileError {
  readonly code: CompileErrorCode;
  readonly detail: string;
  readonly nodeId?: string;
  readonly edge?: EdgeRefLike;
}

export interface CompileErrorRef {
  readonly nodeId?: string;
  readonly edge?: EdgeRefLike;
}

export function compileError(
  code: CompileErrorCode,
  detail: string,
  ref: CompileErrorRef = {}
): CompileError {
  return {
    code,
    detail,
    ...(ref.nodeId === undefined ? {} : { nodeId: ref.nodeId }),
    ...(ref.edge === undefined ? {} : { edge: ref.edge }),
  };
}
