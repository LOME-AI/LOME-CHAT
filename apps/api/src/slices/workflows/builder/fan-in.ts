import { Node } from '@hushbox/shared';
import { positionalInputPortId } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { Edge, TypeTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

/** One typed port per reducer tuple position. */
export type PortsFor<Ins extends readonly TypeTag[]> = {
  readonly [K in keyof Ins]: Port<AssignableTag<Ins[K]>>;
};

export interface FanInOptions<
  Ins extends readonly TypeTag[],
  O extends TypeTag,
> extends NodeOptionsBase {
  readonly reducer: string;
  /** The reducer's registered input tuple — type-level wiring only. */
  readonly accepts: Ins;
  readonly ins: PortsFor<Ins>;
  /** The reducer's registered output tag — the out-port claim. */
  readonly produces: O;
}

export function fanIn<const Ins extends readonly TypeTag[], O extends TypeTag>(
  options: FanInOptions<Ins, O>
): NodeHandle<O> {
  const ports = options.ins as readonly Port[];
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'fanIn',
    reducer: options.reducer,
    ins: ports.map((port) => port.ref),
  });
  const edges: Edge[] = ports.map((port, index) => ({
    from: port.ref,
    to: portRef(options.id, positionalInputPortId(index)),
  }));
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: options.produces },
    nodes: [node],
    edges,
  };
}
