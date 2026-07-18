import { pgTable, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { newsletterIssueStatusEnum } from './enums';

/**
 * One newsletter send. `createdBy` is the admin email from the Access JWT —
 * no users FK, admins are not product users (same as admin_audit.actor).
 * The count columns are written once at dispatch completion.
 */
export const newsletterIssues = pgTable('newsletter_issues', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  subject: text('subject').notNull(),
  bodyMarkdown: text('body_markdown').notNull(),
  status: newsletterIssueStatusEnum('status').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  recipientCount: integer('recipient_count'),
  sentCount: integer('sent_count'),
  failedCount: integer('failed_count'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
