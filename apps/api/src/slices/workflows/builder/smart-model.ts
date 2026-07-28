import { Node, textTag } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, persistedInputSchema, portRef } from './ports.js';
import type { TextTag, TypeTag } from '@hushbox/shared';
import type { AssignableTag, NodeHandle, NodeOptionsBase, Port } from './ports.js';

/** One routable candidate: the model id, its classifier-prompt line, and the
 * admission-derived affordable answer cap the execution applies for THIS model. */
export interface SmartModelCandidate {
  readonly id: string;
  readonly description?: string;
  readonly maxOutputTokens?: number;
}

export interface SmartModelOptions<A extends TypeTag = TextTag> extends NodeOptionsBase {
  /**
   * The turn's classifier engine. The slot does not call it — the classifier is
   * its own node — but it stays on this node because the admission estimate reads
   * it here to price the turn's one classifier reserve.
   */
  readonly classifierModelId: string;
  /** The routable set. The slot takes the first entry as its declared fallback. */
  readonly candidates: readonly SmartModelCandidate[];
  /**
   * The classifier dimensions to request (D3). Absent = the legacy Smart
   * Model shape (`{ model: true, effort: false }`); a pinned-model
   * auto-effort turn declares `{ model: false, effort: true }`.
   */
  readonly classify?: { readonly model: boolean; readonly effort: boolean };
  /** Answer-call parameters, shared by every candidate. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Admission-only prompt input-token count for the candidate answer legs;
   * bounds the estimate's input leg, never forwarded to the provider. */
  readonly promptInputTokens?: number;
  /**
   * The input tag this slot's single port declares — type-level wiring only.
   * Text is the prompt itself; a named json tag is the turn's decision envelope,
   * which the slot reads its prompt out of.
   */
  readonly accepts: A;
  readonly in: Port<AssignableTag<A>>;
}

/**
 * The Smart Model slot: the node that carries the candidate set and binds the
 * turn's decision to one of them. Its output is text — the bound candidate's
 * answer; its single input is whatever `accepts` declares.
 */
export function smartModel<A extends TypeTag>(options: SmartModelOptions<A>): NodeHandle<TextTag> {
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
    ...persistedInputSchema(options.accepts),
    in: options.in.ref,
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: textTag() },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}
