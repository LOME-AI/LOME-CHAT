import { Node } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { TypeTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

export interface TransformOptions<A extends TypeTag, O extends TypeTag> extends NodeOptionsBase {
  readonly transform: string;
  /** The input tag this transform's registration declares — type-level wiring only. */
  readonly accepts: A;
  readonly in: Port<AssignableTag<A>>;
  /** The output tag this transform's registration declares — the out-port claim. */
  readonly produces: O;
}

export function transform<A extends TypeTag, O extends TypeTag>(
  options: TransformOptions<A, O>
): NodeHandle<O> {
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'transform',
    transform: options.transform,
    in: options.in.ref,
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: options.produces },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}
