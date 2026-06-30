import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from './client';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function firstRow(result: { rows: Record<string, unknown>[] }): Record<string, unknown> {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Query returned no rows');
  }
  return row;
}

describe('createDb integration (local neon-proxy)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('returns a native v7 uuid from SELECT uuidv7()', async () => {
    const row = firstRow(await db.execute(sql`select uuidv7() as id`));
    expect(row['id']).toMatch(UUID_V7_PATTERN);
  });

  it('reaches a PostgreSQL 18 server', async () => {
    const row = firstRow(await db.execute(sql`select current_setting('server_version_num') as v`));
    const versionNumber = Number(row['v']);
    expect(versionNumber).toBeGreaterThanOrEqual(180_000);
    expect(versionNumber).toBeLessThan(190_000);
  });

  it('runs a multi-statement interactive transaction with read-your-writes', async () => {
    await db.execute(sql`create temp table client_txn_probe (id int primary key)`);
    const insideCount = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into client_txn_probe values (1)`);
      await tx.execute(sql`insert into client_txn_probe values (2)`);
      const row = firstRow(await tx.execute(sql`select count(*)::int as n from client_txn_probe`));
      return row['n'];
    });
    expect(insideCount).toBe(2);
    const after = firstRow(await db.execute(sql`select count(*)::int as n from client_txn_probe`));
    expect(after['n']).toBe(2);
  });

  it('rolls back every statement when the transaction callback throws', async () => {
    await db.execute(sql`create temp table client_rollback_probe (id int primary key)`);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into client_rollback_probe values (1)`);
        throw new Error('forced rollback');
      })
    ).rejects.toThrow('forced rollback');
    const after = firstRow(
      await db.execute(sql`select count(*)::int as n from client_rollback_probe`)
    );
    expect(after['n']).toBe(0);
  });
});

describe('createDb latency injection (local neon-proxy)', () => {
  // begin + three selects + commit = five statements on one checked-out client.
  async function timeFiveStatementTxn(client: Database): Promise<number> {
    const start = performance.now();
    await client.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await tx.execute(sql`select 2`);
      await tx.execute(sql`select 3`);
    });
    return performance.now() - start;
  }

  it('inflates a multi-statement transaction wall time by the per-statement delay', async () => {
    const plain = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    const slow = createDb(DATABASE_URL, {
      neonDev: LOCAL_NEON_DEV_CONFIG,
      injectLatencyMs: 30,
    });
    try {
      // Warm both pools so connection setup is excluded from the timings.
      await plain.execute(sql`select 1`);
      await slow.execute(sql`select 1`);

      const baseline = Math.min(
        await timeFiveStatementTxn(plain),
        await timeFiveStatementTxn(plain),
        await timeFiveStatementTxn(plain)
      );
      const inflated = await timeFiveStatementTxn(slow);

      // 5 statements x 30 ms = 150 ms nominal; generous margins, no exact timing.
      expect(inflated).toBeGreaterThanOrEqual(120);
      expect(inflated).toBeGreaterThanOrEqual(baseline + 80);
    } finally {
      await plain.$client.end();
      await slow.$client.end();
    }
  });
});
