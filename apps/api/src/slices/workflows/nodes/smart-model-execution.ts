import {
  buildClassifierMessages,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  resolveClassifierOutput,
  textTag,
  truncateForClassifier,
} from '@hushbox/shared';
import { err } from '../../../lib/result/index.js';
import { streamModelCall } from './model-call-execution.js';
import { validateNodeInput } from './node-input.js';
import type {
  ChatHistoryMessage,
  InferenceRequest,
  Node,
  NodePortDeclaration,
  SchemaNameRegistry,
} from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type {
  NodeExecution,
  NodeGenerationCharge,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';
import type { ModelBinding, ModelCallStreamDeps } from './model-call-execution.js';

/**
 * The `smartModel` capability execution: a cheap classifier generation picks
 * the best candidate model for the latest exchange, then the answer streams
 * from it — two generations under one node, both settling in the run's single
 * fenced settlement (the classifier as an auxiliary charge keyed
 * `<node>#classifier`, anchored to the answer's content item).
 *
 * Semantics, stated exactly:
 * - a SINGLE candidate skips the classifier entirely (zero classifier charge);
 * - a classifier ERROR (no generation) falls back to the cheapest candidate
 *   with no classifier charge — the run still succeeds;
 * - an UNRESOLVABLE classifier output falls back the same way, but the
 *   classifier's charge STANDS (it produced a generation);
 * - candidates arrive sorted ascending by price, so the cheapest — the
 *   fallback — is the first entry, and it doubles as the classifier model.
 *
 * The classifier's cost accrues toward the run's cost circuit through
 * `ctx.accrue` BEFORE the answer call; an accrual that trips the circuit
 * aborts the run signal, and the execution refuses to start the answer.
 * Classifier tokens never ride `ctx.emit` — only the answer streams.
 */

type SmartModelNode = Extract<Node, { type: 'smartModel' }>;

const SMART_MODEL_PORTS: NodePortDeclaration = { in: [textTag()], out: textTag() };

export interface SmartModelExecutionDeps extends Omit<ModelCallStreamDeps, 'binding'> {
  /** The classifier model's binding (by construction the cheapest candidate). */
  readonly classifier: ModelBinding;
  /** Every candidate's binding, keyed by model id — resolved with the node. */
  readonly candidates: ReadonlyMap<string, ModelBinding>;
  readonly schemas: SchemaNameRegistry;
}

export function createSmartModelExecution(deps: SmartModelExecutionDeps): NodeExecution {
  return {
    streaming: true,
    run: (node, input, ctx) => runSmartModel(deps, node as SmartModelNode, input, ctx),
  };
}

async function runSmartModel(
  deps: SmartModelExecutionDeps,
  node: SmartModelNode,
  input: readonly unknown[],
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(SMART_MODEL_PORTS, deps.schemas, input);
  if (validated.isErr()) return err(validated.error);
  const prompt = input[0] as string;

  // Single-candidate short-circuit: nothing to classify, zero classifier
  // charge — the answer streams straight from the only affordable model.
  const cheapest = node.candidates[0];
  /* v8 ignore next -- the node schema requires at least one candidate */
  if (cheapest === undefined) return err({});
  if (node.candidates.length === 1) {
    return answerCall(deps, { node, modelId: cheapest.id, prompt, ctx });
  }

  const classified = await classifierCall(deps, node, prompt, ctx);
  // A trip of the cost circuit (or a stop) during the classifier phase aborts
  // the run signal; refuse the answer call rather than spend more.
  if (ctx.signal.aborted) return err({});
  const resolvedId = classified.resolvedId ?? cheapest.id;
  return answerCall(deps, {
    node,
    modelId: resolvedId,
    prompt,
    ctx,
    ...(classified.charge === undefined ? {} : { classifierCharge: classified.charge }),
  });
}

interface ClassifierOutcome {
  /** The candidate the classifier picked, or undefined for the fallback. */
  readonly resolvedId?: string;
  /**
   * The classifier generation's charge — present whenever it actually ran
   * (even when its routing output was discarded); absent on classifier error,
   * which produced no generation.
   */
  readonly charge?: NodeGenerationCharge;
}

/** The last assistant turn in the run history, or '' on a first turn. */
function latestAssistantMessage(history: readonly ChatHistoryMessage[] | undefined): string {
  if (history === undefined) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === 'assistant') return message.content;
  }
  return '';
}

/**
 * The classifier generation: the truncated latest exchange plus the candidate
 * list, NO conversation history (the truncated context IS the input), output
 * capped, and never emitted to the client stream. Its cost accrues toward the
 * circuit immediately — before the answer call spends anything.
 */
async function classifierCall(
  deps: SmartModelExecutionDeps,
  node: SmartModelNode,
  prompt: string,
  ctx: NodeRunContext
): Promise<ClassifierOutcome> {
  const messages = buildClassifierMessages({
    truncatedContext: truncateForClassifier({
      latestUserMessage: prompt,
      latestAssistantMessage: latestAssistantMessage(ctx.history),
    }),
    eligibleModels: node.candidates.map((candidate) => ({
      id: candidate.id,
      description: candidate.description ?? '',
    })),
  });
  const request: InferenceRequest = {
    model: node.classifierModelId,
    // InferenceRequest has no system role/channel: the classifier's system
    // prompt rides as a leading plain-text part ahead of the user part. When
    // the inference contract gains a system channel, this mapping is the seam
    // to migrate.
    inputs: messages.map((message) => ({ modality: 'text', text: message.content })),
    parameters: { maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP },
    outputs: deps.classifier.descriptor.outputs,
  };
  // No emit: classifier tokens are routing internals, never client content.
  const result = await streamModelCall({ ...deps, binding: deps.classifier }, request, {
    signal: ctx.signal,
  });
  // Classifier failure is survivable by design: fall back to the cheapest
  // candidate with no charge (no generation happened).
  if (result.isErr()) return {};
  const success = result.value;
  ctx.accrue?.(success.costNanoUsd);
  const resolvedId =
    typeof success.value === 'string'
      ? resolveClassifierOutput(
          success.value,
          node.candidates.map((candidate) => candidate.id)
        )
      : null;
  return {
    ...(resolvedId === null ? {} : { resolvedId }),
    /* v8 ignore next -- streamModelCall always returns billing on success; the guard is a type narrowing */
    ...(success.billing === undefined
      ? {}
      : {
          charge: {
            keySuffix: 'classifier',
            billing: success.billing,
            baseCostNanoUsd: success.costNanoUsd,
            isEstimated: success.isEstimated ?? false,
          },
        }),
  };
}

/**
 * The answer generation: the resolved candidate, the node's params, the FULL
 * run history, streaming through the node's emit seam. The classifier charge
 * (when one exists) rides the success as an auxiliary charge so both
 * generations settle together.
 */
interface AnswerCallArgs {
  readonly node: SmartModelNode;
  readonly modelId: string;
  readonly prompt: string;
  readonly ctx: NodeRunContext;
  readonly classifierCharge?: NodeGenerationCharge;
}

async function answerCall(
  deps: SmartModelExecutionDeps,
  args: AnswerCallArgs
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const { node, modelId, prompt, ctx, classifierCharge } = args;
  const binding = deps.candidates.get(modelId);
  if (binding === undefined) {
    // The registry resolved every candidate binding when it resolved the node,
    // and resolution only ever picks from the node's own candidate list.
    throw new Error(`smartModel: no binding for resolved candidate '${modelId}'`);
  }
  const history = ctx.history;
  const request: InferenceRequest = {
    model: modelId,
    inputs: [{ modality: 'text', text: prompt }],
    parameters: node.params,
    outputs: binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
  };
  const result = await streamModelCall({ ...deps, binding }, request, ctx);
  if (classifierCharge === undefined) return result;
  return result.map((success) => ({ ...success, auxiliaryCharges: [classifierCharge] }));
}
