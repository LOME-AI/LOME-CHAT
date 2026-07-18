import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { newsletterSubscribers } from '@hushbox/db';
import { NEWSLETTER_DEFAULT_TOPIC } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type {
  NewsletterConsentSource,
  NewsletterStatus,
  NewsletterSuppressReason,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConfirmTokenIssue, NewsletterConsent, NewsletterStore } from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('newsletter store query failed', cause);
}

const LIVE_STATUSES = ['pending', 'subscribed'] as const;

function issueColumns(
  issue: ConfirmTokenIssue
): Pick<
  typeof newsletterSubscribers.$inferInsert,
  'confirmToken' | 'confirmExpiresAt' | 'confirmSentAt'
> {
  return {
    confirmToken: issue.confirmToken,
    confirmExpiresAt: issue.confirmExpiresAt,
    confirmSentAt: issue.confirmSentAt,
  };
}

function consentColumns(
  consent: NewsletterConsent
): Pick<
  typeof newsletterSubscribers.$inferInsert,
  'consentSource' | 'consentIp' | 'consentTextVersion'
> {
  return {
    consentSource: consent.source,
    consentIp: consent.ip,
    consentTextVersion: consent.textVersion,
  };
}

export interface SubscriberStats {
  readonly byStatus: Record<NewsletterStatus, number>;
  readonly bySuppressReason: Record<NewsletterSuppressReason, number>;
}

/**
 * Aggregate subscriber counts for the admin read surface (the feedback
 * slice's standalone barrel-export precedent). One grouped query; the zero
 * baseline keeps every enum member present in the plain-shape return.
 */
export function subscriberStats(
  db: Database,
  options: { readonly topic?: string | undefined } = {}
): ResultAsync<SubscriberStats, DomainError> {
  const topic = options.topic ?? NEWSLETTER_DEFAULT_TOPIC;
  return fromPromise(
    db
      .select({
        status: newsletterSubscribers.status,
        suppressReason: newsletterSubscribers.suppressReason,
        count: sql<number>`count(*)::int`,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.topic, topic))
      .groupBy(newsletterSubscribers.status, newsletterSubscribers.suppressReason),
    storeFailure
  ).map((rows) => {
    const byStatus: Record<NewsletterStatus, number> = {
      pending: 0,
      subscribed: 0,
      unsubscribed: 0,
      suppressed: 0,
    };
    const bySuppressReason: Record<NewsletterSuppressReason, number> = {
      bounce: 0,
      complaint: 0,
    };
    for (const row of rows) {
      byStatus[row.status] += row.count;
      if (row.suppressReason !== null) {
        bySuppressReason[row.suppressReason] += row.count;
      }
    }
    return { byStatus, bySuppressReason };
  });
}

/**
 * The consent-evidence projection the admin read surface may see. The
 * credential columns (`confirmToken`/`unsubscribeToken`) are deliberately
 * absent from the SELECT — they must never cross the barrel.
 */
export interface AdminSubscriberRow {
  readonly id: string;
  readonly email: string;
  readonly status: NewsletterStatus;
  readonly suppressReason: NewsletterSuppressReason | null;
  readonly consentSource: NewsletterConsentSource;
  readonly consentIp: string;
  readonly consentTextVersion: string;
  readonly createdAt: Date;
  readonly confirmedAt: Date | null;
  readonly unsubscribedAt: Date | null;
  readonly suppressedAt: Date | null;
}

export interface ListSubscribersForAdminParams {
  readonly limit: number;
  readonly status?: NewsletterStatus | undefined;
  /** Keyset cursor: the last subscriber id of the previous page (uuidv7 = time-ordered). */
  readonly cursor?: string | undefined;
  readonly topic?: string | undefined;
}

export interface AdminSubscribersPage {
  readonly subscribers: readonly AdminSubscriberRow[];
  readonly nextCursor: string | null;
}

export function listSubscribersForAdmin(
  db: Database,
  params: ListSubscribersForAdminParams
): ResultAsync<AdminSubscribersPage, DomainError> {
  const topic = params.topic ?? NEWSLETTER_DEFAULT_TOPIC;
  return fromPromise(
    db
      .select({
        id: newsletterSubscribers.id,
        email: newsletterSubscribers.email,
        status: newsletterSubscribers.status,
        suppressReason: newsletterSubscribers.suppressReason,
        consentSource: newsletterSubscribers.consentSource,
        consentIp: newsletterSubscribers.consentIp,
        consentTextVersion: newsletterSubscribers.consentTextVersion,
        createdAt: newsletterSubscribers.createdAt,
        confirmedAt: newsletterSubscribers.confirmedAt,
        unsubscribedAt: newsletterSubscribers.unsubscribedAt,
        suppressedAt: newsletterSubscribers.suppressedAt,
      })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.topic, topic),
          params.status === undefined ? undefined : eq(newsletterSubscribers.status, params.status),
          params.cursor === undefined ? undefined : lt(newsletterSubscribers.id, params.cursor)
        )
      )
      .orderBy(desc(newsletterSubscribers.id))
      .limit(params.limit + 1),
    storeFailure
  ).map((rows) => {
    const subscribers = rows.slice(0, params.limit);
    const last = subscribers.at(-1);
    return {
      subscribers,
      nextCursor: rows.length > params.limit && last !== undefined ? last.id : null,
    };
  });
}

/**
 * Drizzle implementation of the newsletter store over the launch topic.
 * Single-writer: this slice owns `newsletter_subscribers`. Every mutation is
 * one atomic conditional statement — the WHERE clause (or the unique
 * constraint) is the state check, never check-then-act.
 */
export function createNewsletterStores(db: Database): NewsletterStore {
  return {
    findByEmail: (email) =>
      fromPromise(
        db
          .select({
            id: newsletterSubscribers.id,
            status: newsletterSubscribers.status,
            suppressReason: newsletterSubscribers.suppressReason,
            confirmSentAt: newsletterSubscribers.confirmSentAt,
          })
          .from(newsletterSubscribers)
          .where(
            and(
              eq(newsletterSubscribers.email, email),
              eq(newsletterSubscribers.topic, NEWSLETTER_DEFAULT_TOPIC)
            )
          ),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    insertPending: (params) =>
      fromPromise(
        db
          .insert(newsletterSubscribers)
          .values({
            email: params.email,
            status: 'pending',
            unsubscribeToken: params.unsubscribeToken,
            ...issueColumns(params.issue),
            ...consentColumns(params.consent),
          })
          .onConflictDoNothing({
            target: [newsletterSubscribers.email, newsletterSubscribers.topic],
          })
          .returning({ id: newsletterSubscribers.id }),
        storeFailure
      ).map((rows) => rows.length === 1),

    refreshPendingConfirm: (params) =>
      fromPromise(
        db
          .update(newsletterSubscribers)
          .set({ ...issueColumns(params.issue), ...consentColumns(params.consent) })
          .where(
            and(
              eq(newsletterSubscribers.id, params.id),
              eq(newsletterSubscribers.status, 'pending')
            )
          )
          .returning({ id: newsletterSubscribers.id }),
        storeFailure
      ).map((rows) => rows.length === 1),

    reopenForConfirmation: (params) =>
      fromPromise(
        db
          .update(newsletterSubscribers)
          .set({
            status: 'pending',
            confirmedAt: null,
            unsubscribedAt: null,
            suppressedAt: null,
            suppressReason: null,
            ...issueColumns(params.issue),
            ...consentColumns(params.consent),
          })
          .where(
            and(
              eq(newsletterSubscribers.id, params.id),
              eq(newsletterSubscribers.status, params.fromStatus),
              // Complaint suppression is sticky, and this WHERE — not the
              // caller's snapshot read — is the referee: a concurrent
              // bounce→complaint flip between read and reopen must lose here,
              // never resurrect the address.
              sql`${newsletterSubscribers.suppressReason} IS DISTINCT FROM 'complaint'`
            )
          )
          .returning({ id: newsletterSubscribers.id }),
        storeFailure
      ).map((rows) => rows.length === 1),

    // The token is retained on consume (not cleared): a re-clicked email
    // link classifies as the already-done no-op via findStatusByConfirmToken.
    // Inert by construction — nothing but the pending transition above and
    // the subscribed no-op reads it, so a kept token cannot re-subscribe a
    // row that later left.
    consumeConfirmToken: (token, now) =>
      fromPromise(
        db
          .update(newsletterSubscribers)
          .set({
            status: 'subscribed',
            confirmedAt: now,
          })
          .where(
            and(
              eq(newsletterSubscribers.confirmToken, token),
              eq(newsletterSubscribers.status, 'pending'),
              gt(newsletterSubscribers.confirmExpiresAt, now)
            )
          )
          .returning({ id: newsletterSubscribers.id }),
        storeFailure
      ).map((rows) => rows.length === 1),

    unsubscribeByToken: (token, now) =>
      fromPromise(
        db
          .update(newsletterSubscribers)
          .set({ status: 'unsubscribed', unsubscribedAt: now })
          .where(
            and(
              eq(newsletterSubscribers.unsubscribeToken, token),
              inArray(newsletterSubscribers.status, [...LIVE_STATUSES])
            )
          )
          .returning({ id: newsletterSubscribers.id }),
        storeFailure
      ).map((rows) => rows.length === 1),

    findStatusByConfirmToken: (token) =>
      fromPromise(
        db
          .select({ status: newsletterSubscribers.status })
          .from(newsletterSubscribers)
          .where(eq(newsletterSubscribers.confirmToken, token)),
        storeFailure
      ).map((rows) => rows[0]?.status ?? null),

    findStatusByUnsubscribeToken: (token) =>
      fromPromise(
        db
          .select({ status: newsletterSubscribers.status })
          .from(newsletterSubscribers)
          .where(eq(newsletterSubscribers.unsubscribeToken, token)),
        storeFailure
      ).map((rows) => rows[0]?.status ?? null),

    listAccountStatuses: (params) =>
      fromPromise(
        db
          .select({ status: newsletterSubscribers.status })
          .from(newsletterSubscribers)
          .where(
            and(
              eq(newsletterSubscribers.topic, NEWSLETTER_DEFAULT_TOPIC),
              or(
                eq(newsletterSubscribers.userId, params.userId),
                eq(newsletterSubscribers.email, params.email)
              )
            )
          ),
        storeFailure
      ).map((rows) => rows.map((row) => row.status)),

    upsertAccountSubscription: (params) =>
      fromPromise(
        db
          .insert(newsletterSubscribers)
          .values({
            email: params.email,
            status: 'subscribed',
            userId: params.userId,
            confirmedAt: params.now,
            unsubscribeToken: params.unsubscribeToken,
            ...consentColumns(params.consent),
          })
          .onConflictDoUpdate({
            target: [newsletterSubscribers.email, newsletterSubscribers.topic],
            set: {
              status: 'subscribed',
              userId: params.userId,
              confirmedAt: params.now,
              unsubscribedAt: null,
              suppressedAt: null,
              suppressReason: null,
              confirmToken: null,
              confirmExpiresAt: null,
              ...consentColumns(params.consent),
            },
            // Complaint suppression is sticky (deliverability rule): the
            // upsert refuses to touch such a row, and 0 rows returned reports
            // the truthful `subscribed: false`.
            setWhere: sql`${newsletterSubscribers.suppressReason} IS DISTINCT FROM 'complaint'`,
          })
          .returning({ status: newsletterSubscribers.status }),
        storeFailure
      ).map((rows) => ({ subscribed: rows[0]?.status === 'subscribed' })),

    suppress: (params) =>
      fromPromise(
        db
          .update(newsletterSubscribers)
          .set({ status: 'suppressed', suppressReason: params.reason, suppressedAt: params.now })
          .where(
            and(
              eq(newsletterSubscribers.email, params.email),
              eq(newsletterSubscribers.topic, NEWSLETTER_DEFAULT_TOPIC),
              // Complaint suppression is terminal for deliverability: only a
              // complaint may write over it, and an identical suppression is
              // excluded so a duplicate delivery is a true 0-row no-op.
              sql`${newsletterSubscribers.suppressReason} IS DISTINCT FROM 'complaint'`,
              sql`(${newsletterSubscribers.status} <> 'suppressed' OR ${newsletterSubscribers.suppressReason} IS DISTINCT FROM ${params.reason})`
            )
          )
          .returning({ id: newsletterSubscribers.id }),
        storeFailure
      ).map((rows) => rows.length === 1),

    unsubscribeAccount: (params) =>
      fromPromise(
        db
          .update(newsletterSubscribers)
          .set({ status: 'unsubscribed', unsubscribedAt: params.now, userId: params.userId })
          .where(
            and(
              eq(newsletterSubscribers.email, params.email),
              eq(newsletterSubscribers.topic, NEWSLETTER_DEFAULT_TOPIC),
              inArray(newsletterSubscribers.status, [...LIVE_STATUSES])
            )
          ),
        storeFailure
      ).andThen(() => okAsync()),
  };
}
