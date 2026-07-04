import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The chargeback auto-defense seam. Identity owns the mechanism (it is the
 * single writer of `users` and the session store): `users.lockedAt` +
 * `lockReason = 'chargeback'` plus revocation of every live session —
 * defensive, immediate, reversible by an admin. The adapter binds this port
 * to identity's published barrel API at the composition root; billing never
 * writes identity's tables.
 *
 * Naturally idempotent: `locked` is true only when THIS call performed the
 * transition (an already-locked account reports false), so a redelivered
 * dispute re-attempts the lock harmlessly and notification rides only on the
 * transition. `email` is the address for the best-effort lock notification
 * (null when the account carries none).
 */
export interface AccountDefensePort {
  lockForChargeback(args: {
    readonly userId: string;
  }): ResultAsync<{ readonly locked: boolean; readonly email: string | null }, DomainError>;
}

/**
 * Best-effort post-commit notification for the dispute auto-lock, bound at
 * the composition root over the notifications slice's `chargebackLockEmail`
 * template + `EmailSender` (the same doctrine as `WelcomeEmailPort`): the
 * domain ignores a failed Result, send-failure observability lives with the
 * adapter.
 */
export interface AccountLockedEmailPort {
  sendAccountLockedEmail(args: { readonly to: string }): ResultAsync<void, DomainError>;
}
