import { NodeId, PortId } from '@hushbox/shared';
import type { Edge, Node, OptionalTag, PortRef, TypeTag } from '@hushbox/shared';

/**
 * A typed handle on one producer port. The tag is the builder's claim, used
 * for type-level wiring and nested-port derivation; the compiler re-derives
 * channel truth from the registries at build().
 */
export interface Port<T extends TypeTag = TypeTag> {
  readonly ref: PortRef;
  readonly tag: T;
}

/**
 * Producer tags a consumer declared as `To` accepts, at the kind level. The
 * shared tag interfaces are not generic, so json schema names and media mime
 * sets are not distinguishable here — `isAssignable` settles those at
 * build(). Optional consumers accept any producer (optional introduction).
 */
export type AssignableTag<To extends TypeTag> = To extends OptionalTag
  ? TypeTag
  : Extract<TypeTag, { kind: To['kind'] }>;

/**
 * One built node plus everything it contributes to the definition: nested
 * body nodes ride along, so each handle is passed to buildWorkflow exactly
 * once and bodies never appear in the caller's node list.
 */
export interface NodeHandle<O extends TypeTag = TypeTag> {
  readonly node: Node;
  readonly out: Port<O>;
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

/** The default producer port id every builder function assigns. */
export const DEFAULT_OUT_PORT_ID = 'out';

/** Option fields common to every node builder. */
export interface NodeOptionsBase {
  readonly id: string;
  readonly version?: number;
  readonly optional?: boolean;
  readonly onError?: 'fail' | 'skip';
}

export function portRef(node: string, port: string): PortRef {
  return { node: NodeId.parse(node), port: PortId.parse(port) };
}

/**
 * Raw base fields for Node.parse: defaults for optional/onError come from
 * the schema, so they are spread in only when the caller set them.
 */
export function baseNodeFields(options: NodeOptionsBase): Record<string, unknown> {
  return {
    id: options.id,
    version: options.version ?? 1,
    out: DEFAULT_OUT_PORT_ID,
    ...(options.optional === undefined ? {} : { optional: options.optional }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };
}

/**
 * The persisted input-schema field for a node whose declared input is a named
 * json tag — derived from the `accepts` claim the caller already made rather
 * than declared a second time, so the compile-time tag and the persisted field
 * cannot name different schemas. A text (or media) input persists nothing: the
 * model's own derived port already says it.
 */
export function persistedInputSchema(accepts: TypeTag): Record<string, unknown> {
  return accepts.kind === 'json' ? { inputSchema: accepts.schemaName } : {};
}
