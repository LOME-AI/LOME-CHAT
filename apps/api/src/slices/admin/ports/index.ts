import type { Database } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Thrown by the audit store when an undo's audit insert loses the
 * `admin_audit_undoes_unique` claim — the row being undone has already been
 * undone. The engine maps this to a `conflict` DomainError; the UNIQUE
 * constraint is what makes undo exactly-once (two concurrent undos of the
 * same row cannot both commit).
 */
export class UndoAlreadyClaimedError extends Error {
  constructor(undoes: string) {
    super(`admin audit row ${undoes} has already been undone`);
    this.name = 'UndoAlreadyClaimedError';
  }
}

/** One audit row, as the engine writes it. `details` must be wire-JSON. */
export interface AdminAuditInsertRow {
  readonly actor: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly details: unknown;
  /** The audit row id being undone, when this run is an inverse-as-undo. */
  readonly undoes?: string;
}

/** The undo target's fields the engine validates the relationship against. */
export interface AdminAuditUndoTarget {
  readonly action: string;
  readonly details: unknown;
}

/** One audit-trail row with its undo threading resolved both ways. */
export interface AdminAuditThreadedRow {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly details: unknown;
  /** The audit row this row undid, when this row is an undo execution. */
  readonly undoes: string | null;
  /** The audit row that undid this one, when it has been undone. */
  readonly undoneBy: string | null;
  readonly createdAt: Date;
}

export interface AdminAuditSearchFilter {
  readonly actor?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  /** An audit row id; strictly-older rows are returned (uuidv7 ordering). */
  readonly cursor?: string;
}

export interface AdminAuditSearchResult {
  readonly rows: readonly AdminAuditThreadedRow[];
  readonly nextCursor: string | null;
}

/** Read surface over the slice-owned `admin_audit` (search + dashboard feed). */
export interface AdminAuditReads {
  search(db: Database, filter: AdminAuditSearchFilter): Promise<AdminAuditSearchResult>;
  recent(db: Database, limit: number): Promise<readonly AdminAuditThreadedRow[]>;
}

/** Per-user panel: conversation metadata counts (never content). */
export interface AdminConversationCounts {
  readonly owned: number;
  readonly activeMemberships: number;
}

/** One job row summarized for the 360 jobs panel / queue screen. */
export interface AdminJobRow {
  readonly id: string;
  readonly type: string;
  readonly shard: string;
  readonly status: string;
  /** True when a dead row has been discarded (restorable marker). */
  readonly discarded: boolean;
  readonly failures: number;
  readonly claims: number;
  readonly payload: unknown;
  readonly errors: readonly { at: string; claim: number; error: string }[];
  readonly nextAttemptAt: Date;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface AdminJobQueueFilter {
  /** `discarded` selects dead rows carrying the restorable marker. */
  readonly status?: 'pending' | 'running' | 'succeeded' | 'cancelled' | 'dead' | 'discarded';
  readonly type?: string;
  readonly limit: number;
  /** A job row id; strictly-older rows are returned (uuidv7 ordering). */
  readonly cursor?: string;
}

export interface AdminJobQueueResult {
  readonly rows: readonly AdminJobRow[];
  readonly nextCursor: string | null;
}

/** Dashboard job-health counters (backlog + dead-letter inbox). */
export interface AdminJobCounts {
  readonly pending: number;
  readonly running: number;
  readonly dead: number;
  readonly discarded: number;
}

/**
 * Cross-slice read surface for the 360 panels and the jobs screens, bound at
 * the composition root (slice code references only its own schema objects;
 * `jobs` is lib-owned and `conversations`/`conversation_members` belong to
 * the conversations slice).
 */
export interface AdminCrossSliceReads {
  conversationCounts(userId: string): Promise<AdminConversationCounts>;
  /**
   * Jobs whose payload names the user. Deliberately payload-based and
   * unindexed — add a `jobs.targetUserId` (payload) index when this panel
   * gets hot.
   */
  jobsTouchingUser(userId: string, limit: number): Promise<readonly AdminJobRow[]>;
  listJobs(filter: AdminJobQueueFilter): Promise<AdminJobQueueResult>;
  jobCounts(): Promise<AdminJobCounts>;
}

/** A SELECT-only SQL panel result page (rows capped, never unbounded). */
export interface SqlPanelResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

/**
 * The read-only SQL panel connection: a SECOND Postgres connection using the
 * SELECT-only `admin_sql_panel` role — psql-grade power, structurally
 * write-proof (a write is refused by the role, not by parsing).
 */
export interface SqlPanel {
  run(queryText: string): ResultAsync<SqlPanelResult, DomainError>;
}

/**
 * The admin slice's own store surface — `admin_audit` is the only table this
 * slice owns; every other effect composes published slice barrels.
 */
export interface AdminStores {
  /**
   * Loads the audit row an undo names as its target. The engine calls this
   * on the open settlement transaction before the audit insert, so the
   * relationship check and the `undoes` UNIQUE claim see one snapshot.
   */
  getAuditForUndo(writer: DbWriter, id: string): Promise<AdminAuditUndoTarget | undefined>;
  /**
   * Inserts the audit row. The engine passes the open settlement transaction
   * so the row commits atomically with the op's effects (audit-in-tx);
   * guardrail-refusal rows pass the client directly (they have no effects to
   * be atomic with). Throws `UndoAlreadyClaimedError` on a lost undo claim.
   */
  insertAudit(writer: DbWriter, row: AdminAuditInsertRow): Promise<{ id: string }>;
}

export type { AccessLogEvent, AccessLogReader, AccessLogWindow } from './access-log.js';
