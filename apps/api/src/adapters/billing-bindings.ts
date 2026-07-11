import { getContext } from 'hono/context-storage';
import { Redis } from '@upstash/redis';
import { createWebhookVerifier } from '../slices/billing/index.js';
import {
  createChargebackRevokeJobRegistration,
  createIdentityStores,
} from '../slices/identity/index.js';
import { wakeJobDispatcher } from '../lib/jobs/index.js';
import type { AccountDefensePort, WebhookVerifier } from '../slices/billing/index.js';
import type { IdentityUsersStore } from '../slices/identity/index.js';
import type { JobDispatcherNamespace, JobRegistration } from '../lib/jobs/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { EnvContext } from '@hushbox/shared';

/**
 * Composition-root wiring for the billing manifest's env/infra-dependent deps.
 * These live outside a slice on purpose: they compose a published barrel with a
 * Worker binding, which slice code (and `lib`) may not reach across.
 */

/** The structural slice of the env the webhook verifier needs — HELCIM_WEBHOOK_VERIFIER is a secret, not on the typed Bindings. */
export interface WebhookVerifierEnv extends EnvContext {
  readonly HELCIM_WEBHOOK_VERIFIER?: string;
}

/**
 * Binds billing's fail-closed Helcim webhook verifier to the request env. The
 * verifier constructor is itself fail-fast on a missing/corrupt secret, so a
 * misconfigured deploy rejects at first use rather than degrading.
 */
export function createWebhookVerifierFromEnv(env: WebhookVerifierEnv): WebhookVerifier {
  return createWebhookVerifier({ verifier: env.HELCIM_WEBHOOK_VERIFIER });
}

/** The per-invocation infra the chargeback lock composes; resolved fresh each call. */
export interface AccountDefenseDeps {
  readonly users: IdentityUsersStore;
}

/**
 * The chargeback auto-defense LOCK port over identity's published within-tx
 * lock (ARCHITECTURE §13). The lock runs inside the webhook's clawback
 * `SettlementTx`, so the ledger clawback and the `users.lockedAt` flip commit
 * atomically — a lock failure throws and rolls the clawback back, and the
 * provider's redelivery re-drives both (no money-reversed-but-not-locked
 * divergence). The `resolve` seam supplies per-request infra (the `createApp*`
 * shape), keeping the composition unit-testable with a fake store.
 *
 * Session revocation is deliberately NOT here: it is the must-happen
 * `chargeback.revoke.v1` job, enqueued in the same transaction and executed by
 * the dispatcher (so a transient watermark/Redis failure is retried to
 * completion instead of being swallowed by a best-effort post-commit tail). The
 * lock is reversible (an admin unlock clears `lockedAt`) and defensive.
 */
export function createAccountDefense(resolve: () => AccountDefenseDeps): AccountDefensePort {
  return {
    lockForChargebackWithinTx(tx, userId) {
      return resolve().users.lockForChargebackWithinTx(tx, userId);
    },
  };
}

/**
 * The composition-root binding for billing's chargeback auto-defense lock
 * (ARCHITECTURE §13). Only actual chargeback/reversal events against a captured
 * payment reach it. Each call resolves the identity users store (single writer
 * of `users`) fresh from hono's context storage, and the lock runs inside the
 * webhook's clawback `SettlementTx` so the ledger reversal and `users.lockedAt`
 * flip commit atomically.
 */
export function createAppAccountDefensePort(): AccountDefensePort {
  return createAccountDefense(() => ({
    users: createIdentityStores(getContext<AppEnv>().var.db).users,
  }));
}

/** The structural slice of the env the enqueue-side chargeback registration needs. */
export interface ChargebackRevokeEnqueueEnv extends EnvContext {
  readonly UPSTASH_REDIS_REST_URL?: string;
  readonly UPSTASH_REDIS_REST_TOKEN?: string;
}

/**
 * The enqueue-side `chargeback.revoke.v1` registration for the billing webhook's
 * job registry. `enqueueWithinTx` reads only the registered type/schema/lease/
 * shard, so the Redis handed in is never invoked here — the handler runs in the
 * dispatcher DO with its own registry (`createDispatcherJobRegistry`). Registering
 * it is what keeps the webhook's clawback settlement from throwing "unregistered
 * job type" (which would roll the clawback back and 503-loop Helcim's redelivery).
 * Fails fast on a missing Redis binding, which the request pipeline already
 * guarantees present on every webhook — this construction never actually throws in
 * production, and the client is HTTP-lazy so no socket opens.
 */
export function createChargebackRevokeEnqueueRegistration(
  env: ChargebackRevokeEnqueueEnv
): JobRegistration {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || url === '' || token === undefined || token === '') {
    throw new Error(
      'billing chargeback-revoke enqueue: missing UPSTASH_REDIS_REST_URL/TOKEN — ' +
        'fails fast instead of degrading.'
    );
  }
  return createChargebackRevokeJobRegistration({ redis: new Redis({ url, token }) });
}

/** The structural slice of the env the payment-verify wake needs — the dispatcher DO binding. */
export interface JobDispatcherEnv extends EnvContext {
  readonly JOB_DISPATCHER?: JobDispatcherNamespace;
}

/**
 * The lossy post-commit nudge for the pre-claim's `payment.verify.v1` enqueue
 * (the `default` shard). Fired via `waitUntil` after the pre-claim transaction
 * commits — never inside it. Absent binding (local dev / tests without the DO)
 * is a no-op: the dispatcher's perpetual alarm is the delivery guarantee.
 */
export async function wakePaymentVerifyDispatcher(env: JobDispatcherEnv): Promise<void> {
  const namespace = env.JOB_DISPATCHER;
  if (namespace === undefined) return;
  await wakeJobDispatcher(namespace, 'default');
}

/**
 * The lossy post-commit nudge for the webhook's `chargeback.revoke.v1` enqueue
 * (the `bulk` shard), fired via `waitUntil` after the clawback + lock + enqueue
 * transaction commits. Absent binding is a no-op: the dispatcher's perpetual
 * alarm is the delivery guarantee, and the job is must-happen regardless.
 */
export async function wakeChargebackRevokeDispatcher(env: JobDispatcherEnv): Promise<void> {
  const namespace = env.JOB_DISPATCHER;
  if (namespace === undefined) return;
  await wakeJobDispatcher(namespace, 'bulk');
}
