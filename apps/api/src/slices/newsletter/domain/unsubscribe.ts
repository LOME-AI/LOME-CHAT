import { okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { NewsletterStore } from '../ports/index.js';

export type UnsubscribeOutcome = { readonly kind: 'unsubscribed' } | { readonly kind: 'invalid' };

/**
 * Token unsubscribe. The transition targets live rows; a 0-row outcome is
 * disambiguated by re-reading the token: an already-unsubscribed or
 * suppressed row is a converged success (suppression never lifts here),
 * an unknown token is `invalid`.
 */
export function unsubscribeFromNewsletter(args: {
  readonly store: NewsletterStore;
  readonly token: string;
  readonly now: Date;
}): ResultAsync<UnsubscribeOutcome, DomainError> {
  return args.store.unsubscribeByToken(args.token, args.now).andThen((transitioned) => {
    if (transitioned) return okAsync<UnsubscribeOutcome, DomainError>({ kind: 'unsubscribed' });
    return args.store
      .findStatusByUnsubscribeToken(args.token)
      .map(
        (status): UnsubscribeOutcome =>
          status === null ? { kind: 'invalid' } : { kind: 'unsubscribed' }
      );
  });
}
