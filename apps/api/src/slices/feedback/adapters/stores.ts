import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { feedback } from '@hushbox/db';
import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type {
  FeedbackDetailWire,
  FeedbackInboxRowWire,
  FeedbackKind,
  FeedbackStatus,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { FeedbackStore } from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('feedback store query failed', cause);
}

/** The inbox body projection: a bounded preview so the list never ships full notes. */
const BODY_PREVIEW_MAX_CHARS = 140;

function bodyPreview(body: string): string {
  return body.slice(0, BODY_PREVIEW_MAX_CHARS);
}

interface FeedbackDetailRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: FeedbackKind;
  readonly status: FeedbackStatus;
  readonly body: string;
  readonly createdAt: Date;
}

function toDetailWire(row: FeedbackDetailRow): FeedbackDetailWire {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    status: row.status,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * How recently an identical body counts as a duplicate resubmission. Tunable:
 * a longer window rejects more accidental double-sends but also blocks a user
 * who genuinely wants to re-file the same wording after a while.
 */
export const FEEDBACK_DEDUP_WINDOW_SECONDS = 3600;

/**
 * Drizzle implementation of the feedback store. Single-writer: this slice owns
 * the `feedback` table.
 */
export function createFeedbackStores(db: DbWriter): FeedbackStore {
  return {
    // Atomically conditional insert: the row lands only when no identical body
    // exists for this user within the dedup window. Expressed as INSERT … SELECT
    // … WHERE NOT EXISTS so the guard and the write are one statement (no
    // check-then-act race). It lives inside the byKey `txn` transaction, so a
    // network retry — SAME Idempotency-Key — never reaches here (byKey replays
    // the stored response), while a genuine resubmit with a NEW key and the same
    // body finds the committed row and inserts zero rows → `null` → the domain's
    // FEEDBACK_DUPLICATE refusal. Scoped by `feedback_user_id_idx`.
    insert: (userId, input) =>
      fromPromise(
        db.execute(sql`
          INSERT INTO ${feedback} (
            ${sql.identifier(feedback.userId.name)},
            ${sql.identifier(feedback.kind.name)},
            ${sql.identifier(feedback.body.name)}
          )
          SELECT ${userId}::uuid, ${input.kind}::feedback_kind, ${input.body}::text
          WHERE NOT EXISTS (
            SELECT 1 FROM ${feedback}
            WHERE ${feedback.userId} = ${userId}::uuid
              AND ${feedback.body} = ${input.body}
              AND ${feedback.createdAt} > now() - make_interval(secs => ${FEEDBACK_DEDUP_WINDOW_SECONDS})
          )
          RETURNING ${feedback.id}
        `),
        storeFailure
      ).map(({ rows }) => {
        const row = rows[0] as { id: string } | undefined;
        return row === undefined ? null : { id: row.id };
      }),
  };
}

/**
 * The admin `feedback.setStatus` transition, run on the engine-owned settlement
 * transaction: it locks the row `FOR UPDATE`, reads the current status, updates
 * `status`/`updatedAt`, and returns the PRIOR status so the op captures its
 * inverse snapshot at execute time (snapshot semantics — undo restores the
 * exact prior status, never a default). A missing row is a typed `not_found`.
 */
export function setFeedbackStatusWithinTx(
  tx: SettlementTx,
  params: { readonly feedbackId: string; readonly status: FeedbackStatus }
): ResultAsync<{ readonly priorStatus: FeedbackStatus }, DomainError> {
  return fromPromise(
    tx
      .select({ status: feedback.status })
      .from(feedback)
      .where(eq(feedback.id, params.feedbackId))
      .for('update'),
    storeFailure
  ).andThen((rows) => {
    const prior = rows[0];
    if (prior === undefined) {
      return errAsync<{ priorStatus: FeedbackStatus }, DomainError>(
        notFoundError('feedback row does not exist')
      );
    }
    return fromPromise(
      tx
        .update(feedback)
        .set({ status: params.status, updatedAt: new Date() })
        .where(eq(feedback.id, params.feedbackId)),
      storeFailure
    ).map(() => ({ priorStatus: prior.status }));
  });
}

/**
 * The admin inbox read: one keyset page over `feedback`, newest first. The
 * cursor rides the uuidv7 `id` (time-ordered, so id-DESC is createdAt-DESC);
 * `nextCursor` is the last row's id when the page filled, else null. Each row
 * carries a bounded `bodyPreview`, never the full note.
 */
export function listFeedbackForInbox(
  db: Database,
  params: { readonly status?: FeedbackStatus; readonly cursor?: string; readonly limit: number }
): ResultAsync<{ rows: FeedbackInboxRowWire[]; nextCursor: string | null }, DomainError> {
  const statusCond = params.status === undefined ? undefined : eq(feedback.status, params.status);
  const cursorCond = params.cursor === undefined ? undefined : lt(feedback.id, params.cursor);
  return fromPromise(
    db
      .select({
        id: feedback.id,
        userId: feedback.userId,
        kind: feedback.kind,
        status: feedback.status,
        body: feedback.body,
        createdAt: feedback.createdAt,
      })
      .from(feedback)
      .where(and(statusCond, cursorCond))
      .orderBy(desc(feedback.id))
      .limit(params.limit),
    storeFailure
  ).map((rows) => {
    const last = rows.at(-1);
    return {
      rows: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        status: row.status,
        bodyPreview: bodyPreview(row.body),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length === params.limit && last !== undefined ? last.id : null,
    };
  });
}

/** The admin detail read: the full note, or null when the id is unknown. */
export function getFeedbackById(
  db: Database,
  id: string
): ResultAsync<FeedbackDetailWire | null, DomainError> {
  return fromPromise(
    db
      .select({
        id: feedback.id,
        userId: feedback.userId,
        kind: feedback.kind,
        status: feedback.status,
        body: feedback.body,
        createdAt: feedback.createdAt,
      })
      .from(feedback)
      .where(eq(feedback.id, id))
      .limit(1),
    storeFailure
  ).map((rows) => {
    const row = rows[0];
    return row === undefined ? null : toDetailWire(row);
  });
}

/** Every note a user has submitted, newest first (the dev read-back surface). */
export function listFeedbackForUser(
  db: Database,
  userId: string
): ResultAsync<FeedbackDetailWire[], DomainError> {
  return fromPromise(
    db
      .select({
        id: feedback.id,
        userId: feedback.userId,
        kind: feedback.kind,
        status: feedback.status,
        body: feedback.body,
        createdAt: feedback.createdAt,
      })
      .from(feedback)
      .where(eq(feedback.userId, userId))
      .orderBy(desc(feedback.id)),
    storeFailure
  ).map((rows) => rows.map((row) => toDetailWire(row)));
}
