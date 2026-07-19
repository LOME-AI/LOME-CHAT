import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The narrow, identity-owned verification-email port (mirroring how the
 * notifications slice left PresenceReader/MembershipReader as unbound ports).
 * It is bound at the composition root to an adapter that composes the
 * notifications slice's `verificationEmail` template + `EmailSender` and owns
 * the frontend-URL construction — so identity never imports notifications
 * internals and never carries a frontend-URL binding.
 *
 * Best-effort by doctrine: the domain deliberately ignores a failed Result —
 * a sender outage must never block or leak through the request. Send-failure
 * observability lands with the production adapter, behind this port. The
 * token is passed (not a full URL) so the adapter owns link construction;
 * implementations keep the address and token out of error messages.
 */
export interface VerificationEmailPort {
  sendVerificationEmail(args: {
    readonly to: string;
    readonly token: string;
    readonly userName?: string;
  }): ResultAsync<void, DomainError>;
}

/**
 * The password-changed security notification (legacy parity: the owner of a
 * compromised account learns their password was rotated). Same shape and
 * doctrine as VerificationEmailPort: bound at the composition root over the
 * notifications slice's template + EmailSender, best-effort — callers swallow
 * a failed Result, observability lives with the adapter.
 */
export interface PasswordChangedEmailPort {
  sendPasswordChangedEmail(args: {
    readonly to: string;
    readonly userName?: string;
  }): ResultAsync<void, DomainError>;
}

/**
 * The password-reset security notification, sent after a recovery-phrase reset
 * completes. Distinct from PasswordChangedEmailPort: a deliberate reset via the
 * recovery phrase gets honest "your password was reset" copy, never the
 * alarming "changed" notice. Same shape and doctrine as the ports above:
 * composition-root adapter over the notifications slice's template +
 * EmailSender, best-effort — the reset flow swallows a failed Result,
 * observability lives with the adapter.
 */
export interface PasswordResetEmailPort {
  sendPasswordResetEmail(args: {
    readonly to: string;
    readonly userName?: string;
  }): ResultAsync<void, DomainError>;
}

/**
 * Security notification sent when TOTP is enabled on an account (legacy
 * parity). Same doctrine as the ports above: composition-root adapter over the
 * notifications slice's template + EmailSender, best-effort — the enrollment
 * flow swallows a failed Result, observability lives with the adapter.
 */
export interface TwoFactorEnabledEmailPort {
  sendTwoFactorEnabledEmail(args: {
    readonly to: string;
    readonly userName?: string;
  }): ResultAsync<void, DomainError>;
}

/** Security notification sent when TOTP is disabled (legacy parity). */
export interface TwoFactorDisabledEmailPort {
  sendTwoFactorDisabledEmail(args: {
    readonly to: string;
    readonly userName?: string;
  }): ResultAsync<void, DomainError>;
}

/**
 * The account-deleted confirmation (legacy parity: the user learns the
 * deletion completed; a hijacked-account owner learns to contact security).
 * Sent to the email captured inside the deletion transaction — the user row
 * is gone by send time. Same doctrine as the ports above: composition-root
 * adapter over the notifications slice's template + EmailSender, best-effort.
 */
export interface AccountDeletedEmailPort {
  sendAccountDeletedEmail(args: { readonly to: string }): ResultAsync<void, DomainError>;
}

/**
 * Security notification sent when repeated failed sign-ins JUST tripped the
 * login lockout (legacy parity — fired once, on the crossing attempt). Distinct
 * from billing's chargeback-lock notification: this port composes the
 * failed-sign-in `accountLockedEmail` template and carries the lockout window
 * in minutes. Best-effort — a send failure never blocks or changes the login
 * response.
 */
export interface AccountLockedEmailPort {
  sendAccountLockedEmail(args: {
    readonly to: string;
    readonly userName?: string;
    readonly lockoutMinutes: number;
  }): ResultAsync<void, DomainError>;
}
