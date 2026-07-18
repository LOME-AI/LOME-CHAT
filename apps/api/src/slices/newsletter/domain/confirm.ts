import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { NewsletterStore } from '../ports/index.js';

export type ConfirmOutcome = { readonly kind: 'confirmed' } | { readonly kind: 'invalid' };

/**
 * Single-use consume: the store's conditional UPDATE is the whole check
 * (pending + matching + unexpired), so a replayed, expired, unknown, or
 * wrong-status token uniformly answers `invalid` — the token is the
 * idempotency credential, exactly like identity's email verification.
 */
export function confirmNewsletterSubscription(args: {
  readonly store: NewsletterStore;
  readonly token: string;
  readonly now: Date;
}): ResultAsync<ConfirmOutcome, DomainError> {
  return args.store
    .consumeConfirmToken(args.token, args.now)
    .map((consumed): ConfirmOutcome => (consumed ? { kind: 'confirmed' } : { kind: 'invalid' }));
}
