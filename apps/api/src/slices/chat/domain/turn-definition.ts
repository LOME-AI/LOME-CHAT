import {
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_SEARCH_TOOL_CALLS,
  MINIMUM_OUTPUT_TOKENS,
  computeSafeMaxTokens,
  mediaTag,
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
import { WEB_SEARCH_TOOL_NAME, createModelPricingResolver } from '../../models/index.js';
import { STORAGE_COST_PER_CHARACTER_NANO, applyMarkup } from '../../billing/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_INPUT, CHAT_TURN_NODE_ID } from './constants.js';
import type { PayerFunding } from './turn-context.js';
import type { ModelResolver, NodeRegistryContext } from '../../workflows/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type { ModelDescriptor, PolicyHooks, WorkflowDefinition } from '@hushbox/shared';

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

/** The legacy paid-tier negative-balance cushion ($0.50) in nano-USD. */
const PAID_CUSHION_NANO_USD = BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) * 10_000_000n;

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

export function turnMaxOutputTokens(
  budget: TurnBudget,
  models: readonly TurnModelPricing[]
): number | undefined {
  if (models.length === 0) return undefined;
  const paid = budget.funding.kind === 'purchased';
  const inputCharsPerToken = paid ? CHARS_PER_TOKEN_STANDARD : CHARS_PER_TOKEN_CONSERVATIVE;
  const outputCharsPerToken = paid ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
  const chars = budget.promptCharacterCount;
  const estimatedInputTokens = chars === 0 ? 0 : Math.ceil(chars / inputCharsPerToken);

  const { sumInputRate, sumOutputRate, minContextLength } = summedTurnPricing(models);
  const fixedCost =
    BigInt(estimatedInputTokens) * sumInputRate + BigInt(chars) * STORAGE_COST_PER_CHARACTER_NANO;
  const variableCostPerToken =
    sumOutputRate +
    BigInt(outputCharsPerToken) * STORAGE_COST_PER_CHARACTER_NANO * BigInt(models.length);
  const effective = budget.funding.remainingNanoUsd + (paid ? PAID_CUSHION_NANO_USD : 0n);
  const minimumCost = fixedCost + BigInt(MINIMUM_OUTPUT_TOKENS) * variableCostPerToken;
  if (effective < minimumCost) return undefined;

  const budgetMaxTokens = Number((effective - fixedCost) / variableCostPerToken);
  return computeSafeMaxTokens({
    budgetMaxTokens,
    modelContextLength: minContextLength,
    estimatedInputTokens,
  });
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
  /** The affordable output-token ceiling; omitted = the model's own default. */
  readonly maxOutputTokens?: number;
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
    params: maxOutputTokensParams(params.maxOutputTokens),
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
   * The ONE shared output-token ceiling every sibling carries — legacy derived
   * a single value from the summed rates and injected it into every slot.
   */
  readonly maxOutputTokens?: number;
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
      params: maxOutputTokensParams(params.maxOutputTokens),
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
 */
const MEDIA_TURN_MIME_TYPES: Record<MediaTurnModality, readonly [string, ...string[]]> = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
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
  return err(validationError(`model does not produce '${modality}' output`));
}

export interface MediaTurnParams {
  readonly model: string;
  readonly modality: MediaTurnModality;
  /**
   * The generation parameters carried onto the modelCall (`aspectRatio`, and
   * for video `durationSeconds`/`resolution`) — validated by the media adapter
   * at execution, mapped 1:1 from the request's `imageConfig`/`videoConfig`.
   */
  readonly params: Readonly<Record<string, unknown>>;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
}

/**
 * The single-model media turn: one `modelCall` node consuming the text prompt
 * and producing one media modality (image or video). It is the media analogue
 * of `buildSingleModelTurn` — same one-node shape, same graph-compile (an
 * unknown model, or a model whose output modality is not the requested one,
 * is refused at build with a typed error). The generation `params` ride the
 * node to the media adapter; media runs are deadline-classed `media`. Media is
 * paid-only (trial is single-model text), so the paid chat hooks always apply.
 */
export function buildMediaTurn(params: MediaTurnParams): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const answer = modelCall({
    id: CHAT_TURN_NODE_ID,
    model: params.model,
    accepts: textTag(),
    in: inputs.ports[CHAT_TURN_INPUT],
    produces: mediaTag(params.modality, MEDIA_TURN_MIME_TYPES[params.modality]),
    params: params.params,
  });
  return buildWorkflow({
    deadlineClass: 'media',
    hooks: CHAT_TURN_HOOKS,
    inputs,
    nodes: [answer],
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      validationError('chat media turn definition could not be compiled', errors)
    );
}

/**
 * Builds the media turn end to end from the request's db, mirroring
 * `buildTurnDefinition`: one catalog snapshot read feeds the compile registries,
 * and `buildMediaTurn` compiles the single media modelCall. The model is
 * validated against the exposed catalog (unknown / unexposed / non-ZDR / wrong
 * output modality all fail the build closed).
 */
export function buildMediaTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  model: string,
  modality: MediaTurnModality,
  params: Readonly<Record<string, unknown>>
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      // The modelCall's produce tag is a sink, so graph-compile never checks the
      // model's output modality against the requested one — a text model would
      // otherwise build an "image turn". Assert the model's sole output IS the
      // requested modality here; an unknown model (absent descriptor) falls
      // through to the compile step's unknown-model refusal.
      return assertModelProducesModality(pricingResolver(model), modality).andThen(() => {
        const registries = createTurnCompileRegistries(pricingResolver);
        return buildMediaTurn({
          model,
          modality,
          params,
          nodes: registries.nodes,
          constraints: registries.constraints,
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
}

export function buildTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  model: string,
  options: TurnDefinitionOptions = {}
): ResultAsync<WorkflowDefinition, DomainError> {
  const webSearchEnabled = options.webSearchEnabled === true;
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      const registries = createTurnCompileRegistries(pricingResolver);
      const ceiling = derivedCeiling(options.budget, [model], pricingResolver);
      return assertWebSearchCapable(pricingResolver(model), webSearchEnabled).andThen(() =>
        buildSingleModelTurn({
          model,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
        })
      );
    }
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
  const webSearchEnabled = options.webSearchEnabled === true;
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      const registries = createTurnCompileRegistries(pricingResolver);
      const ceiling = derivedCeiling(options.budget, models, pricingResolver);
      return assertModelsWebSearchCapable(models, pricingResolver, webSearchEnabled).andThen(() =>
        buildMultiModelTurn({
          models,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
        })
      );
    }
  );
}
