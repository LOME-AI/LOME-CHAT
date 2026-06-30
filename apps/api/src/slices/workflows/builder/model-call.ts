import { Node } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { TypeTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

export interface ModelCallOptions<A extends TypeTag, O extends TypeTag> extends NodeOptionsBase {
  readonly model: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** The input tag this call's registration declares — type-level wiring only. */
  readonly accepts: A;
  readonly in: Port<AssignableTag<A>>;
  /** The output tag this call's registration declares — the out-port claim. */
  readonly produces: O;
  readonly maxSteps?: number;
}

export function modelCall<A extends TypeTag, O extends TypeTag>(
  options: ModelCallOptions<A, O>
): NodeHandle<O> {
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'modelCall',
    model: options.model,
    params: options.params ?? {},
    in: options.in.ref,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: options.produces },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}
