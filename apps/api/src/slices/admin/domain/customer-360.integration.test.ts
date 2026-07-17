import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb } from '@hushbox/db';
import { lockedUserFactory, userFactory, walletFactory } from '@hushbox/db/factories';
import { users, wallets } from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createIdentityStores } from '../../identity/index.js';
import { createDeviceTokenStore } from '../../notifications/index.js';
import { createBillingStores, readBalance, readUsageBreakdown } from '../../billing/index.js';
import { createAdminCrossSliceReads } from '../../../adapters/admin-read-bindings.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminAuditReads } from '../adapters/audit-reads.js';
import { READ_AUDIT_ACTIONS } from './read-audit.js';
import { loadCustomer360 } from './customer-360.js';
import type { Customer360Deps } from './customer-360.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for customer-360 integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const billingStores = createBillingStores();
const stores = createAdminStores();

const createdUserIds: string[] = [];
// Wallets pseudonymize (SET NULL) on user deletion instead of cascading, so
// the seeded rows are tracked and deleted explicitly.
const createdWalletIds: string[] = [];

function realDeps(): Customer360Deps {
  const identity = createIdentityStores(db);
  return {
    db,
    stores,
    auditReads: createAdminAuditReads(),
    crossSlice: createAdminCrossSliceReads(db),
    identity: identity.users,
    billing: {
      balance: (userId, now) => readBalance(billingStores, db, userId, now),
      ledgerHistory: (userId, window) => billingStores.readLedgerHistory(db, { userId, ...window }),
      usage: (userId) => readUsageBreakdown(billingStores, db, { userId, limit: 20 }),
    },
    clock: { now: (): Date => new Date() },
  };
}

async function seedUser(): Promise<{ id: string; email: string }> {
  const built = userFactory.build();
  const inserted = await db
    .insert(users)
    .values(built)
    .returning({ id: users.id, email: users.email });
  const row = inserted[0]!;
  createdUserIds.push(row.id);
  return row;
}

function freshActor(): string {
  return `admin-360-${crypto.randomUUID()}@hushbox.test`;
}

async function auditRowsFor(
  actor: string
): Promise<{ action: string; targetType: string | null; targetId: string | null }[]> {
  return db
    .select({
      action: adminAudit.action,
      targetType: adminAudit.targetType,
      targetId: adminAudit.targetId,
    })
    .from(adminAudit)
    .where(eq(adminAudit.actor, actor));
}

afterAll(async () => {
  if (createdWalletIds.length > 0)
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('loadCustomer360', () => {
  it('assembles the view by email with every panel loaded', async () => {
    const user = await seedUser();
    const actor = freshActor();

    const result = await loadCustomer360(realDeps(), {
      actor,
      query: { email: user.email },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const view = result.value;
    expect(view.user).toMatchObject({ id: user.id, email: user.email, lockedAt: null });
    expect(view.panels.money.ok).toBe(true);
    if (view.panels.money.ok) {
      // Money serializes as NanoUSD strings at the JSON boundary.
      expect(view.panels.money.data.balance.purchasedNanoUsd).toBe('0');
      expect(typeof view.panels.money.data.balance.allowance.remainingNanoUsd).toBe('string');
    }
    expect(view.panels.usage).toEqual({ ok: true, data: { models: [] } });
    expect(view.panels.conversations).toEqual({
      ok: true,
      data: { owned: 0, activeMemberships: 0 },
    });
    expect(view.panels.jobs).toEqual({ ok: true, data: { jobs: [] } });
    expect(view.panels.devices).toEqual({ ok: true, data: { count: 0, tokens: [] } });
    // The view's own read-audit row is already history — reads are audited,
    // and the history panel loads after the row commits.
    expect(view.panels.adminHistory.ok).toBe(true);
    if (view.panels.adminHistory.ok) {
      expect(view.panels.adminHistory.data.actions.map((row) => row.action)).toEqual([
        READ_AUDIT_ACTIONS.customer360,
      ]);
    }
  });

  it('resolves the same user by id', async () => {
    const user = await seedUser();

    const result = await loadCustomer360(realDeps(), {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isOk() && result.value.user.id).toBe(user.id);
  });

  it('writes exactly one coarse read-audit row per view', async () => {
    const user = await seedUser();
    const actor = freshActor();

    const result = await loadCustomer360(realDeps(), { actor, query: { email: user.email } });

    expect(result.isOk()).toBe(true);
    expect(await auditRowsFor(actor)).toEqual([
      { action: READ_AUDIT_ACTIONS.customer360, targetType: 'user', targetId: user.id },
    ]);
  });

  it('answers not_found for an unknown user and audits nothing', async () => {
    const actor = freshActor();

    const result = await loadCustomer360(realDeps(), {
      actor,
      query: { email: `missing-${crypto.randomUUID()}@hushbox.test` },
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
    expect(await auditRowsFor(actor)).toEqual([]);
  });

  it('serializes populated money, usage, and jobs panels to wire JSON', async () => {
    const user = await seedUser();
    const deps = realDeps();
    const when = new Date('2026-07-14T00:00:00Z');
    const populated: Customer360Deps = {
      ...deps,
      billing: {
        balance: () =>
          okAsync({
            purchasedNanoUsd: 5_000_000_000n,
            freeNanoUsd: 0n,
            allowance: {
              day: '2026-07-14',
              limitNanoUsd: 100_000_000n,
              spentNanoUsd: 25_000_000n,
              remainingNanoUsd: 75_000_000n,
            },
          }),
        ledgerHistory: () =>
          okAsync([
            {
              createdAt: when,
              kind: 'charge',
              amountNanoUsd: -1_000_000n,
              balanceAfterNanoUsd: 4_999_000_000n,
            },
          ]),
        usage: () =>
          okAsync({
            models: [
              { modelId: 'openai/gpt-5', totalNanoUsd: 42n, recordCount: 3, estimatedCount: 1 },
            ],
            nextCursor: null,
          }),
      },
      crossSlice: {
        ...deps.crossSlice,
        jobsTouchingUser: () =>
          Promise.resolve([
            {
              id: 'job-1',
              type: 'media.reclaimUser.v1',
              shard: 'bulk',
              status: 'succeeded',
              discarded: false,
              failures: 0,
              claims: 1,
              payload: { userId: user.id },
              errors: [],
              nextAttemptAt: when,
              createdAt: when,
              finishedAt: when,
            },
          ]),
      },
    };

    const result = await loadCustomer360(populated, {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const { panels } = result.value;
    expect(panels.money).toEqual({
      ok: true,
      data: {
        balance: {
          purchasedNanoUsd: '5000000000',
          freeNanoUsd: '0',
          allowance: {
            day: '2026-07-14',
            limitNanoUsd: '100000000',
            spentNanoUsd: '25000000',
            remainingNanoUsd: '75000000',
          },
        },
        wallets: [],
        recentLedger: [
          {
            createdAt: when.toISOString(),
            kind: 'charge',
            amountNanoUsd: '-1000000',
            balanceAfterNanoUsd: '4999000000',
          },
        ],
      },
    });
    expect(panels.usage).toEqual({
      ok: true,
      data: {
        models: [
          { modelId: 'openai/gpt-5', totalNanoUsd: '42', recordCount: 3, estimatedCount: 1 },
        ],
      },
    });
    expect(panels.jobs.ok).toBe(true);
    if (panels.jobs.ok) {
      expect(panels.jobs.data.jobs[0]).toMatchObject({
        id: 'job-1',
        finishedAt: when.toISOString(),
      });
    }
  });

  it('surfaces a locked account in the header projection', async () => {
    const built = lockedUserFactory.build({ lockReason: 'chargeback' });
    const inserted = await db
      .insert(users)
      .values(built)
      .returning({ id: users.id, email: users.email });
    const row = inserted[0]!;
    createdUserIds.push(row.id);

    const result = await loadCustomer360(realDeps(), {
      actor: freshActor(),
      query: { userId: row.id },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.user.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.value.user.lockReason).toBe('chargeback');
    }
  });

  it('carries account facts in the header — createdAt, null lockReason when unlocked', async () => {
    const user = await seedUser();

    const result = await loadCustomer360(realDeps(), {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.value.user.lockReason).toBeNull();
  });

  it('fails the whole view when the account-facts read fails', async () => {
    const user = await seedUser();
    const deps = realDeps();
    const broken: Customer360Deps = {
      ...deps,
      crossSlice: {
        ...deps.crossSlice,
        userAccountFacts: () => Promise.reject(new Error('users read down')),
      },
    };

    const result = await loadCustomer360(broken, {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('answers not_found when the user is deleted between the identity lookup and the facts read', async () => {
    const user = await seedUser();
    const deps = realDeps();
    const gone: Customer360Deps = {
      ...deps,
      crossSlice: {
        ...deps.crossSlice,
        userAccountFacts: () => Promise.resolve(null),
      },
    };

    const result = await loadCustomer360(gone, {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
  });

  it('lists each wallet id, type, and balance in the money panel', async () => {
    const user = await seedUser();
    const inserted = await db
      .insert(wallets)
      .values([
        walletFactory.build({ userId: user.id, type: 'purchased', balanceNanoUsd: 5000n }),
        walletFactory.build({ userId: user.id, type: 'free', balanceNanoUsd: 0n }),
      ])
      .returning({ id: wallets.id, type: wallets.type });
    createdWalletIds.push(...inserted.map((row) => row.id));

    const result = await loadCustomer360(realDeps(), {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const money = result.value.panels.money;
    expect(money.ok).toBe(true);
    if (!money.ok) return;
    const byType = new Map(money.data.wallets.map((wallet) => [wallet.type, wallet]));
    expect(byType.get('purchased')).toEqual({
      id: inserted.find((row) => row.type === 'purchased')!.id,
      type: 'purchased',
      balanceNanoUsd: '5000',
    });
    expect(byType.get('free')).toEqual({
      id: inserted.find((row) => row.type === 'free')!.id,
      type: 'free',
      balanceNanoUsd: '0',
    });
  });

  it('summarizes device tokens by platform and never carries the token value', async () => {
    const user = await seedUser();
    const token = `push-credential-${crypto.randomUUID()}`;
    const registered = await createDeviceTokenStore(db).upsert({
      userId: user.id,
      token,
      platform: 'ios',
    });
    expect(registered.isOk()).toBe(true);

    const result = await loadCustomer360(realDeps(), {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.panels.devices).toEqual({
      ok: true,
      data: { count: 1, tokens: [{ platform: 'ios' }] },
    });
    // The token is push credential material — it must never reach the wire.
    expect(JSON.stringify(result.value)).not.toContain(token);
  });

  it('degrades the devices panel independently when its read fails', async () => {
    const user = await seedUser();
    const deps = realDeps();
    const broken: Customer360Deps = {
      ...deps,
      crossSlice: {
        ...deps.crossSlice,
        deviceTokenSummary: () => Promise.reject(new Error('device tokens read down')),
      },
    };

    const result = await loadCustomer360(broken, {
      actor: freshActor(),
      query: { userId: user.id },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.panels.devices).toEqual({ ok: false, error: 'unavailable' });
    expect(result.value.panels.money.ok).toBe(true);
    expect(result.value.panels.conversations.ok).toBe(true);
  });

  it('propagates an identity-store failure as the whole view error', async () => {
    const deps = realDeps();
    const broken: Customer360Deps = {
      ...deps,
      identity: {
        findByEmail: () => errAsync(unavailableError('identity is down')),
        findById: () => errAsync(unavailableError('identity is down')),
      },
    };

    const result = await loadCustomer360(broken, {
      actor: freshActor(),
      query: { email: 'anyone@hushbox.test' },
    });

    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('answers not_found for an unknown userId lookup too', async () => {
    const result = await loadCustomer360(realDeps(), {
      actor: freshActor(),
      query: { userId: crypto.randomUUID() },
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
  });

  it('degrades every cross-slice panel independently when those reads fail', async () => {
    const user = await seedUser();
    const deps = realDeps();
    const broken: Customer360Deps = {
      ...deps,
      billing: {
        ...deps.billing,
        usage: () => errAsync(unavailableError('usage is down')),
      },
      crossSlice: {
        ...deps.crossSlice,
        conversationCounts: () => Promise.reject(new Error('conversations read down')),
        jobsTouchingUser: () => Promise.reject(new Error('jobs read down')),
      },
      auditReads: {
        ...deps.auditReads,
        search: () => Promise.reject(new Error('audit read down')),
      },
    };

    const result = await loadCustomer360(broken, {
      actor: freshActor(),
      query: { email: user.email },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const { panels } = result.value;
    expect(panels.usage).toEqual({ ok: false, error: 'unavailable' });
    expect(panels.conversations).toEqual({ ok: false, error: 'unavailable' });
    expect(panels.jobs).toEqual({ ok: false, error: 'unavailable' });
    expect(panels.adminHistory).toEqual({ ok: false, error: 'unavailable' });
    expect(panels.money.ok).toBe(true);
  });

  it('isolates a failing panel — the rest of the view still loads', async () => {
    const user = await seedUser();
    const deps = realDeps();
    const broken: Customer360Deps = {
      ...deps,
      billing: {
        ...deps.billing,
        balance: () => errAsync(unavailableError('billing is down')),
      },
    };

    const result = await loadCustomer360(broken, {
      actor: freshActor(),
      query: { email: user.email },
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.panels.money).toEqual({ ok: false, error: 'unavailable' });
    expect(result.value.panels.conversations.ok).toBe(true);
  });
});
