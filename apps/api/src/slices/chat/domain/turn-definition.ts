import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ERROR_CODES,
  REASONING_EFFORT_LABELS,
  IMAGE_MIME_TYPES,
  MAX_SEARCH_TOOL_CALLS,
  ReasoningWire,
  TURN_DECISION_REDUCER,
  isTurnClassifierNode,
  jsonTag,
  mediaTag,
  optionalTag,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  spendableFundsNanoUsd,
  textTag,
} from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { turnEffortOptions } from '@hushbox/shared/affordability/estimate/effort-options';
import { classifierReserveChars } from '@hushbox/shared/affordability/estimate/classifier-line-item';
import { buildClassifierSystemPrompt } from '@hushbox/shared';
import {
  estimateTokensForTier,
  outputCharsPerTokenForTier,
} from '@hushbox/shared/affordability/estimate/pre-adapters';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  TURN_DECISION_SCHEMA_NAME,
  buildWorkflow,
  createConstraintRegistry,
  createModelResolver,
  createNodeRegistry,
  fanIn,
  modelCall,
  truncateForClassifier,
  workflowInputs,
} from '../../workflows/index.js';
import { createServerTransformCompute } from '../../media/index.js';
import {
  WEB_SEARCH_TOOL_NAME,
  createEstimateRun,
  createModelPricingResolver,
  listDescriptors,
  pickEffortClassifier,
  snapshotResolver,
} from '../../models/index.js';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  TRIAL_TURN_HOOKS,
} from './constants.js';
import { requiredReasoningEntryFor, resolveTurnReasoning } from './turn-reasoning.js';
import type { TurnReasoningByModel, TurnReasoningEntry } from './turn-reasoning.js';
import type { PayerFunding } from './turn-context.js';
import type {
  ModelCallOptions,
  ModelResolver,
  NodeRegistryContext,
} from '../../workflows/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type {
  ChatHistoryMessage,
  FlowInputs,
  ModelDescriptor,
  Node,
  TextTag,
  TypeTag,
  PolicyHooks,
  ReasoningEffortSelection,
  UserTier,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { SmartModelStorageContext } from '@hushbox/shared/affordability/estimate/smart-model-affordability';

/**
 * The web-search tool selection a modelCall carries when the turn enabled web
 * search: the closed registry name plus the search loop's step ceiling.
 */
const WEB_SEARCH_TOOLING = {
  tools: [WEB_SEARCH_TOOL_NAME],
  maxSteps: MAX_SEARCH_TOOL_CALLS,
} as const;

/**
 * Web search runs as a server-side tool call, so the answering model must be
 * tool-capable. An incapable model is refused at BUILD with a typed validation
 * error (a client-facing 400), never sent to the provider to fail mid-run. An
 * unknown model (absent descriptor) falls through — the compile step refuses it
 * as an unknown model. A disabled turn is always fine.
 */
export function assertWebSearchCapable(
  descriptor: ModelDescriptor | undefined,
  webSearchEnabled: boolean
): Result<void, DomainError> {
  if (!webSearchEnabled) return ok();
  if (descriptor !== undefined && !descriptor.behaviors.includes('tools')) {
    return err(validationError('web search requires a tool-capable model'));
  }
  return ok();
}

/** The same capability gate across every model of a multi-model turn. */
export function assertModelsWebSearchCapable(
  models: readonly string[],
  resolve: ModelPricingResolver,
  webSearchEnabled: boolean
): Result<void, DomainError> {
  if (!webSearchEnabled) return ok();
  for (const model of models) {
    const capable = assertWebSearchCapable(resolve(model), true);
    if (capable.isErr()) return capable;
  }
  return ok();
}

/**
 * The turn's compile registries, built from one shared `ModelResolver` so
 * compile-time port derivation and runtime execution never diverge — the same
 * instance feeds `createNodeRegistry` here and the DO's live-execution
 * registry. Both the route (to build the definition) and the DO's executor
 * construction start from this; the executor additionally wires the provider.
 */
export interface TurnCompileRegistries {
  readonly models: ModelResolver;
  readonly compute: TransformCompute;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
}

export function createTurnCompileRegistries(
  pricingResolver: ModelPricingResolver
): TurnCompileRegistries {
  const models = createModelResolver(pricingResolver);
  const compute = createServerTransformCompute();
  const nodes = createNodeRegistry({ models, compute });
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
  return { models, compute, nodes, constraints };
}

/**
 * The per-turn inputs the output-token ceiling derives from: the characters
 * the model will see (the built system prompt + resent history + prompt,
 * measured by the ONE shared `promptCharacterCount` the composer preview also
 * uses) and the payer's spendable funds.
 */
export interface TurnBudget {
  readonly promptCharacterCount: number;
  readonly funding: PayerFunding;
}

/** One model's ceiling inputs: BASE (pre-markup) per-token rates + context window
 * + the catalog's provider completion cap when the model carries one. */
export interface TurnModelPricing {
  readonly inputPerTokenNanoUsd: bigint;
  readonly outputPerTokenNanoUsd: bigint;
  readonly contextLength: number;
  /** `limits.maxOutputTokens` — bounds the output ceiling (strict tightening);
   * absent ⇒ the context window alone bounds. */
  readonly maxOutputTokens?: number;
}

/**
 * The user tier the shared token estimators key on, from the payer's funding
 * kind: 'purchased' → paid (4 chars/token input), everything else → free (the
 * conservative 2 chars/token). Single-sourced so the output-ceiling and the
 * input-token basis derive the same tier.
 */
function tierForFunding(funding: PayerFunding): UserTier {
  return funding.kind === 'purchased' ? 'paid' : 'free';
}

/**
 * The payer's spendable funds for a turn: the remaining balance plus the tier's
 * cushion ($0.50 for purchased, none for free/trial) — the SAME figure admission
 * compares a run's worst-case ceiling against. Single-sources the tier→spendable
 * mapping so the output-token sizing and the admission gate agree on affordability.
 */
export function payerSpendableNanoUsd(budget: TurnBudget): bigint {
  return spendableFundsNanoUsd(budget.funding.remainingNanoUsd, tierForFunding(budget.funding));
}

/**
 * The persisting-turn storage context the Smart Model per-candidate caps price
 * against — the payer's tier-sized output-storage ratio and the prompt char
 * count, the SAME storage the admission estimator holds. Single-sources the
 * tier mapping so the affordability caps and the estimator agree.
 */
export function turnStorageContext(budget: TurnBudget): SmartModelStorageContext {
  return {
    outputCharsPerToken: outputCharsPerTokenForTier(tierForFunding(budget.funding)),
    inputChars: budget.promptCharacterCount,
  };
}

/**
 * Stamps a PERSISTING chat turn's definition with the admission-only
 * `{ inputChars, tier }` the run estimator needs to hold the storage settlement
 * will bill (input-prompt storage once, then tier-sized output storage for each
 * node whose value settlement can persist). The
 * stamp rides the DEFINITION because the estimator runs per-run at the
 * conversation DO, where the payer's tier — a route-time funding decision — is
 * otherwise unavailable (it reaches neither the run transport nor the executor).
 *
 * Only the persisting chat policy stores anything: a trial send carries a budget
 * with funding kind 'free' too, so the tier alone cannot distinguish it — the
 * hooks gate does. A trial (no-persist) turn, or a turn with no budget, is
 * returned unstamped, so its hold stays provider-cost-only. Media turns build
 * without a budget and are likewise unstamped here.
 */
export function withStorageStamp(
  definition: WorkflowDefinition,
  budget: TurnBudget | undefined,
  hooks: PolicyHooks
): WorkflowDefinition {
  if (budget === undefined || hooks.settlement !== CHAT_TURN_HOOKS.settlement) return definition;
  return {
    ...definition,
    storage: { inputChars: budget.promptCharacterCount, tier: tierForFunding(budget.funding) },
  };
}

/**
 * The turn's estimated prompt input-token count — the same figure the answer
 * ceiling measures its context headroom against — stamped onto language nodes so
 * admission bounds the input leg at the actual prompt rather than the full
 * context window.
 */
export function promptInputTokensFor(budget: TurnBudget): number {
  return estimateTokensForTier(tierForFunding(budget.funding), budget.promptCharacterCount);
}

/**
 * One model's PHYSICAL answer room: `min(providerCap, contextHeadroom)` — what it
 * can emit and what the prompt leaves free (BILLING §Model bounds). An absent
 * catalog completion cap falls back to the context window, per the same section.
 * Floored at one token so a prompt that overruns the window still yields a
 * searchable bound and the balance gate is what refuses the run.
 */
function modelAnswerRoom(model: TurnModelPricing, inputTokens: number): number {
  const providerCap = model.maxOutputTokens ?? model.contextLength;
  return Math.max(1, Math.min(providerCap, model.contextLength - inputTokens));
}

/**
 * The WIDEST sibling's physical room — the upper bound of the fit's search on a
 * turn whose nodes each clamp themselves. It must be the widest, not the
 * tightest: a shared tightest-sibling bound would let a small-context sibling
 * truncate a large-context one, which §Multi-Model 3 forbids. Each node's own
 * room is applied by {@link withAnswerCap}, so nothing here caps one sibling by
 * another's limits.
 *
 * There is NO money term. The money bound is whatever the canonical admission
 * estimator accepts, applied by {@link fitAnswerCapToCeiling}, so there is
 * exactly one cost formula on the money path. A rate-bearing bound here would be
 * a second one, and at integer nano rates the two rounded differently — the drift
 * that caused live 402 refusals.
 *
 * Undefined for an empty model set: nothing to bound.
 */
export function physicalAnswerCeiling(
  budget: TurnBudget,
  models: readonly TurnModelPricing[]
): number | undefined {
  if (models.length === 0) return undefined;
  const inputTokens = promptInputTokensFor(budget);
  return Math.max(...models.map((model) => modelAnswerRoom(model, inputTokens)));
}

/**
 * The TIGHTEST room across the models — the bound for one cap that must fit every
 * one of them. That is the Smart Model slot's shape: a single composite node
 * carries one answer cap that rides whichever candidate the classifier picks, so
 * it cannot exceed any candidate's own limits. Distinct from
 * {@link physicalAnswerCeiling}, whose consumers clamp per node.
 */
export function sharedAnswerCeiling(
  budget: TurnBudget,
  models: readonly TurnModelPricing[]
): number | undefined {
  if (models.length === 0) return undefined;
  const inputTokens = promptInputTokensFor(budget);
  return Math.min(...models.map((model) => modelAnswerRoom(model, inputTokens)));
}

/**
 * A node's reasoning budget B, re-derived from its own `reasoning` wire param:
 * a budget-native wire carries B verbatim; the hard-off wire is 0; an effort
 * wire maps its native word back through the ONE shared positional ladder
 * (same inputs ⇒ same B — the derivation is headroom-independent). A node
 * with no reasoning param is 0, so every pre-reasoning caller (including the
 * smartModel answer leg) is unchanged.
 */
function nodeReasoningBudgetTokens(node: Node, resolveModel: ModelPricingResolver): number {
  if (node.type !== 'modelCall') return 0;
  const wire = ReasoningWire.safeParse(node.params['reasoning']);
  if (!wire.success) return 0;
  if ('max_tokens' in wire.data) return wire.data.max_tokens;
  if ('enabled' in wire.data) return 0;
  const descriptor = resolveModel(node.model);
  if (descriptor === undefined) return 0;
  return reasoningBudgetForWire(reasoningPlanModelFrom(descriptor), wire.data);
}

/**
 * Clones a turn definition with a new answer output-token cap on every ANSWER
 * node — the sizing probe's single mutation point, shared by the single-model,
 * multi-model, and Smart Model turns. Only the `maxOutputTokens` param changes;
 * every other node field and the definition's storage stamp are preserved, so
 * the probe prices exactly the run that will be admitted. A media turn (whose
 * modelCall nodes carry generation params, never an output-token cap) is never
 * fit — the fit runs only for the text single/multi and Smart turns.
 *
 * Which nodes those are is a question about the graph, not about the node type:
 * a turn's classifier is a `modelCall` too, and carries its own cap. See
 * {@link isAnswerNode}.
 *
 * The shared money-derived answer headroom lands on every answer node, but each
 * `modelCall` then CLAMPS it by its own physical room (§Multi-Model 3: a
 * tight-context sibling must not constrain a large-context one). A `smartModel`
 * node has no single model to clamp against — its one cap rides whichever
 * candidate the classifier picks — so its bound arrives already tightened to the
 * narrowest candidate (`sharedAnswerCeiling`).
 */
function withAnswerCap(
  definition: WorkflowDefinition,
  answerTokens: number,
  resolveModel: ModelPricingResolver
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      isAnswerNode(node, definition.nodes)
        ? {
            ...node,
            params: {
              ...node.params,
              maxOutputTokens: nodeAnswerCap(node, answerTokens, resolveModel),
            },
          }
        : node
    ),
  };
}

/**
 * Whether the shared ANSWER cap applies to this node.
 *
 * The turn's classifier is a `modelCall` and is not an answer node: it carries
 * its own output cap, the one its reserve is priced against, and the shared
 * answer headroom is a far larger number derived from a different question.
 * Overwriting it would let a routing call emit an answer's worth of tokens and
 * would inflate the hold by the difference — so the sweep asks what a node IS
 * rather than only what type it is.
 */
function isAnswerNode(
  node: Node,
  nodes: readonly Node[]
): node is Extract<Node, { type: 'modelCall' | 'smartModel' }> {
  if (node.type === 'smartModel') return true;
  return node.type === 'modelCall' && !isTurnClassifierNode(node, nodes);
}

/**
 * One node's wire cap: its constant reasoning budget B plus the shared answer
 * headroom H, clamped by the node's own physical room. B is 0 on a reasoning-free
 * node, so the cap is the answer tokens alone there.
 */
function nodeAnswerCap(
  node: Node,
  answerTokens: number,
  resolveModel: ModelPricingResolver
): number {
  const requested = answerTokens + nodeReasoningBudgetTokens(node, resolveModel);
  if (node.type !== 'modelCall') return requested;
  // The node's own limits, read through the ONE catalog reader, so a clamp here
  // and a bound derived at build time cannot disagree. An unpriceable model has
  // no room to read — the estimator refuses that definition outright.
  const [pricing] = turnModelPricings([node.model], resolveModel) ?? [];
  if (pricing === undefined) return requested;
  return Math.min(requested, modelAnswerRoom(pricing, node.promptInputTokens ?? 0));
}

/**
 * Shrinks a persisting turn's answer output-token cap until the CANONICAL
 * admission estimator (`createEstimateRun`) prices the whole definition at or
 * below the payer's spendable funds, returning the fitted definition. Shared by
 * the regular single/multi-model turns and the Smart Model turn — the ONE numeric
 * authority for answer sizing (there is no second turn cost formula).
 *
 * DURABLE COUPLING (do not remove without re-checking `estimate-run.ts`): the
 * supplied `guessCap` is a PHYSICAL bound only — what the models can emit and
 * what the prompt leaves free. It carries no rate, because a rate-bearing guess
 * priced the run a second way: per-rate markup rounds the 15% away at integer
 * nano rates while admission marks up the subtotal, so a cap the payer "can
 * afford" could still push admission's ceiling past the allowance (the drift that
 * caused both the Smart-Model and regular-turn 402s). The authoritative cap is
 * therefore whatever the ONE estimator admission uses accepts, which makes
 * "sized-to-fit" provably imply "ceiling ≤ funds" with no second cost formula to
 * keep aligned.
 * CLAMP ORDER, and it differs from the money module's on purpose. §Sharing one
 * budget across siblings solves `T` against the UNCLAMPED summed cost and clamps
 * each sibling afterwards, which is what `getTurnOptions` presents. This fit
 * prices the ALREADY-CLAMPED definition, so a sibling saturating its own room
 * releases its unused budget to the others and the wide sibling receives a
 * longer answer than the presented ceiling. It is bounded by the same spendable
 * figure either way, so the divergence can only lengthen an answer — never admit
 * a send the client refused. Both amounts are pinned, on one fixture, in
 * `turn-ceiling.clamp-order.test.ts`; do not close the gap without reading it.
 *
 * The ceiling is monotonic in the cap, so a binary search returns the largest
 * fitting cap. The search FLOOR is a minimum viable answer
 * (`MINIMUM_OUTPUT_TOKENS`, or the whole physical bound when that is smaller):
 * BILLING §Affordability 6 makes that floor THE minimum, so a shorter answer is
 * not a cheaper option the fit may take. When even the floor over-reserves the
 * definition carries it anyway and `withinFunds` is false — the caller's own gate
 * refuses (admission's balance gate on a paid turn, the per-message ceiling on a
 * trial one) rather than any silent under-reserve.
 *
 * REASONING TURNS: the searched cap is the ANSWER headroom H; each answer
 * node's wire cap is its own reasoning budget B plus H (`withAnswerCap`
 * re-derives B from the node's `reasoning` param through the shared plan). B
 * is a CONSTANT term — the level was the client's explicit ask (G3), so the
 * fit never shrinks the thinking budget, only the answer — and the admission
 * estimator therefore prices the output leg at exactly B + H.
 */
export interface AnswerCapFit {
  /**
   * The definition carrying the cap that was PRICED. Returning the priced one is
   * load-bearing: pricing one definition and returning another is only sound
   * while every caller happens to have built with the same cap, and it fails in
   * the under-reserving direction the moment a definition carries an uncapped
   * `modelCall`.
   */
  readonly definition: WorkflowDefinition;
  /** The answer-token headroom the returned definition is capped at. */
  readonly answerTokens: number;
  /** Whether the estimator prices that cap within the payer's funds. */
  readonly withinFunds: boolean;
}

export function fitAnswerCapToCeiling(
  definition: WorkflowDefinition,
  resolveModel: ModelPricingResolver,
  guessCap: number,
  spendableNanoUsd: bigint
): AnswerCapFit {
  const estimate = createEstimateRun(resolveModel);
  const fits = (cap: number): boolean => {
    const priced = estimate(withAnswerCap(definition, cap, resolveModel));
    return priced.isOk() && priced.value <= spendableNanoUsd;
  };
  const at = (answerTokens: number, withinFunds: boolean): AnswerCapFit => ({
    definition: withAnswerCap(definition, answerTokens, resolveModel),
    answerTokens,
    withinFunds,
  });
  if (fits(guessCap)) return at(guessCap, true);
  const floor = Math.min(MINIMUM_OUTPUT_TOKENS, guessCap);
  if (!fits(floor)) return at(floor, false);
  let lo = floor;
  let hi = guessCap;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return at(lo, true);
}

/**
 * Reconciles a compiled turn definition's answer cap against the canonical
 * admission estimator, on EVERY tier.
 *
 * The stamp is deliberately not a condition. A trial turn is quota-gated and
 * unstamped, so leaving it unfit left its wire cap with no money term at all —
 * and trial has no balance gate behind it, which made the physical bound the only
 * bound (measured at 126× the per-message ceiling). Pricing an unstamped
 * definition through the estimator carries no storage term by construction, which
 * is exactly §Math & Terms' `trialTurnCost`: the trial cap comes out storage-free
 * without a second formula computing it.
 *
 * A budget-less build, or one with no derivable bound, keeps the definition
 * untouched — there is nothing to price it against.
 */
export function reconcileAnswerCeiling(
  stamped: WorkflowDefinition,
  resolveModel: ModelPricingResolver,
  budget: TurnBudget | undefined,
  guessCap: number | undefined
): WorkflowDefinition {
  if (budget === undefined || guessCap === undefined) return stamped;
  return fitAnswerCapToCeiling(stamped, resolveModel, guessCap, payerSpendableNanoUsd(budget))
    .definition;
}

/**
 * Resolves the ceiling inputs for every model of a text turn, or undefined
 * when ANY model lacks a plain per-token rate or a context-length limit — no
 * cap is derivable, the param is omitted, and admission's full-context hold
 * keeps the worst case (today's behavior, fail-closed for low balances).
 */
export function turnModelPricings(
  models: readonly string[],
  resolve: ModelPricingResolver
): readonly TurnModelPricing[] | undefined {
  const pricings: TurnModelPricing[] = [];
  for (const model of models) {
    const descriptor = resolve(model);
    if (descriptor === undefined) return undefined;
    const inputPerTokenNanoUsd = descriptor.pricing['inputPerToken'];
    const outputPerTokenNanoUsd = descriptor.pricing['outputPerToken'];
    const contextLength = descriptor.limits['contextLength'];
    const maxOutputTokens = descriptor.limits['maxOutputTokens'];
    if (
      typeof inputPerTokenNanoUsd !== 'bigint' ||
      typeof outputPerTokenNanoUsd !== 'bigint' ||
      contextLength === undefined
    ) {
      return undefined;
    }
    pricings.push({
      inputPerTokenNanoUsd,
      outputPerTokenNanoUsd,
      contextLength,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });
  }
  return pricings;
}

/**
 * The derived cap as a modelCall `params` fragment: the key is present only
 * when a cap exists (legacy spread `...(safeMaxTokens !== undefined && {…})` —
 * an omitted key means the model's own default).
 */
function maxOutputTokensParams(
  maxOutputTokens: number | undefined
): Readonly<Record<string, unknown>> {
  return maxOutputTokens === undefined ? {} : { maxOutputTokens };
}

/**
 * One answer node's params fragment. Reasoning-free keeps today's shape (the
 * cap only when derivable). A reasoning node ALWAYS carries an explicit
 * completion cap (G2 — unset behavior is undocumented upstream) of B plus the
 * answer headroom; an underivable headroom falls back to the minimum answer
 * allocation, a cap admission then refuses when the payer cannot fund it
 * (mirroring the omitted-cap full-context refusal of the reasoning-free path).
 * The hard-off wire is the exception: B = 0 and no reasoning will run, so its
 * cap is exactly the reasoning-free derivation (present iff derivable — the
 * model default otherwise); G2's explicit-cap rule governs calls with a live
 * reasoning budget.
 */
/**
 * The resolved level as a node-field fragment, stamped beside — never inside —
 * the params the wire rides in. It travels because the wire is lossy: two rungs
 * whose budgets clamp to one ceiling mint the same `max_tokens`, so the level a
 * generation ran at could not be recovered downstream from what it sent. Absent
 * on a reasoning-free node, which ran at no level at all.
 */
function resolvedEffortField(reasoning: TurnReasoningEntry | undefined): {
  readonly reasoningEffort?: TurnReasoningEntry['effort'];
} {
  return reasoning === undefined ? {} : { reasoningEffort: reasoning.effort };
}

function answerNodeParams(
  answerTokens: number | undefined,
  reasoning: TurnReasoningEntry | undefined
): Readonly<Record<string, unknown>> {
  if (reasoning === undefined) return maxOutputTokensParams(answerTokens);
  if ('enabled' in reasoning.wire) {
    return { ...maxOutputTokensParams(answerTokens), reasoning: reasoning.wire };
  }
  return {
    maxOutputTokens: reasoning.reasoningBudgetTokens + (answerTokens ?? MINIMUM_OUTPUT_TOKENS),
    reasoning: reasoning.wire,
  };
}

export interface SingleModelTurnParams {
  readonly model: string;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
  /**
   * The turn's policy hooks. Defaults to the paid chat policy; the trial route
   * passes `TRIAL_TURN_HOOKS` to run the SAME single-model turn under the
   * no-persist / no-charge policy — one pipeline, two policies.
   */
  readonly hooks?: PolicyHooks;
  /** When true the answer node carries the web-search tool + its step ceiling. */
  readonly webSearchEnabled?: boolean;
  /**
   * The affordable ANSWER output-token cap; omitted = the model's own default
   * (reasoning-free) or the minimum answer allocation (reasoning). With no
   * reasoning the answer cap IS the completion cap; with reasoning the node's
   * wire cap is this plus the entry's constant reasoning budget (B + H).
   */
  readonly maxOutputTokens?: number;
  /** The estimated prompt input-token count, stamped for admission bounding. */
  readonly promptInputTokens?: number;
  /** The turn's resolved reasoning (wire + budget from the shared plan), if any. */
  readonly reasoning?: TurnReasoningEntry;
}

/**
 * The single-model text turn: one `modelCall` node consuming the prompt and
 * producing text. `buildWorkflow` runs the same graph-compile validation the
 * DO re-runs at ingest, so an unknown or mis-priced model is refused at build
 * with a typed error rather than failing mid-run.
 */
export function buildSingleModelTurn(
  params: SingleModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const answer = modelCall({
    id: CHAT_TURN_NODE_ID,
    model: params.model,
    accepts: textTag(),
    in: inputs.ports[CHAT_TURN_INPUT],
    produces: textTag(),
    params: answerNodeParams(params.maxOutputTokens, params.reasoning),
    ...resolvedEffortField(params.reasoning),
    ...(params.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: params.promptInputTokens }),
    ...(params.webSearchEnabled === true ? WEB_SEARCH_TOOLING : {}),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: params.hooks ?? CHAT_TURN_HOOKS,
    inputs,
    nodes: [answer],
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      // The turn shape is fixed; a compile error means the requested model is
      // unknown to the catalog or otherwise unusable — a client-facing 400.
      validationError('chat turn definition could not be compiled', errors)
    );
}

export interface MultiModelTurnParams {
  readonly models: readonly string[];
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
  /** When true every sibling carries the web-search tool + its step ceiling. */
  readonly webSearchEnabled?: boolean;
  /**
   * The ONE shared ANSWER output-token cap every sibling carries — legacy
   * derived a single value from the summed rates and injected it into every
   * slot. A reasoning sibling's wire cap adds its own per-model reasoning
   * budget on top (B_i + H, one shared H).
   */
  readonly maxOutputTokens?: number;
  /** The estimated prompt input-token count, stamped on every sibling. */
  readonly promptInputTokens?: number;
  /** Per-model resolved reasoning; a model absent from the map runs reasoning-free. */
  readonly reasoning?: TurnReasoningByModel;
  /**
   * Present when the EFFORT axis is open (`auto` with two or more distinct
   * resolved choices): the turn grows a classifier call and the decision
   * reducer, and every sibling takes its level from the answer. Absent keeps
   * the pinned-effort shape exactly as it was.
   */
  readonly classifier?: TurnClassifierParams;
}

/** The sibling node id for the model at `index` — its own charge key and assistant message. */
function multiModelNodeId(index: number): string {
  return `${CHAT_TURN_NODE_ID}${String(index)}`;
}

/**
 * The turn's classifier call and the reducer that turns its answer into the
 * decision every sibling reads.
 *
 * The classifier is an ORDINARY `modelCall` (`docs/BILLING.md` §How the decision
 * reaches the answer). Nothing on the node says "classifier": the decision
 * reducer reading its answer is what makes it one, and both the engine (which
 * withholds the client's context from it) and admission (which prices it as
 * routing internals) derive that from the graph rather than from a flag.
 *
 * It is `optional` + `onError: 'skip'` so a routing hiccup degrades to the
 * declared fallback instead of failing the turn — the reducer's second input is
 * an optional text for exactly that reason, and the run still answers.
 */
export interface TurnClassifierParams {
  /** The cheapest priceable engine-text model — the classifier engine. */
  readonly modelId: string;
  /**
   * The classifier call's own input-token basis: the truncation budget plus the
   * rendered template, the SAME basis its reserve is priced on, so admission
   * holds the call at what it can actually cost rather than at the engine's
   * full context window.
   */
  readonly promptInputTokens: number;
}

/** The workflow input carrying the rendered classifier prompt. */
export const CHAT_CLASSIFIER_INPUT = 'classifierPrompt';

/** The classifier call's node id — its own charge key, with no content of its own. */
export const CHAT_CLASSIFIER_NODE_ID = 'classify';

/** The decision reducer's node id. */
export const CHAT_DECISION_NODE_ID = 'decide';

/**
 * The multi-model text turn: one `modelCall` sibling node per selected model,
 * each producing its own text. A chat turn's flagship fan-out is N *different*
 * models, which the engine's `fanOut` (a single static-model body) cannot
 * express — so it is N static sibling nodes instead. Each is `optional` +
 * `onError: 'skip'`, so one model failing skips its branch (leaving no output,
 * no charge, no message) without terminal-failing the run; the successful
 * subset persists and bills.
 *
 * What the siblings read depends on whether the effort axis is open: the turn's
 * prompt directly when it is pinned, the decision envelope when it is `auto`
 * (see {@link classifyingMultiModelGraph}). Either way the siblings are the only
 * nodes settlement persists — no reducer joins their outputs, because each
 * originating node's output becomes its own assistant message and the combined
 * text is never persisted. Declaration order is the selected order, which the
 * interpreter preserves, so the last sibling is the fork tip at settlement.
 * `buildWorkflow` runs the same graph-compile the DO re-runs at ingest, so any
 * unknown / unexposed / non-ZDR model is refused at build with a typed error.
 */
export function buildMultiModelTurn(
  params: MultiModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const built =
    params.classifier === undefined
      ? plainMultiModelGraph(params)
      : classifyingMultiModelGraph(params, params.classifier);
  return buildWorkflow({
    deadlineClass: 'text',
    // Multi-model is a paid-only fan-out (trial is single-model), so the paid
    // chat policy hooks always apply.
    hooks: CHAT_TURN_HOOKS,
    inputs: built.inputs,
    nodes: built.nodes,
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      validationError('chat multi-model turn definition could not be compiled', errors)
    );
}

/**
 * One sibling's shared options, whatever its input port turns out to be.
 *
 * Typed as the builder's own options MINUS the ports, rather than as a bag of
 * unknowns: `Node` variants are `z.object`, so an unregistered or mistyped key
 * is silently STRIPPED at parse. A wrong `onError` would compile, parse, and
 * default to `'fail'` — turning a skipping sibling into a turn-killer with
 * nothing to see. The type is what refuses that, since no test can assert the
 * absence of a key nobody wrote.
 */
type SiblingOptions = Omit<ModelCallOptions<TypeTag, TextTag>, 'id' | 'accepts' | 'in'>;

function siblingOptions(params: MultiModelTurnParams, model: string): SiblingOptions {
  return {
    model,
    produces: textTag(),
    optional: true,
    onError: 'skip',
    params: answerNodeParams(params.maxOutputTokens, params.reasoning?.get(model)),
    ...resolvedEffortField(params.reasoning?.get(model)),
    ...(params.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: params.promptInputTokens }),
    ...(params.webSearchEnabled === true ? WEB_SEARCH_TOOLING : {}),
  };
}

/** The pinned-effort shape: every sibling reads the prompt directly. */
function plainMultiModelGraph(params: MultiModelTurnParams): {
  readonly inputs: ReturnType<typeof workflowInputs<{ prompt: ReturnType<typeof textTag> }>>;
  readonly nodes: readonly ReturnType<typeof modelCall>[];
} {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const nodes = params.models.map((model, index) =>
    modelCall({
      id: multiModelNodeId(index),
      accepts: textTag(),
      in: inputs.ports[CHAT_TURN_INPUT],
      ...siblingOptions(params, model),
    })
  );
  return { inputs, nodes };
}

/**
 * The `auto`-effort shape: the classifier answers once for the whole turn, the
 * reducer folds its answer into the decision envelope, and every sibling reads
 * that envelope through its ordinary single input port. One call decides for N
 * siblings — a per-sibling classifier would cost N× the reserve and change who
 * is allowed to send (§Mechanisms rejected).
 *
 * The classifier reads its OWN input rather than the turn's prompt: what it is
 * sent is the truncated excerpt plus the rendered option lines, which is what
 * its reserve prices — the turn's full prompt is neither.
 */
function classifyingMultiModelGraph(
  params: MultiModelTurnParams,
  classifier: TurnClassifierParams
): {
  readonly inputs: ReturnType<
    typeof workflowInputs<{
      prompt: ReturnType<typeof textTag>;
      classifierPrompt: ReturnType<typeof textTag>;
    }>
  >;
  readonly nodes: readonly ReturnType<typeof modelCall>[];
} {
  const inputs = workflowInputs({
    [CHAT_TURN_INPUT]: textTag(),
    [CHAT_CLASSIFIER_INPUT]: textTag(),
  });
  const classify = modelCall({
    id: CHAT_CLASSIFIER_NODE_ID,
    model: classifier.modelId,
    accepts: textTag(),
    in: inputs.ports[CHAT_CLASSIFIER_INPUT],
    produces: textTag(),
    // A routing hiccup must not kill a paid turn: the branch skips, the reducer
    // sees an absent answer, and the declared fallback applies.
    optional: true,
    onError: 'skip',
    // The output cap the reserve is priced against, applied to the request that
    // spends it rather than only to the figure that reserves it.
    params: { maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP },
    promptInputTokens: classifier.promptInputTokens,
  });
  const decide = fanIn({
    id: CHAT_DECISION_NODE_ID,
    reducer: TURN_DECISION_REDUCER,
    accepts: [textTag(), optionalTag(textTag())] as const,
    ins: [inputs.ports[CHAT_TURN_INPUT], classify.out],
    produces: jsonTag(TURN_DECISION_SCHEMA_NAME),
  });
  const siblings = params.models.map((model, index) =>
    modelCall({
      id: multiModelNodeId(index),
      accepts: jsonTag(TURN_DECISION_SCHEMA_NAME),
      in: decide.out,
      ...siblingOptions(params, model),
    })
  );
  return { inputs, nodes: [classify, decide, ...siblings] };
}

/** The non-text chat modalities reachable from a text prompt. */
export type MediaTurnModality = 'image' | 'video';

/**
 * The accepted mime set a media turn's sink output tag declares per modality —
 * the same default allowlist the engine derives a media model's output port
 * from, so the node's declared producer tag matches the model it runs. Only the
 * output port needs it (a media turn's input is the text prompt).
 *
 * Parity with the legacy pipeline's ALLOWED_MEDIA_MIME_TYPES: the image and
 * video subsets are identical, and every mime here passes that allowlist at
 * storage.put (the R2 adapter re-validates against it). Legacy's only extra
 * members are its audio mimes — audio is a deferred modality, deliberately
 * absent from MediaTurnModality, not a narrowing of image/video.
 */
export const MEDIA_TURN_MIME_TYPES: Record<MediaTurnModality, readonly [string, ...string[]]> = {
  image: IMAGE_MIME_TYPES,
  video: ['video/mp4', 'video/webm'],
};

/**
 * A media turn must run on a model whose SOLE output is the requested modality.
 * The modelCall produce tag is a sink (not compile-checked against the model),
 * so this is the gate that refuses a text (or wrong-media) model at build with
 * a typed validation error. An unknown model (absent descriptor) is ok here —
 * the compile step then refuses it as an unknown model.
 */
export function assertModelProducesModality(
  descriptor: ModelDescriptor | undefined,
  modality: MediaTurnModality
): Result<void, DomainError> {
  if (descriptor === undefined) return ok();
  if (descriptor.outputs.length === 1 && descriptor.outputs[0] === modality) return ok();
  return err(
    validationError(
      `model does not produce '${modality}' output`,
      undefined,
      ERROR_CODES.UNSUPPORTED_MODALITY
    )
  );
}

/** The same modality gate across every model of a media turn's list — one bad
 * model refuses the whole build (matching the text multi-model behavior:
 * `assertModelsWebSearchCapable` and the compile both fail the whole list). */
export function assertModelsProduceModality(
  models: readonly string[],
  resolve: ModelPricingResolver,
  modality: MediaTurnModality
): Result<void, DomainError> {
  for (const model of models) {
    const produces = assertModelProducesModality(resolve(model), modality);
    if (produces.isErr()) return produces;
  }
  return ok();
}

export interface MediaTurnParams {
  readonly models: readonly string[];
  readonly modality: MediaTurnModality;
  /**
   * The generation parameters carried onto the modelCall (`aspectRatio`, and
   * for video `durationSeconds`/`resolution`) — validated by the media adapter
   * at execution, mapped 1:1 from the request's `imageConfig`/`videoConfig`.
   */
  readonly params: Readonly<Record<string, unknown>>;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
  /**
   * The payer's turn budget. Media is paid-only and always persists, so its
   * hold must reserve the storage settlement bills (media byte-storage + the
   * prompt char-storage); the budget carries the prompt char count and payer
   * tier the stamp records. Omitted only by unit callers that price no storage.
   */
  readonly budget?: TurnBudget;
}

/**
 * The media turn: one media `modelCall` per selected model (1–5), every node
 * consuming the same text prompt and producing the requested modality (image
 * or video), all deadline-classed `media`. One model is the media analogue of
 * `buildSingleModelTurn` — the exact historical one-node shape under
 * `CHAT_TURN_NODE_ID`, which settlement keys the charge and assistant message
 * on. Two or more mirrors `buildMultiModelTurn`'s legacy fan-out (the engine's
 * `fanOut` is a single static-model body, so it is N static sibling nodes):
 * each sibling is `optional` + `onError: 'skip'` under its own
 * `multiModelNodeId`, so one model failing skips its branch (no output, no
 * charge, no message) while the successful subset persists and bills — and
 * all models failing terminal-fails the run with nothing persisted or billed.
 * The generation `params` ride every node to the media adapter. Media is
 * paid-only (trial is single-model text), so the paid chat hooks always apply.
 */
export function buildMediaTurn(params: MediaTurnParams): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const produces = mediaTag(params.modality, MEDIA_TURN_MIME_TYPES[params.modality]);
  const shared = {
    accepts: textTag(),
    in: inputs.ports[CHAT_TURN_INPUT],
    produces,
    params: params.params,
  } as const;
  const nodes =
    params.models.length === 1 && params.models[0] !== undefined
      ? [modelCall({ id: CHAT_TURN_NODE_ID, model: params.models[0], ...shared })]
      : params.models.map((model, index) =>
          modelCall({
            id: multiModelNodeId(index),
            model,
            optional: true,
            onError: 'skip',
            ...shared,
          })
        );
  return (
    buildWorkflow({
      deadlineClass: 'media',
      hooks: CHAT_TURN_HOOKS,
      inputs,
      nodes,
      registries: { nodes: params.nodes, constraints: params.constraints },
    })
      // Media is a paid-only, always-persisting turn, so the persisting chat hooks
      // always apply and the stamp is what makes admission reserve the media
      // byte-storage + prompt char-storage settlement will bill.
      .map((compiled) => withStorageStamp(compiled.definition, params.budget, CHAT_TURN_HOOKS))
      .mapErr((errors) =>
        validationError('chat media turn definition could not be compiled', errors)
      )
  );
}

/**
 * Builds the media turn end to end from the request's db, mirroring
 * `buildTurnDefinition` / `buildMultiModelTurnDefinition`: one catalog snapshot
 * read feeds the compile registries, and `buildMediaTurn` compiles one media
 * modelCall per selected model. Every model is validated against the exposed
 * catalog (unknown / unexposed / non-ZDR / wrong output modality all fail the
 * whole build closed — the text multi-model refusal behavior).
 */
export interface MediaTurnDefinitionOptions {
  /** The generation parameters carried onto every media node (image/video config). */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * The payer's turn budget. Media always persists, so the definition is stamped
   * and admission reserves the media byte-storage + prompt char-storage settlement
   * bills (the prompt char count rides the budget).
   */
  readonly budget: TurnBudget;
}

export function buildMediaTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  models: readonly string[],
  modality: MediaTurnModality,
  options: MediaTurnDefinitionOptions
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      // A modelCall's produce tag is a sink, so graph-compile never checks a
      // model's output modality against the requested one — a text model would
      // otherwise build an "image turn". Assert every model's sole output IS
      // the requested modality here; an unknown model (absent descriptor)
      // falls through to the compile step's unknown-model refusal.
      return assertModelsProduceModality(models, pricingResolver, modality).andThen(() => {
        const registries = createTurnCompileRegistries(pricingResolver);
        return buildMediaTurn({
          models,
          modality,
          params: options.params,
          nodes: registries.nodes,
          constraints: registries.constraints,
          budget: options.budget,
        });
      });
    }
  );
}

/**
 * Builds the turn definition end to end from the request's db: loads the
 * catalog pricing snapshot, derives the shared compile registries from it, and
 * compiles the single-model turn for the requested model. The snapshot read is
 * per-request (the resolver holds no cross-request state) — bounded by the
 * catalog's own size, and it fails closed on an unknown model.
 */
export interface TurnDefinitionOptions {
  /** The declared billing/idempotency policy; the paid chat hooks by default. */
  readonly hooks?: PolicyHooks;
  readonly webSearchEnabled?: boolean;
  /** The payer's turn budget for the output-token ceiling; omitted = no cap (trial). */
  readonly budget?: TurnBudget;
  /**
   * The request's reasoning selection, resolved against the model via the ONE
   * shared plan (`resolveTurnReasoning`): an infeasible level refuses the
   * build with a typed 400 (G3), a feasible one rides the answer node as its
   * wire config plus a B+H completion cap.
   */
  readonly reasoningEffort?: ReasoningEffortSelection;
}

/**
 * The answer sizing for a text turn build: the physical upper bound the nodes
 * carry and the reconcile hands to the fit (one figure — the fit sizes the
 * authoritative cap against the ONE admission estimator).
 *
 * A reasoning turn's searched quantity is the answer headroom H, so its bound is
 * the physical room LESS the constant reasoning budget B, leaving the wire cap
 * B + H. It fails closed when the payer budget or any model's pricing basis is
 * missing — a reasoning call must always carry an explicit, affordably-derived
 * completion cap, so there is no capless reasoning build. When B leaves less
 * than a minimum viable answer inside the physical room the bound floors there and
 * the fit reports it does not fit: the caller's own gate refuses rather than any
 * silent effort downgrade.
 */
function turnAnswerSizing(
  models: readonly string[],
  resolve: ModelPricingResolver,
  budget: TurnBudget | undefined,
  reasoning: TurnReasoningByModel
): Result<number | undefined, DomainError> {
  if (reasoning.size === 0) return ok(derivedCeiling(budget, models, resolve));
  const maxReasoningBudget = Math.max(
    ...[...reasoning.values()].map((entry) => entry.reasoningBudgetTokens)
  );
  // All-off entries ('off') reserve no thinking tokens: the answer sizes
  // exactly like a reasoning-free turn (B = 0 ⇒ the cap is H alone), so the
  // hard-off wire never changes what a payer or trial sender could run.
  if (maxReasoningBudget === 0) return ok(derivedCeiling(budget, models, resolve));
  if (budget === undefined) {
    return err(validationError('a reasoning turn requires a payer budget'));
  }
  const pricings = turnModelPricings(models, resolve);
  if (pricings === undefined) {
    return err(validationError('a reasoning turn requires priceable models'));
  }
  const room = physicalAnswerCeiling(budget, pricings);
  /* v8 ignore next -- `pricings` is non-empty here, so the room always resolves */
  if (room === undefined) return err(validationError('a reasoning turn requires priceable models'));
  return ok(Math.max(MINIMUM_OUTPUT_TOKENS, room - maxReasoningBudget));
}

export function buildTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  model: string,
  options: TurnDefinitionOptions = {}
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => compileSingleTurn(pricingResolver, model, options)
  );
}

/**
 * The synchronous compile of a single-model turn against a loaded pricing snapshot.
 * Exported as the sizing seam: the answer-cap sweep prices exactly the definition
 * a request compiles, so nothing re-derives the build's own sizing to test it.
 */
export function compileSingleTurn(
  pricingResolver: ModelPricingResolver,
  model: string,
  options: TurnDefinitionOptions
): Result<WorkflowDefinition, DomainError> {
  const webSearchEnabled = options.webSearchEnabled === true;
  const registries = createTurnCompileRegistries(pricingResolver);
  const promptInputTokens =
    options.budget === undefined ? undefined : promptInputTokensFor(options.budget);
  const reasoning = resolveTurnReasoning([model], pricingResolver, options.reasoningEffort);
  if (reasoning.isErr()) return err(reasoning.error);
  const sized = turnAnswerSizing([model], pricingResolver, options.budget, reasoning.value);
  if (sized.isErr()) return err(sized.error);
  const answerCap = sized.value;
  const entry = reasoning.value.get(model);
  return (
    assertWebSearchCapable(pricingResolver(model), webSearchEnabled)
      .andThen(() =>
        buildSingleModelTurn({
          model,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(answerCap === undefined ? {} : { maxOutputTokens: answerCap }),
          ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
          ...(entry === undefined ? {} : { reasoning: entry }),
        })
      )
      .map((definition) =>
        withStorageStamp(definition, options.budget, options.hooks ?? CHAT_TURN_HOOKS)
      )
      // The per-rate answer sizing is only an upper-bound guess; the ONE
      // canonical estimator sizes the authoritative cap (see
      // `reconcileAnswerCeiling`), so a persisting turn's admission ceiling
      // fits the payer's funds by construction.
      .map((stamped) => reconcileAnswerCeiling(stamped, pricingResolver, options.budget, answerCap))
  );
}

/**
 * The physical answer ceiling for a text turn's model set, or undefined when no
 * budget was supplied (trial) or no pricing basis is derivable — the param is
 * then omitted and the model default applies. The money bound is the canonical
 * admission estimator's, applied downstream by {@link reconcileAnswerCeiling}.
 */
function derivedCeiling(
  budget: TurnBudget | undefined,
  models: readonly string[],
  resolve: ModelPricingResolver
): number | undefined {
  if (budget === undefined) return undefined;
  const pricings = turnModelPricings(models, resolve);
  if (pricings === undefined) return undefined;
  return physicalAnswerCeiling(budget, pricings);
}

export interface MultiModelTurnDefinitionOptions {
  /**
   * The exposed catalog snapshot the classifier engine is picked from — the
   * SAME snapshot the pricing resolver reads, so the engine and the sizing can
   * never come from two different reads.
   *
   * ABSENT IS AN EMPTY CATALOG, NOT AN OPT-OUT. A classifiable `auto` turn —
   * two or more presented rungs — then finds no priceable engine and is
   * REFUSED with the typed classifier code, exactly as it would be against a
   * real catalog holding no priceable text model (§Reasoning Effort 5(d)). A
   * turn with a pinned effort, or with fewer than two rungs, never asks and is
   * unaffected.
   *
   * That is deliberate and is the fail-closed direction: if omission quietly
   * meant "do not classify", a caller that forgot to pass the snapshot would
   * ship silently unclassified `auto` turns — the exact regression this path
   * exists to remove, and invisible. A caller that genuinely wants an
   * unclassified turn says so by not selecting `auto`, which is a statement
   * about the turn rather than about an argument it left out.
   *
   * Both arms are pinned; the sentence above is checkable, not a promise.
   */
  readonly catalog?: readonly ModelDescriptor[];
  readonly webSearchEnabled?: boolean;
  /** payer's turn budget for the shared output-token ceiling; omitted = no cap. */
  readonly budget?: TurnBudget;
  /** The request's reasoning selection, applied to every sibling (see {@link TurnDefinitionOptions}). */
  readonly reasoningEffort?: ReasoningEffortSelection;
}

/**
 * Builds the multi-model turn end to end from the request's db, mirroring
 * `buildTurnDefinition`: one catalog snapshot read feeds the compile registries,
 * and `buildMultiModelTurn` compiles one sibling per selected model. Every model
 * is validated against the exposed catalog (unknown / unexposed / non-ZDR are
 * absent from the snapshot), so any bad model in the list fails the build closed.
 */
export function buildMultiModelTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  models: readonly string[],
  options: MultiModelTurnDefinitionOptions = {}
): ResultAsync<MultiModelTurnBuild, DomainError> {
  // The LIST, not just a resolver: the classifier engine is the cheapest
  // priceable model in the exposed catalog, which is a question about the whole
  // snapshot. Both the engine pick and the per-model sizing then read that one
  // snapshot, so compile and runtime cannot diverge.
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
    compileMultiModelTurn(snapshotResolver(catalog), models, { ...options, catalog })
  );
}

/**
 * A compiled multi-model turn: the definition, plus the classifier's own prompt
 * when the turn classifies.
 *
 * The prompt travels beside the definition rather than inside it because it is
 * two halves with different natures. The half built here — the marker, the
 * option lines, the answer instruction — is content-free and derived from the
 * catalog this compile already read. The other half is the conversation
 * excerpt, which only the send path holds, and content never enters a
 * definition. The send path joins them.
 */
export interface MultiModelTurnBuild {
  readonly definition: WorkflowDefinition;
  /** Absent when the turn pins its effort — there is nothing to classify. */
  readonly classifierPrompt?: string;
}

/**
 * The effort options this turn PRESENTS, as the classifier must see them: the
 * union across the selected models, in the user's own labels.
 *
 * §Reasoning Effort 6 presents the classifier exactly the options the user saw,
 * so the declared domain is the wrong list — a turn whose models offer four
 * rungs must not be offered six. The union comes from the one shared authority
 * the menu and the server validation already use, so a rung can never be
 * offered here that the resolver would not accept back.
 */
function presentedEffortOptions(
  models: readonly string[],
  resolve: ModelPricingResolver
): readonly { readonly optionId: string; readonly label: string }[] {
  const descriptors = models
    .map((model) => resolve(model))
    .filter((descriptor): descriptor is ModelDescriptor => descriptor !== undefined);
  return turnEffortOptions(descriptors.map((descriptor) => reasoningPlanModelFrom(descriptor))).map(
    (option) => ({
      optionId: option.choice,
      label: REASONING_EFFORT_LABELS[option.choice],
    })
  );
}

/**
 * The turn's classifier, or `undefined` when the effort axis is not open.
 *
 * Two or more distinct resolved choices is what makes a classification exist;
 * with one or none the answer is settled and no call is bought (§Reasoning
 * Effort 5). A turn that IS classifiable but has no priceable engine is refused
 * outright rather than silently downgraded — auto is the server's choice, and a
 * static fallback is exactly what §Effort 5 forbids.
 */
function turnClassifierFor(
  models: readonly string[],
  catalog: readonly ModelDescriptor[],
  resolve: ModelPricingResolver,
  selection: ReasoningEffortSelection | undefined
): Result<{ readonly params: TurnClassifierParams; readonly prompt: string } | null, DomainError> {
  if (selection !== 'auto') return ok(null);
  const presented = presentedEffortOptions(models, resolve);
  if (presented.length < 2) return ok(null);
  const engine = pickEffortClassifier(catalog);
  if (engine === null) {
    return err(
      unavailableError(
        'no priceable classifier engine in the catalog',
        undefined,
        ERROR_CODES.CLASSIFIER_UNAVAILABLE
      )
    );
  }
  return ok({
    params: {
      modelId: engine.classifierModelId,
      // The classifier's model axis is CLOSED on a multi-model turn — the user
      // pinned the models — so its prompt names none, and its reserve is priced
      // against the same empty list.
      promptInputTokens: estimateTokensForTier('trial', classifierReserveChars([])),
    },
    prompt: buildClassifierSystemPrompt({ classifyEffort: true, effortOptions: presented }),
  });
}

/**
 * The run's workflow inputs for a compiled turn.
 *
 * A turn that classifies declares a SECOND text input, and this is where its two
 * halves meet: the content-free prompt the compile rendered (the marker, the
 * turn's own effort options, the answer instruction) joined to the conversation
 * excerpt, truncated to the budget the classifier reserve prices. The excerpt is
 * content, so it never enters the definition; the option lines are identifiers
 * and labels, so they are not content and the compile can render them.
 */
export function turnInputs(
  build: MultiModelTurnBuild,
  userMessage: string,
  history: readonly ChatHistoryMessage[]
): FlowInputs {
  const prompt = { [CHAT_TURN_INPUT]: { kind: 'text' as const, text: userMessage } };
  if (build.classifierPrompt === undefined) return prompt;
  return {
    ...prompt,
    [CHAT_CLASSIFIER_INPUT]: {
      kind: 'text' as const,
      text: `${build.classifierPrompt}\n\n${truncateForClassifier({
        latestUserMessage: userMessage,
        latestAssistantMessage: latestAssistantMessage(history),
      })}`,
    },
  };
}

/** The last assistant turn in the resent history, or '' on a first turn. */
function latestAssistantMessage(history: readonly ChatHistoryMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === 'assistant') return message.content;
  }
  return '';
}

/** The synchronous compile of a multi-model turn against a loaded pricing snapshot
 * (the multi-model half of the sizing seam — see {@link compileSingleTurn}). */
export function compileMultiModelTurn(
  pricingResolver: ModelPricingResolver,
  models: readonly string[],
  options: MultiModelTurnDefinitionOptions
): Result<MultiModelTurnBuild, DomainError> {
  const webSearchEnabled = options.webSearchEnabled === true;
  const registries = createTurnCompileRegistries(pricingResolver);
  const promptInputTokens =
    options.budget === undefined ? undefined : promptInputTokensFor(options.budget);
  const reasoning = resolveTurnReasoning(models, pricingResolver, options.reasoningEffort);
  if (reasoning.isErr()) return err(reasoning.error);
  const sized = turnAnswerSizing(models, pricingResolver, options.budget, reasoning.value);
  if (sized.isErr()) return err(sized.error);
  const answerCap = sized.value;
  const classifier = turnClassifierFor(
    models,
    options.catalog ?? [],
    pricingResolver,
    options.reasoningEffort
  );
  if (classifier.isErr()) return err(classifier.error);
  const classified = classifier.value;
  return (
    assertModelsWebSearchCapable(models, pricingResolver, webSearchEnabled)
      .andThen(() =>
        buildMultiModelTurn({
          models,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(answerCap === undefined ? {} : { maxOutputTokens: answerCap }),
          ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
          ...(reasoning.value.size === 0 ? {} : { reasoning: reasoning.value }),
          ...(classified === null ? {} : { classifier: classified.params }),
        })
      )
      // A multi-model turn is paid-only and always uses the persisting chat hooks.
      .map((definition) => withStorageStamp(definition, options.budget, CHAT_TURN_HOOKS))
      // The per-rate answer sizing is only an upper-bound guess; the ONE
      // canonical estimator sizes the authoritative shared sibling cap, so the
      // admission ceiling fits the payer's funds by construction.
      .map((stamped) => reconcileAnswerCeiling(stamped, pricingResolver, options.budget, answerCap))
      .map((definition) => ({
        definition,
        ...(classified === null ? {} : { classifierPrompt: classified.prompt }),
      }))
  );
}

/**
 * The trial route's reasoning acceptance (G9/R3): a trial send may run only
 * effort levels whose cost fits the fixed trial ceiling — decided by
 * COMPILE-THEN-PRICE through the same canonical estimator every other money
 * decision uses, never a second cost formula and never a hardcoded level list.
 * An explicit level that does not fit is refused (`accepted: false` → the trial's
 * over-cap 402); `none` passes through so the build owns the mandatory-reasoning
 * refusal.
 *
 * `auto` is deliberately outside this function's domain, and the parameter type
 * enforces it. An auto trial turn goes to the classifier, exactly as a paid one
 * does — the trial arm's compiler answers it, and its deterministic
 * single-choice case is the shared `resolveTurnReasoning` resolution the paid
 * path already uses. Resolving auto here could only mean choosing a level with
 * no classifier, which §Reasoning Effort 5 forbids by name.
 */
export type TrialReasoningDecision =
  | { readonly accepted: true; readonly selection: ReasoningEffortSelection | undefined }
  | { readonly accepted: false };

/**
 * Whether one reasoning level's smallest useful trial turn fits the per-message
 * ceiling: compile the turn at that level, price it UNSTAMPED (a trial turn
 * persists nothing, so §Trial Usage gives it no storage term — the unstamped
 * definition carries none by construction), and ask whether `B + a minimum viable
 * answer` is within the ceiling.
 *
 * The build has to happen before the price because there is nothing else to price;
 * that ordering is what lets this decision share `createEstimateRun` with every
 * other money decision instead of re-deriving a cost from rates.
 */
function trialLevelFits(
  descriptor: ModelDescriptor,
  budget: TurnBudget,
  entry: TurnReasoningEntry
): boolean {
  const resolve: ModelPricingResolver = () => descriptor;
  const registries = createTurnCompileRegistries(resolve);
  const built = buildSingleModelTurn({
    model: descriptor.id,
    nodes: registries.nodes,
    constraints: registries.constraints,
    hooks: TRIAL_TURN_HOOKS,
    promptInputTokens: promptInputTokensFor(budget),
    reasoning: entry,
    maxOutputTokens: MINIMUM_OUTPUT_TOKENS,
  });
  /* v8 ignore next -- the descriptor resolves by construction (it IS the
     resolver), so the graph compile cannot fail on an unknown model here */
  if (built.isErr()) return false;
  return fitAnswerCapToCeiling(
    built.value,
    resolve,
    MINIMUM_OUTPUT_TOKENS,
    payerSpendableNanoUsd(budget)
  ).withinFunds;
}

export function trialReasoningSelection(
  descriptor: ModelDescriptor,
  budget: TurnBudget,
  selection: Exclude<ReasoningEffortSelection, 'auto'>
): Result<TrialReasoningDecision, DomainError> {
  if (selection === 'off') return ok({ accepted: true, selection });
  return requiredReasoningEntryFor(descriptor, selection).map((entry) =>
    trialLevelFits(descriptor, budget, entry) ? { accepted: true, selection } : { accepted: false }
  );
}
