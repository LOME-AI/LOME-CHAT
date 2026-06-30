/**
 * Dev-only stack-freshness bookkeeping. Installs a single-row `__stack_meta`
 * table plus per-table AFTER INSERT/UPDATE/DELETE triggers (FOR EACH STATEMENT,
 * not FOR EACH ROW — bulk writes fire the trigger once per query, not once per
 * row). The triggers flip `dirty=true` on first write; subsequent writes are
 * no-ops thanks to the `WHERE dirty=false` guard in the trigger function.
 *
 * ensure-stack uses the meta row to skip drizzle-kit when the recorded
 * migration fingerprint is current. The `seed_hash`/`seeded_at` column names
 * are historical (the retired seed phase wrote them); they're kept so existing
 * local DBs don't need a destructive table rebuild. Dirty-tracking currently
 * covers no tables — there is no seed baseline to invalidate.
 *
 * Never installed against production: ensure-stack only invokes
 * {@link installDevOnlyTracking} when `isLocalDev` is true. Production migrations
 * live under packages/db/drizzle/ and never reference any of these objects.
 */

/**
 * Thin SQL surface. Tests pass a fake; ensure-stack passes a Drizzle-backed
 * adapter. Two methods are enough because the only SELECT we do is
 * `SELECT ... FROM __stack_meta` and we don't need parameterized queries —
 * every value we substitute is either a strictly-validated identifier or a
 * single string that we escape ourselves.
 */
export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
}

export interface StackMeta {
  seedHash: string;
  seededAt: Date | null;
  dirty: boolean;
}

const META_TABLE = '__stack_meta';
const TRIGGER_FUNCTION = '__stack_mark_dirty';

const IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(
      `stack-meta: "${name}" is not a valid snake_case identifier; refusing to interpolate into SQL.`
    );
  }
}

/** SQL standard: double the single quote inside a literal. */
function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function triggerNameFor(table: string): string {
  return `__stack_dirty_${table}`;
}

export function buildInstallStatements(tables: readonly string[]): string[] {
  for (const t of tables) assertIdentifier(t);

  const createTable = `
    CREATE TABLE IF NOT EXISTS "${META_TABLE}" (
      id        integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      seed_hash text NOT NULL DEFAULT '',
      seeded_at timestamptz,
      dirty     boolean NOT NULL DEFAULT true
    )
  `.trim();

  const seedRow = `
    INSERT INTO "${META_TABLE}" (id) VALUES (1) ON CONFLICT DO NOTHING
  `.trim();

  // WHERE dirty = false makes subsequent writes inside the same "dirty period"
  // skip the UPDATE entirely — steady-state cost is one visibility check.
  // RETURN NULL because this is a statement-level trigger; the return value is
  // ignored regardless.
  const function_ = `
    CREATE OR REPLACE FUNCTION "${TRIGGER_FUNCTION}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE "${META_TABLE}" SET dirty = true WHERE id = 1 AND dirty = false;
      RETURN NULL;
    END;
    $$
  `.trim();

  const triggerStatements: string[] = [];
  for (const table of tables) {
    const triggerName = triggerNameFor(table);
    triggerStatements.push(
      `DROP TRIGGER IF EXISTS "${triggerName}" ON "${table}"`,
      `CREATE TRIGGER "${triggerName}" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "${TRIGGER_FUNCTION}"()`
    );
  }

  return [createTable, seedRow, function_, ...triggerStatements];
}

export async function installDevOnlyTracking(
  executor: SqlExecutor,
  tables: readonly string[]
): Promise<void> {
  const statements = buildInstallStatements(tables);
  for (const statement of statements) {
    await executor.exec(statement);
  }
}

interface MetaRow {
  seed_hash: string;
  seeded_at: string | null;
  dirty: boolean;
}

export async function readMeta(executor: SqlExecutor): Promise<StackMeta> {
  const rows = await executor.query<MetaRow>(
    `SELECT seed_hash, seeded_at, dirty FROM "${META_TABLE}" WHERE id = 1`
  );
  const row = rows[0];
  if (!row) {
    return { seedHash: '', seededAt: null, dirty: true };
  }
  return {
    seedHash: row.seed_hash,
    seededAt: row.seeded_at === null ? null : new Date(row.seeded_at),
    dirty: row.dirty,
  };
}

export async function markClean(executor: SqlExecutor, seedHash: string): Promise<void> {
  const escaped = escapeLiteral(seedHash);
  await executor.exec(
    `UPDATE "${META_TABLE}" SET seed_hash = '${escaped}', seeded_at = NOW(), dirty = false WHERE id = 1`
  );
}
