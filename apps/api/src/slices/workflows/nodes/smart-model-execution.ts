import {
  REASONING_OFF,
  ReasoningWire,
  planReasoningOff,
  reasoningPlanModelFrom,
  smartModelClassifierDimensions,
  textTag,
} from '@hushbox/shared';
import { pickClassifiedEffortPlan } from '@hushbox/shared/affordability/smart-model/effort-dimension';
import { resolveClassifierOutput } from '@hushbox/shared/affordability/smart-model/resolve';
import { err } from '../../../lib/result/index.js';
import { streamModelCall } from './model-call-execution.js';
import { validateNodeInput } from './node-input.js';
import { callInputOf, decisionOf } from './turn-decision.js';
import { portsAccepting } from '../engine/model-ports.js';
import type {
  ClassifierEffortLevel,
  InferenceRequest,
  ModelDescriptor,
  Node,
  NodePortDeclaration,
  ResolvedReasoningEffort,
  SchemaNameRegistry,
} from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type {
  NodeExecution,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';
import type { TurnDecision } from './turn-decision.js';
import type { ModelBinding, ModelCallStreamDeps } from './model-call-execution.js';

/**
 * The `smartModel` capability execution: the slot that carries the MODEL
 * dimension. It holds the candidate set — the only place a `MAX` over
 * alternatives is expressible — binds the turn's decision to one of them, and
 * streams the answer.
 *
 * It performs NO classification of its own. The decision arrives as a typed
 * envelope on the node's ordinary single input port, produced by a registered
 * reducer from an ordinary classifier `modelCall` (`docs/BILLING.md` §How the
 * decision reaches the answer), which is what makes the definition that is
 * priced the definition that executes.
 *
 * Semantics, stated exactly:
 * - a decision naming a candidate binds that candidate;
 * - anything else — no decision on the port, or an answer naming nothing in the
 *   list — binds the node's FIRST candidate as the declared fallback. This node
 *   never resolves outside its own candidate list, and every candidate's cost was
 *   priced into the reservation's `MAX`, so no arm of this function can bind a
 *   model the hold did not cover. Which entry is cheapest is the candidate
 *   producer's ordering guarantee, not this node's;
 * - the effort axis takes the decision's own level, and nothing when no
 *   decision arrived: the axis's ONE declared fallback lives in the reducer,
 *   which is the only place that knows the axis's cheapest option.
 */

type SmartModelNode = Extract<Node, { type: 'smartModel' }>;

const SMART_MODEL_PORTS: NodePortDeclaration = { in: [textTag()], out: textTag() };

export interface SmartModelExecutionDeps extends Omit<ModelCallStreamDeps, 'binding'> {
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
  const validated = validateNodeInput(
    portsAccepting(SMART_MODEL_PORTS, node.inputSchema),
    deps.schemas,
    input
  );
  if (validated.isErr()) return err(validated.error);
  // The slot reads the turn's prompt off the decision envelope when its port
  // declares one, and off the raw text otherwise — one input port either way.
  const decision = decisionOf(input[0]);
  const prompt = callInputOf(input[0]) as string;

  // Which axes this node is the resolver for — derived through the ONE shared
  // authority admission's classifier-reserve condition also reads.
  const dimensions = smartModelClassifierDimensions(node);
  // Only a MODEL-routing turn is badged Smart Model; a pinned-model
  // auto-effort turn (`classify.model === false`) keeps the user's own pick
  // unbadged.
  const badged = node.classify?.model ?? true;
  const cheapest = node.candidates[0];
  /* v8 ignore next -- the node schema requires at least one candidate */
  if (cheapest === undefined) return err({});

  const effort = decidedEffort(dimensions, decision);
  return answerCall(deps, {
    node,
    modelId: decidedCandidateId(node, dimensions, decision) ?? cheapest.id,
    prompt,
    ctx,
    smartModelRan: badged,
    ...(effort === undefined ? {} : { effort }),
  });
}

/**
 * The candidate the decision names, resolved WITHIN this node's own list —
 * `null` when the model axis is not this node's to resolve, no decision reached
 * it, or the answer named nothing in the list. Every `null` means the caller
 * applies the declared cheapest-presented fallback.
 */
function decidedCandidateId(
  node: SmartModelNode,
  dimensions: { readonly model: boolean },
  decision: TurnDecision | undefined
): string | null {
  if (!dimensions.model || decision === undefined) return null;
  return resolveClassifierOutput(
    decision.modelText,
    node.candidates.map((candidate) => candidate.id)
  );
}

/**
 * The effort the answer runs at: the decision's own already-resolved level.
 * `undefined` when the axis is not open for this turn, or when the axis IS open
 * and no decision reached the slot — the reducer owns the declared fallback (it
 * is the one place that knows the axis's cheapest option), so a slot that was
 * handed nothing rides its built params rather than inventing a second answer
 * to the same question.
 */
function decidedEffort(
  dimensions: { readonly effort: boolean },
  decision: TurnDecision | undefined
): ClassifierEffortLevel | undefined {
  if (!dimensions.effort) return undefined;
  return decision?.effort;
}

/**
 * The answer generation: the bound candidate, the node's params, the FULL run
 * history, streaming through the node's emit seam.
 */
interface AnswerCallArgs {
  readonly node: SmartModelNode;
  readonly modelId: string;
  readonly prompt: string;
  readonly ctx: NodeRunContext;
  /** The routing pipeline ran — badge the answer. */
  readonly smartModelRan?: boolean;
  /** The canonical effort to apply to the answer call (auto turns). */
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
  if (!carriesOffWire(base)) return base;
  if (planReasoningOff(reasoningPlanModelFrom(descriptor), 1).feasible) return base;
  return Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'reasoning'));
}

/** Whether these call parameters carry the hard-off wire — the one built shape. */
function carriesOffWire(parameters: Readonly<Record<string, unknown>>): boolean {
  const wire = ReasoningWire.safeParse(parameters['reasoning']);
  return wire.success && 'enabled' in wire.data;
}

/** What the answer call sends, and the rung its wire was minted at. */
interface DecidedCall {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly level?: ResolvedReasoningEffort;
}

/**
 * The answer call's parameters for the BOUND candidate: its OWN affordable
 * cap (`cap(m)`, stamped per candidate at admission) becomes the completion
 * `maxOutputTokens`, and the decided effort is carved INTO that cap — the
 * shared positional pick maps the canonical level onto the model's offered
 * ladder and returns a plan whose `maxTokens` equals `cap(m)`, so the decided
 * choice can never spend past what admission reserved for THIS model. With no
 * decided effort, delegates to `paramsRespectingHardOff` (forwards or strips a
 * built hard-off wire); the cap stays untouched when the model offers no level
 * or carries no integer cap (a reasoning budget never rides a call without an
 * explicit `max_tokens`).
 */
function answerParamsWithEffort(
  node: SmartModelNode,
  descriptor: ModelDescriptor,
  effort: ClassifierEffortLevel | undefined,
  candidateMaxOutputTokens: number | undefined
): DecidedCall {
  const base =
    candidateMaxOutputTokens === undefined
      ? node.params
      : { ...node.params, maxOutputTokens: candidateMaxOutputTokens };
  if (effort === undefined) return builtLevel(paramsRespectingHardOff(base, descriptor));
  const cap = base['maxOutputTokens'];
  if (typeof cap !== 'number') return builtLevel(base);
  const plan = pickClassifiedEffortPlan(reasoningPlanModelFrom(descriptor), effort, cap);
  if (plan === undefined) return builtLevel(base);
  return {
    parameters: { ...base, reasoning: plan.wire, maxOutputTokens: plan.maxTokens },
    level: plan.level,
  };
}

/**
 * The level a BUILT (rather than classified) slot wire runs at. The build stamps
 * exactly one wire shape here — the shared hard-off wire — and `off` is the rung
 * it names, so a surviving off wire records `off` and a stripped one records
 * nothing, per candidate. Any other pinned wire records no level: which rung a
 * budget wire named is not recoverable from the wire, and an under-recorded
 * level costs a badge where a guessed one would name the wrong rung.
 */
function builtLevel(parameters: Readonly<Record<string, unknown>>): DecidedCall {
  return { parameters, ...(carriesOffWire(parameters) ? { level: REASONING_OFF } : {}) };
}

async function answerCall(
  deps: SmartModelExecutionDeps,
  args: AnswerCallArgs
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const { node, modelId, prompt, ctx, smartModelRan } = args;
  const binding = deps.candidates.get(modelId);
  if (binding === undefined) {
    // The registry resolved every candidate binding when it resolved the node,
    // and resolution only ever picks from the node's own candidate list.
    throw new Error(`smartModel: no binding for resolved candidate '${modelId}'`);
  }
  const history = ctx.history;
  // Custom instructions shape the ANSWER only — they ride the run-scoped ctx
  // (never the definition), so the answer node picks them up with no
  // per-builder wiring.
  const customInstructions = ctx.customInstructions;
  // The bound candidate's OWN affordable cap (stamped per candidate at
  // admission) — the reservation held exactly this at this model's rate.
  const candidateMaxOutputTokens = node.candidates.find(
    (candidate) => candidate.id === modelId
  )?.maxOutputTokens;
  const call = answerParamsWithEffort(
    node,
    binding.descriptor,
    args.effort,
    candidateMaxOutputTokens
  );
  const request: InferenceRequest = {
    model: modelId,
    inputs: [{ modality: 'text', text: prompt }],
    parameters: call.parameters,
    outputs: binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
    ...(customInstructions === undefined ? {} : { customInstructions }),
  };
  const result = await streamModelCall({ ...deps, binding }, request, {
    ...ctx,
    ...(call.level === undefined ? {} : { resolvedEffort: call.level }),
  });
  if (smartModelRan !== true) return result;
  return result.map((success) => ({ ...success, smartModelRan: true }));
}
