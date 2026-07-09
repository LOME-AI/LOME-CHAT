import { Node, textTag } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { TextTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

/** One routable candidate: the model id plus its classifier-prompt line. */
export interface SmartModelCandidate {
  readonly id: string;
  readonly description?: string;
}

export interface SmartModelOptions extends NodeOptionsBase {
  /** The classifier model — by construction the cheapest candidate. */
  readonly classifierModelId: string;
  /** Sorted ascending by price; the first entry is the fallback. */
  readonly candidates: readonly SmartModelCandidate[];
  /** Answer-call parameters (the classifier call sets only its output cap). */
  readonly params?: Readonly<Record<string, unknown>>;
  readonly in: Port<AssignableTag<TextTag>>;
}

/**
 * The composite Smart Model node: classify → resolve → answer as ONE
 * capability node. Its ports are fixed text→text — the prompt in, the
 * resolved candidate's answer out.
 */
export function smartModel(options: SmartModelOptions): NodeHandle<TextTag> {
  const node = Node.parse({
    ...baseNodeFields(options),
    type: 'smartModel',
    classifierModelId: options.classifierModelId,
    candidates: options.candidates,
    ...(options.params === undefined ? {} : { params: options.params }),
    in: options.in.ref,
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: textTag() },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}
