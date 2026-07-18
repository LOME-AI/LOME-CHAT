import { okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { NewsletterStore } from '../ports/index.js';

export type ConfirmOutcome = { readonly kind: 'confirmed' } | { readonly kind: 'invalid' };

/**
 * Atomic conditional confirm, then already-done classification: the store's
 * UPDATE is the whole transition check (pending + matching + unexpired); on
 * 0 rows the actual state is read by token — a matching token on a
 * `subscribed` row is the re-clicked email link, a success no-op (already
 * done, per doctrine). Every other 0-row state (unsubscribed, suppressed,
 * expired-pending, unknown) stays `invalid`: an old confirm link must never
 * re-subscribe someone who left. Expiry gates only the pending transition —
 * a kept token on a subscribed row is inert by construction.
 */
export function confirmNewsletterSubscription(args: {
  readonly store: NewsletterStore;
  readonly token: string;
  readonly now: Date;
}): ResultAsync<ConfirmOutcome, DomainError> {
  return args.store
    .consumeConfirmToken(args.token, args.now)
    .andThen((consumed): ResultAsync<ConfirmOutcome, DomainError> => {
      if (consumed) return okAsync({ kind: 'confirmed' });
      return args.store
        .findStatusByConfirmToken(args.token)
        .map(
          (status): ConfirmOutcome =>
            status === 'subscribed' ? { kind: 'confirmed' } : { kind: 'invalid' }
        );
    });
}
