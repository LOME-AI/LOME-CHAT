import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { newsletterDeliveries, newsletterIssues, newsletterSubscribers } from '@hushbox/db';
import type { Database } from '@hushbox/db';
import type {
  DeliveryTarget,
  DispatchIssueClaim,
  NewsletterDispatchStore,
} from '../ports/index.js';

/** VALUES-list chunking for the freeze insert; unrelated to the send batch size. */
const FREEZE_INSERT_CHUNK = 1000;

function chunkIds<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Drizzle implementation of the dispatch store. Single-writer: this slice
 * owns `newsletter_issues` and `newsletter_deliveries`; the WHERE clause (or
 * the unique constraint) is the state check, never check-then-act.
 */
export function createNewsletterDispatchStores(db: Database): NewsletterDispatchStore {
  return {
    async claimIssue(issueId: string, topic: string, now: Date): Promise<DispatchIssueClaim> {
      return db.transaction(async (tx): Promise<DispatchIssueClaim> => {
        const claimed = await tx
          .update(newsletterIssues)
          .set({ status: 'sending' })
          .where(
            and(
              eq(newsletterIssues.id, issueId),
              eq(newsletterIssues.status, 'scheduled'),
              lte(newsletterIssues.scheduledAt, now)
            )
          )
          .returning({
            subject: newsletterIssues.subject,
            bodyMarkdown: newsletterIssues.bodyMarkdown,
          });
        const row = claimed[0];
        if (row !== undefined) {
          // The winner freezes the recipient set atomically with its claim:
          // rows exist iff the sending transition committed, so no later
          // attempt (yield resume or lease-reclaim) ever adds one.
          const subscribed = await tx
            .select({ id: newsletterSubscribers.id })
            .from(newsletterSubscribers)
            .where(
              and(
                eq(newsletterSubscribers.status, 'subscribed'),
                eq(newsletterSubscribers.topic, topic)
              )
            )
            .orderBy(asc(newsletterSubscribers.id));
          for (const idChunk of chunkIds(subscribed, FREEZE_INSERT_CHUNK)) {
            await tx.insert(newsletterDeliveries).values(
              idChunk.map((subscriber) => ({
                issueId,
                subscriberId: subscriber.id,
                status: 'claimed' as const,
              }))
            );
          }
          return { kind: 'claimed', ...row };
        }

        const current = await tx
          .select({
            status: newsletterIssues.status,
            subject: newsletterIssues.subject,
            bodyMarkdown: newsletterIssues.bodyMarkdown,
          })
          .from(newsletterIssues)
          .where(eq(newsletterIssues.id, issueId));
        const issue = current[0];
        if (issue === undefined) return { kind: 'missing' };
        switch (issue.status) {
          case 'canceled': {
            return { kind: 'canceled' };
          }
          case 'sent': {
            return { kind: 'sent' };
          }
          case 'sending': {
            // The lease-reclaimed retry of the run that already claimed (and
            // froze) it; the delivery rows are the composition of record.
            return { kind: 'claimed', subject: issue.subject, bodyMarkdown: issue.bodyMarkdown };
          }
          case 'scheduled': {
            return { kind: 'not-due' };
          }
        }
      });
    },

    async loadTargets(issueId: string): Promise<DeliveryTarget[]> {
      return db
        .select({
          deliveryId: newsletterDeliveries.id,
          status: newsletterDeliveries.status,
          email: newsletterSubscribers.email,
          unsubscribeToken: newsletterSubscribers.unsubscribeToken,
        })
        .from(newsletterDeliveries)
        .innerJoin(
          newsletterSubscribers,
          eq(newsletterDeliveries.subscriberId, newsletterSubscribers.id)
        )
        .where(eq(newsletterDeliveries.issueId, issueId))
        .orderBy(asc(newsletterDeliveries.subscriberId));
    },

    async markDeliveries(
      deliveryIds: readonly string[],
      status: 'sent' | 'failed',
      resendIdByDeliveryId?: ReadonlyMap<string, string>
    ): Promise<void> {
      await db.transaction(async (tx) => {
        for (const deliveryId of deliveryIds) {
          await tx
            .update(newsletterDeliveries)
            .set({ status, resendEmailId: resendIdByDeliveryId?.get(deliveryId) ?? null })
            .where(eq(newsletterDeliveries.id, deliveryId));
        }
      });
    },

    async completeIssue(issueId: string, now: Date): Promise<void> {
      const counts = await db
        .select({
          total: sql<number>`count(*)::int`,
          sent: sql<number>`count(*) FILTER (WHERE ${newsletterDeliveries.status} = 'sent')::int`,
          failed: sql<number>`count(*) FILTER (WHERE ${newsletterDeliveries.status} = 'failed')::int`,
        })
        .from(newsletterDeliveries)
        .where(eq(newsletterDeliveries.issueId, issueId));
      /* v8 ignore next -- a count(*) aggregate always returns exactly one row */
      const tally = counts[0] ?? { total: 0, sent: 0, failed: 0 };
      await db
        .update(newsletterIssues)
        .set({
          status: 'sent',
          sentAt: now,
          recipientCount: tally.total,
          sentCount: tally.sent,
          failedCount: tally.failed,
        })
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.status, 'sending')));
    },
  };
}
