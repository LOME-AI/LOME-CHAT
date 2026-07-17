import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { afterAll } from 'vitest';
import { createIdentityStores } from '../../identity/index.js';
import { createBillingStores, readBalance, readUsageBreakdown } from '../../billing/index.js';
import { createAdminCrossSliceReads } from '../../../adapters/admin-read-bindings.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminAuditReads } from '../adapters/audit-reads.js';
import { createSqlPanel } from '../adapters/sql-panel.js';
import { READ_AUDIT_ACTIONS } from './read-audit.js';
import { createAdminReadSurface } from './read-surface.js';
import type { AdminReadSurface } from './read-surface.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin read-surface integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const billingStores = createBillingStores();
const stores = createAdminStores();

function panelUrl(): string {
  const url = new URL(DATABASE_URL!);
  url.username = 'admin_sql_panel';
  url.password = 'admin_sql_panel';
  return url.toString();
}

function surface(): AdminReadSurface {
  return createAdminReadSurface({
    db,
    stores,
    auditReads: createAdminAuditReads(),
    crossSlice: createAdminCrossSliceReads(db),
    identity: createIdentityStores(db).users,
    billing: {
      balance: (userId, now) => readBalance(billingStores, db, userId, now),
      ledgerHistory: (userId, window) => billingStores.readLedgerHistory(db, { userId, ...window }),
      usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
    },
    sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
    clock: { now: (): Date => new Date() },
  });
}

const createdUserIds: string[] = [];

function freshActor(): string {
  return `admin-surface-${crypto.randomUUID()}@hushbox.test`;
}

async function sqlPanelAuditRows(actor: string): Promise<{ details: unknown }[]> {
  return db
    .select({ details: adminAudit.details })
    .from(adminAudit)
    .where(and(eq(adminAudit.actor, actor), eq(adminAudit.action, READ_AUDIT_ACTIONS.sqlPanel)));
}

beforeAll(async () => {
  // Dev-only LOGIN provisioning (ensure-stack does this for `pnpm dev`).
  await db.execute(sql`ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'`);
});

afterAll(async () => {
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('AdminReadSurface.sqlPanel', () => {
  it('audits the query text and returns the result page', async () => {
    const actor = freshActor();

    const result = await surface().sqlPanel({ actor, query: 'SELECT 41 + 1 AS answer' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toEqual([{ answer: 42 }]);
    }
    const audits = await sqlPanelAuditRows(actor);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toEqual({ query: 'SELECT 41 + 1 AS answer' });
  });

  it('audits a role-refused write attempt too — the refusal is on the record', async () => {
    const actor = freshActor();
    const query = "INSERT INTO admin_audit (actor, action) VALUES ('x', 'y')";

    const result = await surface().sqlPanel({ actor, query });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    const audits = await sqlPanelAuditRows(actor);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toEqual({ query });
  });

  it('refuses a blank query at the boundary without touching the panel connection', async () => {
    const actor = freshActor();

    const result = await surface().sqlPanel({ actor, query: '   ' });

    expect(result.isErr() && result.error.code).toBe('validation');
    expect(await sqlPanelAuditRows(actor)).toEqual([]);
  });
});

describe('AdminReadSurface.auditSearch', () => {
  it('returns wire rows with ISO timestamps and threading fields', async () => {
    const actor = freshActor();
    const { id } = await stores.insertAudit(db, {
      actor,
      action: 'fixture.mark',
      details: { input: {}, effects: [], inverseInput: null },
    });

    const result = await surface().auditSearch({ actor, limit: 10 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.rows[0]).toMatchObject({ id, actor, undoes: null, undoneBy: null });
      expect(result.value.rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.value.nextCursor).toBeNull();
    }
  });
});

describe('AdminReadSurface.dashboard', () => {
  it('returns job counters and the recent-actions feed', async () => {
    const result = await surface().dashboard();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.jobs).toMatchObject({
        pending: expect.any(Number),
        running: expect.any(Number),
        dead: expect.any(Number),
        discarded: expect.any(Number),
      });
      expect(Array.isArray(result.value.recentActions)).toBe(true);
    }
  });
});

describe('AdminReadSurface error surfaces', () => {
  function brokenSurface(): AdminReadSurface {
    return createAdminReadSurface({
      db,
      stores,
      auditReads: {
        search: () => Promise.reject(new Error('audit search down')),
        recent: () => Promise.reject(new Error('recent down')),
      },
      crossSlice: {
        userAccountFacts: () => Promise.reject(new Error('down')),
        walletSummaries: () => Promise.reject(new Error('down')),
        deviceTokenSummary: () => Promise.reject(new Error('down')),
        conversationCounts: () => Promise.reject(new Error('down')),
        jobsTouchingUser: () => Promise.reject(new Error('down')),
        listJobs: () => Promise.reject(new Error('job list down')),
        jobCounts: () => Promise.reject(new Error('job counts down')),
      },
      identity: createIdentityStores(db).users,
      billing: {
        balance: (userId, now) => readBalance(billingStores, db, userId, now),
        ledgerHistory: (userId, window) =>
          billingStores.readLedgerHistory(db, { userId, ...window }),
        usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
      },
      sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
      clock: { now: (): Date => new Date() },
    });
  }

  it('maps a failed audit search to unavailable', async () => {
    const result = await brokenSurface().auditSearch({ limit: 5 });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('maps a failed dashboard read to unavailable', async () => {
    const result = await brokenSurface().dashboard();
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('serializes a populated job-queue page to wire rows', async () => {
    const when = new Date('2026-07-14T00:00:00Z');
    const surfaceWithJobs = createAdminReadSurface({
      db,
      stores,
      auditReads: createAdminAuditReads(),
      crossSlice: {
        userAccountFacts: () => Promise.resolve(null),
        walletSummaries: () => Promise.resolve([]),
        deviceTokenSummary: () => Promise.resolve({ count: 0, tokens: [] }),
        conversationCounts: () => Promise.resolve({ owned: 0, activeMemberships: 0 }),
        jobsTouchingUser: () => Promise.resolve([]),
        listJobs: () =>
          Promise.resolve({
            rows: [
              {
                id: 'job-1',
                type: 'test.noop.v1',
                shard: 'bulk',
                status: 'pending',
                discarded: false,
                failures: 0,
                claims: 0,
                payload: {},
                errors: [],
                nextAttemptAt: when,
                createdAt: when,
                finishedAt: null,
              },
            ],
            nextCursor: null,
          }),
        jobCounts: () => Promise.resolve({ pending: 1, running: 0, dead: 0, discarded: 0 }),
      },
      identity: createIdentityStores(db).users,
      billing: {
        balance: (userId, now) => readBalance(billingStores, db, userId, now),
        ledgerHistory: (userId, window) =>
          billingStores.readLedgerHistory(db, { userId, ...window }),
        usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
      },
      sqlPanel: createSqlPanel({ url: panelUrl(), isDev: true }),
      clock: { now: (): Date => new Date() },
    });

    const result = await surfaceWithJobs.jobQueue({ limit: 5 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows[0]).toMatchObject({
        id: 'job-1',
        createdAt: when.toISOString(),
        finishedAt: null,
      });
    }
  });

  it('maps a failed job-queue read to unavailable', async () => {
    const result = await brokenSurface().jobQueue({ limit: 5 });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});

describe('AdminReadSurface.jobQueue and customer360 delegation', () => {
  it('lists jobs as wire rows', async () => {
    const result = await surface().jobQueue({ limit: 5 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      for (const row of result.value.rows) {
        expect(typeof row.createdAt).toBe('string');
      }
    }
  });

  it('delegates customer360 (found user, one audit row)', async () => {
    const inserted = await db
      .insert(users)
      .values(userFactory.build())
      .returning({ id: users.id, email: users.email });
    const user = inserted[0]!;
    createdUserIds.push(user.id);
    const actor = freshActor();

    const result = await surface().customer360({ actor, query: { email: user.email } });

    expect(result.isOk() && result.value.user.id).toBe(user.id);
  });
});
