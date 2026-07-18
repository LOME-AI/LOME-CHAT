import { NEWSLETTER_CONFIRM_TTL_MS, NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ConfirmTokenIssue,
  NewsletterConfirmEmailPort,
  NewsletterConsent,
  NewsletterStore,
  NewsletterSubscriberSnapshot,
} from '../ports/index.js';

/**
 * How long a pending signup must wait before a repeat request re-issues and
 * resends the confirmation. Bounds outbound mail per address; inside the
 * window a repeat is a silent no-op (the response never varies).
 */
export const NEWSLETTER_RESEND_THROTTLE_MS = 10 * 60 * 1000;

export interface SubscribeArgs {
  readonly store: NewsletterStore;
  readonly emailPort: NewsletterConfirmEmailPort;
  readonly email: string;
  readonly consentIp: string;
  readonly now: Date;
}

function freshIssue(now: Date): ConfirmTokenIssue {
  return {
    confirmToken: crypto.randomUUID(),
    confirmExpiresAt: new Date(now.getTime() + NEWSLETTER_CONFIRM_TTL_MS),
    confirmSentAt: now,
  };
}

function marketingConsent(ip: string): NewsletterConsent {
  return { source: 'marketing_site', ip, textVersion: NEWSLETTER_CONSENT_TEXT_VERSION };
}

/**
 * Sends the double-opt-in confirmation, best-effort (the identity
 * verification-send precedent): a transient sender outage never fails — or
 * leaks through — the enumeration-safe response; the adapter logs the code.
 */
function sendBestEffort(
  emailPort: NewsletterConfirmEmailPort,
  email: string,
  token: string
): ResultAsync<void, DomainError> {
  return emailPort.sendConfirmation({ to: email, token }).orElse(() => okAsync());
}

/**
 * Public double-opt-in signup. Every branch resolves to the same `void`
 * success (the route answers one constant body — enumeration-safe):
 * fresh → pending + send; pending → throttled resend; subscribed → no-op;
 * unsubscribed / bounce-suppressed → back to pending with fresh consent
 * evidence + resend; complaint-suppressed → sticky no-op (never email a
 * complainer again). Expired pending rows heal lazily right here — a repeat
 * signup re-issues the credential; there is no cleaner job.
 */
export function subscribeToNewsletter(args: SubscribeArgs): ResultAsync<void, DomainError> {
  const email = args.email.toLowerCase();
  return args.store.findByEmail(email).andThen((existing) => {
    if (existing === null) {
      const issue = freshIssue(args.now);
      return args.store
        .insertPending({
          email,
          issue,
          unsubscribeToken: crypto.randomUUID(),
          consent: marketingConsent(args.consentIp),
        })
        .andThen((inserted) =>
          // A lost insert race converged on the other writer's row (and send).
          inserted ? sendBestEffort(args.emailPort, email, issue.confirmToken) : okAsync()
        );
    }
    return resubscribeExisting(args, email, existing);
  });
}

function resubscribeExisting(
  args: SubscribeArgs,
  email: string,
  existing: NewsletterSubscriberSnapshot
): ResultAsync<void, DomainError> {
  switch (existing.status) {
    case 'pending': {
      const sentAt = existing.confirmSentAt?.getTime() ?? 0;
      if (args.now.getTime() - sentAt < NEWSLETTER_RESEND_THROTTLE_MS) {
        return okAsync();
      }
      const issue = freshIssue(args.now);
      return args.store
        .refreshPendingConfirm({
          id: existing.id,
          issue,
          consent: marketingConsent(args.consentIp),
        })
        .andThen((updated) =>
          updated ? sendBestEffort(args.emailPort, email, issue.confirmToken) : okAsync()
        );
    }
    case 'subscribed': {
      return okAsync();
    }
    case 'unsubscribed':
    case 'suppressed': {
      if (existing.status === 'suppressed' && existing.suppressReason === 'complaint') {
        return okAsync();
      }
      const issue = freshIssue(args.now);
      return args.store
        .reopenForConfirmation({
          id: existing.id,
          fromStatus: existing.status,
          issue,
          consent: marketingConsent(args.consentIp),
        })
        .andThen((updated) =>
          updated ? sendBestEffort(args.emailPort, email, issue.confirmToken) : okAsync()
        );
    }
  }
}
