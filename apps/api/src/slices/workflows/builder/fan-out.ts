import { listTag, Node, optionalTag } from '@hushbox/shared';
import { FAN_OUT_ELEMENT_PORT_ID, FAN_OUT_OVER_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { ListTag, TypeTag } from '@hushbox/shared';
import type { NodeHandle, NodeOptionsBase, Port } from './ports.js';

export interface FanOutOptions<E extends TypeTag, O extends TypeTag> extends NodeOptionsBase {
  /** The collection-valued producer the fan-out iterates. */
  readonly over: Port<ListTag>;
  readonly maxWidth: number;
  /**
   * Builds the body around the fan-out's per-branch element port. The shared
   * ListTag is not generic, so the element's static type is the explicit E
   * type argument; the compiler validates the real element channel.
   */
  readonly body: (element: Port<E>) => NodeHandle<O>;
}

export function fanOut<E extends TypeTag = TypeTag, O extends TypeTag = TypeTag>(
  options: FanOutOptions<E, O>
): NodeHandle<ListTag> {
  const element: Port<E> = {
    ref: portRef(options.id, FAN_OUT_ELEMENT_PORT_ID),
    // The runtime claim is the over-list's inner tag; E only narrows it for
    // type-level wiring inside the body.
    tag: options.over.tag.inner as E,
  };
  const body = options.body(element);
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'fanOut',
    over: options.over.ref,
    body: body.node.id,
    maxWidth: options.maxWidth,
  });
  // Optional branches make the collected elements maybe-absent.
  const collected = body.node.optional ? optionalTag(body.out.tag) : body.out.tag;
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: listTag(collected) },
    nodes: [node, ...body.nodes],
    edges: [
      { from: options.over.ref, to: portRef(options.id, FAN_OUT_OVER_PORT_ID) },
      ...body.edges,
    ],
  };
}
