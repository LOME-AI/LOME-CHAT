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
