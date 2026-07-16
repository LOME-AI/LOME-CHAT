import { getContext } from 'hono/context-storage';
import { createAppJobRegistry } from '../lib/jobs/index.js';
import {
  createConversationsStores,
  createMembershipRevoker,
} from '../slices/conversations/index.js';
import { createIdentityStores } from '../slices/identity/index.js';
import { createSessionRevokeEnqueueRegistration } from './billing-bindings.js';
import { createConversationRoomRealtime } from './realtime-broadcast.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../lib/context/index.js';
import type { JobDispatcherNamespace } from '../lib/jobs/index.js';
import type { AdminOperationsDeps } from '../slices/admin/index.js';
import type { BillingStores } from '../slices/billing/index.js';
import type { RealtimeBroadcast } from '../slices/conversations/index.js';
import type { EvictUserPort } from '../slices/identity/index.js';
import type { JobDispatcherEnv } from './billing-bindings.js';
import type { ConversationRoomEnv } from './realtime-broadcast.js';

/**
 * The one message both absent-binding throws share: it surfaces through the
 * engine's ephemeral-effect capture (job wake) or `wakeJobDispatcher`'s own
 * swallow — never as a request failure — because both consumers are
 * post-commit promptness layers whose delivery guarantee lives elsewhere
 * (the dispatcher's perpetual alarm; the broadcast-time membership recheck).
 */
function absentBinding(name: string): () => never {
  return (): never => {
    throw new Error(`${name} Durable Object binding is missing — promptness nudge skipped`);
  };
}

/**
 * A `JobDispatcherNamespace` for environments without the DO binding (local
 * node tests): the admin job ops consume it only inside the post-commit wake
 * nudge, which is lossy by design, so use-time failure is the correct
 * degradation — a missing binding must not fail engine construction for
 * every unrelated op.
 */
const ABSENT_JOB_DISPATCHER: JobDispatcherNamespace = {
  idFromName: absentBinding('JOB_DISPATCHER'),
  get: absentBinding('JOB_DISPATCHER'),
};

/**
 * `createConversationRoomRealtime` fail-fasts at CONSTRUCTION on a missing
 * CONVERSATION_ROOM binding, but admin op deps are built per engine — eager
 * construction would 500 every op (wallet, model, …) in environments without
 * the DO. The share ops touch realtime only inside their post-commit
 * best-effort eviction, so resolution defers to first use: a missing binding
 * surfaces as a captured ephemeral-effect failure in telemetry, while the
 * fail-closed broadcast-time membership recheck remains the guarantee.
 */
function lazyConversationRealtime(env: ConversationRoomEnv): RealtimeBroadcast {
  let instance: RealtimeBroadcast | undefined;
  const resolved = (): RealtimeBroadcast => (instance ??= createConversationRoomRealtime(env));
  return {
    broadcast: (...args) => resolved().broadcast(...args),
    evict: (...args) => resolved().evict(...args),
    presence: (...args) => resolved().presence(...args),
    startRun: (...args) => resolved().startRun(...args),
    stopRun: (...args) => resolved().stopRun(...args),
    upgrade: (...args) => resolved().upgrade(...args),
  };
}

/**
 * The production dep set for the twelve registered admin ops, resolved per
 * engine construction from the request context (AsyncLocalStorage-backed —
 * the same seam the composition root's other static bindings use). The
 * billing stores instance and the evict-user factory arrive as parameters:
 * billing must stay the ONE shared published surface app-wide, and the
 * evict-user port is composed in `app.ts` (importing it here would cycle).
 */
export function createAdminOpDeps(
  db: Database,
  billingStores: BillingStores,
  evictUser: (redis: Redis, env: AppEnv['Bindings']) => EvictUserPort
): AdminOperationsDeps {
  const c = getContext<AppEnv>();
  const env = c.env;
  const redis = c.var.redis;
  const dispatcherEnv: JobDispatcherEnv = env;
  return {
    billingStores,
    redis,
    identityStores: createIdentityStores(db),
    // Enqueue-only registry: user.lock / sessions.revokeAll enqueue
    // `session.revoke.v1` inside the settlement transaction; the handler runs
    // in the dispatcher DO with its own registry.
    jobRegistry: createAppJobRegistry([createSessionRevokeEnqueueRegistration(env)]),
    evictUser: evictUser(redis, env),
    jobDispatcher: dispatcherEnv.JOB_DISPATCHER ?? ABSENT_JOB_DISPATCHER,
    clock: { now: (): Date => new Date() },
    conversationsStores: createConversationsStores,
    membershipRevoker: createMembershipRevoker(redis),
    realtime: lazyConversationRealtime(env),
  };
}
