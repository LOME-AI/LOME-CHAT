import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { routePath } from 'hono/route';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  acceptInviteTransition,
  addMember,
  addMemberBodySchema,
  addMemberOutcomeSchema,
  broadcastForkCreated,
  broadcastForkDeleted,
  broadcastForkRenamed,
  broadcastMemberAdded,
  broadcastMemberPrivilegeChanged,
  broadcastMemberRemoved,
  broadcastRotationComplete,
  callerUserId,
  changeMemberPrivilege,
  changePrivilegeBodySchema,
  changePrivilegeOutcomeSchema,
  conversationIdParameterSchema,
  createConversation,
  createConversationBodySchema,
  createConversationOutcomeSchema,
  createErrorResponse,
  createFork,
  createForkBodySchema,
  createForkOutcomeSchema,
  createLinkBodySchema,
  createLinkOutcomeSchema,
  createSharedLink,
  createSharedMessage,
  createSharedMessageBodySchema,
  createSharedMessageOutcomeSchema,
  declineInviteTransition,
  deleteConversation,
  deleteConversationOutcomeSchema,
  deleteFork,
  deleteForkOutcomeSchema,
  evictPrincipals,
  forkParameterSchema,
  getConversation,
  getKeyChain,
  getKeyChainBatch,
  getMemberKeys,
  getMessageHistory,
  idempotencyExempt,
  idempotent,
  isIdempotencyConflict,
  isRefusal,
  leaveBodySchema,
  leaveConversation,
  leaveOutcomeSchema,
  linkIdParameterSchema,
  linkParameterSchema,
  listConversations,
  listConversationsQuerySchema,
  listForks,
  listMembers,
  listSharedLinks,
  memberKeysBatchQuerySchema,
  memberParameterSchema,
  messageHistoryQuerySchema,
  muteBodySchema,
  pinBodySchema,
  readIdempotencyKey,
  readPublicShare,
  refusalToWire,
  removeMember,
  removeMemberBodySchema,
  removeMemberOutcomeSchema,
  renameFork,
  renameForkBodySchema,
  renameForkOutcomeSchema,
  revokeLinkOutcomeSchema,
  revokeSharedLink,
  runMutation,
  setMutedTransition,
  setPinnedTransition,
  updateConversationTitle,
  updateForkTip,
  updateForkTipBodySchema,
  updateForkTipOutcomeSchema,
  updateTitleBodySchema,
  updateTitleOutcomeSchema,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  ConversationsStoresFactory,
  DbWriter,
  DomainError,
  DomainErrorCode,
  ForkMessageDeleter,
  MembershipRevoker,
  Outcome,
  RealtimeBroadcast,
  Refusal,
  Result,
} from './domain/index.js';

/** The pipeline's Redis client type, named without importing the infra module. */
type RequestRedis = AppEnv['Variables']['redis'];

export interface ConversationsRouteDeps {
  /** Bound per call site to the pipeline's `c.var.db` or a byKey transaction. */
  readonly stores: ConversationsStoresFactory;
  /** Membership-cache invalidation over the pipeline's `c.var.redis`. */
  readonly revoker: (redis: RequestRedis) => MembershipRevoker;
  /** ConversationRoom DO client; a port double in tests (infra edge). */
  readonly realtime: (env: AppEnv['Bindings']) => RealtimeBroadcast;
  /**
   * Chat's `messages` deleter, bound to the fork-delete transaction. Composed
   * so a fork deletion removes its orphaned branch messages atomically with the
   * fork row — conversations decides which ids, chat (the single writer) deletes.
   */
  readonly deleteForkMessages: (db: DbWriter) => ForkMessageDeleter;
}

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

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  if (isIdempotencyConflict(error)) {
    return c.json(createErrorResponse(error.wireCode), 409);
  }
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/** Success payloads pass through; refusals answer their mapped wire error. */
function respondOutcome<S extends object>(
  c: Context<AppEnv>,
  outcome: Outcome<S>,
  respond: (success: Exclude<S, Refusal>) => Response
): Response {
  if (isRefusal(outcome)) {
    const wire = refusalToWire(outcome);
    return c.json(createErrorResponse(wire.code, wire.details), wire.status);
  }
  // The guard above eliminated every refusal variant; TS cannot subtract a
  // union member from an unresolved generic, so the narrowing is asserted.
  return respond(outcome as Exclude<S, Refusal>);
}

/** The uniform handler tail: success answers 200 JSON, refusals and errors map to wire codes. */
function respond200<S extends object>(
  c: Context<AppEnv>,
  result: Result<Outcome<S>, DomainError>
): Response {
  return result.match(
    (outcome) => respondOutcome(c, outcome, (success) => c.json(success, 200)),
    (error) => respondDomainError(c, error)
  );
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. The
 * context is typed with hono's base `Env` because the hook's `E` is not
 * inferred from the route chain — `AppEnv` here would fail contravariance.
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The pipeline enforced the header before the handler ran; absence is a
 * defect. Exported so the defect arm stays executable in tests — no request
 * can reach a byKey handler without the header while the pipeline stage
 * holds (the `continueFromClaim` precedent in lib/idempotency).
 */
export function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    throw new Error('conversations: idempotency key missing after the pipeline stage');
  }
  return key;
}

interface ByKeyRoute<T> {
  readonly c: Context<AppEnv>;
  /** The validated request identity (body and/or params) for the body hash. */
  readonly body: unknown;
  readonly responseSchema: z.ZodType<T>;
  readonly execute: Parameters<typeof idempotent.byKey<T>>[0]['execute'];
}

/** One byKey envelope per mutating route: scope, body hash, claim, execute. */
function runByKey<T>(route: ByKeyRoute<T>): ReturnType<typeof idempotent.byKey<T>> {
  const { c } = route;
  return runMutation(() =>
    idempotent.byKey({
      db: c.var.db,
      scope: {
        userId: callerUserId(c.var.principal),
        route: routePath(c),
        key: requiredIdempotencyKey(c),
      },
      body: route.body,
      executorId: crypto.randomUUID(),
      responseSchema: route.responseSchema,
      execute: route.execute,
    })
  );
}

/**
 * Post-commit realtime-event broadcast; best-effort. A failed fan-out is
 * logged, never unwound — the mutation already committed and a client resync
 * recovers.
 */
async function broadcastAfterCommit(
  c: Context<AppEnv>,
  conversationId: string,
  run: () => ReturnType<typeof broadcastForkCreated>
): Promise<void> {
  const broadcast = await run();
  if (broadcast.isErr()) {
    c.var.logger.warn('realtime event broadcast failed', {
      conversationId,
      errorCode: broadcast.error.code,
    });
  }
}

/** Post-commit eviction; failures are logged, never unwound (cache TTL recovers). */
async function evictAfterCommit(
  deps: ConversationsRouteDeps,
  c: Context<AppEnv>,
  conversationId: string,
  principalIds: readonly string[]
): Promise<void> {
  const evicted = await evictPrincipals(
    { revoker: deps.revoker(c.var.redis), realtime: deps.realtime(c.env) },
    conversationId,
    principalIds
  );
  if (evicted.isErr()) {
    c.var.logger.warn('conversation eviction incomplete', {
      conversationId,
      errorCode: evicted.error.code,
    });
  }
}

// No return annotation on purpose: the chained route schema must flow through
// `defineSliceManifest`'s generic so `AppType` (and the typed client) carry
// this slice's routes — an explicit `Hono<AppEnv>` would erase it to
// `BlankSchema` (the `createApp()` pattern in app.ts, applied at the slice).
export function createConversationsManifest(deps: ConversationsRouteDeps) {
  return defineSliceManifest({
    basePath: '/conversations',
    routes: new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', createConversationBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body,
            responseSchema: createConversationOutcomeSchema,
            execute: (tx) => createConversation(deps.stores(tx), { callerUserId: caller, ...body }),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/',
        routeClass('session'),
        zValidator('query', listConversationsQuerySchema, rejectInvalid),
        async (c) => {
          const { cursor, limit } = c.req.valid('query');
          const result = await listConversations(deps.stores(c.var.db), {
            callerUserId: callerUserId(c.var.principal),
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/:conversationId',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await getConversation(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      // The realtime WebSocket upgrade. The default-deny pipeline plus this
      // membership gate authorize BEFORE the socket is proxied to the DO — a
      // non-member (or a revoked session, which the pipeline downgrades) never
      // upgrades. The adapter returns the DO's 101 untouched so the socket
      // reaches the client.
      .get(
        '/:conversationId/websocket',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const userId = callerUserId(c.var.principal);
          const member = await deps.stores(c.var.db).members.activeByUser(conversationId, userId);
          if (member.isErr()) return respondDomainError(c, member.error);
          if (member.value === null) {
            return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
          }
          const upgraded = await deps
            .realtime(c.env)
            .upgrade(conversationId, { principalId: userId, isGuest: false }, c.req.raw.headers);
          return upgraded.match(
            (response) => response,
            (error) => respondDomainError(c, error)
          );
        }
      )
      .delete(
        '/:conversationId',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId },
            responseSchema: deleteConversationOutcomeSchema,
            execute: (tx) =>
              deleteConversation(deps.stores(tx), { conversationId, callerUserId: caller }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            await evictAfterCommit(deps, c, conversationId, result.value.evicteePrincipalIds);
          }
          return result.match(
            (outcome) => respondOutcome(c, outcome, () => c.json({ deleted: true as const }, 200)),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/:conversationId/members',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await listMembers(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/members',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', addMemberBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: addMemberOutcomeSchema,
            execute: (tx) =>
              addMember(deps.stores(tx), { conversationId, callerUserId: caller, body }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            const { member, newEpochNumber } = result.value;
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberAdded(deps.realtime(c.env), {
                conversationId,
                memberId: member.id,
                userId: member.userId ?? undefined,
                privilege: member.privilege,
              })
            );
            // A full-history add leaves the epoch unchanged (null); only an
            // add-with-rotation advances it, so only then does a connected
            // device need to refetch the keychain.
            if (newEpochNumber !== null) {
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastRotationComplete(deps.realtime(c.env), { conversationId, newEpochNumber })
              );
            }
          }
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/members/:memberId/remove',
        routeClass('session'),
        zValidator('param', memberParameterSchema, rejectInvalid),
        zValidator('json', removeMemberBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, memberId } = c.req.valid('param');
          const { rotation } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, memberId, rotation },
            responseSchema: removeMemberOutcomeSchema,
            execute: (tx) =>
              removeMember(deps.stores(tx), {
                conversationId,
                memberId,
                callerUserId: caller,
                rotation,
              }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            const { newEpochNumber } = result.value;
            await evictAfterCommit(deps, c, conversationId, result.value.evicteePrincipalIds);
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberRemoved(deps.realtime(c.env), { conversationId, memberId })
            );
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastRotationComplete(deps.realtime(c.env), { conversationId, newEpochNumber })
            );
          }
          return result.match(
            (outcome) =>
              respondOutcome(c, outcome, (success) =>
                c.json({ removed: true as const, newEpochNumber: success.newEpochNumber }, 200)
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/:conversationId/leave',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', leaveBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { rotation } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...(rotation === undefined ? {} : { rotation }) },
            responseSchema: leaveOutcomeSchema,
            execute: (tx) =>
              leaveConversation(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                rotation,
              }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            const success = result.value;
            await evictAfterCommit(deps, c, conversationId, success.evicteePrincipalIds);
            // The owner's leave deletes the conversation (no surviving room to
            // notify); a non-owner's leave rotates the epoch, so peers get the
            // departure and the keychain refresh.
            if ('left' in success) {
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastMemberRemoved(deps.realtime(c.env), {
                  conversationId,
                  memberId: success.memberId,
                  userId: caller,
                })
              );
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastRotationComplete(deps.realtime(c.env), {
                  conversationId,
                  newEpochNumber: success.newEpochNumber,
                })
              );
            }
          }
          return result.match(
            (outcome) =>
              respondOutcome(c, outcome, (success) =>
                'left' in success
                  ? c.json({ left: true as const, newEpochNumber: success.newEpochNumber }, 200)
                  : c.json({ deleted: true as const }, 200)
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .patch(
        '/:conversationId/membership/mute',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', muteBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { muted } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byTransition(
              setMutedTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
                muted,
              })
            )
          );
          return respond200(c, result);
        }
      )
      .patch(
        '/:conversationId/membership/pin',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', pinBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { pinned } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byTransition(
              setPinnedTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
                pinned,
              })
            )
          );
          return respond200(c, result);
        }
      )
      // Accept a pending invite: naturally idempotent (an already-accepted
      // membership replays 200), so it carries no Idempotency-Key.
      .patch(
        '/:conversationId/membership/accept',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await runMutation(() =>
            idempotent.byTransition(
              acceptInviteTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: callerUserId(c.var.principal),
              })
            )
          );
          return respond200(c, result);
        }
      )
      // Decline a pending invite (accepted members must `/leave` with a
      // rotation). Naturally idempotent — a repeat answers not-found. Broadcasts
      // the departure so peers refresh their member list.
      .post(
        '/:conversationId/membership/decline',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runMutation(() =>
            idempotent.byTransition(
              declineInviteTransition(deps.stores(c.var.db), {
                conversationId,
                callerUserId: caller,
              })
            )
          );
          if (result.isOk() && !isRefusal(result.value)) {
            const { memberId } = result.value;
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberRemoved(deps.realtime(c.env), {
                conversationId,
                memberId,
                userId: caller,
              })
            );
          }
          return respond200(c, result);
        }
      )
      // Admin-driven member privilege change (the legacy ladder ported exactly
      // in `changeMemberPrivilege`). A mutation, so it takes an Idempotency-Key.
      .patch(
        '/:conversationId/member/:memberId/privilege',
        routeClass('session'),
        zValidator('param', memberParameterSchema, rejectInvalid),
        zValidator('json', changePrivilegeBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, memberId } = c.req.valid('param');
          const { privilege } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, memberId, privilege },
            responseSchema: changePrivilegeOutcomeSchema,
            execute: (tx) =>
              changeMemberPrivilege(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                memberId,
                privilege,
              }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastMemberPrivilegeChanged(deps.realtime(c.env), {
                conversationId,
                memberId,
                privilege,
              })
            );
          }
          return respond200(c, result);
        }
      )
      // Owner-only title update. The title is opaque ciphertext; the body hash
      // and the byKey replay treat it as bytes.
      .patch(
        '/:conversationId',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', updateTitleBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: updateTitleOutcomeSchema,
            execute: (tx) =>
              updateConversationTitle(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                title: body.title,
                titleEpochNumber: body.titleEpochNumber,
              }),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/:conversationId/keychain',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await getKeyChain(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      // The authoritative active-member public-key set — every epoch rotation's
      // wrap-set input, so no rotation works without it. Read-privilege (any
      // active member), not admin: a departing non-owner re-wraps for everyone.
      .get(
        '/:conversationId/member-keys',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await getMemberKeys(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      // Batch keychain refresh for the conversation list. A read, so it is a GET
      // with a comma-separated `conversationIds` query — the static
      // `member-keys/batch` segment never collides with `:conversationId`
      // (a uuid). Always 200: inaccessible ids ride `missing`, never a 404.
      .get(
        '/member-keys/batch',
        routeClass('session'),
        zValidator('query', memberKeysBatchQuerySchema, rejectInvalid),
        async (c) => {
          const { conversationIds } = c.req.valid('query');
          const result = await getKeyChainBatch(deps.stores(c.var.db), {
            conversationIds,
            callerUserId: callerUserId(c.var.principal),
          });
          return result.match(
            (view) => c.json(view, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Authenticated history read — the only path a second device, a reload, or
      // a newly-added member has to load prior messages. Membership-gated;
      // history is served from the caller's `visibleFromEpoch` forward.
      .get(
        '/:conversationId/messages',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('query', messageHistoryQuerySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { cursor, limit } = c.req.valid('query');
          const result = await getMessageHistory(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/:conversationId/forks',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await listForks(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/forks',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', createForkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: createForkOutcomeSchema,
            execute: (tx) =>
              createFork(deps.stores(tx), { conversationId, callerUserId: caller, ...body }),
          });
          // Emit fork:created only for a genuinely new branch (a converged
          // re-create is a no-op), naming the created fork by its client id.
          if (result.isOk() && !isRefusal(result.value) && result.value.isNew) {
            const created = result.value.forks.find((fork) => fork.id === body.id);
            if (created !== undefined) {
              await broadcastAfterCommit(c, conversationId, () =>
                broadcastForkCreated(deps.realtime(c.env), {
                  conversationId,
                  forkId: created.id,
                  name: created.name,
                  tipMessageId: created.tipMessageId,
                })
              );
            }
          }
          return respond200(c, result);
        }
      )
      .patch(
        '/:conversationId/forks/:forkId',
        routeClass('session'),
        zValidator('param', forkParameterSchema, rejectInvalid),
        zValidator('json', renameForkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, forkId } = c.req.valid('param');
          const { name } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, forkId, name },
            responseSchema: renameForkOutcomeSchema,
            execute: (tx) =>
              renameFork(deps.stores(tx), { conversationId, forkId, callerUserId: caller, name }),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            // Bind the renamed name before the closure — control-flow narrowing
            // of `result.value` does not survive into a nested function.
            const renamedName = result.value.fork.name;
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastForkRenamed(deps.realtime(c.env), {
                conversationId,
                forkId,
                name: renamedName,
              })
            );
          }
          return respond200(c, result);
        }
      )
      .put(
        '/:conversationId/forks/:forkId/tip',
        routeClass('session'),
        zValidator('param', forkParameterSchema, rejectInvalid),
        zValidator('json', updateForkTipBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, forkId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, forkId, ...body },
            responseSchema: updateForkTipOutcomeSchema,
            execute: (tx) =>
              updateForkTip(deps.stores(tx), {
                conversationId,
                forkId,
                callerUserId: caller,
                ...body,
              }),
          });
          return respond200(c, result);
        }
      )
      .delete(
        '/:conversationId/forks/:forkId',
        routeClass('session'),
        zValidator('param', forkParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId, forkId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, forkId },
            responseSchema: deleteForkOutcomeSchema,
            execute: (tx) =>
              deleteFork(
                deps.stores(tx),
                { conversationId, forkId, callerUserId: caller },
                deps.deleteForkMessages(tx)
              ),
          });
          if (result.isOk() && !isRefusal(result.value)) {
            await broadcastAfterCommit(c, conversationId, () =>
              broadcastForkDeleted(deps.realtime(c.env), { conversationId, forkId })
            );
          }
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/links',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', createLinkBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: createLinkOutcomeSchema,
            execute: (tx) =>
              createSharedLink(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                linkPublicKey: body.linkPublicKey,
                displayName: body.displayName ?? null,
                expiresAt: body.expiresAt ?? null,
              }),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/:conversationId/links',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await listSharedLinks(deps.stores(c.var.db), {
            conversationId,
            callerUserId: callerUserId(c.var.principal),
          });
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/links/:linkId/revoke',
        routeClass('session'),
        zValidator('param', linkParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId, linkId } = c.req.valid('param');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, linkId },
            responseSchema: revokeLinkOutcomeSchema,
            execute: (tx) =>
              revokeSharedLink(deps.stores(tx), { conversationId, linkId, callerUserId: caller }),
          });
          return respond200(c, result);
        }
      )
      .post(
        '/:conversationId/shares',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', createSharedMessageBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, ...body },
            responseSchema: createSharedMessageOutcomeSchema,
            execute: (tx) =>
              createSharedMessage(deps.stores(tx), {
                conversationId,
                callerUserId: caller,
                linkId: body.linkId,
                messageId: body.messageId,
                wrappedContentKey: body.wrappedContentKey,
                now: new Date(),
              }),
          });
          return respond200(c, result);
        }
      )
      // Unauthenticated public read: revoke/expiry are enforced LAZILY here
      // (a predicate, no sweep). Per-IP throttling is a registry entry only —
      // `publicShareReadRateLimit` — whose enforcement lands with the edge/IP
      // rate-limit enforcer; nothing consumes the entry here. This handler
      // derives nothing from a session; the route class is `public`.
      .get(
        '/shared/:linkId',
        routeClass('public'),
        zValidator('param', linkIdParameterSchema, rejectInvalid),
        async (c) => {
          const { linkId } = c.req.valid('param');
          const result = await readPublicShare(deps.stores(c.var.db), {
            linkId,
            now: new Date(),
          });
          return respond200(c, result);
        }
      ),
  });
}
