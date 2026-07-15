import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAdminStores } from './stores.js';
import { createAdminAuditReads } from './audit-reads.js';
import type { AdminAuditInsertRow } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin audit-read integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createAdminStores();
const reads = createAdminAuditReads();

/** Rows are append-only; per-run actors isolate this suite forever. */
function freshActor(): string {
  return `admin-audit-reads-reads-${crypto.randomUUID()}@hushbox.test`;
}

/** Executed-effect details shape (what the engine writes for real ops). */
function executedDetails(): AdminAuditInsertRow['details'] {
  return { input: {}, effects: [{ label: 'fixture' }], inverseInput: null };
}

async function seedRow(row: Partial<AdminAuditInsertRow> & { actor: string }): Promise<string> {
  const { id } = await stores.insertAudit(db, {
    action: 'fixture.mark',
    details: executedDetails(),
    ...row,
  });
  return id;
}

describe('createAdminAuditReads().search', () => {
  it('returns only the filtered actor’s rows, newest first', async () => {
    const actor = freshActor();
    const first = await seedRow({ actor });
    const second = await seedRow({ actor });
    await seedRow({ actor: freshActor() });

    const result = await reads.search(db, { actor, limit: 10 });

    expect(result.rows.map((row) => row.id)).toEqual([second, first]);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by action', async () => {
    const actor = freshActor();
    await seedRow({ actor });
    const undone = await seedRow({ actor, action: 'fixture.unmark' });

    const result = await reads.search(db, { actor, action: 'fixture.unmark', limit: 10 });

    expect(result.rows.map((row) => row.id)).toEqual([undone]);
  });

  it('filters by target type and id', async () => {
    const actor = freshActor();
    const targetId = `model/${crypto.randomUUID()}`;
    const hit = await seedRow({ actor, targetType: 'model', targetId });
    await seedRow({ actor, targetType: 'model', targetId: `model/${crypto.randomUUID()}` });
    await seedRow({ actor, targetType: 'user', targetId: crypto.randomUUID() });

    const result = await reads.search(db, { targetType: 'model', targetId, limit: 10 });

    expect(result.rows.map((row) => row.id)).toEqual([hit]);
  });

  it('bounds the page by a date range', async () => {
    const actor = freshActor();
    const seeded = await seedRow({ actor });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    const inside = await reads.search(db, { actor, from: past, to: future, limit: 10 });
    const outside = await reads.search(db, { actor, to: past, limit: 10 });

    expect(inside.rows.map((row) => row.id)).toEqual([seeded]);
    expect(outside.rows).toEqual([]);
  });

  it('paginates with a strictly-older cursor and reports the next cursor', async () => {
    const actor = freshActor();
    const oldest = await seedRow({ actor });
    const middle = await seedRow({ actor });
    const newest = await seedRow({ actor });

    const firstPage = await reads.search(db, { actor, limit: 2 });
    expect(firstPage.rows.map((row) => row.id)).toEqual([newest, middle]);
    expect(firstPage.nextCursor).toBe(middle);

    const secondPage = await reads.search(db, { actor, limit: 2, cursor: firstPage.nextCursor! });
    expect(secondPage.rows.map((row) => row.id)).toEqual([oldest]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('threads undoes and undone-by both ways', async () => {
    const actor = freshActor();
    const executed = await seedRow({ actor });
    const undo = await seedRow({ actor, action: 'fixture.unmark', undoes: executed });

    const result = await reads.search(db, { actor, limit: 10 });

    const executedRow = result.rows.find((row) => row.id === executed);
    const undoRow = result.rows.find((row) => row.id === undo);
    expect(executedRow).toMatchObject({ undoes: null, undoneBy: undo });
    expect(undoRow).toMatchObject({ undoes: executed, undoneBy: null });
  });

  it('answers a target search from the (target_type, target_id) index — never a seq scan', async () => {
    // Force the planner to prove index usability: with seq scans disabled the
    // target predicate must still plan onto admin_audit_target_idx.
    const plan = await db.execute(sql`
      BEGIN;
      SET LOCAL enable_seqscan = off;
      EXPLAIN SELECT * FROM admin_audit
        WHERE target_type = 'model' AND target_id = 'openai/gpt-5'
        ORDER BY id DESC LIMIT 20;
    `);
    const planText = JSON.stringify(plan);
    await db.execute(sql`ROLLBACK;`);
    expect(planText).toContain('admin_audit_target_idx');
  });
});

describe('createAdminAuditReads().recent', () => {
  it('returns at most the requested count, newest first', async () => {
    const actor = freshActor();
    await seedRow({ actor });
    await seedRow({ actor });

    const rows = await reads.recent(db, 5);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(5);
    const ids = rows.map((row) => row.id);
    const newestFirst = ids.toSorted((a, b) => b.localeCompare(a));
    expect(newestFirst).toEqual(ids);
  });
});
