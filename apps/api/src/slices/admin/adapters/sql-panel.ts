import { sql } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { forbiddenError, unavailableError, validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SqlPanel, SqlPanelResult } from '../ports/index.js';

export interface SqlPanelOptions {
  /** The SELECT-only `admin_sql_panel` role's connection string. */
  readonly url: string;
  /** Local dev/CI routes through the neon proxy (same gate as `createRequestDb`). */
  readonly isDev: boolean;
}

/**
 * Response-page cap: results beyond it are dropped and flagged `truncated`.
 * The cap bounds the wire payload (and counts as the per-query volume cap);
 * the per-request rate-limit entry bounds query volume.
 */
export const SQL_PANEL_MAX_ROWS = 200;

/** Per-query `SET LOCAL statement_timeout`: a runaway panel query cancels
 * server-side instead of holding the connection until the Worker dies. */
export const SQL_PANEL_STATEMENT_TIMEOUT_MS = 5000;

/** Query shapes that can be wrapped as a subquery for a server-side LIMIT. */
const SELECT_SHAPED = /^\s*(?:select|with|values|table)\b/i;

/**
 * Applies the row cap server-side where possible: a SELECT-shaped query is
 * wrapped as a subquery with `LIMIT cap+1` (the +1 detects truncation), so
 * an over-cap result stops pulling at the cap instead of materializing fully
 * and slicing. Non-SELECT read shapes (SHOW, EXPLAIN, …) run as written and
 * keep the client-side slice. The newline before the closing paren keeps a
 * trailing line comment from swallowing it.
 */
function fetchCappedQuery(queryText: string): string {
  if (!SELECT_SHAPED.test(queryText)) return queryText;
  const body = queryText.replace(/;\s*$/, '');
  return `SELECT * FROM (\n${body}\n) AS sql_panel_page LIMIT ${String(SQL_PANEL_MAX_ROWS + 1)}`;
}

/** Postgres insufficient_privilege — the role refused a write (or a carve-out read). */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Walks the driver's nested causes for the Postgres SQLSTATE, if any. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** SQLSTATE classes that are the connection's fault, not the query's:
 * 08 connection, 28 authentication, 57 operator intervention, 58 system. */
const INFRA_SQLSTATE_CLASSES = new Set(['08', '28', '57', '58']);

/**
 * Errors carry codes, never query text or database messages — the query is
 * already recorded in the audit row, and a driver message can embed data.
 * Exported for its own unit tests (the cause-walk arms are hard to force
 * through a live database).
 */
export function mapPanelError(error: unknown): DomainError {
  const state = sqlState(error);
  if (state === INSUFFICIENT_PRIVILEGE) {
    return forbiddenError('sql panel: refused by the SELECT-only role', error);
  }
  if (state !== undefined && !INFRA_SQLSTATE_CLASSES.has(state.slice(0, 2))) {
    return validationError('sql panel: query rejected by postgres', error);
  }
  return unavailableError('sql panel connection failed', error);
}

/**
 * The read-only SQL panel: a SECOND connection as the SELECT-only
 * `admin_sql_panel` Postgres role. Write-proofness is structural (the role
 * has no write grants and the plaintext-credential carve-outs are revoked at
 * the grant level) — nothing here parses or classifies the query text.
 */
export function createSqlPanel(options: SqlPanelOptions): SqlPanel {
  return {
    run(queryText: string) {
      const db = options.isDev
        ? createDb(options.url, { neonDev: LOCAL_NEON_DEV_CONFIG })
        : createDb(options.url);
      // One transaction pins one connection, so SET LOCAL is guaranteed to
      // govern the query that follows (plain execute may pool-hop).
      const executed = db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`SET LOCAL statement_timeout = ${String(SQL_PANEL_STATEMENT_TIMEOUT_MS)}`)
        );
        return tx.execute(sql.raw(fetchCappedQuery(queryText)));
      });
      return fromPromise(executed, mapPanelError).map((result): SqlPanelResult => {
        const rows = result.rows;
        const truncated = rows.length > SQL_PANEL_MAX_ROWS;
        const page = truncated ? rows.slice(0, SQL_PANEL_MAX_ROWS) : rows;
        return { rows: page, rowCount: page.length, truncated };
      });
    },
  };
}
