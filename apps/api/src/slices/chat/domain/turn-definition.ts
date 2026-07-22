import {
  ERROR_CODES,
  IMAGE_MIME_TYPES,
  MAX_SEARCH_TOOL_CALLS,
  MINIMUM_OUTPUT_TOKENS,
  ReasoningWire,
  computeSafeMaxTokens,
  estimateTokensForTier,
  mediaTag,
  outputCharsPerTokenForTier,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  spendableFundsNanoUsd,
  textTag,
} from '@hushbox/shared';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  buildWorkflow,
  createConstraintRegistry,
  createModelResolver,
  createNodeRegistry,
  modelCall,
  workflowInputs,
} from '../../workflows/index.js';
import { createServerTransformCompute } from '../../media/index.js';
import {
  WEB_SEARCH_TOOL_NAME,
  createEstimateRun,
  createModelPricingResolver,
} from '../../models/index.js';
import { STORAGE_COST_PER_CHARACTER_NANO, applyMarkup } from '../../billing/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_INPUT, CHAT_TURN_NODE_ID } from './constants.js';
import {
  AUTO_REASONING_EFFORT_ORDER,
  reasoningEntryFor,
  requiredReasoningEntryFor,
  resolveTurnReasoning,
} from './turn-reasoning.js';
import type { TurnReasoningByModel, TurnReasoningEntry } from './turn-reasoning.js';
import type { PayerFunding } from './turn-context.js';
import type { ModelResolver, NodeRegistryContext } from '../../workflows/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type {
  ModelDescriptor,
  Node,
  PolicyHooks,
  ReasoningEffortSelection,
  UserTier,
  WorkflowDefinition,
} from '@hushbox/shared';

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
 * the model will see (prompt + resent history — legacy `promptCharacterCount`
 * less the system prompt, which the new tree does not hold at build time) and
 * the payer's spendable funds.
 */
export interface TurnBudget {
  readonly promptCharacterCount: number;
  readonly funding: PayerFunding;
}

/** One model's ceiling inputs: BASE (pre-markup) per-token rates + context window. */
export interface TurnModelPricing {
  readonly inputPerTokenNanoUsd: bigint;
  readonly outputPerTokenNanoUsd: bigint;
  readonly contextLength: number;
}

/**
 * The per-turn affordable output-token ceiling — the legacy budget derivation
 * (`calculateBudget` → `computeSafeMaxTokens`) replicated in nano-USD bigint:
 *   - input tokens = ceil(chars / charsPerToken), 4 chars/token for a
 *     purchased payer (legacy paid) and 2 for a free payer (legacy
 *     conservative), zero for zero chars;
 *   - fixed cost = input tokens × Σ fee-inclusive input rates + chars ×
 *     storage rate; variable cost/token = Σ fee-inclusive output rates +
 *     output-storage chars/token (tier-inverted: 2 paid, 4 free) × storage
 *     rate × model count;
 *   - effective funds = remaining + the $0.50 cushion (purchased only);
 *   - below the 1000-token minimum-output threshold the ceiling is omitted —
 *     legacy denied such sends upstream; here the uncapped full-context hold
 *     makes admission refuse, the new tree's one balance gate;
 *   - `computeSafeMaxTokens` drops the cap when it covers the remaining
 *     context window (the model default applies).
 * Rates arrive BASE (catalog) and are marked up per-token here, mirroring the
 * fee-inclusive prices legacy fed the same math. Multi-model sums rates across
 * models and caps against the MIN context length — legacy computed ONE shared
 * value for all slots. The quotient is a token count, never money.
 */
/** The fee-inclusive rate sums plus the tightest context window across the turn's models. */
interface SummedTurnPricing {
  readonly sumInputRate: bigint;
  readonly sumOutputRate: bigint;
  readonly minContextLength: number;
}

function summedTurnPricing(models: readonly TurnModelPricing[]): SummedTurnPricing {
  let sumInputRate = 0n;
  let sumOutputRate = 0n;
  let minContextLength = models[0]?.contextLength ?? 0;
  for (const model of models) {
    sumInputRate += applyMarkup(model.inputPerTokenNanoUsd);
    sumOutputRate += applyMarkup(model.outputPerTokenNanoUsd);
    if (model.contextLength < minContextLength) minContextLength = model.contextLength;
  }
  return { sumInputRate, sumOutputRate, minContextLength };
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
 * Stamps a PERSISTING chat turn's definition with the admission-only
 * `{ inputChars, tier }` the run estimator needs to hold the storage settlement
 * will bill (input-prompt storage once, tier-sized output storage per node). The
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
 * The turn's estimated prompt input-token count — the exact figure
 * `turnMaxOutputTokens` prices the input leg at — stamped onto language nodes so
 * admission bounds the input leg at the actual prompt rather than the full
 * context window.
 */
export function promptInputTokensFor(budget: TurnBudget): number {
  return estimateTokensForTier(tierForFunding(budget.funding), budget.promptCharacterCount);
}

/** The per-turn cost basis both output-token derivations price against. */
interface TurnCostBasis {
  readonly estimatedInputTokens: number;
  readonly fixedCost: bigint;
  readonly variableCostPerToken: bigint;
  readonly minContextLength: number;
  readonly effective: bigint;
}

function turnCostBasis(budget: TurnBudget, models: readonly TurnModelPricing[]): TurnCostBasis {
  const tier = tierForFunding(budget.funding);
  const chars = budget.promptCharacterCount;
  const estimatedInputTokens = estimateTokensForTier(tier, chars);
  const outputCharsPerToken = outputCharsPerTokenForTier(tier);
  const { sumInputRate, sumOutputRate, minContextLength } = summedTurnPricing(models);
  const fixedCost =
    BigInt(estimatedInputTokens) * sumInputRate + BigInt(chars) * STORAGE_COST_PER_CHARACTER_NANO;
  const variableCostPerToken =
    sumOutputRate +
    BigInt(outputCharsPerToken) * STORAGE_COST_PER_CHARACTER_NANO * BigInt(models.length);
  return {
    estimatedInputTokens,
    fixedCost,
    variableCostPerToken,
    minContextLength,
    effective: payerSpendableNanoUsd(budget),
  };
}

export function turnMaxOutputTokens(
  budget: TurnBudget,
  models: readonly TurnModelPricing[]
): number | undefined {
  if (models.length === 0) return undefined;
  const basis = turnCostBasis(budget, models);
  const minimumCost = basis.fixedCost + BigInt(MINIMUM_OUTPUT_TOKENS) * basis.variableCostPerToken;
  if (basis.effective < minimumCost) return undefined;

  const budgetMaxTokens = Number((basis.effective - basis.fixedCost) / basis.variableCostPerToken);
  return computeSafeMaxTokens({
    budgetMaxTokens,
    modelContextLength: basis.minContextLength,
    estimatedInputTokens: basis.estimatedInputTokens,
  });
}

/**
 * The answer headroom H a reasoning turn can afford: total affordable output
 * tokens (budget-bounded AND context-bounded) minus the reasoning budget B —
 * the completion cap the call carries is then `B + H` (the shared plan's
 * `maxTokens`), so admission prices the output leg at exactly `B + H`.
 *
 * Two deliberate divergences from {@link turnMaxOutputTokens}: the context
 * bound is applied EXPLICITLY (never dropped for a rich payer — a reasoning
 * call always sends `max_tokens`, G2), and the minimum-output affordability
 * gate counts B on top of the minimum answer (the reasoning tokens are billed
 * output too). Undefined = the level does not fit this payer's ceiling; the
 * caller decides the refusal (trial refuses the level, the paid path holds
 * `B + MINIMUM_OUTPUT_TOKENS` and lets admission's balance gate refuse).
 */
export function answerHeadroomTokens(
  budget: TurnBudget,
  models: readonly TurnModelPricing[],
  reasoningBudgetTokens: number
): number | undefined {
  if (models.length === 0) return undefined;
  const basis = turnCostBasis(budget, models);
  const minimumCost =
    basis.fixedCost +
    BigInt(reasoningBudgetTokens + MINIMUM_OUTPUT_TOKENS) * basis.variableCostPerToken;
  if (basis.effective < minimumCost) return undefined;
  const budgetMaxTokens = Number((basis.effective - basis.fixedCost) / basis.variableCostPerToken);
  const contextHeadroom = basis.minContextLength - basis.estimatedInputTokens;
  const headroom = Math.min(budgetMaxTokens, contextHeadroom) - reasoningBudgetTokens;
  return headroom >= 1 ? headroom : undefined;
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
 * Clones a turn definition with a new answer output-token cap on every
 * answer-producing node — the sizing probe's single mutation point, shared by
 * the single-model, multi-model, and Smart Model turns (a multi-model turn's
 * siblings all take the SAME cap, as legacy applied one value to every slot; the
 * Smart Model turn's one composite node takes it on its answer leg). Only the
 * `maxOutputTokens` param changes; every other node field and the definition's
 * storage stamp are preserved, so the probe prices exactly the run that will be
 * admitted. A definition is homogeneous in its answer nodes, so a media turn
 * (whose modelCall nodes carry generation params, never an output-token cap) is
 * never fit — the fit runs only for the text single/multi and Smart turns.
 */
function withAnswerCap(
  definition: WorkflowDefinition,
  answerTokens: number,
  resolveModel: ModelPricingResolver
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.type === 'modelCall' || node.type === 'smartModel'
        ? {
            ...node,
            params: {
              ...node.params,
              // The wire cap is the node's constant reasoning budget plus the
              // sized answer headroom (B + H); B is 0 on a reasoning-free node,
              // so the cap is the answer tokens exactly as before.
              maxOutputTokens: answerTokens + nodeReasoningBudgetTokens(node, resolveModel),
            },
          }
        : node
    ),
  };
}

/**
 * Shrinks a persisting turn's answer output-token cap until the CANONICAL
 * admission estimator (`createEstimateRun`) prices the whole definition at or
 * below the payer's spendable funds, returning the fitted definition. Shared by
 * the regular single/multi-model turns and the Smart Model turn — the ONE numeric
 * authority for answer sizing (there is no second turn cost formula).
 *
 * DURABLE COUPLING (do not remove without re-checking `estimate-run.ts`): the
 * per-rate/inverse-solve guess (`turnMaxOutputTokens`, and `answerMaxOutputTokens`
 * for Smart Model) sizes its guess with PER-RATE markup and — for Smart Model — a
 * STORAGE-EXCLUDED classifier reserve, whereas admission prices the run with
 * SUBTOTAL markup and STORAGE-INCLUSIVE reserves. At integer nano rates per-rate
 * markup rounds the 15% away, and any storage-inclusive reserve is larger — so a
 * guess the payer "can afford" can still push admission's ceiling past the
 * allowance (the drift that caused both the Smart-Model and regular-turn 402s).
 * The guess is therefore only an UPPER BOUND; the authoritative cap is whatever
 * the ONE estimator admission uses accepts, which makes "sized-to-fit" provably
 * imply "ceiling ≤ funds" and removes the second cost computation that drifted.
 * The ceiling is monotonic in the cap, so a binary search over `[1, guessCap]`
 * returns the largest fitting cap; when even a one-token answer over-reserves, the
 * cap floors at 1 and admission refuses the run (the balance gate does its job)
 * rather than any silent under-reserve.
 *
 * REASONING TURNS: the searched cap is the ANSWER headroom H; each answer
 * node's wire cap is its own reasoning budget B plus H (`withAnswerCap`
 * re-derives B from the node's `reasoning` param through the shared plan). B
 * is a CONSTANT term — the level was the client's explicit ask (G3), so the
 * fit never shrinks the thinking budget, only the answer — and the admission
 * estimator therefore prices the output leg at exactly B + H.
 */
export function fitAnswerCapToCeiling(
  definition: WorkflowDefinition,
  resolveModel: ModelPricingResolver,
  guessCap: number,
  spendableNanoUsd: bigint
): WorkflowDefinition {
  const estimate = createEstimateRun(resolveModel);
  const fits = (cap: number): boolean => {
    const priced = estimate(withAnswerCap(definition, cap, resolveModel));
    return priced.isOk() && priced.value <= spendableNanoUsd;
  };
  if (fits(guessCap)) return definition;
  if (!fits(1)) return withAnswerCap(definition, 1, resolveModel);
  let lo = 1;
  let hi = guessCap;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return withAnswerCap(definition, lo, resolveModel);
}

/**
 * Reconciles a compiled turn definition's answer cap against the canonical
 * admission estimator. Only the persisting (storage-stamped) turn is balance-gated,
 * so only there must the admission ceiling fit the payer's funds — the per-rate
 * guess is re-fit against the ONE estimator (see {@link fitAnswerCapToCeiling}). A
 * trial (quota-gated, unstamped) or budget-less build, or a build with no derivable
 * guess cap, keeps the definition untouched: a single-model turn whose budget
 * covers its full context needs no cap, and admission then prices the full window
 * the budget already covers.
 */
export function reconcileAnswerCeiling(
  stamped: WorkflowDefinition,
  resolveModel: ModelPricingResolver,
  budget: TurnBudget | undefined,
  guessCap: number | undefined
): WorkflowDefinition {
  if (budget === undefined || guessCap === undefined || stamped.storage === undefined) {
    return stamped;
  }
  return fitAnswerCapToCeiling(stamped, resolveModel, guessCap, payerSpendableNanoUsd(budget));
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
    if (
      typeof inputPerTokenNanoUsd !== 'bigint' ||
      typeof outputPerTokenNanoUsd !== 'bigint' ||
      contextLength === undefined
    ) {
      return undefined;
    }
    pricings.push({ inputPerTokenNanoUsd, outputPerTokenNanoUsd, contextLength });
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
}

/** The sibling node id for the model at `index` — its own charge key and assistant message. */
function multiModelNodeId(index: number): string {
  return `${CHAT_TURN_NODE_ID}${String(index)}`;
}

/**
 * The multi-model text turn: one `modelCall` sibling node per selected model,
 * all consuming the same prompt and each producing its own text. A chat turn's
 * flagship fan-out is N *different* models, which the engine's `fanOut` (a
 * single static-model body) cannot express — so it is N static sibling nodes
 * instead. Each is `optional` + `onError: 'skip'`, so one model failing skips
 * its branch (leaving no output, no charge, no message) without terminal-failing
 * the run; the successful subset persists and bills. The siblings are the
 * definition's sinks — no reducer joins them, because settlement persists each
 * originating node's output as its own assistant message (the combined text is
 * never persisted). Declaration order is the selected order, which the
 * interpreter preserves, so the last sibling is the fork tip at settlement.
 * `buildWorkflow` runs the same graph-compile the DO re-runs at ingest, so any
 * unknown / unexposed / non-ZDR model is refused at build with a typed error.
 */
export function buildMultiModelTurn(
  params: MultiModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const siblings = params.models.map((model, index) =>
    modelCall({
      id: multiModelNodeId(index),
      model,
      accepts: textTag(),
      in: inputs.ports[CHAT_TURN_INPUT],
      produces: textTag(),
      optional: true,
      onError: 'skip',
      params: answerNodeParams(params.maxOutputTokens, params.reasoning?.get(model)),
      ...(params.promptInputTokens === undefined
        ? {}
        : { promptInputTokens: params.promptInputTokens }),
      ...(params.webSearchEnabled === true ? WEB_SEARCH_TOOLING : {}),
    })
  );
  return buildWorkflow({
    deadlineClass: 'text',
    // Multi-model is a paid-only fan-out (trial is single-model), so the paid
    // chat policy hooks always apply.
    hooks: CHAT_TURN_HOOKS,
    inputs,
    nodes: siblings,
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      validationError('chat multi-model turn definition could not be compiled', errors)
    );
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
 * The answer sizing for a text turn build: the answer cap the nodes carry and
 * the reconcile guess (one figure — the reconcile re-fits it against the ONE
 * admission estimator). Reasoning-free turns keep the legacy derived ceiling.
 * A reasoning turn sizes the answer headroom H so the wire cap is B + H; it
 * fails closed when the payer budget or any model's pricing basis is missing —
 * a reasoning call must always carry an explicit, affordably-derived
 * completion cap (G2), so there is no capless reasoning build. An undefined
 * headroom (the level does not fit the payer's ceiling) builds with the
 * minimum answer allocation and no reconcile guess: admission's balance gate
 * then refuses the run rather than any silent effort downgrade (G3).
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
  // All-off entries ('none') reserve no thinking tokens: the answer sizes
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
  return ok(answerHeadroomTokens(budget, pricings, maxReasoningBudget));
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

/** The synchronous compile of a single-model turn against a loaded pricing snapshot. */
function compileSingleTurn(
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
 * The affordable output-token ceiling for a text turn's model set, or
 * undefined when no budget was supplied (trial) or no cap is derivable — the
 * param is then omitted and the model default applies.
 */
function derivedCeiling(
  budget: TurnBudget | undefined,
  models: readonly string[],
  resolve: ModelPricingResolver
): number | undefined {
  if (budget === undefined) return undefined;
  const pricings = turnModelPricings(models, resolve);
  if (pricings === undefined) return undefined;
  return turnMaxOutputTokens(budget, pricings);
}

export interface MultiModelTurnDefinitionOptions {
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
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => compileMultiModelTurn(pricingResolver, models, options)
  );
}

/** The synchronous compile of a multi-model turn against a loaded pricing snapshot. */
function compileMultiModelTurn(
  pricingResolver: ModelPricingResolver,
  models: readonly string[],
  options: MultiModelTurnDefinitionOptions
): Result<WorkflowDefinition, DomainError> {
  const webSearchEnabled = options.webSearchEnabled === true;
  const registries = createTurnCompileRegistries(pricingResolver);
  const promptInputTokens =
    options.budget === undefined ? undefined : promptInputTokensFor(options.budget);
  const reasoning = resolveTurnReasoning(models, pricingResolver, options.reasoningEffort);
  if (reasoning.isErr()) return err(reasoning.error);
  const sized = turnAnswerSizing(models, pricingResolver, options.budget, reasoning.value);
  if (sized.isErr()) return err(sized.error);
  const answerCap = sized.value;
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
        })
      )
      // A multi-model turn is paid-only and always uses the persisting chat hooks.
      .map((definition) => withStorageStamp(definition, options.budget, CHAT_TURN_HOOKS))
      // The per-rate answer sizing is only an upper-bound guess; the ONE
      // canonical estimator sizes the authoritative shared sibling cap, so the
      // admission ceiling fits the payer's funds by construction.
      .map((stamped) => reconcileAnswerCeiling(stamped, pricingResolver, options.budget, answerCap))
  );
}

/**
 * The trial route's reasoning acceptance (G9/R3): a trial send may run only
 * effort levels whose shared-plan token cost fits the fixed trial ceiling —
 * COMPUTED via the same plan and headroom math the paid path prices with,
 * never a hardcoded level list. An explicit level that does not fit is
 * refused (`accepted: false` → the trial's over-cap 402); `auto` picks the
 * first placeholder-order level that is both feasible and ceiling-fitting, or
 * quietly runs reasoning-free (auto is the server's choice — degrading it is
 * honest, unlike downgrading an explicit ask); `none` passes through so the
 * build owns the mandatory-reasoning refusal.
 */
export type TrialReasoningDecision =
  | { readonly accepted: true; readonly selection: ReasoningEffortSelection | undefined }
  | { readonly accepted: false };

export function trialReasoningSelection(
  descriptor: ModelDescriptor,
  budget: TurnBudget,
  selection: ReasoningEffortSelection
): Result<TrialReasoningDecision, DomainError> {
  if (selection === 'none') return ok({ accepted: true, selection });
  const pricings = turnModelPricings([descriptor.id], () => descriptor);
  const fitsCeiling = (entry: TurnReasoningEntry): boolean =>
    pricings !== undefined &&
    answerHeadroomTokens(budget, pricings, entry.reasoningBudgetTokens) !== undefined;
  if (selection === 'auto') {
    if (descriptor.reasoning === undefined) return ok({ accepted: true, selection: undefined });
    for (const effort of AUTO_REASONING_EFFORT_ORDER) {
      const entry = reasoningEntryFor(descriptor, effort);
      if (entry !== undefined && fitsCeiling(entry)) {
        return ok({ accepted: true, selection: effort });
      }
    }
    return ok({ accepted: true, selection: undefined });
  }
  return requiredReasoningEntryFor(descriptor, selection).map((entry) =>
    fitsCeiling(entry) ? { accepted: true, selection } : { accepted: false }
  );
}
