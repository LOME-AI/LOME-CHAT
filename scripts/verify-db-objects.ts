import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';

import { isMainModule } from './lib/is-main.js';

/**
 * F-09 golden-dump gate. Drizzle-kit does not model Postgres functions or
 * triggers, so the migration-drift gate is blind to any edit or deletion of the
 * money-safety objects — the `ledger_entries_zero_sum` constraint trigger, its
 * `assert_ledger_transaction_balanced` function (with its pinned `search_path`),
 * and the `admin_audit` append-only triggers. This dumps every hand-written
 * (non-internal) function and trigger from a freshly migrated DB and diffs it
 * against a committed golden file, so any such change must be an intentional,
 * reviewed golden-file update rather than a silent one.
 *
 * pg_get_functiondef renders the `SET search_path` clause inline, so the pin is
 * captured within each function definition.
 */

interface FunctionRow {
  name: string;
  definition: string;
}

interface TriggerRow {
  name: string;
  table_name: string;
  definition: string;
}

// The golden lives with the migrations it guards, in the db package.
const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'db',
  'db-objects.golden.sql'
);

const GOLDEN_HEADER = [
  '-- Golden dump of hand-written Postgres functions and triggers (audit F-09).',
  '-- Drizzle-kit does not model these objects, so the migration-drift gate cannot',
  '-- see them; this file is the drift guard. Regenerate intentionally with:',
  '--   pnpm verify:db-objects:update',
  '-- Do not edit by hand.',
];

function normalizeDefinition(definition: string): string {
  return definition
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

export function formatDbObjects(functions: FunctionRow[], triggers: TriggerRow[]): string {
  const blocks: string[] = [GOLDEN_HEADER.join('\n')];

  for (const function_ of functions) {
    blocks.push(`-- function: ${function_.name}\n${normalizeDefinition(function_.definition)}`);
  }
  for (const trigger of triggers) {
    blocks.push(
      `-- trigger: ${trigger.table_name}.${trigger.name}\n${normalizeDefinition(trigger.definition)}`
    );
  }

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Returns true when the freshly-dumped objects differ from the golden file — the
 * signal a trigger/function was altered or deleted without an intentional golden
 * update.
 */
export function isDrifted(actual: string, expected: string): boolean {
  return actual !== expected;
}

/**
 * Dumps the hand-written functions and triggers from a live, migrated DB.
 *
 * `tgisinternal` excludes the constraint-enforcement triggers Postgres creates
 * for foreign keys; `prokind = 'f'` excludes aggregates/procedures. The `__`
 * prefix filter drops ensure-stack's dev-only freshness tracking
 * (`__stack_mark_dirty` / `__stack_dirty_*`), installed locally but never in CI
 * — including it would make local and CI dumps diverge. Migrations never create
 * `__`-prefixed objects, so what remains is exactly the hand-written objects.
 */
export async function dumpDbObjects(db: Database): Promise<string> {
  const functionResult = await db.execute(sql`
    SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND left(p.proname, 2) <> '__'
    ORDER BY p.proname
  `);
  const functions = functionResult.rows as unknown as FunctionRow[];

  const triggerResult = await db.execute(sql`
    SELECT t.tgname AS name, c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal AND left(t.tgname, 2) <> '__'
    ORDER BY c.relname, t.tgname
  `);
  const triggers = triggerResult.rows as unknown as TriggerRow[];

  return formatDbObjects(functions, triggers);
}

/* v8 ignore start -- CLI wiring: env + fs + createDb; the dump and comparison are proven via the run integration test and the pure-function tests */
async function main(): Promise<void> {
  const update = process.argv.includes('--update');

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('verify-db-objects: DATABASE_URL is required (run pnpm generate:env)');
  }

  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  let actual: string;
  try {
    actual = await dumpDbObjects(db);
  } finally {
    await db.$client.end();
  }

  if (update) {
    writeFileSync(GOLDEN_PATH, actual);
    console.error('verify-db-objects: golden file updated');
    return;
  }

  const expected = readFileSync(GOLDEN_PATH, 'utf8');
  if (isDrifted(actual, expected)) {
    console.error(
      'verify-db-objects: hand-written function/trigger drift detected.\n' +
        'A trigger or function differs from the committed golden dump. If this change is\n' +
        'intentional, regenerate with `pnpm verify:db-objects:update` and commit\n' +
        'packages/db/db-objects.golden.sql; otherwise a money-safety object was altered.'
    );
    process.exitCode = 1;
    return;
  }

  console.error('verify-db-objects: OK');
}

if (isMainModule(import.meta.url)) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('verify-db-objects failed:', error);
      process.exitCode = 1;
    }
  })();
}
/* v8 ignore stop */
