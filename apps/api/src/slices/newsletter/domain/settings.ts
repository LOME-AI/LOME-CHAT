import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { AccountEmailReader, NewsletterStore } from '../ports/index.js';

export interface NewsletterSettings {
  readonly subscribed: boolean;
}

function accountEmail(users: AccountEmailReader, userId: string): ResultAsync<string, DomainError> {
  return users
    .findById(userId)
    .andThen((user) =>
      user === null
        ? errAsync<string, DomainError>(notFoundError('account does not exist'))
        : okAsync<string, DomainError>(user.email)
    );
}

/** Subscription state for the caller's account: linked by userId or account email. */
export function readNewsletterSettings(args: {
  readonly store: NewsletterStore;
  readonly users: AccountEmailReader;
  readonly userId: string;
}): ResultAsync<NewsletterSettings, DomainError> {
  return accountEmail(args.users, args.userId).andThen((email) =>
    args.store
      .listAccountStatuses({ userId: args.userId, email })
      .map((statuses) => ({ subscribed: statuses.includes('subscribed') }))
  );
}

/**
 * Settings toggle. Account emails are verified, so toggle-on subscribes
 * instantly (no confirmation round-trip) with `app_settings` consent
 * evidence; a complaint-suppressed address stays suppressed (deliverability
 * rule — sticky even against the owner's toggle) and the returned state
 * reflects reality. Toggle-off converges on `unsubscribed`.
 */
export function writeNewsletterSettings(args: {
  readonly store: NewsletterStore;
  readonly users: AccountEmailReader;
  readonly userId: string;
  readonly subscribed: boolean;
  readonly consentIp: string;
  readonly now: Date;
}): ResultAsync<NewsletterSettings, DomainError> {
  return accountEmail(args.users, args.userId).andThen((email) => {
    if (args.subscribed) {
      return args.store.upsertAccountSubscription({
        email,
        userId: args.userId,
        unsubscribeToken: crypto.randomUUID(),
        consent: {
          source: 'app_settings',
          ip: args.consentIp,
          textVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
        },
        now: args.now,
      });
    }
    return args.store
      .unsubscribeAccount({ email, userId: args.userId, now: args.now })
      .map(() => ({ subscribed: false }));
  });
}
