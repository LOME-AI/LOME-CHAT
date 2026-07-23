import { Node, textTag } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, portRef } from './ports.js';
import type { TextTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

/** One routable candidate: the model id, its classifier-prompt line, and the
 * admission-derived affordable answer cap the execution applies for THIS model. */
export interface SmartModelCandidate {
  readonly id: string;
  readonly description?: string;
  readonly maxOutputTokens?: number;
}

export interface SmartModelOptions extends NodeOptionsBase {
  /** The classifier model — by construction the cheapest candidate. */
  readonly classifierModelId: string;
  /** Sorted ascending by price; the first entry is the fallback. */
  readonly candidates: readonly SmartModelCandidate[];
  /**
   * The classifier dimensions to request (D3). Absent = the legacy Smart
   * Model shape (`{ model: true, effort: false }`); a pinned-model
   * auto-effort turn declares `{ model: false, effort: true }`.
   */
  readonly classify?: { readonly model: boolean; readonly effort: boolean };
  /** Answer-call parameters (the classifier call sets only its output cap). */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Admission-only prompt input-token count for the candidate answer legs;
   * bounds the estimate's input leg, never forwarded to the provider. */
  readonly promptInputTokens?: number;
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
    ...(options.classify === undefined ? {} : { classify: options.classify }),
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: options.promptInputTokens }),
    in: options.in.ref,
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: textTag() },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}
