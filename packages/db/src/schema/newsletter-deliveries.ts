import { pgTable, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { newsletterDeliveryStatusEnum } from './enums';
import { newsletterIssues } from './newsletter-issues';
import { newsletterSubscribers } from './newsletter-subscribers';

/**
 * Per-recipient send record, kept forever (founder ruling — no retention
 * hook). Both FKs take the default NO ACTION (admin_audit.undoes precedent):
 * issues and subscribers are never deleted in v1, and a delivery row must
 * never be orphaned or cascaded away — a parent delete is refused instead.
 * The UNIQUE(issueId, subscriberId) claim makes each send exactly-once.
 */
export const newsletterDeliveries = pgTable(
  'newsletter_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => newsletterIssues.id),
    subscriberId: uuid('subscriber_id')
      .notNull()
      .references(() => newsletterSubscribers.id),
    status: newsletterDeliveryStatusEnum('status').notNull(),
    resendEmailId: text('resend_email_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('newsletter_deliveries_issue_id_subscriber_id_unique').on(
      table.issueId,
      table.subscriberId
    ),
    index('newsletter_deliveries_issue_id_idx').on(table.issueId),
    index('newsletter_deliveries_subscriber_id_idx').on(table.subscriberId),
  ]
);
