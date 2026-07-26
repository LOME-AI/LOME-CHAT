import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  parseReasoningText,
  ReasoningWire,
  reasoningPlanModelFrom,
  smartModelClassifierDimensions,
  textTag,
} from '@hushbox/shared';
import { planReasoningOff } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import {
  parseClassifierAnswer,
  pickClassifiedEffortPlan,
  resolveClassifiedEffort,
} from '@hushbox/shared/affordability/smart-model/effort-dimension';
import { resolveClassifierOutput } from '@hushbox/shared/affordability/smart-model/resolve';
import { err } from '../../../lib/result/index.js';
import { truncateForClassifier } from './classifier-context.js';
import { buildClassifierMessages } from './classifier-messages.js';
import { streamModelCall } from './model-call-execution.js';
import { validateNodeInput } from './node-input.js';
import type {
  ChatHistoryMessage,
  ClassifierEffortLevel,
  InferenceRequest,
  ModelDescriptor,
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

  // The dimensions this node's classifier call actually classifies — derived
  // through the ONE shared authority admission's classifier-reserve condition
  // also reads, so a generation happens exactly when a reserve was held.
  const dimensions = smartModelClassifierDimensions(node);
  // Only a MODEL-routing turn is badged Smart Model; a pinned-model
  // auto-effort turn (`classify.model === false`) keeps the user's own pick
  // unbadged. Legacy parity holds for the declared-model shapes: the
  // single-eligible short-circuit still badges (the Smart pipeline ran).
  const badged = node.classify?.model ?? true;
  const cheapest = node.candidates[0];
  /* v8 ignore next -- the node schema requires at least one candidate */
  if (cheapest === undefined) return err({});
  // Short-circuit: no active dimension means nothing to classify — zero
  // classifier generations, zero classifier charge; the answer streams
  // straight from the only candidate.
  if (!dimensions.model && !dimensions.effort) {
    return answerCall(deps, { node, modelId: cheapest.id, prompt, ctx, smartModelRan: badged });
  }

  const classified = await classifierCall(deps, { node, prompt, ctx, dimensions });
  // A trip of the cost circuit (or a stop) during the classifier phase aborts
  // the run signal; refuse the answer call rather than spend more.
  if (ctx.signal.aborted) return err({});
  return answerCall(deps, {
    node,
    modelId: classified.resolvedId ?? cheapest.id,
    prompt,
    ctx,
    smartModelRan: badged,
    ...classifiedAnswerExtras(classified),
  });
}

/** The classified outcome's optional answer-call fields, spread when present. */
function classifiedAnswerExtras(
  classified: ClassifierOutcome
): Pick<AnswerCallArgs, 'effort' | 'classifierCharge'> {
  return {
    ...(classified.effort === undefined ? {} : { effort: classified.effort }),
    ...(classified.charge === undefined ? {} : { classifierCharge: classified.charge }),
  };
}

interface ClassifierOutcome {
  /** The candidate the classifier picked, or undefined for the fallback. */
  readonly resolvedId?: string;
  /**
   * The classified canonical effort level — present iff the effort dimension
   * was requested. Unresolvable output AND classifier error both fall back to
   * `medium` (the classifier stage's documented auto fallback); only the
   * charge differs (a generation that ran bills, an error does not).
   */
  readonly effort?: ClassifierEffortLevel;
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
interface ClassifierDimensions {
  readonly model: boolean;
  readonly effort: boolean;
}

interface ClassifierCallArgs {
  readonly node: SmartModelNode;
  readonly prompt: string;
  readonly ctx: NodeRunContext;
  readonly dimensions: ClassifierDimensions;
}

/** The classifier generation's request: prompt composed from the requested dimensions. */
function classifierRequest(
  deps: SmartModelExecutionDeps,
  args: ClassifierCallArgs
): InferenceRequest {
  const { node, prompt, ctx, dimensions } = args;
  const messages = buildClassifierMessages({
    truncatedContext: truncateForClassifier({
      latestUserMessage: prompt,
      latestAssistantMessage: latestAssistantMessage(ctx.history),
    }),
    ...(dimensions.model
      ? {
          eligibleModels: node.candidates.map((candidate) => ({
            id: candidate.id,
            description: candidate.description ?? '',
          })),
        }
      : {}),
    ...(dimensions.effort ? { classifyEffort: true } : {}),
  });
  return {
    model: node.classifierModelId,
    // InferenceRequest has no system role/channel: the classifier's system
    // prompt rides as a leading plain-text part ahead of the user part. When
    // the inference contract gains a system channel, this mapping is the seam
    // to migrate.
    inputs: messages.map((message) => ({ modality: 'text', text: message.content })),
    parameters: { maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP },
    outputs: deps.classifier.descriptor.outputs,
  };
}

/**
 * The per-dimension resolution of one classifier generation's value. A
 * reasoning-streaming classifier model yields a canonical-inline-prefixed
 * value (same-field doctrine); only the parsed ANSWER is routing output —
 * the raw value would resolve nowhere. The medium fallback applies whenever
 * the effort dimension gets no confident answer.
 */
function resolveClassifierValue(
  value: unknown,
  node: SmartModelNode,
  dimensions: ClassifierDimensions
): Pick<ClassifierOutcome, 'resolvedId' | 'effort'> {
  const parts =
    typeof value === 'string'
      ? parseClassifierAnswer(parseReasoningText(value).answer, dimensions)
      : null;
  const resolvedId =
    parts !== null && dimensions.model
      ? resolveClassifierOutput(
          parts.modelText,
          node.candidates.map((candidate) => candidate.id)
        )
      : null;
  const effort =
    parts !== null && dimensions.effort ? resolveClassifiedEffort(parts.effortText) : null;
  return {
    ...(resolvedId === null ? {} : { resolvedId }),
    ...(effort === null ? mediumFallback(dimensions) : { effort }),
  };
}

/**
 * The effort dimension's fallback on EVERY non-answer (unresolvable output
 * and thrown classifier alike) — auto is the server's choice, and medium is
 * its documented fallback. Empty when effort was not requested.
 */
function mediumFallback(dimensions: ClassifierDimensions): Pick<ClassifierOutcome, 'effort'> {
  return dimensions.effort ? { effort: 'medium' } : {};
}

async function classifierCall(
  deps: SmartModelExecutionDeps,
  args: ClassifierCallArgs
): Promise<ClassifierOutcome> {
  const { node, ctx, dimensions } = args;
  const request = classifierRequest(deps, args);
  // No emit: classifier tokens are routing internals, never client content.
  // Legacy parity: the classifier stage catches ANY throw from the classifier
  // generation — not just typed Result failures — and still reports the stage
  // as having run. The catch is scoped to the provider call ALONE; a defect in
  // the post-call routing below (accrual, output resolution) still propagates.
  // A thrown classifier generation (any shape) is survivable: fall back to the
  // cheapest candidate with no charge. This is an EXPECTED degrade, not a defect,
  // so it emits a non-Sentry structured breadcrumb (model id only — never the
  // error, prompt, or output) and never fires captureError.
  let result: Result<NodeRunSuccess, NodeRunError>;
  try {
    result = await streamModelCall({ ...deps, binding: deps.classifier }, request, {
      signal: ctx.signal,
    });
    // eslint-disable-next-line catch-swallow/no-silent-catch -- expected degrade: breadcrumb below, no Sentry (see note above)
  } catch {
    deps.telemetry?.warn('smartModel classifier failed; falling back to cheapest candidate', {
      modelName: node.classifierModelId,
    });
    return { ...mediumFallback(dimensions) };
  }
  // Classifier failure is survivable by design: fall back to the cheapest
  // candidate with no charge (no generation happened).
  if (result.isErr()) return { ...mediumFallback(dimensions) };
  const success = result.value;
  ctx.accrue?.(success.costNanoUsd);
  return {
    ...resolveClassifierValue(success.value, node, dimensions),
    /* v8 ignore start -- streamModelCall (a modelCall) always resolves billing and isEstimated on success; NodeRunSuccess types them optional only because the shape is shared with non-modelCall executions, so both the billing-absent arm and the isEstimated fallback are unreachable here */
    ...(success.billing === undefined
      ? {}
      : {
          charge: {
            keySuffix: 'classifier',
            billing: success.billing,
            billableCostNanoUsd: success.costNanoUsd,
            isEstimated: success.isEstimated ?? false,
          },
        }),
    /* v8 ignore stop */
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
  /** The routing pipeline ran — badge the answer even if the classifier didn't bill. */
  readonly smartModelRan?: boolean;
  /** The classified canonical effort to apply to the answer call (auto turns). */
  readonly effort?: ClassifierEffortLevel;
}

/**
 * The node params for a hard-off (`none`) turn, applied per resolved
 * candidate: the build stamps ONE `{ enabled: false }` wire shared by every
 * candidate, but the hard-off ruling binds only reasoning-capable
 * NON-MANDATORY models. The shared off plan is the feasibility authority —
 * a mandatory candidate cannot disable (it keeps reasoning rather than
 * failing the whole server-picked composite) and a non-reasoning candidate
 * has nothing to turn off, so both drop the wire from the answer call.
 * Non-off wires never appear in smartModel params (classified effort is
 * carved in at runtime, never built in), so they pass through untouched.
 */
function paramsRespectingHardOff(
  base: Readonly<Record<string, unknown>>,
  descriptor: ModelDescriptor
): Readonly<Record<string, unknown>> {
  const wire = ReasoningWire.safeParse(base['reasoning']);
  if (!wire.success || !('enabled' in wire.data)) return base;
  if (planReasoningOff(reasoningPlanModelFrom(descriptor), 1).feasible) return base;
  return Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'reasoning'));
}

/**
 * The answer call's parameters for the RESOLVED candidate: its OWN affordable
 * cap (`cap(m)`, stamped per candidate at admission) becomes the completion
 * `maxOutputTokens`, and the classified effort is carved INTO that cap — the
 * shared positional pick maps the canonical level onto the model's offered
 * ladder and returns a plan whose `maxTokens` equals `cap(m)`, so the classified
 * choice can never spend past what admission reserved for THIS model. When no
 * effort was classified, delegates to `paramsRespectingHardOff` (forwards or
 * strips a built hard-off wire); the cap stays untouched when the model offers
 * no level or carries no integer cap (G2 — a reasoning budget never rides a call
 * without an explicit `max_tokens`).
 */
function answerParamsWithEffort(
  node: SmartModelNode,
  descriptor: ModelDescriptor,
  effort: ClassifierEffortLevel | undefined,
  candidateMaxOutputTokens: number | undefined
): Readonly<Record<string, unknown>> {
  const base =
    candidateMaxOutputTokens === undefined
      ? node.params
      : { ...node.params, maxOutputTokens: candidateMaxOutputTokens };
  if (effort === undefined) return paramsRespectingHardOff(base, descriptor);
  const cap = base['maxOutputTokens'];
  if (typeof cap !== 'number') return base;
  const plan = pickClassifiedEffortPlan(reasoningPlanModelFrom(descriptor), effort, cap);
  if (plan === undefined) return base;
  return { ...base, reasoning: plan.wire, maxOutputTokens: plan.maxTokens };
}

async function answerCall(
  deps: SmartModelExecutionDeps,
  args: AnswerCallArgs
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const { node, modelId, prompt, ctx, classifierCharge, smartModelRan } = args;
  const binding = deps.candidates.get(modelId);
  if (binding === undefined) {
    // The registry resolved every candidate binding when it resolved the node,
    // and resolution only ever picks from the node's own candidate list.
    throw new Error(`smartModel: no binding for resolved candidate '${modelId}'`);
  }
  const history = ctx.history;
  // Custom instructions shape the ANSWER only — the classifier is routing
  // internals. They ride the run-scoped ctx (never the definition), so the
  // answer node picks them up with no per-builder wiring.
  const customInstructions = ctx.customInstructions;
  // The resolved candidate's OWN affordable cap (stamped per candidate at
  // admission) — the reservation held exactly this at this model's rate.
  const candidateMaxOutputTokens = node.candidates.find(
    (candidate) => candidate.id === modelId
  )?.maxOutputTokens;
  const request: InferenceRequest = {
    model: modelId,
    inputs: [{ modality: 'text', text: prompt }],
    parameters: answerParamsWithEffort(
      node,
      binding.descriptor,
      args.effort,
      candidateMaxOutputTokens
    ),
    outputs: binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
    ...(customInstructions === undefined ? {} : { customInstructions }),
  };
  const result = await streamModelCall({ ...deps, binding }, request, ctx);
  if (classifierCharge === undefined && smartModelRan !== true) return result;
  return result.map((success) => ({
    ...success,
    ...(smartModelRan === true ? { smartModelRan: true } : {}),
    ...(classifierCharge === undefined ? {} : { auxiliaryCharges: [classifierCharge] }),
  }));
}
