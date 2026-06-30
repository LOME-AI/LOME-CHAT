import { Node } from '@hushbox/shared';
import { LOOP_STATE_PORT_ID, SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { TypeTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

export interface LoopOptions<S extends TypeTag> extends NodeOptionsBase {
  readonly until: string;
  readonly maxIterations: number;
  /** Feeds the loop's input channel; its tag is the iteration state's tag. */
  readonly initial: Port<S>;
  /**
   * Builds the body around the loop's state port; the body's output must
   * re-enter the state channel, so its kind is pinned to the state's.
   */
  readonly body: (state: Port<S>) => NodeHandle<AssignableTag<S>>;
}

export function loop<S extends TypeTag>(options: LoopOptions<S>): NodeHandle<S> {
  const state: Port<S> = {
    ref: portRef(options.id, LOOP_STATE_PORT_ID),
    tag: options.initial.tag,
  };
  const body = options.body(state);
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'loop',
    body: body.node.id,
    until: options.until,
    maxIterations: options.maxIterations,
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: options.initial.tag },
    nodes: [node, ...body.nodes],
    edges: [
      { from: options.initial.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) },
      ...body.edges,
    ],
  };
}
