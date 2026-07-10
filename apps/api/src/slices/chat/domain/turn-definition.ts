import { MAX_SEARCH_TOOL_CALLS, mediaTag, textTag } from '@hushbox/shared';
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
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_INPUT, CHAT_TURN_NODE_ID } from './constants.js';
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
export function buildTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  model: string,
  hooks?: PolicyHooks,
  webSearchEnabled = false
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      const registries = createTurnCompileRegistries(pricingResolver);
      return assertWebSearchCapable(pricingResolver(model), webSearchEnabled).andThen(() =>
        buildSingleModelTurn({
          model,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(hooks === undefined ? {} : { hooks }),
        })
      );
    }
  );
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
  webSearchEnabled = false
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => {
      const registries = createTurnCompileRegistries(pricingResolver);
      return assertModelsWebSearchCapable(models, pricingResolver, webSearchEnabled).andThen(() =>
        buildMultiModelTurn({
          models,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
        })
      );
    }
  );
}
