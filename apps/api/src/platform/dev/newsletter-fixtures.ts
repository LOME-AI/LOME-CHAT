import { newsletterSubscribers } from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { NewsletterStatus } from '@hushbox/shared';

export interface MintNewsletterSubscribersParams {
  readonly count: number;
  readonly status?: NewsletterStatus | undefined;
  readonly emailPrefix?: string | undefined;
}

export interface MintedNewsletterSubscriber {
  readonly id: string;
  readonly email: string;
  readonly unsubscribeToken: string;
  readonly confirmToken: string | null;
}

/**
 * Bulk E2E-precondition subscriber rows (the `mintAdminTargets` fresh-id
 * pattern): unique emails per call so parallel specs own private rows.
 * Confirmed `subscribed` by default; `pending` rows carry a live, unexpired
 * confirm token so a spec can drive the confirmation flow.
 */
export async function mintNewsletterSubscribers(
  db: Database,
  params: MintNewsletterSubscribersParams
): Promise<{ subscribers: MintedNewsletterSubscriber[] }> {
  const status = params.status ?? 'subscribed';
  const now = new Date();
  const values = Array.from({ length: params.count }, (_, index) => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    return {
      email: `${params.emailPrefix ?? 'nl-e2e'}-${String(index)}-${suffix}@dev.hushbox.test`,
      status,
      unsubscribeToken: crypto.randomUUID(),
      consentSource: 'marketing_site' as const,
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      ...(status === 'pending'
        ? {
            confirmToken: crypto.randomUUID(),
            confirmExpiresAt: new Date(now.getTime() + 86_400_000),
            confirmSentAt: now,
          }
        : { confirmedAt: now }),
      ...(status === 'unsubscribed' ? { unsubscribedAt: now } : {}),
      ...(status === 'suppressed' ? { suppressedAt: now, suppressReason: 'bounce' as const } : {}),
    };
  });
  const rows = await db.insert(newsletterSubscribers).values(values).returning({
    id: newsletterSubscribers.id,
    email: newsletterSubscribers.email,
    unsubscribeToken: newsletterSubscribers.unsubscribeToken,
    confirmToken: newsletterSubscribers.confirmToken,
  });
  return { subscribers: rows };
}
