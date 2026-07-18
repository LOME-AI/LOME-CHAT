import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The narrow seam behind the double-opt-in confirmation send. The
 * composition-root adapter owns the frontend URL construction — the domain
 * passes a bare token.
 */
export interface NewsletterConfirmEmailPort {
  sendConfirmation(args: {
    readonly to: string;
    readonly token: string;
  }): ResultAsync<void, DomainError>;
}
