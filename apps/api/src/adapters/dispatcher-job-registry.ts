import { Redis } from '@upstash/redis';
import { createEnvUtilities } from '@hushbox/shared';
import { evictUserFromRooms } from '@hushbox/realtime/user-rooms';
import { createAppJobRegistry, openDispatcherDb } from '../lib/jobs/index.js';
import {
  createBillingStores,
  createPaymentProviderFromEnv,
  createPaymentVerifyJobRegistration,
} from '../slices/billing/index.js';
import { createSessionRevokeJobRegistration } from '../slices/identity/index.js';
import { createMediaReclaimUserJob, createR2StorageFromEnv } from '../slices/media/index.js';
import {
  createNewsletterDispatchJobRegistration,
  createNewsletterDispatchStores,
} from '../slices/newsletter/index.js';
import { createEmailSenderFromEnv } from '../slices/notifications/index.js';
import { REALTIME_REDIS_KEYS } from '../lib/redis/define-key.js';
import { createConversationRoomRealtime } from './realtime-broadcast.js';
import type { Database } from '@hushbox/db';
import type { JobRegistry } from '../lib/jobs/index.js';
import type { EvictUserPort } from '../slices/identity/index.js';
import type { ConversationRoomEnv } from './realtime-broadcast.js';
import type { Bindings } from '../lib/context/app-env.js';
import type { EnvContext } from '@hushbox/shared';

/**
 * Composition-root wiring for the JobDispatcher DO's job registry. It composes
 * the dispatcher's registrations from the owning slices' published barrels —
 * work `lib/jobs` may not do, since `lib` may not import a slice. The running
 * dispatcher's registry comes from here (via the composition-only
 * `job-dispatcher.ts`), so a `payment.verify.v1` row enqueued by billing's
 * pre-claim resolves to its handler instead of dead-lettering as an
 * unregistered type in the live dispatcher.
 */

/**
 * Opens the dispatcher's Database handle from the DO's per-invocation env. The
 * payment-verify handler's settlement writes run on this connection; the Neon
 * pool connects lazily, so an idle dispatcher still holds no socket, and it
 * lives for the DO instance (the pass executor opens its own per-pass
 * connection for claim/complete and closes it at pass end). Fails fast on a
 * missing DATABASE_URL rather than degrading.
 */
export function openDispatcherDbFromEnv(env: Bindings): Database {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      'JobDispatcher registry: missing required binding DATABASE_URL — ' +
        'the dispatcher fails fast instead of degrading.'
    );
  }
  return openDispatcherDb(databaseUrl, createEnvUtilities(env));
}

/**
 * Opens the dispatcher's Redis client from the DO env, fail-fast on a missing
 * binding. The `session.revoke.v1` handler bumps the all-session
 * `passwordChangedAt` watermark through it (revoke-all).
 */
export function openDispatcherRedis(env: Bindings): Redis {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || url === '' || token === undefined || token === '') {
    throw new Error(
      'JobDispatcher registry: missing required binding UPSTASH_REDIS_REST_URL/TOKEN — ' +
        'the session-revoke handler fails fast instead of degrading.'
    );
  }
  return new Redis({ url, token });
}

/**
 * The realtime eviction fan-out for the session-revoke handler (the
 * promptness half of session revocation; the watermark bump is the correctness
 * half). A missing CONVERSATION_ROOM binding degrades to a no-op port rather
 * than throwing — eviction is best-effort, backstopped by the fail-closed
 * broadcast-time session-liveness check (ARCHITECTURE §15).
 */
function buildEvictUserPort(env: Bindings, redis: Redis): EvictUserPort {
  const realtimeEnv: ConversationRoomEnv = env;
  if (realtimeEnv.CONVERSATION_ROOM === undefined) {
    return { evictUser: (): Promise<void> => Promise.resolve() };
  }
  const realtime = createConversationRoomRealtime(env);
  return {
    evictUser: (userId: string): Promise<void> =>
      evictUserFromRooms(userId, {
        listRooms: async (id) => {
          const rooms = await redis.smembers(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(id));
          return rooms.map(String);
        },
        evictRoom: async (conversationId, id) => {
          await realtime.evict(conversationId, id);
        },
      }),
  };
}

/**
 * The origins a dispatched newsletter issue links against. API_URL is how the
 * API knows its own public origin (the one-click unsubscribe POST target);
 * FRONTEND_URL is the human goodbye page. Both are env registry entries;
 * missing either is a deployment defect, never a silently broken link.
 */
interface IssueUrlsEnv extends EnvContext {
  readonly API_URL?: string;
  readonly FRONTEND_URL?: string;
}

function requireIssueEmailUrls(env: IssueUrlsEnv): { apiUrl: string; frontendUrl: string } {
  const { API_URL, FRONTEND_URL } = env;
  if (
    API_URL === undefined ||
    API_URL === '' ||
    FRONTEND_URL === undefined ||
    FRONTEND_URL === ''
  ) {
    throw new Error(
      'JobDispatcher registry: missing required binding API_URL/FRONTEND_URL — ' +
        'the newsletter dispatch handler fails fast instead of degrading.'
    );
  }
  return { apiUrl: API_URL, frontendUrl: FRONTEND_URL };
}

/**
 * The registry the live JobDispatcher DO runs. The db is passed in (rather than
 * opened here) so the DO composition owns its lifetime and tests can supply a
 * closable handle.
 *
 * `payment.verify.v1` (billing's pre-claim reconcile), `media.reclaimUser.v1`
 * (account deletion's R2 sweep), and `session.revoke.v1` (identity's
 * must-happen session revocation, enqueued by the chargeback webhook and the
 * admin containment ops) are all
 * registered here, at the composition seam where their owning slices' barrels
 * are importable — a row of any type resolves to its handler instead of
 * dead-lettering as an unregistered type. The reclaim handler deletes R2
 * objects (env-bound Storage); the revoke handler bumps the session watermark
 * (env-bound Redis) and evicts live sockets (env-bound realtime).
 */
export function createDispatcherJobRegistry(env: Bindings, db: Database): JobRegistry {
  const redis = openDispatcherRedis(env);
  return createAppJobRegistry([
    createPaymentVerifyJobRegistration({
      db,
      stores: createBillingStores(),
      provider: createPaymentProviderFromEnv(env),
    }),
    createMediaReclaimUserJob({ storage: createR2StorageFromEnv(env, db) }),
    createSessionRevokeJobRegistration({ redis, evictUser: buildEvictUserPort(env, redis) }),
    createNewsletterDispatchJobRegistration({
      store: createNewsletterDispatchStores(db),
      sender: createEmailSenderFromEnv(env, db),
      urls: requireIssueEmailUrls(env),
    }),
  ]);
}
