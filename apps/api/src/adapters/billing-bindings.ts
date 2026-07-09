import { createWebhookVerifier } from '../slices/billing/index.js';
import { wakeJobDispatcher } from '../lib/jobs/index.js';
import type { AccountDefensePort, WebhookVerifier } from '../slices/billing/index.js';
import type { JobDispatcherNamespace } from '../lib/jobs/index.js';
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

/**
 * The chargeback auto-defense port is not yet wired: it must lock `users` and
 * revoke sessions through identity's published barrel, and identity does not
 * yet publish that capability. Until it does, the dispute-lock path fails loud
 * (a defect → 500 + Sentry, so a human notices) rather than silently skipping a
 * security action. Only actual chargeback/reversal events reach it; balance,
 * payments, and the notify-only dispute paths never do.
 */
export function createDeferredAccountDefense(): AccountDefensePort {
  return {
    lockForChargeback: () => {
      throw new Error(
        'chargeback auto-defense is not wired yet: identity must publish a user-lock + ' +
          'session-revocation barrel for the composition root to bind this port'
      );
    },
  };
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
