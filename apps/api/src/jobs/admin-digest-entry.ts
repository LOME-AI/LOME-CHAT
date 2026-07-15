import { and, desc, gte, lt } from 'drizzle-orm';
import { adminAudit } from '@hushbox/db';
import { adminDailyDigestEmail, adminDailyDigestSubject } from '../slices/notifications/index.js';
import type { Database } from '@hushbox/db';
import type { AdminDigestAction, EmailSender } from '../slices/notifications/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { CronEntry } from './cron.js';

/**
 * The daily admin audit digest (telemetry, never a control):
 * one email per allowlisted admin summarizing the previous
 * full UTC day of `admin_audit` actions. Best-effort by email-port doctrine:
 * a failed send is logged (codes only) and never fails the entry.
 */

/** Bounded read — a digest is a summary, never an unbounded table scan. */
export const DIGEST_MAX_ACTIONS = 500;

export interface DigestWindow {
  /** The summarized day, `YYYY-MM-DD` (UTC). */
  readonly day: string;
  readonly since: Date;
  readonly until: Date;
}

/** The previous full UTC day relative to the cron's fire time. */
export function digestWindowFor(now: Date): DigestWindow {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  const day = since.toISOString().slice(0, 10);
  return { day, since, until };
}

export interface AdminDigestSendDeps {
  readonly sender: EmailSender;
  readonly adminEmails: readonly string[];
}

export interface AdminDigestEntryDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
  /** Resolved inside `run` so a config fault is an isolated entry failure. */
  readonly resolveSend: () => AdminDigestSendDeps;
}

export function createAdminDigestEntry(deps: AdminDigestEntryDeps): CronEntry {
  return {
    name: 'admin-daily-digest',
    run: async (): Promise<void> => {
      const window = digestWindowFor(deps.now());
      // Newest-first under the cap (an over-full day keeps its most recent
      // actions), reversed after the read so the digest renders chronologically.
      const rows = await deps.db
        .select({
          action: adminAudit.action,
          actor: adminAudit.actor,
          targetType: adminAudit.targetType,
          targetId: adminAudit.targetId,
          createdAt: adminAudit.createdAt,
        })
        .from(adminAudit)
        .where(and(gte(adminAudit.createdAt, window.since), lt(adminAudit.createdAt, window.until)))
        .orderBy(desc(adminAudit.createdAt))
        .limit(DIGEST_MAX_ACTIONS);
      rows.reverse();
      const actions: AdminDigestAction[] = rows.map((row) => ({
        opName: row.action,
        actorEmail: row.actor,
        targetType: row.targetType ?? 'none',
        targetId: row.targetId ?? 'none',
        occurredAt: row.createdAt.toISOString(),
      }));
      const content = adminDailyDigestEmail({ day: window.day, actions });
      const subject = adminDailyDigestSubject({ day: window.day });
      const { sender, adminEmails } = deps.resolveSend();
      for (const to of adminEmails) {
        const sent = await sender.send({
          to,
          subject,
          html: content.html,
          text: content.text,
        });
        if (sent.isErr()) {
          deps.telemetry.warn('admin daily digest email send failed', {
            errorCode: sent.error.code,
          });
        }
      }
    },
  };
}
