import type { Database } from '@hushbox/db';
import type {
  NewsletterConsentSource,
  NewsletterStatus,
  NewsletterSuppressReason,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** The CAN-SPAM/GDPR evidence recorded with every fresh consent. */
export interface NewsletterConsent {
  readonly source: NewsletterConsentSource;
  readonly ip: string;
  readonly textVersion: string;
}

/** A fresh double-opt-in credential issued on (re)signup. */
export interface ConfirmTokenIssue {
  readonly confirmToken: string;
  readonly confirmExpiresAt: Date;
  readonly confirmSentAt: Date;
}

/** What the subscribe flow needs to pick its branch. */
export interface NewsletterSubscriberSnapshot {
  readonly id: string;
  readonly status: NewsletterStatus;
  readonly suppressReason: NewsletterSuppressReason | null;
  readonly confirmSentAt: Date | null;
}

/**
 * The newsletter slice's single-writer store over `newsletter_subscribers`
 * (default topic only — a second list is a data change behind these same
 * methods). Every mutation is one atomic conditional statement: the WHERE
 * clause is the state check, and a `false` return means the expected state
 * was gone — a converged no-op, never an error.
 */
export interface NewsletterStore {
  findByEmail(email: string): ResultAsync<NewsletterSubscriberSnapshot | null, DomainError>;

  /**
   * `INSERT … ON CONFLICT DO NOTHING`: `false` means a racing signup already
   * created the row (that writer owns the confirmation send).
   */
  insertPending(params: {
    readonly email: string;
    readonly issue: ConfirmTokenIssue;
    readonly unsubscribeToken: string;
    readonly consent: NewsletterConsent;
  }): ResultAsync<boolean, DomainError>;

  /** Re-issues the confirm credential on a still-pending row. */
  refreshPendingConfirm(params: {
    readonly id: string;
    readonly issue: ConfirmTokenIssue;
    readonly consent: NewsletterConsent;
  }): ResultAsync<boolean, DomainError>;

  /**
   * Re-signup after leaving: flips an `unsubscribed` or `suppressed` row back
   * to `pending` with a fresh confirm credential and fresh consent evidence,
   * clearing the prior terminal timestamps.
   */
  reopenForConfirmation(params: {
    readonly id: string;
    readonly fromStatus: NewsletterStatus;
    readonly issue: ConfirmTokenIssue;
    readonly consent: NewsletterConsent;
  }): ResultAsync<boolean, DomainError>;

  /**
   * Atomic confirm: pending + matching + unexpired → `subscribed`; the token
   * is KEPT so a re-clicked link can classify as already-done. `false` for
   * anything else — the caller disambiguates via `findStatusByConfirmToken`.
   */
  consumeConfirmToken(token: string, now: Date): ResultAsync<boolean, DomainError>;

  /** Disambiguates a 0-row confirm: already-subscribed no-op vs truly invalid. */
  findStatusByConfirmToken(token: string): ResultAsync<NewsletterStatus | null, DomainError>;

  /** `pending`/`subscribed` → `unsubscribed`; `false` when nothing matched. */
  unsubscribeByToken(token: string, now: Date): ResultAsync<boolean, DomainError>;

  /** Disambiguates a 0-row unsubscribe: unknown token vs already-terminal row. */
  findStatusByUnsubscribeToken(token: string): ResultAsync<NewsletterStatus | null, DomainError>;

  /** Every status matching the account (linked by userId or account email). */
  listAccountStatuses(params: {
    readonly userId: string;
    readonly email: string;
  }): ResultAsync<readonly NewsletterStatus[], DomainError>;

  /**
   * Settings toggle-on: one upsert that creates or converges the row to
   * `subscribed` (verified account email — no confirmation round-trip) and
   * links `userId` to a pre-existing anonymous row. Complaint-suppressed rows
   * are never touched (`subscribed: false` reports reality).
   */
  upsertAccountSubscription(params: {
    readonly email: string;
    readonly userId: string;
    readonly unsubscribeToken: string;
    readonly consent: NewsletterConsent;
    readonly now: Date;
  }): ResultAsync<{ readonly subscribed: boolean }, DomainError>;

  /**
   * Deliverability suppression from the provider webhook. One atomic
   * conditional update; `true` only when the row changed. Complaint
   * overwrites anything (including a bounce suppression); bounce never
   * overwrites a complaint; an identical repeat or unknown email is a
   * converged no-op (`false`).
   */
  suppress(params: {
    readonly email: string;
    readonly reason: NewsletterSuppressReason;
    readonly now: Date;
  }): ResultAsync<boolean, DomainError>;

  /** Settings toggle-off: `pending`/`subscribed` → `unsubscribed`, linking userId. */
  unsubscribeAccount(params: {
    readonly email: string;
    readonly userId: string;
    readonly now: Date;
  }): ResultAsync<void, DomainError>;
}

/** Stores are constructed per request from the pipeline's `c.var.db`. */
export type NewsletterStoresFactory = (db: Database) => NewsletterStore;
