import { DEADLINE_CLASS_MS, ERROR_CODES } from '@hushbox/shared';
import {
  createEstimateRun,
  createModelPricingResolver,
  createModelProvider,
} from '../../models/index.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createFencedSettlementHook,
  createLiveExecutionRegistry,
  createWorkflowExecutor,
  keyRowCompletion,
  predicateCode,
  reducerCode,
} from '../../workflows/index.js';
import {
  admitRun,
  createBillingStores,
  resolveBudgetScopes,
  utcMonthKey,
} from '../../billing/index.js';
import { createConversationsStores } from '../../conversations/index.js';
import { okAsync } from '../../../lib/result/index.js';
import {
  RUN_LEASE_SECONDS,
  claimKeyRow,
  isIdempotencyConflict,
} from '../../../lib/idempotency/index.js';
import { createTurnCompileRegistries } from './turn-definition.js';
import { createChatSettlementCommit } from './settlement.js';
import { bindTrialHooks, requireTrialContext } from './trial.js';
import {
  CHAT_ADMISSION_HOOK,
  CHAT_TURN_ROUTE,
  PER_WALLET_CONCURRENT_RUN_CAP,
  TRIAL_ADMISSION_HOOK,
} from './constants.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { ChatStores } from '../ports/stores.js';
import type { SubWorkflowBinding, createConstraintRegistry } from '../../workflows/index.js';
import type { AdmissionDeps, BillingStores, BudgetScope } from '../../billing/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ClaimRun,
  FlowExecutor,
  FlowHookBindings,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  PaidRunIdentity,
  RunClaim,
  RunContext,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * The conversation runtime: the real workflow executor, the definition's
 * policy-hook binder, and the run referee, composed from the production
 * factories. This lives in chat's domain — the single layer permitted to
 * import the workflows / models / billing barrels the composition needs — and
 * is consumed by the ConversationRoom DO bindings. Everything the chat turn
 * runs on assembles here.
 */

export interface ConversationRuntime {
  readonly executor: FlowExecutor;
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => FlowHookBindings;
  readonly claimRun: ClaimRun;
}

export interface ConversationRuntimeDeps {
  /** The DO-scoped database handle for the executor, hooks, and referee. */
  readonly db: Database;
  readonly redis: AdmissionDeps['redis'];
  readonly telemetry: Telemetry;
  /** The OpenRouter key (via envUtils at the composition boundary — never read here). */
  readonly apiKey: string;
  /** Chat's content persister (chat's own adapter, injected by the composer). */
  readonly chatStores: ChatStores;
  /** The epoch public key read, supplied by the conversations slice (it owns `epochs`). */
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A chat turn resolves no sub-workflows; every ref misses this empty catalog. */
const NO_SUB_WORKFLOWS: Record<string, SubWorkflowBinding | undefined> = {};

type ConstraintRegistry = ReturnType<typeof createConstraintRegistry>;

/**
 * The live-execution-registry lookups the executor is wired with: no
 * sub-workflows (a chat turn has none) and schema resolution over the shared
 * constraint registry (compile ⟺ runtime typing from one source).
 */
export function createExecutionResolvers(constraints: ConstraintRegistry) {
  return {
    subWorkflows: { resolve: (ref: string) => NO_SUB_WORKFLOWS[ref] },
    schemas: { resolveSchema: (name: string) => constraints.resolve('schema', name)?.schema },
  };
}

/** Workflow control randomness (fan-out ordering) — not security-sensitive, but crypto-sourced. */
export function engineRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  /* v8 ignore next -- a length-1 Uint32Array always has index 0 populated */
  return (buffer[0] ?? 0) / 2 ** 32;
}

/**
 * The executor is built lazily: the catalog pricing snapshot loads on the
 * first run and the one resolver instance feeds BOTH the compile registries
 * and the live execution registry (compile ⟺ runtime never diverge). The
 * memoized build matches the resolver's read-once freshness contract; a DO
 * that outlives the catalog's hourly refresh is reconstructed by the platform.
 */
function createLazyExecutor(deps: ConversationRuntimeDeps): FlowExecutor {
  let cached: Promise<FlowExecutor> | undefined;
  const build = async (): Promise<FlowExecutor> => {
    const pricingResolver = await createModelPricingResolver({
      db: deps.db,
      telemetry: deps.telemetry,
    }).match(
      (resolver) => resolver,
      (error) => {
        throw new Error('chat runtime: model catalog snapshot unavailable', { cause: error });
      }
    );
    const { models, compute, nodes, constraints } = createTurnCompileRegistries(pricingResolver);
    const provider = createModelProvider({ apiKey: deps.apiKey });
    const execution = createLiveExecutionRegistry({
      provider,
      models,
      compute,
      ...createExecutionResolvers(constraints),
      predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
      reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
    });
    return createWorkflowExecutor({
      registries: { nodes, constraints },
      execution,
      estimateRun: createEstimateRun(pricingResolver),
      clock: { now: () => Date.now() },
      rng: { random: engineRandom },
      telemetry: deps.telemetry,
    });
  };
  const ready = (): Promise<FlowExecutor> => (cached ??= build());
  return {
    start(request: FlowStartRequest): FlowRunHandle {
      let inner: FlowRunHandle | undefined;
      let stopped: FlowStopReason | undefined;
      const done = (async (): Promise<FlowRunOutcome> => {
        const executor = await ready();
        inner = executor.start(request);
        if (stopped) inner.stop(stopped);
        return inner.done;
      })();
      return {
        runId: request.runKey,
        done,
        stop(reason: FlowStopReason): void {
          if (inner === undefined) stopped = reason;
          else inner.stop(reason);
        },
      };
    },
  };
}

/** The run context of a paid turn — the only shape the chat policy binds over. */
type PaidRunContext = PaidRunIdentity & {
  readonly runId: string;
  readonly fence: RunContext['fence'];
};

/**
 * The chat policy runs only under a paid identity (balance hold + epoch-wrapped
 * persistence). A `chat`-hooked definition arriving with any other identity is
 * a composition defect — the binder fails fast rather than bind a policy to the
 * wrong identity.
 */
function requirePaidContext(context: RunContext): PaidRunContext {
  if (context.mode !== 'paid') {
    throw new Error(
      `chat runtime: the chat policy requires a paid run identity, got "${context.mode}"`
    );
  }
  return context;
}

/**
 * Resolves the initiator's member-budget scope for admission. Member budgets
 * are opt-in and period-keyed: a scope is enforced only when a budget row is
 * configured for the member's current period (a group turn with a set budget).
 * A solo turn or an unconfigured member has no row and no scope, so admission
 * gates on balance and the concurrent-run cap alone. The membership/budget reads
 * fail closed through the hook's error mapping. Conversation spending is tracked
 * uncapped by design, so it produces no scope.
 */
function resolveMemberBudgetScopes(
  deps: ConversationRuntimeDeps,
  stores: BillingStores,
  context: PaidRunContext,
  now: Date
): ResultAsync<readonly BudgetScope[], DomainError> {
  const conversationsStores = createConversationsStores(deps.db);
  const month = utcMonthKey(now);
  return conversationsStores.members
    .activeByUser(context.conversationId, context.userId)
    .andThen((member) => {
      if (member === null) return okAsync<readonly BudgetScope[], DomainError>([]);
      return stores.readMemberBudget(deps.db, member.id, month).andThen((row) => {
        if (row === null) return okAsync<readonly BudgetScope[], DomainError>([]);
        return resolveBudgetScopes(stores, deps.db, {
          now,
          memberBudget: { memberId: member.id, capNanoUsd: row.budgetNanoUsd },
        });
      });
    });
}

/** Maps a refusal or infra failure onto the engine's admission error codes. */
function createAdmissionHook(
  deps: ConversationRuntimeDeps,
  context: PaidRunContext,
  definition: WorkflowDefinition,
  clock: () => Date
): FlowHookBindings['admission'] {
  const stores = createBillingStores();
  const admissionDeps: AdmissionDeps = {
    redis: deps.redis,
    db: deps.db,
    stores,
  };
  return (request) => {
    const now = clock();
    return resolveMemberBudgetScopes(deps, stores, context, now)
      .andThen((budgets) =>
        admitRun(admissionDeps, {
          walletId: context.walletId,
          holdId: context.runId,
          estimateNanoUsd: request.estimate,
          deadlineSeconds: DEADLINE_CLASS_MS[definition.deadlineClass] / 1000,
          concurrentRunCap: PER_WALLET_CONCURRENT_RUN_CAP,
          budgets,
          now,
        })
      )
      .match(
        (decision) =>
          decision.admitted
            ? {
                admitted: true as const,
                holdRef: decision.hold.holdId,
                circuit: {
                  estimateNanoUsd: decision.hold.estimateNanoUsd,
                  costCircuitMultiplier: decision.hold.costCircuitMultiplier,
                  costCircuitLimitNanoUsd: decision.hold.costCircuitLimitNanoUsd,
                },
              }
            : { admitted: false as const, code: ERROR_CODES.INSUFFICIENT_ADMISSION },
        (error) => ({
          admitted: false as const,
          code:
            error.code === 'unavailable'
              ? ERROR_CODES.ADMISSION_UNAVAILABLE
              : ERROR_CODES.INSUFFICIENT_ADMISSION,
        })
      );
  };
}

/** The per-binder collaborators the chat policy closes over (clock, ids, stores). */
interface BinderContext {
  readonly clock: () => Date;
  readonly newId: () => string;
  readonly billingStores: ReturnType<typeof createBillingStores>;
}

/** The chat policy's admission (balance hold) + settlement (persist-then-charge). */
function bindChatHooks(
  deps: ConversationRuntimeDeps,
  context: PaidRunContext,
  definition: WorkflowDefinition,
  binder: BinderContext
): FlowHookBindings {
  return {
    admission: createAdmissionHook(deps, context, definition, binder.clock),
    settlement: createFencedSettlementHook({
      db: deps.db,
      fence: context.fence,
      // The replayable response a succeeded key row returns on retry; the
      // client re-fetches the settled turn's final cost.
      complete: keyRowCompletion({ runId: context.runId }),
      commit: createChatSettlementCommit({
        identity: {
          conversationId: context.conversationId,
          epochNumber: context.epochNumber,
          walletId: context.walletId,
          userId: context.userId,
          runId: context.runId,
          userMessage: context.userMessage,
          ...(context.forkId == null ? {} : { forkId: context.forkId }),
          ...(context.regenerate == null ? {} : { regenerate: context.regenerate }),
        },
        stores: deps.chatStores,
        billingStores: binder.billingStores,
        readEpochPublicKey: deps.readEpochPublicKey,
        now: binder.clock,
        newId: binder.newId,
      }),
    }),
  };
}

/**
 * The policy-hook binder — the anti-duplication seam. It dispatches on the
 * definition's DECLARED hook names, not on a hardcoded policy: `chat` binds the
 * balance-hold admission and the persist-then-charge settlement; `trial` binds
 * the quota admission and the no-op settlement. The turn pipeline is one; only
 * the bound policy differs. An unregistered hook name is a composition defect.
 */
function createHookBinder(
  deps: ConversationRuntimeDeps
): (context: RunContext, definition: WorkflowDefinition) => FlowHookBindings {
  const binder: BinderContext = {
    clock: deps.now ?? ((): Date => new Date()),
    newId: deps.newId ?? ((): string => crypto.randomUUID()),
    billingStores: createBillingStores(),
  };
  return (context, definition) => {
    if (definition.hooks.admission === CHAT_ADMISSION_HOOK) {
      return bindChatHooks(deps, requirePaidContext(context), definition, binder);
    }
    if (definition.hooks.admission === TRIAL_ADMISSION_HOOK) {
      return bindTrialHooks(deps, requireTrialContext(context), binder.clock);
    }
    throw new Error(
      `chat runtime: no policy registered for hooks admission="${definition.hooks.admission}" settlement="${definition.hooks.settlement}"`
    );
  };
}

function createClaimRun(deps: ConversationRuntimeDeps): ClaimRun {
  const newId = deps.newId ?? ((): string => crypto.randomUUID());
  return (request) => {
    const executorId = newId();
    // The key-row scope's `userId` is the paying user for a paid run and the
    // trial session id for a trial run — both uuids fitting the uuid column.
    const scopeUserId =
      request.identity.mode === 'paid' ? request.identity.userId : request.identity.sessionId;
    return claimKeyRow(deps.db, {
      scope: { userId: scopeUserId, route: CHAT_TURN_ROUTE, key: request.runKey },
      kind: 'run',
      bodyHash: request.bodyHash,
      executorId,
      leaseSeconds: RUN_LEASE_SECONDS,
      runId: request.runId,
    }).match(
      (claim): RunClaim => {
        if (claim.outcome === 'executor') {
          return {
            outcome: 'executor',
            fence: { id: claim.row.id, executorId, claims: claim.row.claims },
          };
        }
        if (claim.outcome === 'replay') {
          return { outcome: 'replay', response: claim.response };
        }
        return { outcome: 'attach' };
      },
      (error): RunClaim => {
        // A reused key + different body is an EXPECTED conflict → 409 with the
        // body-mismatch code, never swallowed into "runtime unavailable". Any
        // other DomainError is an infra failure — rethrow so the DO's startRun
        // catch releases the in-memory claim and surfaces it.
        if (isIdempotencyConflict(error)) return { outcome: 'conflict', code: error.wireCode };
        throw new Error('chat runtime: run referee unavailable', { cause: error });
      }
    );
  };
}

export function createConversationRuntime(deps: ConversationRuntimeDeps): ConversationRuntime {
  return {
    executor: createLazyExecutor(deps),
    bindHooks: createHookBinder(deps),
    claimRun: createClaimRun(deps),
  };
}
