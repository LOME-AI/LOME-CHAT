import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The billing-owned welcome-email port, fired at welcome-credit provisioning
 * (same shape and doctrine as identity's VerificationEmailPort): bound at the
 * composition root over the notifications slice's `welcomeEmail` template +
 * `EmailSender`, best-effort — the domain deliberately ignores a failed
 * Result, send-failure observability lives with the adapter.
 */
export interface WelcomeEmailPort {
  sendWelcomeEmail(args: {
    readonly to: string;
    readonly userName?: string;
  }): ResultAsync<void, DomainError>;
}
