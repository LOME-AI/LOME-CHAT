import { notFoundError, unavailableError, validationError } from '../../../lib/errors/index.js';
import { err, fromPromise, ok } from '../../../lib/result/index.js';
import { getFeedbackById, listFeedbackForInbox } from '../../feedback/index.js';
import { listAdminCatalog } from '../../models/index.js';
import { listIssues, listSubscribersForAdmin, subscriberStats } from '../../newsletter/index.js';
import { newsletterIssueEmail } from '../../notifications/index.js';
import { auditToWire, jobToWire, loadCustomer360 } from './customer-360.js';
import { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
import type {
  AdminSubscriberRow,
  NewsletterIssueRow,
  SubscriberStats,
} from '../../newsletter/index.js';
import type {
  NewsletterIssueWire,
  NewsletterIssuesWire,
  NewsletterStatus,
  NewsletterSubscriberWire,
  NewsletterSubscribersWire,
} from '@hushbox/shared';
import type { AdminCatalogModel } from '../../models/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { FeedbackDetailWire, FeedbackInboxWire, FeedbackStatus } from '@hushbox/shared';
import type {
  AdminAuditSearchFilter,
  AdminJobCounts,
  AdminJobQueueFilter,
  SqlPanel,
  SqlPanelResult,
} from '../ports/index.js';
import type {
  AdminAuditWire,
  AdminJobWire,
  Customer360Deps,
  Customer360Query,
  Customer360View,
} from './customer-360.js';

export interface AdminReadSurfaceDeps extends Customer360Deps {
  readonly sqlPanel: SqlPanel;
}

export interface AuditSearchWire {
  readonly rows: readonly AdminAuditWire[];
  readonly nextCursor: string | null;
}

export interface JobQueueWire {
  readonly rows: readonly AdminJobWire[];
  readonly nextCursor: string | null;
}

export interface DashboardWire {
  readonly jobs: AdminJobCounts;
  readonly recentActions: readonly AdminAuditWire[];
}

/** One keyset page request for the feedback triage inbox. */
export interface FeedbackInboxFilter {
  readonly status?: FeedbackStatus;
  readonly cursor?: string;
  readonly limit: number;
}

/** One keyset page request for the newsletter issues table. */
export interface NewsletterIssuesFilter {
  readonly limit: number;
  readonly cursor?: string;
}

/** One audited, capped page request for the subscriber consent-evidence list. */
export interface NewsletterSubscribersQuery {
  readonly actor: string;
  readonly limit: number;
  readonly status?: NewsletterStatus;
  readonly cursor?: string;
}

/** One catalog row for the Models screen; `adminDisabledAt` as ISO string. */
export interface AdminCatalogModelWire extends Omit<AdminCatalogModel, 'adminDisabledAt'> {
  readonly adminDisabledAt: string | null;
}

export interface ModelsCatalogWire {
  readonly models: readonly AdminCatalogModelWire[];
  readonly truncated: boolean;
}

/**
 * The admin plane's bespoke read surface (reads skip the op-engine tx
 * machinery but stay audited and volume-capped per the Charter). One
 * factory, one wire mapping — routes hold no business logic.
 */
export interface AdminReadSurface {
  customer360(params: {
    readonly actor: string;
    readonly query: Customer360Query;
  }): Promise<Result<Customer360View, DomainError>>;
  auditSearch(filter: AdminAuditSearchFilter): Promise<Result<AuditSearchWire, DomainError>>;
  dashboard(): Promise<Result<DashboardWire, DomainError>>;
  jobQueue(filter: AdminJobQueueFilter): Promise<Result<JobQueueWire, DomainError>>;
  feedbackInbox(filter: FeedbackInboxFilter): Promise<Result<FeedbackInboxWire, DomainError>>;
  feedbackDetail(params: {
    readonly actor: string;
    readonly id: string;
  }): Promise<Result<FeedbackDetailWire, DomainError>>;
  newsletterIssues(
    filter: NewsletterIssuesFilter
  ): Promise<Result<NewsletterIssuesWire, DomainError>>;
  newsletterSubscriberStats(): Promise<Result<SubscriberStats, DomainError>>;
  renderIssue(params: {
    readonly subject: string;
    readonly bodyMarkdown: string;
  }): Promise<Result<{ readonly html: string }, DomainError>>;
  newsletterSubscribers(
    query: NewsletterSubscribersQuery
  ): Promise<Result<NewsletterSubscribersWire, DomainError>>;
  modelsCatalog(): Promise<Result<ModelsCatalogWire, DomainError>>;
  sqlPanel(params: {
    readonly actor: string;
    readonly query: string;
  }): Promise<Result<SqlPanelResult, DomainError>>;
}

export function createAdminReadSurface(deps: AdminReadSurfaceDeps): AdminReadSurface {
  return {
    customer360: (params) => loadCustomer360(deps, params),

    async auditSearch(filter) {
      const result = await fromPromise(deps.auditReads.search(deps.db, filter), (cause) =>
        unavailableError('audit search failed', cause)
      );
      return result.map((page) => ({
        rows: page.rows.map((row) => auditToWire(row)),
        nextCursor: page.nextCursor,
      }));
    },

    async dashboard() {
      const result = await fromPromise(
        Promise.all([
          deps.crossSlice.jobCounts(),
          deps.auditReads.recent(deps.db, DASHBOARD_RECENT_ACTIONS),
        ]),
        (cause) => unavailableError('dashboard read failed', cause)
      );
      return result.map(([jobs, recent]) => ({
        jobs,
        recentActions: recent.map((row) => auditToWire(row)),
      }));
    },

    async jobQueue(filter) {
      const result = await fromPromise(deps.crossSlice.listJobs(filter), (cause) =>
        unavailableError('job queue read failed', cause)
      );
      return result.map((page) => ({
        rows: page.rows.map((row) => jobToWire(row)),
        nextCursor: page.nextCursor,
      }));
    },

    // Feedback triage inbox: a keyset page composed from the feedback slice's
    // published read (this slice never touches the `feedback` table). Not a
    // sensitive per-customer read — the list ships bounded body previews only,
    // so it is unaudited like the dashboard/jobs feeds (the detail read below
    // is the audited one).
    async feedbackInbox(filter) {
      return listFeedbackForInbox(deps.db, filter);
    },

    // Feedback detail: the full note. Sensitive (Charter #12) — exactly one
    // read-audit row per found detail, mirroring Customer-360, written only
    // when the row exists (a miss reveals nothing and targets no one).
    async feedbackDetail({ actor, id }) {
      const found = await getFeedbackById(deps.db, id);
      if (found.isErr()) return err(found.error);
      const detail = found.value;
      if (detail === null) return err(notFoundError('no feedback matches the id'));
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        action: READ_AUDIT_ACTIONS.feedbackView,
        targetType: 'feedback',
        targetId: id,
        details: { feedbackId: id },
      });
      return ok(detail);
    },

    // Newsletter issues table: admin-authored content composed from the
    // newsletter slice's published keyset read — like the feedback inbox,
    // unaudited (nothing customer-derived; the subscriber reads are the
    // audited newsletter surface). The route caps the page size.
    async newsletterIssues(filter) {
      return listIssues(deps.db, {
        limit: filter.limit,
        ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      }).map((page) => ({
        rows: page.issues.map((issue) => issueToWire(issue)),
        nextCursor: page.nextCursor,
      }));
    },

    // Aggregate counts only — no per-person data — so unaudited like the
    // dashboard; the per-row consent-evidence list below is the audited one.
    async newsletterSubscriberStats() {
      return subscriberStats(deps.db);
    },

    // Compose-screen preview: the SAME template the dispatch job renders
    // (sendIssueTest's rendering), with the inert '#' unsubscribe link —
    // never a live unsubscribe URL, never a parallel renderer. Unaudited:
    // admin-authored content, no user data (the issues-read rationale).
    renderIssue({ subject, bodyMarkdown }) {
      const content = newsletterIssueEmail({ subject, bodyMarkdown, unsubscribeUrl: '#' });
      return Promise.resolve(ok({ html: content.html }));
    },

    // Subscriber consent evidence: customer-derived PII (Charter #12) —
    // audited BEFORE the read executes (the SQL-panel precedent: a failed
    // read is still on the record) with the query parameters, never results.
    // The barrel's projection excludes every token column by construction.
    async newsletterSubscribers({ actor, limit, status, cursor }) {
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        action: READ_AUDIT_ACTIONS.newsletterSubscribers,
        details: {
          limit,
          ...(status === undefined ? {} : { status }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      return listSubscribersForAdmin(deps.db, { limit, status, cursor }).map((page) => ({
        rows: page.subscribers.map((subscriber) => subscriberToWire(subscriber)),
        nextCursor: page.nextCursor,
      }));
    },

    // Catalog metadata, not customer metadata: deliberately OUTSIDE the
    // closed audited-read set (read-audit.ts covers Customer-360 views and
    // SQL queries) and unlimited like dashboard/jobs — models' published
    // admin read is what sees through the product exposure gate.
    async modelsCatalog() {
      return listAdminCatalog(deps.db).map((page) => ({
        truncated: page.truncated,
        models: page.models.map((model) => ({
          ...model,
          adminDisabledAt:
            model.adminDisabledAt === null ? null : model.adminDisabledAt.toISOString(),
        })),
      }));
    },

    async sqlPanel({ actor, query }) {
      const trimmed = query.trim();
      if (trimmed === '') {
        return err(validationError('sql panel query is empty'));
      }
      // Audit BEFORE executing: a refused or failed query is still on the
      // record, and the row counts toward the read-volume story either way.
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        action: READ_AUDIT_ACTIONS.sqlPanel,
        details: { query: trimmed },
      });
      return deps.sqlPanel.run(trimmed);
    },
  };
}

/** Dashboard feed depth — a screenful, not an export. */
const DASHBOARD_RECENT_ACTIONS = 20;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function subscriberToWire(subscriber: AdminSubscriberRow): NewsletterSubscriberWire {
  return {
    ...subscriber,
    createdAt: subscriber.createdAt.toISOString(),
    confirmedAt: iso(subscriber.confirmedAt),
    unsubscribedAt: iso(subscriber.unsubscribedAt),
    suppressedAt: iso(subscriber.suppressedAt),
  };
}

function issueToWire(issue: NewsletterIssueRow): NewsletterIssueWire {
  return {
    id: issue.id,
    subject: issue.subject,
    status: issue.status,
    scheduledAt: issue.scheduledAt.toISOString(),
    canceledAt: iso(issue.canceledAt),
    sentAt: iso(issue.sentAt),
    recipientCount: issue.recipientCount,
    sentCount: issue.sentCount,
    failedCount: issue.failedCount,
    createdBy: issue.createdBy,
    createdAt: issue.createdAt.toISOString(),
  };
}
