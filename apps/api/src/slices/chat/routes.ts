import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  CHAT_TURN_INPUT,
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  TRIAL_TURN_HOOKS,
  buildMultiModelTurnDefinition,
  buildTurnDefinition,
  callerUserId,
  canRegenerate,
  consumeTrialBurst,
  consumeTrialQuota,
  createErrorResponse,
  hashCanonicalJson,
  hashIp,
  listDescriptors,
  readIdempotencyKey,
  resolveTrialSessionPrincipal,
  resolveTurnContext,
  trialEligibility,
  trialMessageBaseNanoUsd,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ModelDescriptor } from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  ChatRouteDeps,
  DomainError,
  DomainErrorCode,
  RegenerateDecision,
} from './domain/index.js';

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

export const startTurnBodySchema = z.object({
  conversationId: z.string().min(1),
  model: z.string().min(1),
  // The multi-model fan-out: an ordered list of models the one prompt is sent
  // to, each producing its own answer as a sibling message. Absent (or a single
  // model) is the single-model turn; two or more selects the fan-out. `model`
  // stays required for the single-model case and single-model clients.
  models: z.array(z.string().min(1)).min(2).optional(),
  // The branch this turn extends. Absent for a linear send; when present the
  // turn chains onto the fork's tip and advances it at settlement.
  forkId: z.uuid().optional(),
  // The initiator's message: a client-supplied id (persisted as the turn's user
  // message, idempotent across a re-executed run) and its content (the prompt).
  userMessage: z.object({
    id: z.uuid(),
    content: z.string().min(1),
  }),
});

export const regenerateTurnBodySchema = z.object({
  conversationId: z.string().min(1),
  model: z.string().min(1),
  // The anchor USER message this turn re-runs. `action` keeps it (`retry`,
  // swapping the reply) or replaces it (`edit`); `replaceAssistantId` (retry
  // only) deletes just that reply instead of every reply below the anchor.
  targetMessageId: z.uuid(),
  action: z.enum(['retry', 'edit']),
  replaceAssistantId: z.uuid().optional(),
  // The branch the target lives on; absent for a linear conversation.
  forkId: z.uuid().optional(),
  // The turn's user message: for `edit`, the replacement (a fresh id + the
  // edited content); for `retry`, the re-sent prompt (content feeds inference).
  userMessage: z.object({
    id: z.uuid(),
    content: z.string().min(1),
  }),
});

export const stopTurnBodySchema = z.object({
  conversationId: z.string().min(1),
});

export const trialTurnBodySchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  webSearchEnabled: z.boolean().optional(),
});

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/**
 * Maps a non-`allowed` regenerate verdict to its rejection response, or null to
 * proceed to admission. `invalid-replace` (the retry-one target is not a real
 * assistant reply of the anchor) shares the 404 with a missing target; both are
 * authorization gates that keep the settlement's delete from touching an
 * arbitrary message. `fork-required` (409) refuses a no-forkId regenerate once
 * the conversation has forks (the linear sequence-delete would cross branches);
 * `blocked` (403) is the cross-member intervening-message refusal.
 */
function regenerateRejection(c: Context<AppEnv>, decision: RegenerateDecision): Response | null {
  switch (decision) {
    case 'target-missing':
    case 'invalid-replace': {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
    }
    case 'fork-required': {
      return c.json(createErrorResponse(ERROR_CODES.FORK_ID_REQUIRED), 409);
    }
    case 'blocked': {
      return c.json(createErrorResponse(ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER), 403);
    }
    case 'allowed': {
      return null;
    }
  }
}

/**
 * The trial send's MODEL/AFFORDABILITY gate — three pre-run refusals that keep
 * the free trial to cheap text models: a non-text (image/video) model, a
 * premium model (top price quartile, recent release, or an unaffordable minimal
 * exchange), and an actual message whose estimated cost exceeds 1¢. Returns the
 * refusal response, or null to proceed. Runs before the quota INCR (a refusal
 * burns no slot) and before the turn compile (so a non-text model gets
 * MEDIA_TRIAL_BLOCKED, not the compile step's generic 400). An unknown model is
 * absent from the exposed catalog (`target === undefined`): the gate is a no-op
 * and the compile step refuses it as an unknown model.
 */
function trialGateRejection(
  c: Context<AppEnv>,
  target: ModelDescriptor | undefined,
  exposedCatalog: readonly ModelDescriptor[],
  prompt: string
): Response | null {
  if (target === undefined) return null;
  const verdict = trialEligibility(target, exposedCatalog, Date.now());
  if (!verdict.eligible) {
    return verdict.reason === 'non-text'
      ? c.json(createErrorResponse(ERROR_CODES.MEDIA_TRIAL_BLOCKED), 403)
      : c.json(createErrorResponse(ERROR_CODES.PREMIUM_REQUIRES_ACCOUNT), 403);
  }
  // The actual message priced on a minimum basis (prompt tokens + a fixed
  // minimum output allocation), BASE cost against the 1¢ cap.
  const cost = trialMessageBaseNanoUsd(target, prompt);
  if (cost.isErr()) return respondDomainError(c, cost.error);
  if (cost.value > TRIAL_MESSAGE_COST_CAP_NANO_USD) {
    return c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402);
  }
  return null;
}

/**
 * The caller's IP for the trial anti-evasion counter. `cf-connecting-ip` is
 * absent off Cloudflare (local dev, tests); the sentinel shares one counter
 * there, which those environments tolerate.
 */
function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? '0.0.0.0';
}

/**
 * The trial send's per-IP BURST throttle — an abuse cap (20 sends / 60s per
 * hashed IP) refusing a flood BEFORE the catalog read, so a refusal reads no
 * catalog and burns no daily quota slot. Returns the refusal response, or null
 * to proceed. Redis down fails closed (503), never open to unlimited sends.
 */
async function trialBurstRejection(c: Context<AppEnv>, ipHash: string): Promise<Response | null> {
  const burst = await consumeTrialBurst(c.var.redis, ipHash);
  if (burst.isErr()) return respondDomainError(c, burst.error);
  if (burst.value.allowed) return null;
  return c.json(
    createErrorResponse(ERROR_CODES.RATE_LIMITED, {
      retryAfterSeconds: burst.value.retryAfterSeconds,
    }),
    429
  );
}

/**
 * Maps a run-start outcome to a response — shared by the paid and trial turn
 * routes so the one referee→HTTP contract lives once. A settled/duplicate key
 * replays the persisted response (never a transport error); a still-live run
 * tells the client to rejoin its stream; otherwise a fresh run handle or a
 * 409-class refusal. The return type is inferred so both routes' response
 * shapes still flow into `AppType`.
 */
function respondRunStart(
  c: Context<AppEnv>,
  started: ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>
) {
  return started.match(
    (outcome) => {
      if ('outcome' in outcome) {
        return outcome.outcome === 'replay'
          ? c.json(outcome.response as Record<string, unknown>, 200)
          : c.json({ outcome: 'attach' as const }, 200);
      }
      return outcome.started
        ? c.json({ runId: outcome.runId, deadlineAt: outcome.deadlineAt }, 201)
        : c.json(createErrorResponse(outcome.code), 409);
    },
    (error) => respondDomainError(c, error)
  );
}

function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The pipeline enforced the header before the handler ran (the chat turn is a
 * `run`-kind mutation whose referee is the conversation DO, so the route
 * requires the key and forwards it as the run key rather than claiming
 * itself). Absence here is a composition defect.
 */
function requiredRunKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  /* v8 ignore next 3 -- the idempotency-key middleware enforces the key on this mutating route before the handler runs; this guard is a defect-only invariant */
  if (key === undefined) {
    throw new Error('chat: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The chat turn's HTTP surface. The route resolves the run identity (paying
 * wallet, current epoch), compiles the single-model turn, and hands the run to
 * the conversation DO — the DO owns the referee claim, deadline, streaming, and
 * settlement. No business logic settles here; the handler only composes.
 *
 * The return type is deliberately inferred so the route schema flows into
 * `AppType` (annotating `Hono<AppEnv>` erases it to `BlankSchema`).
 */
export function createChatManifest(deps: ChatRouteDeps) {
  return defineSliceManifest({
    basePath: '/chat',
    routes: new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', startTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredRunKey(c);

          const context = await resolveTurnContext(
            { conversations: deps.conversations, billing: deps.billing },
            c.var.db,
            { conversationId: body.conversationId, userId, forkId: body.forkId }
          );
          if (context.isErr()) return respondDomainError(c, context.error);

          // A models list of two or more is the multi-model fan-out (one sibling
          // per model); otherwise the single-model turn. Every listed model is
          // validated against the exposed catalog inside the build — an unknown,
          // unexposed, or non-ZDR model fails closed before the run starts.
          const definition = await (body.models === undefined
            ? buildTurnDefinition({ db: c.var.db, telemetry: c.var.logger }, body.model)
            : buildMultiModelTurnDefinition(
                { db: c.var.db, telemetry: c.var.logger },
                body.models
              ));
          if (definition.isErr()) return respondDomainError(c, definition.error);

          const bodyHash = await hashCanonicalJson({
            conversationId: body.conversationId,
            model: body.model,
            ...(body.models === undefined ? {} : { models: body.models }),
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
            userMessage: body.userMessage,
          });
          const runStartBody: RunStartBody = {
            mode: 'paid',
            runKey,
            bodyHash,
            definition: definition.value,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.userMessage.content } },
            userId,
            senderId: userId,
            walletId: context.value.walletId,
            epochNumber: context.value.epochNumber,
            userMessage: body.userMessage,
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
          };

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody)
          );
        }
      )
      // The regenerate/edit turn: the SAME paid pipeline, but the settlement
      // deletes the superseded reply(s) and re-parents the new one. Two extra
      // pre-run gates: the target must belong to the conversation (404), and a
      // group regenerate must not delete across another member's message (403).
      .post(
        '/regenerate',
        routeClass('session'),
        zValidator('json', regenerateTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredRunKey(c);

          const context = await resolveTurnContext(
            { conversations: deps.conversations, billing: deps.billing },
            c.var.db,
            { conversationId: body.conversationId, userId, forkId: body.forkId }
          );
          if (context.isErr()) return respondDomainError(c, context.error);

          const decision = await canRegenerate(deps.conversations(c.var.db), {
            conversationId: body.conversationId,
            targetMessageId: body.targetMessageId,
            userId,
            forkId: body.forkId,
            replaceAssistantId: body.replaceAssistantId,
          });
          if (decision.isErr()) return respondDomainError(c, decision.error);
          const rejection = regenerateRejection(c, decision.value.decision);
          if (rejection !== null) return rejection;

          const definition = await buildTurnDefinition(
            { db: c.var.db, telemetry: c.var.logger },
            body.model
          );
          if (definition.isErr()) return respondDomainError(c, definition.error);

          // The client-intent fields that scope idempotency dedup; the
          // server-derived observed tip is bound to the run body below, NOT the
          // body hash — a retry after the tip legitimately moved must not 409.
          const regenerateCore = {
            action: body.action,
            targetMessageId: body.targetMessageId,
            ...(body.replaceAssistantId === undefined
              ? {}
              : { replaceAssistantId: body.replaceAssistantId }),
          };
          const bodyHash = await hashCanonicalJson({
            conversationId: body.conversationId,
            model: body.model,
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
            userMessage: body.userMessage,
            regenerate: regenerateCore,
          });
          // Carry the tip the guard validated its deletable tail against so the
          // settlement can assert the fork-row-locked tip still matches it (the
          // fork-tip TOCTOU fence). Only meaningful on a fork regenerate.
          const regenerate = {
            ...regenerateCore,
            ...(body.forkId === undefined
              ? {}
              : { observedForkTipId: decision.value.observedForkTipId }),
          };
          const runStartBody: RunStartBody = {
            mode: 'paid',
            runKey,
            bodyHash,
            definition: definition.value,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.userMessage.content } },
            userId,
            senderId: userId,
            walletId: context.value.walletId,
            epochNumber: context.value.epochNumber,
            userMessage: body.userMessage,
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
            regenerate,
          };

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody)
          );
        }
      )
      // The trial turn: the SAME single-model pipeline under the no-persist /
      // no-charge policy. Public (no session) — an authenticated caller is
      // refused; a trial-session principal is resolved from `x-trial-token`,
      // never a cookie. The 5/day dual-identity quota (token + IP) lives here
      // because only the route holds both; the global Sybil budget is enforced
      // by the trial admission hook.
      .post(
        '/trial',
        routeClass('public'),
        zValidator('json', trialTurnBodySchema, rejectInvalid),
        async (c) => {
          if (c.var.principal.kind !== 'none') {
            return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
          }
          const body = c.req.valid('json');
          // Web search is an account feature; trial reserves no budget for the
          // tool cap, so a hand-crafted request enabling it is refused.
          if (body.webSearchEnabled === true) {
            return c.json(createErrorResponse(ERROR_CODES.FEATURE_REQUIRES_AUTH), 403);
          }
          const runKey = requiredRunKey(c);
          const principal = resolveTrialSessionPrincipal({
            credential: c.req.header('x-trial-token') ?? null,
            newId: () => crypto.randomUUID(),
          });
          // The hashed IP is the identity for BOTH the burst throttle and the
          // 5/day quota; compute it once and reuse it (never double-hash).
          const ipHash = await hashIp(clientIp(c));
          // The per-IP BURST throttle runs BEFORE the catalog read so a flood is
          // refused cheaply — reading no catalog and burning no daily quota slot.
          const burstRejection = await trialBurstRejection(c, ipHash);
          if (burstRejection !== null) return burstRejection;
          // The MODEL/AFFORDABILITY gate runs BEFORE the compile and the quota
          // INCR: a refusal burns no slot, and a non-text model is refused as
          // MEDIA_TRIAL_BLOCKED here rather than falling through to the compile
          // step's generic unknown-model 400. An unknown model is absent from
          // the exposed catalog, so the gate is a no-op and the compile below
          // refuses it.
          const catalog = await listDescriptors({ db: c.var.db, telemetry: c.var.logger });
          if (catalog.isErr()) return respondDomainError(c, catalog.error);
          const target = catalog.value.find((descriptor) => descriptor.id === body.model);
          const gateRejection = trialGateRejection(c, target, catalog.value, body.prompt);
          if (gateRejection !== null) return gateRejection;
          // Validate the model and compile the turn BEFORE consuming a quota
          // slot: a refused request must never burn one. A model that cannot
          // build a text turn — unknown, or a non-text (image/video) model — is
          // refused here with a typed 400, having consumed nothing.
          const definition = await buildTurnDefinition(
            { db: c.var.db, telemetry: c.var.logger },
            body.model,
            TRIAL_TURN_HOOKS
          );
          if (definition.isErr()) return respondDomainError(c, definition.error);

          // Consume one 5/day slot only now that the turn is runnable. The INCR
          // is atomic (Redis) and fails closed. Residual replay edge: the run
          // referee is the conversation DO (startRun), so the route cannot
          // cheaply distinguish a same-key network retry from a first send
          // before this gate — a retry re-increments the slot even though the DO
          // then replays/attaches without executing a second run. Bounded and
          // accepted; splitting claim from check would need a new DO surface.
          const quota = await consumeTrialQuota(c.var.redis, {
            sessionId: principal.sessionId,
            ipHash,
          });
          if (quota.isErr()) return respondDomainError(c, quota.error);
          if (!quota.value.allowed) {
            return c.json(createErrorResponse(ERROR_CODES.TRIAL_LIMIT_REACHED), 429);
          }

          const bodyHash = await hashCanonicalJson({ model: body.model, prompt: body.prompt });
          const runStartBody: RunStartBody = {
            mode: 'trial',
            runKey,
            bodyHash,
            definition: definition.value,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.prompt } },
            sessionId: principal.sessionId,
          };
          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(deps.trialRoomName(principal.sessionId), runStartBody)
          );
        }
      )
      // The trial WebSocket upgrade — the trial client's only way to attach to
      // the run streaming server-side (the paid `/:conversationId/websocket` is
      // membership-gated and keyed by a conversationId, neither of which a trial
      // session has). Public: an authenticated caller belongs on the
      // conversation socket and is refused. The room and the principal id are
      // BOTH derived server-side as `trialRoomName(sessionId)`, where `sessionId`
      // comes only from the resolved `x-trial-token`; the client supplies no
      // conversationId or principalId. So the DO addressed (`idFromName`) and the
      // socket's attachment principal are prefix-scoped to this session's own
      // trial room, and the broadcast-time `isTrialRoomSelf` verifier confines
      // delivery there — a trial credential can never upgrade to another trial
      // room or any conversation DO (the `trial:` prefix disjoints the DO
      // namespace). No membership check: a trial session has no membership.
      .get('/trial/websocket', routeClass('public'), async (c) => {
        if (c.var.principal.kind !== 'none') {
          return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
        }
        const principal = resolveTrialSessionPrincipal({
          credential: c.req.header('x-trial-token') ?? null,
          newId: () => crypto.randomUUID(),
        });
        const room = deps.trialRoomName(principal.sessionId);
        const upgraded = await deps
          .realtime(c.env)
          .upgrade(room, { principalId: room, isGuest: false }, c.req.raw.headers);
        return upgraded.match(
          (response) => response,
          (error) => respondDomainError(c, error)
        );
      })
      // Explicit user stop. Plain HTTP by design — a WS-blocked user must still
      // be able to abort a paid run — and membership-gated so no one can stop
      // another conversation's run. The DO settles and bills the partial; a
      // repeat is a no-op (`stopped:false` once the run is gone).
      .post(
        '/stop',
        routeClass('session'),
        zValidator('json', stopTurnBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const member = await deps
            .conversations(c.var.db)
            .members.activeByUser(conversationId, userId);
          if (member.isErr()) return respondDomainError(c, member.error);
          if (member.value === null) {
            return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
          }
          const stopped = await deps.realtime(c.env).stopRun(conversationId);
          return stopped.match(
            (didStop) => c.json({ stopped: didStop }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
