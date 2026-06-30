import { Node } from '@hushbox/shared';
import { positionalInputPortId } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { Edge, TypeTag } from '@hushbox/shared';
import type { NodeHandle, NodeOptionsBase, Port } from './ports.js';

export interface SubWorkflowOptions<O extends TypeTag> extends NodeOptionsBase {
  readonly ref: string;
  /**
   * Positional inputs; the referenced workflow's port shapes live in the
   * registry, so positions are only checkable at build().
   */
  readonly ins: readonly Port[];
  readonly produces: O;
}

export function subWorkflow<O extends TypeTag>(options: SubWorkflowOptions<O>): NodeHandle<O> {
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'subWorkflow',
    ref: options.ref,
  });
  const edges: Edge[] = options.ins.map((port, index) => ({
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
