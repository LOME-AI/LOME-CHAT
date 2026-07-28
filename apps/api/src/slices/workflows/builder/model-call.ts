import { Node } from '@hushbox/shared';
import { SINGLE_INPUT_PORT_ID } from '../compile/conventions.js';
import { baseNodeFields, DEFAULT_OUT_PORT_ID, persistedInputSchema, portRef } from './ports.js';
import type { ResolvedReasoningEffort, TypeTag } from '@hushbox/shared';
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
  /** Server-side tool names the call may use (resolved at execution wiring). */
  readonly tools?: readonly string[];
  /** Admission-only prompt input-token count; bounds the estimate's input leg,
   * never forwarded to the provider. */
  readonly promptInputTokens?: number;
  /** The reasoning rung this call's built wire runs at; never forwarded to the
   * provider. Absent when the call reasons at a level decided at runtime, or
   * not at all. */
  readonly reasoningEffort?: ResolvedReasoningEffort;
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
    ...persistedInputSchema(options.accepts),
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: options.promptInputTokens }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  });
  return {
    node,
    out: { ref: portRef(options.id, DEFAULT_OUT_PORT_ID), tag: options.produces },
    nodes: [node],
    edges: [{ from: options.in.ref, to: portRef(options.id, SINGLE_INPUT_PORT_ID) }],
  };
}
