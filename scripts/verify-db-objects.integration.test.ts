import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';

import { dumpDbObjects } from './verify-db-objects.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'db',
  'db-objects.golden.sql'
);

describe('dumpDbObjects', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('captures the ledger zero-sum trigger and its balance-assert function with the search_path pin', async () => {
    const dump = await dumpDbObjects(db);

    expect(dump).toContain('-- function: assert_ledger_transaction_balanced');
    expect(dump).toContain('-- trigger: ledger_entries.ledger_entries_zero_sum');
    expect(dump).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(dump).toMatch(/search_path/);
  });

  it('captures the admin_audit append-only triggers', async () => {
    const dump = await dumpDbObjects(db);

    expect(dump).toContain('-- trigger: admin_audit.admin_audit_append_only');
    expect(dump).toContain('-- trigger: admin_audit.admin_audit_block_truncate');
  });

  it('matches the committed golden file exactly (no undetected drift)', async () => {
    const dump = await dumpDbObjects(db);
    const golden = readFileSync(GOLDEN_PATH, 'utf8');

    expect(dump).toBe(golden);
  });
});
