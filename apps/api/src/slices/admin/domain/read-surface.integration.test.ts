import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  feedback,
  newsletterIssues,
  newsletterSubscribers,
  users,
} from '@hushbox/db';
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

/** `readDb` overrides only the top-level connection the feedback reads use
 * (the panel/identity/billing deps stay bound to the real db). */
function surface(readDb: typeof db = db): AdminReadSurface {
  return createAdminReadSurface({
    db: readDb,
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

/** Seed one feedback row (its user is tracked for cascade cleanup in afterAll). */
async function seedFeedback(status: 'new' | 'triaged' | 'resolved' = 'new'): Promise<string> {
  const inserted = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  const user = inserted[0]!;
  createdUserIds.push(user.id);
  const rows = await db
    .insert(feedback)
    .values({ userId: user.id, kind: 'bug', body: 'long body '.repeat(30), status })
    .returning({ id: feedback.id });
  return rows[0]!.id;
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

describe('AdminReadSurface.newsletterIssues', () => {
  const issueMarker = `admin-surface-nl ${crypto.randomUUID()}`;
  const seededIssueIds: string[] = [];

  async function seedIssues(): Promise<void> {
    for (const status of ['scheduled', 'canceled', 'sent'] as const) {
      const rows = await db
        .insert(newsletterIssues)
        .values({
          subject: `${issueMarker} ${status}`,
          bodyMarkdown: 'body',
          status,
          scheduledAt: new Date('2999-01-01T00:00:00.000Z'),
          ...(status === 'sent'
            ? {
                sentAt: new Date('2026-01-01T00:00:00.000Z'),
                recipientCount: 5,
                sentCount: 4,
                failedCount: 1,
              }
            : {}),
          createdBy: 'seed@hushbox.ai',
        })
        .returning({ id: newsletterIssues.id });
      seededIssueIds.push(rows[0]!.id);
    }
  }

  afterAll(async () => {
    if (seededIssueIds.length > 0) {
      await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, seededIssueIds));
    }
  });

  it('pages issues by keyset and maps rows to wire shape', async () => {
    await seedIssues();

    const collected: { id: string; subject: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await surface().newsletterIssues({
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const view = result._unsafeUnwrap();
      expect(view.rows.length).toBeLessThanOrEqual(2);
      collected.push(...view.rows.map((row) => ({ id: row.id, subject: row.subject })));
      if (view.nextCursor === null) break;
      cursor = view.nextCursor;
    }

    const mine = collected.filter((row) => row.subject.startsWith(issueMarker));
    // Newest-first: uuidv7 ids are time-ordered, so seeded order reverses.
    expect(mine.map((row) => row.id)).toEqual(seededIssueIds.toReversed());
  });

  it('serializes timestamps as ISO strings and carries the delivery counts', async () => {
    const result = await surface().newsletterIssues({ limit: 50 });

    const rows = result._unsafeUnwrap().rows;
    const sent = rows.find((row) => row.subject === `${issueMarker} sent`);
    expect(sent).toMatchObject({
      status: 'sent',
      scheduledAt: '2999-01-01T00:00:00.000Z',
      sentAt: '2026-01-01T00:00:00.000Z',
      canceledAt: null,
      recipientCount: 5,
      sentCount: 4,
      failedCount: 1,
      createdBy: 'seed@hushbox.ai',
    });
    const scheduled = rows.find((row) => row.subject === `${issueMarker} scheduled`);
    expect(scheduled).toMatchObject({ status: 'scheduled', sentAt: null, recipientCount: null });
  });
});

describe('AdminReadSurface newsletter subscribers', () => {
  const emailMarker = `admin-surface-sub-${crypto.randomUUID().slice(0, 8)}`;
  const seededSubscriberIds: string[] = [];

  async function seedSubscriber(
    status: 'pending' | 'subscribed' | 'suppressed',
    suppressReason: 'bounce' | 'complaint' | null = null
  ): Promise<string> {
    const rows = await db
      .insert(newsletterSubscribers)
      .values({
        email: `${emailMarker}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`,
        status,
        suppressReason,
        unsubscribeToken: crypto.randomUUID(),
        confirmToken: crypto.randomUUID(),
        consentSource: 'marketing_site',
        consentIp: '203.0.113.7',
        consentTextVersion: 'v1',
      })
      .returning({ id: newsletterSubscribers.id });
    seededSubscriberIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  afterAll(async () => {
    if (seededSubscriberIds.length > 0) {
      await db
        .delete(newsletterSubscribers)
        .where(inArray(newsletterSubscribers.id, seededSubscriberIds));
    }
  });

  it('aggregates counts per status and per suppressReason', async () => {
    const beforeResult = await surface().newsletterSubscriberStats();
    const before = beforeResult._unsafeUnwrap();
    await seedSubscriber('subscribed');
    await seedSubscriber('suppressed', 'bounce');

    const afterResult = await surface().newsletterSubscriberStats();
    const after = afterResult._unsafeUnwrap();

    expect(after.byStatus.subscribed).toBe(before.byStatus.subscribed + 1);
    expect(after.byStatus.suppressed).toBe(before.byStatus.suppressed + 1);
    expect(after.bySuppressReason.bounce).toBe(before.bySuppressReason.bounce + 1);
  });

  it('lists consent evidence without token columns, filtered by status, and audits the read', async () => {
    const id = await seedSubscriber('subscribed');
    const actor = freshActor();

    const result = await surface().newsletterSubscribers({
      actor,
      limit: 100,
      status: 'subscribed',
    });

    const page = result._unsafeUnwrap();
    const mine = page.rows.find((row) => row.id === id);
    expect(mine).toMatchObject({
      status: 'subscribed',
      consentSource: 'marketing_site',
      consentIp: '203.0.113.7',
      consentTextVersion: 'v1',
    });
    expect(typeof mine?.email).toBe('string');
    expect(typeof mine?.createdAt).toBe('string');
    expect(Object.keys(mine!)).not.toContain('unsubscribeToken');
    expect(Object.keys(mine!)).not.toContain('confirmToken');
    for (const row of page.rows) {
      expect(row.status).toBe('subscribed');
    }

    const audits = await db
      .select({ action: adminAudit.action, details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(audits).toEqual([
      {
        action: READ_AUDIT_ACTIONS.newsletterSubscribers,
        details: { limit: 100, status: 'subscribed' },
      },
    ]);
  });

  it('pages the subscriber list by keyset cursor', async () => {
    await seedSubscriber('pending');
    await seedSubscriber('pending');

    const firstResult = await surface().newsletterSubscribers({ actor: freshActor(), limit: 1 });
    const first = firstResult._unsafeUnwrap();
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const secondResult = await surface().newsletterSubscribers({
      actor: freshActor(),
      limit: 1,
      cursor: first.nextCursor!,
    });
    const second = secondResult._unsafeUnwrap();
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
  });
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

describe('AdminReadSurface.feedbackInbox', () => {
  it('returns inbox rows with a nextCursor when the page fills', async () => {
    await seedFeedback();

    const result = await surface().feedbackInbox({ limit: 1 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows).toHaveLength(1);
      expect(result.value.nextCursor).toBe(result.value.rows[0]!.id);
    }
  });

  it('honors the status filter', async () => {
    const triaged = await seedFeedback('triaged');

    const result = await surface().feedbackInbox({ status: 'triaged', limit: 100 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.rows.every((row) => row.status === 'triaged')).toBe(true);
      expect(result.value.rows.some((row) => row.id === triaged)).toBe(true);
    }
  });
});

describe('AdminReadSurface.feedbackDetail', () => {
  it('returns the detail and writes exactly one read.feedbackView audit row', async () => {
    const id = await seedFeedback();
    const actor = freshActor();

    const result = await surface().feedbackDetail({ actor, id });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.id).toBe(id);
      expect(result.value.body).toContain('long body');
    }
    const audits = await db
      .select({
        action: adminAudit.action,
        targetType: adminAudit.targetType,
        targetId: adminAudit.targetId,
      })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(audits).toEqual([
      { action: READ_AUDIT_ACTIONS.feedbackView, targetType: 'feedback', targetId: id },
    ]);
  });

  it('returns not_found and writes no audit row for an unknown id', async () => {
    const actor = freshActor();

    const result = await surface().feedbackDetail({ actor, id: crypto.randomUUID() });

    expect(result.isErr() && result.error.code).toBe('not_found');
    const audits = await db
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(audits).toEqual([]);
  });

  it('propagates a store failure as the typed domain error', async () => {
    const failingDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.reject(new Error('feedback down')) }),
        }),
      }),
    } as unknown as typeof db;

    const result = await surface(failingDb).feedbackDetail({
      actor: freshActor(),
      id: crypto.randomUUID(),
    });

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
