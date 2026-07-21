import { DEADLINE_CLASS_MS, ERROR_CODES } from '@hushbox/shared';
import {
  createEstimateRun,
  createModelPricingResolver,
  resolveModelProvider,
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
  refreshWalletSnapshot,
  releaseHold,
  resolveBudgetScopes,
} from '../../billing/index.js';
import { createConversationsStores, resolveCallerMember } from '../../conversations/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { senderCaller } from './sender.js';
import {
  RUN_LEASE_SECONDS,
  claimKeyRow,
  failKeyRow,
  heartbeatKeyRow,
  isIdempotencyConflict,
} from '../../../lib/idempotency/index.js';
import { createTurnCompileRegistries } from './turn-definition.js';
import { createMediaPersistRun, mediaCallNodes } from './media-persist.js';
import { createVideoProgressEmitter } from './media-progress.js';
import { createChatSettlementCommit } from './settlement.js';
import { isOwnerFundedTurn } from './turn-context.js';
import { bindTrialHooks, requireTrialContext } from './trial.js';
import {
  CHAT_ADMISSION_HOOK,
  CHAT_TURN_ROUTE,
  PER_WALLET_CONCURRENT_RUN_CAP,
  TRIAL_ADMISSION_HOOK,
} from './constants.js';
import type { ModelProvider } from '../../models/index.js';
import type { ConversationCaller } from '../../conversations/index.js';
import type { Storage } from '../../media/index.js';
import type { MediaPersistRun } from './media-persist.js';
import type { ChatSettlementIdentity, EpochPublicKeyReader } from './settlement.js';
import type { ChatStores } from '../ports/stores.js';
import type { SubWorkflowBinding, createConstraintRegistry } from '../../workflows/index.js';
import type { AdmissionDeps, BillingStores, BudgetScope } from '../../billing/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ClaimRun,
  FilePartMapper,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowHoldIdentity,
  FlowHookBindings,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  MediaPersistPlan,
  MockDirectives,
  PaidRunIdentity,
  RunClaim,
  RunContext,
  RunFence,
  SettlementHook,
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

/**
 * The media pre-mint duties one run's hook bindings carry to the executor
 * start path: `mint` pre-mints the per-node persistence identities (an async
 * DB read, awaited BEFORE `executor.start`) and `mapFilePartFor` resolves the
 * per-node encrypt-and-store mappers the engine threads to `provider.infer`.
 * Absent on every text run.
 */
export interface MediaPersistStart {
  readonly mint: () => Promise<void>;
  readonly mapFilePartFor: (nodeKey: string) => FilePartMapper | undefined;
}

/**
 * The chat runtime's hook bindings: the shared `FlowHookBindings` plus the
 * in-process-only media pre-mint duties. Like the held-stream field on
 * `HeldStartRequest`, the extra field rides the in-process DO wiring by
 * structural extension — never the wire protocol — because the binder call and
 * `executor.start` are adjacent in the DO's `startRun`, making the hooks
 * object the one value that travels from bind to start.
 */
export type ChatHookBindings = FlowHookBindings & {
  readonly mediaPersist?: MediaPersistStart;
};

export interface ConversationRuntime {
  readonly executor: FlowExecutor;
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => ChatHookBindings;
  readonly claimRun: ClaimRun;
  /**
   * The run's money/lease duties, called by the DO's terminal sink — all
   * best-effort by design (a failure never fails a run): early hold release
   * (the TTL is the backstop), the fenced key-row lease heartbeat (`lost` =
   * a retry superseded the run), and the fenced `claimed → failed` flip that
   * frees the key for one serialized retry (a settled row no-ops).
   */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  readonly failRun: (fence: RunFence) => Promise<void>;
}

export interface ConversationRuntimeDeps {
  /** The DO-scoped database handle for the executor, hooks, and referee. */
  readonly db: Database;
  readonly redis: AdmissionDeps['redis'];
  readonly telemetry: Telemetry;
  /**
   * The R2 storage a media run's mappers encrypt-and-store generated files
   * through DURING streaming (under pre-minted final keys). Text runs never
   * touch it.
   */
  readonly storage: Storage;
  /** The OpenRouter key (via envUtils at the composition boundary — never read here). */
  readonly apiKey: string;
  /**
   * The DO-side env gate for the deterministic `x-mock-*` mock provider: true
   * only in dev/E2E (the composer sets it from `mockProviderEnabled(envUtils)`
   * over the DO's OWN env bindings). This is the PARAMOUNT production-inert
   * guarantee — it is false in production, so no per-request `mockDirectives` on
   * a run can ever construct the mock there. Omitted defaults to false (real).
   * Per-run directives ride `FlowStartRequest.mockDirectives`; the mock is
   * selected only when this gate is true AND a run carries directives.
   */
  readonly mockProviderEnabled?: boolean;
  /**
   * CI classification (`createEnvUtilities(env).isCI`), set by the composer. On
   * the real inference path it selects the CI-vitest cassette + service-evidence
   * wiring (true) versus the production plain-fetch wiring (false). Threaded
   * alongside `db` so the provider factory has both.
   */
  readonly isCI: boolean;
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
 * Whether THIS run selects the deterministic mock provider. The paramount
 * production-inert guarantee: it is false unless the DO's OWN env mode enables
 * the mock (`mockProviderEnabled`, derived at composition from the DO's env
 * bindings — never from request content). Only in dev/E2E, and only when the run
 * actually carries `mockDirectives`, is the mock chosen. A crafted production
 * body carrying `mockDirectives` fails the gate here and gets the real provider.
 */
export function usesMockProvider(
  deps: Pick<ConversationRuntimeDeps, 'mockProviderEnabled'>,
  mockDirectives: MockDirectives | undefined
): boolean {
  return (deps.mockProviderEnabled ?? false) && mockDirectives !== undefined;
}

/**
 * The provider for a single run. All provider-selection logic lives in the
 * models slice's {@link resolveModelProvider} factory (the single source of
 * truth mirroring legacy's three-way `getAIClient` gate); this only computes
 * the per-run mock decision and forwards the run's inputs. `isCI`/`db` default
 * for the mock/production paths that never consult them (real CI wiring always
 * supplies both).
 */
export function providerFor(
  deps: Pick<ConversationRuntimeDeps, 'mockProviderEnabled' | 'apiKey'> &
    Partial<Pick<ConversationRuntimeDeps, 'isCI' | 'db'>>,
  mockDirectives?: MockDirectives,
  awaitStreamRelease?: () => Promise<void>
): ModelProvider {
  return resolveModelProvider({
    useMock: usesMockProvider(deps, mockDirectives),
    apiKey: deps.apiKey,
    isCI: deps.isCI ?? false,
    db: deps.db,
    ...(mockDirectives === undefined ? {} : { mockDirectives }),
    ...(awaitStreamRelease === undefined ? {} : { awaitStreamRelease }),
  });
}

/**
 * The executor start request as the ConversationRoom DO hands it in: the shared
 * `FlowStartRequest` plus the DO's in-memory-only held-stream release awaitable
 * (`awaitStreamRelease`). It rides the in-process executor wiring, NEVER the wire
 * protocol, and only in dev/E2E (the DO adds it solely for a `holdPrimaryStream`
 * run). The structural field matches the DO's `HeldStreamStartRequest` in
 * `@hushbox/realtime`; both sides agree by shape, not a shared import.
 */
export type HeldStartRequest = FlowStartRequest & {
  readonly awaitStreamRelease?: () => Promise<void>;
  /**
   * The binder's own bindings object, seen at its runtime (chat) type: a media
   * run's bindings carry `mediaPersist`, which the start path consumes to mint
   * before `executor.start` and to thread `mapFilePartFor` onto the request.
   */
  readonly hooks: ChatHookBindings;
};

/**
 * The media pre-mint step of the start path: a media run (bindings carrying
 * `mediaPersist`) awaits the async plan mint BEFORE the executor starts, then
 * threads the per-node mapper resolver onto the request. A text run's request
 * is returned untouched — the very same object, so that path is byte-identical
 * to the pre-media wiring. A mint failure rejects like an executor-build
 * failure: `done` rejects (run-sink contained) and admission fails closed.
 */
/**
 * The video-progress wiring of the start path: a MEDIA-classed run's `emit` is
 * wrapped by the synthetic per-node video sweep (media-progress frames ride the
 * node's own stream); `stopProgress` is hooked to the run's terminal so an
 * aborted/deadline-killed run clears every timer silently — the existing
 * terminal frames end the tile, no extra signal is invented. A text-classed
 * run's request is returned untouched (the very same object) with a no-op stop.
 */
export function attachVideoProgress(request: HeldStartRequest): {
  readonly request: HeldStartRequest;
  readonly stopProgress: () => void;
} {
  if (request.definition.deadlineClass !== 'media') {
    return { request, stopProgress: noop };
  }
  const progress = createVideoProgressEmitter(request.definition, request.emit);
  return { request: { ...request, emit: progress.emit }, stopProgress: progress.stopAll };
}

export async function prepareStartRequest(request: HeldStartRequest): Promise<HeldStartRequest> {
  const media = request.hooks.mediaPersist;
  if (media === undefined) return request;
  await media.mint();
  return {
    ...request,
    mapFilePartFor: (nodeKey): FilePartMapper | undefined => media.mapFilePartFor(nodeKey),
  };
}

/**
 * The executor is built lazily: the catalog pricing snapshot loads on the
 * first run and the one resolver instance feeds BOTH the compile registries
 * and the live execution registry (compile ⟺ runtime never diverge). The
 * memoized build matches the resolver's read-once freshness contract; a DO
 * that outlives the catalog's hourly refresh is reconstructed by the platform.
 */
/** The catalog snapshot + compile registries, loaded once and shared by every run. */
type ExecutorCommon = ReturnType<typeof createTurnCompileRegistries> & {
  readonly pricingResolver: Parameters<typeof createEstimateRun>[0];
};

function createLazyExecutor(deps: ConversationRuntimeDeps): FlowExecutor {
  let cachedCommon: Promise<ExecutorCommon> | undefined;
  let cachedReal: FlowExecutor | undefined;
  const buildCommon = async (): Promise<ExecutorCommon> => {
    const pricingResolver = await createModelPricingResolver({
      db: deps.db,
      telemetry: deps.telemetry,
    }).match(
      (resolver) => resolver,
      (error) => {
        throw new Error('chat runtime: model catalog snapshot unavailable', { cause: error });
      }
    );
    return { pricingResolver, ...createTurnCompileRegistries(pricingResolver) };
  };
  const commonReady = (): Promise<ExecutorCommon> => (cachedCommon ??= buildCommon());
  // Only the cheap wiring (execution registry + executor) is built per invocation;
  // the expensive catalog snapshot + compile registries are the shared `common`.
  const buildExecutor = (common: ExecutorCommon, provider: ModelProvider): FlowExecutor => {
    const execution = createLiveExecutionRegistry({
      provider,
      models: common.models,
      compute: common.compute,
      ...createExecutionResolvers(common.constraints),
      predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
      reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
    });
    return createWorkflowExecutor({
      registries: { nodes: common.nodes, constraints: common.constraints },
      execution,
      estimateRun: createEstimateRun(common.pricingResolver),
      clock: { now: () => Date.now() },
      rng: { random: engineRandom },
      telemetry: deps.telemetry,
    });
  };
  // Per-run provider selection: the mock path rebuilds the cheap wiring for each
  // run so per-request `mockDirectives` take effect; the real (OpenRouter/cassette)
  // path is built ONCE and cached — unchanged from the single-provider design.
  const executorFor = async (request: HeldStartRequest): Promise<FlowExecutor> => {
    const common = await commonReady();
    if (usesMockProvider(deps, request.mockDirectives)) {
      // The held-stream barrier (dev/E2E only) rides through to the mock provider;
      // undefined on every unheld run and never present on the real path.
      return buildExecutor(
        common,
        providerFor(deps, request.mockDirectives, request.awaitStreamRelease)
      );
    }
    cachedReal ??= buildExecutor(common, providerFor(deps));
    return cachedReal;
  };
  return {
    start(request: HeldStartRequest): FlowRunHandle {
      let inner: FlowRunHandle | undefined;
      let stopped: FlowStopReason | undefined;
      const progress = attachVideoProgress(request);
      const innerReady = (async (): Promise<FlowRunHandle> => {
        const executor = await executorFor(progress.request);
        inner = executor.start(await prepareStartRequest(progress.request));
        if (stopped) inner.stop(stopped);
        return inner;
      })();
      const done: Promise<FlowRunOutcome> = (async () => {
        try {
          const handle = await innerReady;
          return await handle.done;
        } finally {
          // Every terminal — success, stop, deadline, or a build failure —
          // clears the video-progress timers; nothing outlives the run.
          progress.stopProgress();
        }
      })();
      // A build failure rejects `done` (contained by the DO's run sink), but
      // `admitted` must still settle or the start request would hang.
      const admitted: Promise<FlowAdmissionOutcome> = (async () => {
        try {
          const handle = await innerReady;
          return await handle.admitted;
          // eslint-disable-next-line catch-swallow/no-silent-catch -- admission fails closed to not-admitted; the build error surfaces on `done` (run-sink contained).
        } catch {
          return { admitted: false as const, code: ERROR_CODES.INTERNAL };
        }
      })();
      return {
        runId: request.runKey,
        done,
        admitted,
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
 * Resolves the group budget scopes for admission — emitted ONLY for an
 * OWNER-FUNDED group turn. The scopes are what make the admission Lua gate the
 * run on `Math.min` over the sender's durable per-member budget and the durable
 * per-conversation budget (plus the owner-wallet balance, gated by the payer
 * wallet itself). Three cases emit nothing:
 *   - a SOLO turn (sender is the owner): the owner funds from their wallet and
 *     is never member-capped;
 *   - a PERSONAL fall-through group turn (the route chose the sender's OWN
 *     wallet as payer because the group headroom was ≤ 0): the sender self-funds
 *     and admission gates their own balance alone — no group scope applies;
 *   - a missing conversation (defensive): the group budget scopes are skipped,
 *     but a free-wallet payer still emits its user-keyed daily-allowance scope
 *     (the free snapshot skips the balance check, so the cap must stay paired).
 * Owner-funding is recovered ONCE per run from the payer wallet the route froze
 * into the run identity (`ownerFunded`, read outside any transaction and threaded
 * to both hooks), so scope emission agrees with the payer and with settlement's
 * accrual by construction. An owner-funded group turn's absent member row reads a
 * zero cap here (deny), but the route only chooses owner-funding when the group
 * headroom is positive, so that combination is not route-reachable. The
 * membership/budget reads fail closed through the hook's error mapping.
 */
/** The per-run scope inputs: the settlement-time clock and the funding decision. */
interface ScopeContext {
  readonly now: Date;
  readonly ownerFunded: ResultAsync<boolean, DomainError>;
}

/**
 * The sender's own user id for the solo (sender-is-owner) check — a user
 * sender's userId (the flat fallback keeps the legacy single-principal turn),
 * or `undefined` for a link guest (which holds no account and is never owner).
 */
function contextSenderUserId(context: PaidRunContext): string | undefined {
  if (context.sender === undefined) return context.userId;
  return context.sender.kind === 'user' ? context.sender.userId : undefined;
}

/** The membership-gate caller for the run's sender (flat fallback keeps the user path). */
function contextSenderCaller(context: PaidRunContext): ConversationCaller {
  return context.sender === undefined
    ? { kind: 'user', userId: context.userId }
    : senderCaller(context.sender, context.conversationId);
}

function resolveMemberBudgetScopes(
  deps: ConversationRuntimeDeps,
  stores: BillingStores,
  context: PaidRunContext,
  scope: ScopeContext
): ResultAsync<readonly BudgetScope[], DomainError> {
  const conversationsStores = createConversationsStores(deps.db);
  // The daily-allowance ceiling, emitted ONLY when the payer is the sender's own
  // `free` wallet — the route fell through to it because the purchased balance
  // was ≤ 0 (turn-context). Recovered here from the wallet type, mirroring how
  // `ownerFunded` recovers the funding decision from the payer wallet: a
  // self-funded free-tier turn is gated on the daily allowance alone (group
  // scopes never apply to it — the free wallet is only ever the sender's own).
  const freeTierScopes = (): ResultAsync<readonly BudgetScope[], DomainError> =>
    stores.readWallets(deps.db, context.userId).andThen((wallets) => {
      const payerIsFree = wallets.some(
        (wallet) => wallet.id === context.walletId && wallet.type === 'free'
      );
      return payerIsFree
        ? resolveBudgetScopes(stores, deps.db, {
            now: scope.now,
            allowance: { userId: context.userId },
          })
        : okAsync<readonly BudgetScope[], DomainError>([]);
    });
  // The SENDER identity the group-scope decision keys on (recovered from
  // `context.sender`, never from the payer `userId` — which is the OWNER for a
  // guest turn): a user by userId, a link guest which is NEVER the owner and
  // never free-tier (the owner always pays).
  const senderIsGuest = context.sender?.kind === 'linkGuest';
  const senderUserId = contextSenderUserId(context);
  return conversationsStores.conversations.get(context.conversationId).andThen((conversation) => {
    // No conversation (defensive): the conversation was deleted between route-time
    // validation and this hook. Only the conversation-keyed member/conversation
    // BUDGET scopes are legitimately skipped — the free-tier allowance is
    // user-keyed and does not depend on the conversation existing, so a free-wallet
    // payer must still be capped by it (the free snapshot skips the balance check;
    // the two must never be unpaired). A purchased payer emits `[]` and stays
    // bound by the admission balance check.
    if (conversation === null) {
      return freeTierScopes();
    }
    // An owner-initiated solo turn is never member-capped, but the owner may
    // still be paying from their own free wallet (purchased ≤ 0) — then the
    // daily allowance applies. A guest is never the owner.
    if (!senderIsGuest && senderUserId === conversation.ownerUserId) {
      return freeTierScopes();
    }
    return scope.ownerFunded.andThen((funded) => {
      // Personal fall-through: a USER sender self-funds on their own wallet — no
      // group scope applies. Their purchased balance (if positive) is gated by
      // the wallet itself; a spent-down sender pays the free wallet, capped by
      // the daily allowance. A guest turn is always owner-funded, so it never
      // reaches this arm.
      if (!funded) {
        return freeTierScopes();
      }
      return resolveCallerMember(
        conversationsStores,
        context.conversationId,
        contextSenderCaller(context)
      ).andThen((member) => {
        /* v8 ignore next 3 -- turn-context asserted active membership before the run started; a null here is unreachable */
        if (member === null) {
          return okAsync<readonly BudgetScope[], DomainError>([]);
        }
        return resolveBudgetScopes(stores, deps.db, {
          now: scope.now,
          memberBudget: { memberId: member.id },
          conversationBudget: {
            conversationId: context.conversationId,
            capNanoUsd: conversation.conversationBudgetNanoUsd,
          },
        });
      });
    });
  });
}

/** The per-run admission inputs bundled to stay under the param cap. */
interface AdmissionRunContext {
  readonly clock: () => Date;
  readonly ownerFunded: ResultAsync<boolean, DomainError>;
}

/** Maps a refusal or infra failure onto the engine's admission error codes. */
function createAdmissionHook(
  deps: ConversationRuntimeDeps,
  context: PaidRunContext,
  definition: WorkflowDefinition,
  run: AdmissionRunContext
): FlowHookBindings['admission'] {
  const stores = createBillingStores();
  const admissionDeps: AdmissionDeps = {
    redis: deps.redis,
    db: deps.db,
    stores,
  };
  return (request) => {
    const now = run.clock();
    return resolveMemberBudgetScopes(deps, stores, context, { now, ownerFunded: run.ownerFunded })
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
        (decision) => {
          if (!decision.admitted) {
            // The route/DO collapse every refusal to the opaque
            // INSUFFICIENT_ADMISSION wire code (the reason must not reach the
            // client), so the typed AdmissionRefusalReason survives ONLY here.
            // Emit it — with content-free correlation ids — so a 402 is
            // debuggable from logs. Money stays off the line: no field carries
            // the nano-USD estimate, and `errorCode` is the machine-readable
            // reason, never content.
            const { runId, conversationId } = context;
            deps.telemetry.warn('chat admission refused', {
              errorCode: decision.reason,
              runId,
              conversationId,
            });
            return { admitted: false as const, code: ERROR_CODES.INSUFFICIENT_ADMISSION };
          }
          return {
            admitted: true as const,
            holdRef: decision.hold.holdId,
            // The hold identity rides the grant to the run handle's
            // `admitted` promise, so the DO's terminal sink can release
            // the hold instead of waiting out its TTL.
            hold: {
              walletId: decision.hold.walletId,
              holdId: decision.hold.holdId,
              scopeIds: decision.hold.scopeIds,
            },
            circuit: {
              estimateNanoUsd: decision.hold.estimateNanoUsd,
              costCircuitMultiplier: decision.hold.costCircuitMultiplier,
              costCircuitLimitNanoUsd: decision.hold.costCircuitLimitNanoUsd,
            },
          };
        },
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

/**
 * Post-commit, best-effort snapshot refresh around the fenced settlement: once
 * the charge commits, the Redis balance snapshot is CAS-written from DB truth
 * so the NEXT admission gates on the fresh balance instead of a stale
 * admission-time snapshot (until now only the snapshot TTL healed it). A
 * refresh failure is swallowed — it must never fail a run that already
 * settled; a settlement failure propagates and skips the refresh (nothing
 * committed, nothing to refresh).
 */
export function withPostCommitSnapshotRefresh(
  settle: SettlementHook,
  deps: Pick<ConversationRuntimeDeps, 'db' | 'redis' | 'telemetry'>,
  walletId: string
): SettlementHook {
  const stores = createBillingStores();
  return async (request) => {
    await settle(request);
    await refreshWalletSnapshot({ redis: deps.redis, db: deps.db, stores }, walletId).match(
      () => {
        // Written through — the next admission gates on the fresh balance.
      },
      () => {
        deps.telemetry.warn('post-settlement snapshot refresh skipped', {});
      }
    );
  };
}

/**
 * The put barrier a media run's settlement passes first: every ciphertext put
 * the mappers initiated must have landed before the fenced settlement runs. A
 * lost put rejects here, terminal-failing the run BEFORE anything commits — a
 * content row never points at a missing object, and an involuntary failure
 * bills nothing (saved ⟺ billed).
 */
export function withMediaPutBarrier(
  settle: SettlementHook,
  flushPuts: () => Promise<void>
): SettlementHook {
  return async (request) => {
    await flushPuts();
    await settle(request);
  };
}

/**
 * The settlement identity for one paid run. `mediaPlans` is the SAME map
 * instance the media mint filled — pre-mint and settlement can never see
 * different plans — and is absent (not empty) for a text run.
 */
export function chatSettlementIdentity(
  context: PaidRunContext,
  mediaPlans?: ReadonlyMap<string, MediaPersistPlan>
): ChatSettlementIdentity {
  return {
    conversationId: context.conversationId,
    epochNumber: context.epochNumber,
    walletId: context.walletId,
    userId: context.userId,
    // The resolved sender rides settlement so senderId, the member-keyed
    // epoch gate, and per-member spend key on the guest (or member), not
    // the paying owner. Absent falls back to the user path on `userId`.
    ...(context.sender === undefined ? {} : { sender: context.sender }),
    runId: context.runId,
    userMessage: context.userMessage,
    ...(context.forkId == null ? {} : { forkId: context.forkId }),
    ...(context.regenerate == null ? {} : { regenerate: context.regenerate }),
    ...(mediaPlans === undefined ? {} : { mediaPlans }),
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
): ChatHookBindings {
  // A MEDIA turn (deadline-classed 'media'; its modelCall nodes are the 1–5
  // media siblings) gets a media-persist run: pre-minted per-node identities
  // (minted on the start path, before executor.start) whose plans instance is
  // shared verbatim with the settlement identity, per-node encrypt-and-store
  // mappers, and the put barrier ahead of settlement. A text turn constructs
  // none of this — no storage, no epoch read, no extra binding field.
  const mediaNodes = mediaCallNodes(definition);
  const media: MediaPersistRun | undefined =
    mediaNodes.length === 0
      ? undefined
      : createMediaPersistRun(
          {
            storage: deps.storage,
            db: deps.db,
            readEpochPublicKey: deps.readEpochPublicKey,
            newId: binder.newId,
          },
          { conversationId: context.conversationId, epochNumber: context.epochNumber },
          mediaNodes
        );
  // The single funding decision, recovered ONCE per run and threaded to BOTH
  // hooks, so scope emission and group-spend attribution can never disagree —
  // and settlement never opens a second connection mid-transaction. A LINK GUEST
  // turn is ALWAYS owner-funded (a guest holds no wallet; the route denies it
  // otherwise), so recovery short-circuits to `true` — the wallet-ownership
  // trick can't be used because a guest's payer `userId` is the OWNER. A USER
  // turn recovers owner-funded ⟺ the payer is NOT one of the sender's own
  // wallets (context.userId is the sender for a user turn). A read failure
  // propagates through each hook's own error mapping (admission → refused;
  // settlement → rolled back).
  const ownerFunded =
    context.sender?.kind === 'linkGuest'
      ? okAsync<boolean, DomainError>(true)
      : isOwnerFundedTurn(binder.billingStores, deps.db, context.userId, context.walletId);
  const settlement = withPostCommitSnapshotRefresh(
    createFencedSettlementHook({
      db: deps.db,
      fence: context.fence,
      // The replayable response a succeeded key row returns on retry; the
      // client re-fetches the settled turn's final cost.
      complete: keyRowCompletion({ runId: context.runId }),
      commit: createChatSettlementCommit({
        identity: chatSettlementIdentity(context, media?.plans),
        stores: deps.chatStores,
        billingStores: binder.billingStores,
        ownerFunded,
        readEpochPublicKey: deps.readEpochPublicKey,
        now: binder.clock,
        newId: binder.newId,
      }),
    }),
    deps,
    context.walletId
  );
  return {
    admission: createAdmissionHook(deps, context, definition, { clock: binder.clock, ownerFunded }),
    settlement: media === undefined ? settlement : withMediaPutBarrier(settlement, media.flushPuts),
    ...(media === undefined
      ? {}
      : { mediaPersist: { mint: media.mint, mapFilePartFor: media.mapFilePartFor } }),
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
): (context: RunContext, definition: WorkflowDefinition) => ChatHookBindings {
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

/** The swallow arm of the best-effort duties (each mechanism's backstop recovers). */
function noop(): void {
  // Deliberately empty.
}

export function createConversationRuntime(deps: ConversationRuntimeDeps): ConversationRuntime {
  return {
    executor: createLazyExecutor(deps),
    bindHooks: createHookBinder(deps),
    claimRun: createClaimRun(deps),
    // The DO's terminal-sink capabilities, all best-effort by design: every
    // error is swallowed into the mechanism's own backstop (hold TTL, lease
    // lapse) because none of these may ever fail or stop a run.
    releaseHold: (hold: FlowHoldIdentity): Promise<void> =>
      releaseHold(deps.redis, hold).match(noop, noop),
    heartbeat: (fence: RunFence): Promise<'alive' | 'lost'> =>
      heartbeatKeyRow(deps.db, fence).match(
        (outcome) => outcome,
        // A transient store failure must never stop a healthy run; the fence
        // stays authoritative — a truly superseded run loses at settlement.
        () => 'alive' as const
      ),
    failRun: (fence: RunFence): Promise<void> => failKeyRow(deps.db, fence).match(noop, noop),
  };
}
