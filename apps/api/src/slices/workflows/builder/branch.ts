import { Node } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { NodeId, TypeTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

/** A case target: a built node, or the reserved end sentinel's NodeId. */
export type BranchTarget = NodeHandle | NodeId;

export interface BranchOptions<A extends TypeTag> extends NodeOptionsBase {
  readonly predicate: string;
  /** The predicate's registered input tag — type-level wiring only. */
  readonly accepts: A;
  readonly in: Port<AssignableTag<A>>;
  readonly cases: Readonly<Record<string, BranchTarget>>;
  readonly else: BranchTarget;
}

/**
 * The branch's out channel passes its consumed value through, so downstream
 * nodes may pick the routed value up — hence NodeHandle<A>.
 */
export function branch<A extends TypeTag>(options: BranchOptions<A>): NodeHandle<A> {
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'branch',
    predicate: options.predicate,
    cases: Object.fromEntries(
      Object.entries(options.cases).map(([label, target]) => [label, targetId(target)])
    ),
    else: targetId(options.else),
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: options.accepts },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}

function targetId(target: BranchTarget): string {
  return typeof target === 'string' ? target : target.node.id;
}
