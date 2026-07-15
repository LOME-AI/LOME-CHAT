import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The chargeback auto-defense lock seam. Identity owns the mechanism (it is the
 * single writer of `users`): `users.lockedAt` + `lockReason = 'chargeback'` —
 * defensive, immediate, reversible by an admin. The adapter binds this port to
 * identity's published within-tx lock at the composition root; billing never
 * writes identity's tables.
 *
 * The lock runs INSIDE the webhook's clawback `SettlementTx` so the ledger
 * clawback and the lock commit atomically: a lock failure rolls the clawback
 * back and the provider's redelivery re-drives both — closing the
 * money-reversed-but-account-not-locked divergence a separate standalone lock
 * left open. Naturally idempotent: `locked` is true (with the captured email)
 * only when THIS delivery performed the transition; an already-locked account
 * reports `locked: false` with a null email, and the best-effort lock
 * notification rides only the fresh transition. Session revocation is NOT here —
 * it is the must-happen `session.revoke.v1` job enqueued in the same
 * transaction. Throws on infra failure (aborting the enclosing settlement).
 */
export interface AccountDefensePort {
  lockForChargebackWithinTx(
    tx: SettlementTx,
    userId: string
  ): Promise<{ readonly locked: boolean; readonly email: string | null }>;
}

/**
 * Best-effort post-commit notification for the dispute auto-lock, bound at
 * the composition root over the notifications slice's `chargebackLockEmail`
 * template + `EmailSender` (the same doctrine as `WelcomeEmailPort`): the
 * domain ignores a failed Result, send-failure observability lives with the
 * adapter.
 */
export interface ChargebackLockEmailPort {
  sendChargebackLockEmail(args: { readonly to: string }): ResultAsync<void, DomainError>;
}
