import { textTag } from '@hushbox/shared';
import { buildWorkflow, smartModel, workflowInputs } from '../../workflows/index.js';
import {
  buildSmartModelCandidates,
  buildTrialSmartModelCandidates,
  listDescriptors,
  snapshotResolver,
} from '../../models/index.js';
import { readBalance } from '../../billing/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  TRIAL_TURN_HOOKS,
} from './constants.js';
import { createTurnCompileRegistries } from './turn-definition.js';
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
  /** The declared billing/idempotency policy; the paid chat hooks by default. */
  readonly hooks?: PolicyHooks;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
}

/** The one-node smartModel definition; compile fails closed on any bad model. */
export function buildSmartModelTurn(
  params: SmartModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const node = smartModel({
    id: CHAT_TURN_NODE_ID,
    classifierModelId: params.classifierModelId,
    candidates: params.candidates,
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
function compileSmartModelBuild(
  catalog: readonly ModelDescriptor[],
  picked: {
    readonly classifierModelId: string;
    readonly candidates: readonly SmartModelCandidateEntry[];
  } | null,
  hooks?: PolicyHooks
): ResultAsync<SmartModelTurnBuild, DomainError> {
  if (picked === null) return okAsync<SmartModelTurnBuild, DomainError>({ buildable: false });
  const registries = createTurnCompileRegistries(snapshotResolver(catalog));
  const built = buildSmartModelTurn({
    classifierModelId: picked.classifierModelId,
    candidates: picked.candidates,
    ...(hooks === undefined ? {} : { hooks }),
    nodes: registries.nodes,
    constraints: registries.constraints,
  });
  /* v8 ignore next -- defensive: candidates are filtered to engine-runnable
     text→text models over the SAME catalog snapshot the compile registries
     read, so a compile failure here means the two derivations drifted — a
     defect path kept fail-closed rather than assumed impossible */
  if (built.isErr()) return errAsync<SmartModelTurnBuild, DomainError>(built.error);
  return okAsync<SmartModelTurnBuild, DomainError>({
    buildable: true,
    definition: built.value,
  });
}

/**
 * Builds the Smart Model turn end to end for one paid send: reads the paying
 * (purchased) wallet balance through billing's published read — candidate
 * SHAPING only, admission stays the sole enforcement gate — derives the
 * affordable candidate list from one exposed-catalog read, and compiles the
 * one-node definition over that same snapshot. No affordable candidate yields
 * `buildable: false`.
 */
export function buildSmartModelTurnDefinition(
  deps: SmartModelTurnDeps,
  args: { readonly userId: string; readonly now: Date }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  return readBalance(deps.billing, deps.db, args.userId, args.now).andThen((balance) =>
    listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
      compileSmartModelBuild(
        catalog,
        buildSmartModelCandidates({
          descriptors: catalog,
          balanceNanoUsd: balance.purchasedNanoUsd,
        })
      )
    )
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
  }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
    compileSmartModelBuild(
      catalog,
      buildTrialSmartModelCandidates({
        descriptors: catalog,
        nowMs: args.now.getTime(),
        prompt: args.prompt,
        history: args.history,
      }),
      TRIAL_TURN_HOOKS
    )
  );
}
