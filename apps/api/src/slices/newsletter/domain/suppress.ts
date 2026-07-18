import { okAsync } from '../../../lib/result/index.js';
import type { NewsletterSuppressReason } from '@hushbox/shared';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NewsletterStore } from '../ports/index.js';

export interface SuppressRecipientsParams {
  readonly store: NewsletterStore;
  readonly recipients: readonly string[];
  readonly reason: NewsletterSuppressReason;
  readonly now: Date;
}

/**
 * Applies one webhook event's suppression to every recipient it names,
 * sequentially (a Resend event rarely carries more than one). Resolves
 * whether ANY row changed; an unknown or already-converged recipient is a
 * no-op, never an error — Resend reports on transactional recipients who
 * never subscribed, and a non-2xx would only make it redeliver.
 */
export function suppressRecipients(
  params: SuppressRecipientsParams
): ResultAsync<boolean, DomainError> {
  let chain: ResultAsync<boolean, DomainError> = okAsync(false);
  for (const email of params.recipients) {
    chain = chain.andThen((changedSoFar) =>
      params.store
        .suppress({ email, reason: params.reason, now: params.now })
        .map((changed) => changedSoFar || changed)
    );
  }
  return chain;
}
