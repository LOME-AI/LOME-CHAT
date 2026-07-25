import {
  ERROR_CODES,
  REASONING_OFF_WIRE,
  reasoningPlanModelFrom,
  textTag,
  turnEffortOptions,
} from '@hushbox/shared';
import { buildWorkflow, smartModel, workflowInputs } from '../../workflows/index.js';
import {
  buildSmartModelCandidates,
  buildTrialSmartModelCandidates,
  listDescriptors,
  pickEffortClassifier,
  snapshotResolver,
} from '../../models/index.js';
import { readBalance } from '../../billing/index.js';
import { err, errAsync, ok, okAsync } from '../../../lib/result/index.js';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  TRIAL_TURN_HOOKS,
} from './constants.js';
import {
  answerHeadroomTokens,
  createTurnCompileRegistries,
  payerSpendableNanoUsd,
  promptInputTokensFor,
  reconcileAnswerCeiling,
  turnMaxOutputTokens,
  turnModelPricings,
  turnStorageContext,
  withStorageStamp,
} from './turn-definition.js';
import type { TurnBudget, TurnModelPricing } from './turn-definition.js';
import type { createConstraintRegistry, NodeRegistryContext } from '../../workflows/index.js';
import type { SmartModelCandidateEntry } from '../../models/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type {
  ChatHistoryMessage,
  ModelDescriptor,
  PolicyHooks,
  WorkflowDefinition,
} from '@hushbox/shared';

/**
 * The Smart Model turn: ONE composite `smartModel` node on the same executor,
 * hooks, and settlement as every other paid turn. The candidate list is
 * server-derived definition data — the payer's affordable text models — never
 * client intent, so it does not perturb the request body hash.
 */

export interface SmartModelTurnParams {
  readonly classifierModelId: string;
  readonly candidates: readonly SmartModelCandidateEntry[];
  /**
   * The classifier dimensions to request (D3). Absent = the legacy Smart
   * Model shape (model routing only).
   */
  readonly classify?: { readonly model: boolean; readonly effort: boolean };
  /** The declared billing/idempotency policy; the paid chat hooks by default. */
  readonly hooks?: PolicyHooks;
  /**
   * The affordable output-token ceiling for the ANSWER generation, carried as
   * the node's params (the classifier call never reads them — it sets only its
   * own fixed output cap). Omitted = the answering model's own default.
   */
  readonly answerMaxOutputTokens?: number;
  /** The estimated prompt input-token count, stamped for the candidate answer
   * legs' admission bounding (the classifier reserve is truncated-context). */
  readonly promptInputTokens?: number;
  /**
   * True when the send selected `none`: the node params carry the explicit
   * `{ enabled: false }` wire (the hard-off ruling — never parameter
   * omission, so a `default_enabled` candidate truly stops reasoning). The
   * wire is shared node data; the execution applies it per resolved
   * candidate — a mandatory-reasoning candidate keeps reasoning (it cannot
   * disable, and one candidate cannot refuse the whole server-picked
   * composite) and a non-reasoning candidate has nothing to turn off, so
   * both drop it at the answer call. B = 0; the cap sizing is unchanged.
   */
  readonly reasoningOff?: boolean;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
}

/**
 * The tightest declared provider completion cap across the candidates: it
 * bounds the answer ceiling jointly with the context window (a candidate
 * without one is bounded by its context alone). Undefined when none declares
 * a cap.
 */
function tightestCompletionCap(pricings: readonly TurnModelPricing[]): number | undefined {
  const declared = pricings
    .map((candidate) => candidate.maxOutputTokens)
    .filter((cap): cap is number => cap !== undefined);
  return declared.length === 0 ? undefined : Math.min(...declared);
}

/**
 * The answer generation's output-token ceiling for a Smart Model turn: the
 * shared derivation priced at the MOST EXPENSIVE candidate rates (legacy
 * `computeMaxEligibleFees` — the budget must absorb whichever candidate the
 * classifier picks) against the TIGHTEST candidate context window, sized
 * against the funds left after the classifier's worst-case reserve is set
 * aside (legacy deducted the stage reservation from the balance first, so
 * classifier + answer together never exceed the payer's funds). Undefined when
 * any candidate is missing a rate or context limit, or when the post-reserve
 * budget covers the remaining context (the model default applies).
 */
export function answerMaxOutputTokens(
  catalog: readonly ModelDescriptor[],
  candidates: readonly SmartModelCandidateEntry[],
  budget: TurnBudget,
  classifierReserveNanoUsd: bigint
): number | undefined {
  const pricings = turnModelPricings(
    candidates.map((candidate) => candidate.id),
    snapshotResolver(catalog)
  );
  const first = pricings?.[0];
  if (pricings === undefined || first === undefined) return undefined;
  // Rates are bigint (Math.max cannot take them); a plain scan keeps the money
  // math integral.
  let maxInputRate = first.inputPerTokenNanoUsd;
  let maxOutputRate = first.outputPerTokenNanoUsd;
  let minContextLength = first.contextLength;
  for (const candidate of pricings) {
    if (candidate.inputPerTokenNanoUsd > maxInputRate)
      maxInputRate = candidate.inputPerTokenNanoUsd;
    if (candidate.outputPerTokenNanoUsd > maxOutputRate) {
      maxOutputRate = candidate.outputPerTokenNanoUsd;
    }
    minContextLength = Math.min(candidate.contextLength, minContextLength);
  }
  const minMaxOutputTokens = tightestCompletionCap(pricings);
  const worstCase: TurnModelPricing = {
    inputPerTokenNanoUsd: maxInputRate,
    outputPerTokenNanoUsd: maxOutputRate,
    contextLength: minContextLength,
    ...(minMaxOutputTokens === undefined ? {} : { maxOutputTokens: minMaxOutputTokens }),
  };
  // The classifier call is spent before the answer, so the answer's affordable
  // ceiling is sized against the funds that remain once the classifier's
  // worst-case reserve is deducted.
  const answerBudget: TurnBudget = {
    promptCharacterCount: budget.promptCharacterCount,
    funding: {
      ...budget.funding,
      remainingNanoUsd: budget.funding.remainingNanoUsd - classifierReserveNanoUsd,
    },
  };
  const cap = turnMaxOutputTokens(answerBudget, [worstCase]);
  if (cap !== undefined) return cap;
  // `turnMaxOutputTokens` (via `computeSafeMaxTokens`) drops the cap when the
  // budget covers the tightest candidate's remaining context. That is safe for
  // a SINGLE-model turn, but wrong here: the multi-candidate admission estimator
  // (`declaredOutputCeiling`) takes the MAX over the candidates' OWN full
  // contexts, so an omitted cap reserves the WIDEST candidate's full window at
  // the priciest rate — >$200 on a $100 wallet. Always stamp a concrete
  // ceiling, clamped to the tightest candidate's remaining context and its
  // declared completion cap, so BOTH the admission estimate and the real
  // provider request stay bounded.
  const contextHeadroom = minContextLength - promptInputTokensFor(budget);
  return Math.max(
    1,
    minMaxOutputTokens === undefined
      ? contextHeadroom
      : Math.min(contextHeadroom, minMaxOutputTokens)
  );
}

/**
 * The payer's tier-EFFECTIVE Smart Model funding: the cushion-inclusive
 * spendable balance for a budgeted turn — the SAME figure the admission Redis
 * gate (`spendableFundsNanoUsd`) and the client affordability preflight compare
 * against, so the affordable-subset gate cannot admit a subset the client denies
 * (or refuse one it accepts). A paid wallet spends into the $0.50 negative
 * cushion; free/trial get none (their allowance rides a separate budget scope).
 * The budget-less defensive build falls back to the sender wallet's purchased
 * balance (no budget ⇒ no tier context). Passing the RAW remainder here (the
 * prior bug) refused paid-within-cushion sends the client had accepted.
 */
export function smartModelEffectiveBalanceNanoUsd(
  budget: TurnBudget | undefined,
  purchasedNanoUsd: bigint
): bigint {
  return budget === undefined ? purchasedNanoUsd : payerSpendableNanoUsd(budget);
}

/** The one-node smartModel definition; compile fails closed on any bad model. */
export function buildSmartModelTurn(
  params: SmartModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  // The off wire is the shared module's minted value — the branded wire type
  // cannot be hand-written here, so the shape can never drift from
  // `planReasoningOff`'s output.
  const answerParams: Record<string, unknown> = {
    ...(params.answerMaxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: params.answerMaxOutputTokens }),
    ...(params.reasoningOff === true ? { reasoning: REASONING_OFF_WIRE } : {}),
  };
  const node = smartModel({
    id: CHAT_TURN_NODE_ID,
    classifierModelId: params.classifierModelId,
    candidates: params.candidates,
    ...(params.classify === undefined ? {} : { classify: params.classify }),
    ...(Object.keys(answerParams).length === 0 ? {} : { params: answerParams }),
    ...(params.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: params.promptInputTokens }),
    in: inputs.ports[CHAT_TURN_INPUT],
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: params.hooks ?? CHAT_TURN_HOOKS,
    inputs,
    nodes: [node],
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      validationError('chat smart-model turn definition could not be compiled', errors)
    );
}

export type SmartModelTurnBuild =
  | { readonly buildable: true; readonly definition: WorkflowDefinition }
  /** No affordable candidate for this payer — the route refuses the send. */
  | { readonly buildable: false };

export interface SmartModelTurnDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
  /** Billing's published stores — the read-only wallet balance query. */
  readonly billing: BillingStores;
}

/**
 * Compiles the one-node definition from a derived candidate pick over the
 * SAME catalog snapshot the pick was derived from (compile ⟺ runtime never
 * diverge) — the shared tail of the paid and trial builders.
 */
interface CompileSmartModelOptions {
  readonly hooks?: PolicyHooks;
  readonly budget?: TurnBudget;
  readonly classify?: { readonly model: boolean; readonly effort: boolean };
  /** True when the send selected `none` — see {@link SmartModelTurnParams.reasoningOff}. */
  readonly reasoningOff?: boolean;
}

/** The optional smartModel turn params, each spread only when present. */
function optionalTurnParams(
  classify: CompileSmartModelOptions['classify'],
  hooks: PolicyHooks | undefined,
  guessCap: number | undefined,
  promptInputTokens: number | undefined
): Partial<SmartModelTurnParams> {
  return {
    ...(classify === undefined ? {} : { classify }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(guessCap === undefined ? {} : { answerMaxOutputTokens: guessCap }),
    ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
  };
}

function compileSmartModelBuild(
  catalog: readonly ModelDescriptor[],
  picked: {
    readonly classifierModelId: string;
    readonly candidates: readonly SmartModelCandidateEntry[];
    readonly classifierWorstCaseNanoUsd?: bigint;
  } | null,
  options: CompileSmartModelOptions
): ResultAsync<SmartModelTurnBuild, DomainError> {
  const { hooks, budget, classify } = options;
  if (picked === null) return okAsync<SmartModelTurnBuild, DomainError>({ buildable: false });
  const registries = createTurnCompileRegistries(snapshotResolver(catalog));
  // The paid candidate derivation carries the marked-up classifier reserve; the
  // trial derivation prices in base units and never sizes an answer ceiling
  // against that reserve, so an absent reserve is a zero deduction.
  const classifierReserveNanoUsd = picked.classifierWorstCaseNanoUsd ?? 0n;
  // The paid derivation stamps a PER-CANDIDATE cap on each eligible candidate
  // (`cap(m)`); the node then reserves and runs each at its own cap, so there is
  // NO single node-level answer cap and no single-cap reconcile. The trial
  // derivation carries no per-candidate caps, so it keeps the single-cap
  // `answerMaxOutputTokens` guess + `reconcileAnswerCeiling` (storage-fit).
  const perCandidateCaps = picked.candidates.some(
    (candidate) => candidate.maxOutputTokens !== undefined
  );
  const guessCap =
    budget === undefined || perCandidateCaps
      ? undefined
      : answerMaxOutputTokens(catalog, picked.candidates, budget, classifierReserveNanoUsd);
  const promptInputTokens = budget === undefined ? undefined : promptInputTokensFor(budget);
  const built = buildSmartModelTurn({
    classifierModelId: picked.classifierModelId,
    candidates: picked.candidates,
    ...optionalTurnParams(classify, hooks, guessCap, promptInputTokens),
    ...(options.reasoningOff === true ? { reasoningOff: true } : {}),
    nodes: registries.nodes,
    constraints: registries.constraints,
  });
  /* v8 ignore next -- defensive: candidates are filtered to engine-runnable
     text→text models over the SAME catalog snapshot the compile registries
     read, so a compile failure here means the two derivations drifted — a
     defect path kept fail-closed rather than assumed impossible */
  if (built.isErr()) return errAsync<SmartModelTurnBuild, DomainError>(built.error);
  // A paid Smart turn persists (default chat hooks) and is stamped with the
  // payer's storage context; the trial variant passes TRIAL_TURN_HOOKS and is
  // left unstamped (no-persist → no storage held).
  const stamped = withStorageStamp(built.value, budget, hooks ?? CHAT_TURN_HOOKS);
  return okAsync<SmartModelTurnBuild, DomainError>({
    buildable: true,
    // The per-rate / storage-excluded `answerMaxOutputTokens` is only an
    // upper-bound guess; the shared `reconcileAnswerCeiling` re-fits it against
    // the ONE canonical admission estimator (see `fitAnswerCapToCeiling`).
    definition: reconcileAnswerCeiling(stamped, snapshotResolver(catalog), budget, guessCap),
  });
}

/**
 * Builds the Smart Model turn end to end for one paid send: derives the
 * affordable candidate list from one exposed-catalog read and compiles the
 * one-node definition over that same snapshot. No affordable candidate yields
 * `buildable: false` — the route refuses the send before admission runs, so
 * the affordability filter is a pre-admission gate for the empty case and
 * must use the PAYER's effective funding (`budget.funding.remainingNanoUsd`:
 * owner wallet ∧ budget remainders for group turns, remaining daily allowance
 * for free tier), not the sender's own purchased balance — a $0-purchased
 * group member or free-tier sender is otherwise wrongly refused (402). The
 * sender-wallet read remains only the defensive fallback for the budget-less
 * path.
 */
export function buildSmartModelTurnDefinition(
  deps: SmartModelTurnDeps,
  args: {
    readonly userId: string;
    readonly now: Date;
    /**
     * The payer's turn budget for the ANSWER output-token ceiling; an omitted
     * budget builds without a cap.
     */
    readonly budget?: TurnBudget;
    /**
     * True when the request selected `auto` effort: the ONE classifier call
     * additionally classifies the effort dimension. Gated on at least one
     * reasoning-capable candidate — with none, no effort dimension exists
     * (no call beyond routing, no extra charge, no reserve change).
     */
    readonly classifyEffort?: boolean;
    /** True when the send selected `none` — see {@link SmartModelTurnParams.reasoningOff}. */
    readonly reasoningOff?: boolean;
  }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  return readBalance(deps.billing, deps.db, args.userId, args.now).andThen((balance) =>
    listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) => {
      const picked = buildSmartModelCandidates({
        descriptors: catalog,
        // The tier-effective (cushion-inclusive) balance — the SAME figure
        // admission and the client gate on — never the raw remainder, so
        // paid-within-cushion agrees on both sides (see
        // `smartModelEffectiveBalanceNanoUsd`).
        balanceNanoUsd: smartModelEffectiveBalanceNanoUsd(args.budget, balance.purchasedNanoUsd),
        ...(args.budget === undefined
          ? {}
          : {
              promptInputTokens: promptInputTokensFor(args.budget),
              // A paid Smart Model turn always persists, so the per-candidate
              // caps must cover the answer/prompt storage the estimator holds.
              storage: turnStorageContext(args.budget),
            }),
      });
      const classify =
        args.classifyEffort === true && picked !== null
          ? effortDimensionForCandidates(catalog, picked.candidates)
          : undefined;
      return compileSmartModelBuild(catalog, picked, {
        ...(args.budget === undefined ? {} : { budget: args.budget }),
        ...(classify === undefined ? {} : { classify }),
        ...(args.reasoningOff === true ? { reasoningOff: true } : {}),
      });
    })
  );
}

/**
 * The Smart Model + auto classify set: both dimensions when at least one
 * candidate can actually reason, otherwise undefined — a candidate pool with
 * nothing to tune runs the legacy model-only classification (no extra
 * dimension, no reserve change), the non-reasoning analogue of the pinned
 * path's no-call rule.
 */
export function effortDimensionForCandidates(
  catalog: readonly ModelDescriptor[],
  candidates: readonly SmartModelCandidateEntry[]
): { readonly model: boolean; readonly effort: boolean } | undefined {
  const ids = new Set(candidates.map((candidate) => candidate.id));
  const anyReasoning = catalog.some(
    (descriptor) => ids.has(descriptor.id) && descriptor.reasoning !== undefined
  );
  return anyReasoning ? { model: true, effort: true } : undefined;
}

export type AutoEffortTurnBuild =
  | { readonly kind: 'built'; readonly definition: WorkflowDefinition }
  /**
   * Not classifier-eligible: the turn has at most ONE real effort choice
   * (unknown/non-reasoning model, single-level mandatory ladder, Min-only
   * model), no pricing basis, or no affordable reasoning level. The regular
   * single-model path owns the turn — its `auto` resolution is the
   * deterministic pick or reasoning-free, with no classifier call, charge,
   * or reserve.
   */
  | { readonly kind: 'fallback' };

/**
 * The pinned-model + auto-effort turn: the user chose the model, so the
 * ONE classifier generation classifies only the effort dimension over a
 * single-candidate smartModel node — `classify: { model: false, effort:
 * true }` — and the model dimension short-circuits at runtime. The node is
 * NOT badged Smart Model (the pick is the user's own).
 *
 * The answer cap reserves the STRONGEST affordable option's budget on top of
 * the answer headroom (B + H, sized after deducting the classifier's
 * worst-case reserve), so whichever option the classifier picks at runtime
 * carves its budget out of an already-held cap — reserve ≥ charge by
 * construction. The classifier is the cheapest priceable engine-text model
 * (the Smart Model derivation, reused); when the catalog holds no priceable
 * engine the send is REFUSED with the typed classifier code (BILLING §Effort
 * 5) — never a silent static pick, and explicit levels stay usable.
 */
export function compileAutoEffortTurn(
  catalog: readonly ModelDescriptor[],
  model: string,
  budget: TurnBudget
): Result<AutoEffortTurnBuild, DomainError> {
  const target = catalog.find((descriptor) => descriptor.id === model);
  if (target === undefined) return ok({ kind: 'fallback' });
  // Two or more real choices is what makes a classification exist; with one
  // or none the answer is settled, so no call is bought (BILLING §Effort 5).
  if (turnEffortOptions([reasoningPlanModelFrom(target)]).length < 2) {
    return ok({ kind: 'fallback' });
  }
  const classifier = pickEffortClassifier(catalog, target);
  if (classifier === null) {
    return err(
      unavailableError(
        'no priceable classifier engine in the catalog',
        undefined,
        ERROR_CODES.CLASSIFIER_UNAVAILABLE
      )
    );
  }
  const pricings = turnModelPricings([model], snapshotResolver(catalog));
  if (pricings === undefined) return ok({ kind: 'fallback' });
  // The classifier spends before the answer, so the cap sizes against the
  // funds left after its worst-case reserve (the Smart Model deduction rule).
  const answerBudget: TurnBudget = {
    promptCharacterCount: budget.promptCharacterCount,
    funding: {
      ...budget.funding,
      remainingNanoUsd: budget.funding.remainingNanoUsd - classifier.classifierWorstCaseNanoUsd,
    },
  };
  const cap = autoEffortAnswerCap(target, answerBudget, pricings);
  if (cap === undefined) return ok({ kind: 'fallback' });
  const registries = createTurnCompileRegistries(snapshotResolver(catalog));
  const built = buildSmartModelTurn({
    classifierModelId: classifier.classifierModelId,
    candidates: [
      {
        id: target.id,
        ...(target.description === undefined ? {} : { description: target.description }),
      },
    ],
    classify: { model: false, effort: true },
    answerMaxOutputTokens: cap,
    promptInputTokens: promptInputTokensFor(budget),
    nodes: registries.nodes,
    constraints: registries.constraints,
  });
  /* v8 ignore next -- defensive: the pinned model was found in the SAME
     catalog snapshot the compile registries read, so a compile failure means
     the two reads drifted — kept fail-closed rather than assumed impossible */
  if (built.isErr()) return ok({ kind: 'fallback' });
  const stamped = withStorageStamp(built.value, budget, CHAT_TURN_HOOKS);
  return ok({
    kind: 'built',
    // The B+H guess is an upper bound; the ONE canonical admission estimator
    // re-fits it (shrinking the cap, never growing it) so the hold fits the
    // payer's funds by construction.
    definition: reconcileAnswerCeiling(stamped, snapshotResolver(catalog), budget, cap),
  });
}

/**
 * The auto turn's completion-cap guess: the STRONGEST offered option the
 * payer can afford, as B + H. The reserve must cover whatever the classifier
 * picks, and it is presented exactly the turn's options — so the walk runs
 * the model's own offered budgets, descending, rather than any fixed level
 * order. Min (B = 0) needs no reserve of its own: any level's cap covers it.
 * Undefined when no offered level fits — auto then degrades through the
 * fallback path.
 */
function autoEffortAnswerCap(
  target: ModelDescriptor,
  budget: TurnBudget,
  pricings: readonly TurnModelPricing[]
): number | undefined {
  const budgets = turnEffortOptions([reasoningPlanModelFrom(target)])
    .map((option) => option.maxReasoningBudgetTokens)
    .filter((tokens) => tokens > 0)
    .toSorted((a, b) => b - a);
  for (const reasoningBudgetTokens of budgets) {
    const headroom = answerHeadroomTokens(budget, pricings, reasoningBudgetTokens);
    if (headroom !== undefined) return reasoningBudgetTokens + headroom;
  }
  return undefined;
}

/**
 * Builds the pinned+auto turn end to end from the request's db — one exposed
 * catalog read feeds the classifier pick, the cap sizing, and the compile
 * registries (compile ⟺ runtime never diverge). `fallback` tells the route
 * to build the regular single-model turn instead; a typed error refuses the
 * send outright (no priceable classifier engine).
 */
export function buildAutoEffortTurnDefinition(
  deps: TrialSmartModelTurnDeps,
  model: string,
  args: { readonly budget: TurnBudget }
): ResultAsync<AutoEffortTurnBuild, DomainError> {
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
    compileAutoEffortTurn(catalog, model, args.budget)
  );
}

export interface TrialSmartModelTurnDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
}

/**
 * Builds the Smart Model turn for one TRIAL send: no wallet and no balance
 * read — the candidate list is the trial-eligible text set whose classifier
 * reserve plus the ACTUAL message's base cost fits the fixed 1¢ per-message
 * ceiling (see `buildTrialSmartModelCandidates` for the full basis), compiled
 * under the trial hooks (no-persist / no-charge). No eligible candidate
 * yields `buildable: false` — the route refuses the send as too expensive,
 * the same refusal class as a concrete over-cap model.
 */
export function buildTrialSmartModelTurnDefinition(
  deps: TrialSmartModelTurnDeps,
  args: {
    readonly prompt: string;
    readonly history: readonly ChatHistoryMessage[];
    readonly now: Date;
    /**
     * The 1¢-derived answer output-token ceiling budget; omitted builds without
     * a cap. The trial reserve is priced in base units and not deducted here.
     */
    readonly budget?: TurnBudget;
    /** True when the trial request selected `auto` effort (same gate as paid). */
    readonly classifyEffort?: boolean;
    /** True when the send selected `none` — see {@link SmartModelTurnParams.reasoningOff}. */
    readonly reasoningOff?: boolean;
  }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) => {
    const picked = buildTrialSmartModelCandidates({
      descriptors: catalog,
      nowMs: args.now.getTime(),
      prompt: args.prompt,
      history: args.history,
    });
    const classify =
      args.classifyEffort === true && picked !== null
        ? effortDimensionForCandidates(catalog, picked.candidates)
        : undefined;
    return compileSmartModelBuild(catalog, picked, {
      hooks: TRIAL_TURN_HOOKS,
      ...(args.budget === undefined ? {} : { budget: args.budget }),
      ...(classify === undefined ? {} : { classify }),
      ...(args.reasoningOff === true ? { reasoningOff: true } : {}),
    });
  });
}
