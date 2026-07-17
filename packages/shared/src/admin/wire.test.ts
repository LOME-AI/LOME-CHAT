import { describe, it, expect } from 'vitest';
import {
  adminOpExecuteResultSchema,
  adminOpPreviewResultSchema,
  adminOpsCatalogSchema,
  dashboardWireSchema,
  adminAuditExecutedDetailsSchema,
  adminModelsWireSchema,
  customer360ViewSchema,
  jobQueueWireSchema,
  auditSearchWireSchema,
  sqlPanelResultWireSchema,
} from './wire.js';

describe('adminOpsCatalogSchema', () => {
  it('parses a catalog entry with guardrails', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'wallet.credit',
          title: 'Credit wallet',
          kind: 'mutation',
          effectClass: 'durable',
          inverse: 'wallet.clawback',
          fields: ['walletId', 'amountNanoUsd', 'reason'],
          guardrails: { maxAmountNanoUsd: '1000000000000', maxTargets: 1, rateLimitKey: 'k' },
        },
      ],
    });
    expect(parsed.ops[0]?.guardrails?.maxAmountNanoUsd).toBe('1000000000000');
  });

  it('parses an ephemeral entry without guardrails and with a null inverse', () => {
    const parsed = adminOpsCatalogSchema.parse({
      ops: [
        {
          name: 'session.revoke',
          title: 'Revoke sessions',
          kind: 'mutation',
          effectClass: 'ephemeral',
          inverse: null,
          fields: ['userId', 'reason'],
        },
      ],
    });
    expect(parsed.ops[0]?.inverse).toBeNull();
    expect(parsed.ops[0]?.guardrails).toBeUndefined();
  });

  it('rejects an entry with a non-string name', () => {
    expect(() =>
      adminOpsCatalogSchema.parse({
        ops: [
          {
            name: 42,
            title: 'Broken',
            kind: 'mutation',
            effectClass: 'durable',
            inverse: null,
            fields: [],
          },
        ],
      })
    ).toThrow();
  });

  it('rejects a non-decimal maxAmountNanoUsd guardrail', () => {
    expect(() =>
      adminOpsCatalogSchema.parse({
        ops: [
          {
            name: 'wallet.credit',
            title: 'Credit wallet',
            kind: 'mutation',
            effectClass: 'durable',
            inverse: 'wallet.clawback',
            fields: [],
            guardrails: { maxAmountNanoUsd: '10 dollars' },
          },
        ],
      })
    ).toThrow();
  });
});

describe('adminOpPreviewResultSchema', () => {
  it('parses effects with optional before/after and a nullable inverseInput', () => {
    const parsed = adminOpPreviewResultSchema.parse({
      effects: [{ label: 'wallet.balance', before: '0', after: '5000000000' }, { label: 'flag' }],
      inverseInput: null,
    });
    expect(parsed.effects).toHaveLength(2);
    expect(parsed.inverseInput).toBeNull();
  });

  it('rejects a payload missing effects', () => {
    expect(() => adminOpPreviewResultSchema.parse({ inverseInput: null })).toThrow();
  });
});

describe('adminOpExecuteResultSchema', () => {
  it('parses the committed run result', () => {
    const parsed = adminOpExecuteResultSchema.parse({
      auditId: '018f6b3a-0000-7000-8000-000000000000',
      effects: [{ label: 'user.lockedAt' }],
      inverseInput: { userId: 'u', reason: 'undo' },
    });
    expect(parsed.auditId).toBe('018f6b3a-0000-7000-8000-000000000000');
    expect(parsed.inverseInput).toEqual({ userId: 'u', reason: 'undo' });
  });

  it('rejects a non-uuid auditId', () => {
    expect(() =>
      adminOpExecuteResultSchema.parse({ auditId: 'nope', effects: [], inverseInput: null })
    ).toThrow();
  });
});

const AUDIT_ROW = {
  id: '018f6b3a-0000-7000-8000-000000000001',
  actor: 'founder@hushbox.test',
  action: 'user.lock',
  targetType: 'user',
  targetId: '018f6b3a-0000-7000-8000-000000000002',
  details: {
    input: { userId: 'u', lockReason: 'chargeback', reason: 'dispute' },
    effects: [{ label: 'user.lockedAt' }],
    inverseInput: { userId: 'u', reason: 'undo lock' },
  },
  undoes: null,
  undoneBy: null,
  createdAt: '2026-07-15T00:00:00.000Z',
};

describe('dashboardWireSchema', () => {
  it('parses the dashboard envelope', () => {
    const parsed = dashboardWireSchema.parse({
      jobs: { pending: 1, running: 2, dead: 3, discarded: 4 },
      recentActions: [AUDIT_ROW],
    });
    expect(parsed.jobs.dead).toBe(3);
    expect(parsed.recentActions[0]?.action).toBe('user.lock');
  });

  it('rejects a non-integer job count', () => {
    expect(() =>
      dashboardWireSchema.parse({
        jobs: { pending: 1.5, running: 0, dead: 0, discarded: 0 },
        recentActions: [],
      })
    ).toThrow();
  });

  it('rejects an audit row missing its actor', () => {
    const rest = Object.fromEntries(Object.entries(AUDIT_ROW).filter(([key]) => key !== 'actor'));
    expect(() =>
      dashboardWireSchema.parse({
        jobs: { pending: 0, running: 0, dead: 0, discarded: 0 },
        recentActions: [rest],
      })
    ).toThrow();
  });
});

describe('adminAuditExecutedDetailsSchema', () => {
  it('parses an executed-effect details payload', () => {
    const parsed = adminAuditExecutedDetailsSchema.parse(AUDIT_ROW.details);
    expect(parsed.inverseInput).toEqual({ userId: 'u', reason: 'undo lock' });
  });

  it('rejects a read-audit details payload (no effects)', () => {
    expect(() => adminAuditExecutedDetailsSchema.parse({ query: { email: 'a@b.c' } })).toThrow();
  });
});

const MONEY_PANEL = {
  balance: {
    purchasedNanoUsd: '-2500000000',
    freeNanoUsd: '0',
    allowance: {
      day: '2026-07-15',
      limitNanoUsd: '100000000',
      spentNanoUsd: '100000000',
      remainingNanoUsd: '0',
    },
  },
  wallets: [
    {
      id: '018f6b3a-0000-7000-8000-000000000004',
      type: 'purchased',
      balanceNanoUsd: '-2500000000',
    },
  ],
  recentLedger: [
    {
      createdAt: '2026-07-14T10:00:00.000Z',
      kind: 'charge',
      amountNanoUsd: '-2500000000',
      balanceAfterNanoUsd: '-2500000000',
    },
  ],
};

const C360 = {
  user: {
    id: '018f6b3a-0000-7000-8000-000000000002',
    email: 'user@example.com',
    username: 'user',
    emailVerified: true,
    totpEnabled: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    lockedAt: '2026-07-10T00:00:00.000Z',
    lockReason: 'chargeback',
    hasAcknowledgedPhrase: true,
  },
  panels: {
    money: { ok: true, data: MONEY_PANEL },
    usage: {
      ok: true,
      data: {
        models: [
          { modelId: 'openai/gpt-5', totalNanoUsd: '900000000', recordCount: 3, estimatedCount: 1 },
        ],
      },
    },
    conversations: { ok: true, data: { owned: 4, activeMemberships: 6 } },
    devices: {
      ok: true,
      data: { count: 2, tokens: [{ platform: 'ios' }, { platform: 'android' }] },
    },
    jobs: {
      ok: true,
      data: {
        jobs: [
          {
            id: '018f6b3a-0000-7000-8000-000000000003',
            type: 'media.reclaimUser.v1',
            shard: 'bulk',
            status: 'dead',
            discarded: false,
            failures: 8,
            claims: 9,
            payload: { userId: 'u' },
            errors: [{ at: '2026-07-14T10:00:00.000Z', claim: 9, error: 'boom' }],
            nextAttemptAt: '2026-07-14T11:00:00.000Z',
            createdAt: '2026-07-14T09:00:00.000Z',
            finishedAt: null,
          },
        ],
      },
    },
    adminHistory: { ok: false, error: 'unavailable' },
  },
};

describe('customer360ViewSchema', () => {
  it('parses a full view with ok and failed panels', () => {
    const parsed = customer360ViewSchema.parse(C360);
    expect(parsed.user.email).toBe('user@example.com');
    expect(parsed.panels.money.ok).toBe(true);
    expect(parsed.panels.adminHistory).toEqual({ ok: false, error: 'unavailable' });
  });

  it('parses a negative NanoUSD balance string', () => {
    const parsed = customer360ViewSchema.parse(C360);
    if (!parsed.panels.money.ok) throw new Error('expected money panel ok');
    expect(parsed.panels.money.data.balance.purchasedNanoUsd).toBe('-2500000000');
  });

  it('rejects a malformed NanoUSD wire string', () => {
    const broken = {
      ...C360,
      panels: {
        ...C360.panels,
        money: {
          ok: true,
          data: {
            ...MONEY_PANEL,
            balance: { ...MONEY_PANEL.balance, purchasedNanoUsd: '2.5' },
          },
        },
      },
    };
    expect(() => customer360ViewSchema.parse(broken)).toThrow();
  });

  it('rejects a failed panel missing its error code', () => {
    const broken = { ...C360, panels: { ...C360.panels, adminHistory: { ok: false } } };
    expect(() => customer360ViewSchema.parse(broken)).toThrow();
  });

  it('parses an unlocked user (null lockedAt)', () => {
    const parsed = customer360ViewSchema.parse({
      ...C360,
      user: { ...C360.user, lockedAt: null },
    });
    expect(parsed.user.lockedAt).toBeNull();
  });

  it('parses the account facts the server always emits (createdAt, lockReason)', () => {
    const parsed = customer360ViewSchema.parse(C360);
    expect(parsed.user.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(parsed.user.lockReason).toBe('chargeback');
  });

  it('parses wallet identity rows inside the money panel', () => {
    const parsed = customer360ViewSchema.parse(C360);
    if (!parsed.panels.money.ok) throw new Error('expected money panel ok');
    expect(parsed.panels.money.data.wallets).toEqual([
      {
        id: '018f6b3a-0000-7000-8000-000000000004',
        type: 'purchased',
        balanceNanoUsd: '-2500000000',
      },
    ]);
  });

  it('parses the devices panel (platform per token, no token value)', () => {
    const parsed = customer360ViewSchema.parse(C360);
    expect(parsed.panels.devices).toEqual({
      ok: true,
      data: { count: 2, tokens: [{ platform: 'ios' }, { platform: 'android' }] },
    });
  });

  it('rejects a view missing createdAt (the server always emits it)', () => {
    const rest = Object.fromEntries(
      Object.entries(C360.user).filter(([key]) => key !== 'createdAt')
    );
    expect(() => customer360ViewSchema.parse({ ...C360, user: rest })).toThrow();
  });

  it('rejects a view missing the devices panel (the server always emits it)', () => {
    const panels = Object.fromEntries(
      Object.entries(C360.panels).filter(([key]) => key !== 'devices')
    );
    expect(() => customer360ViewSchema.parse({ ...C360, panels })).toThrow();
  });

  it('rejects a money panel missing wallet identity rows', () => {
    const moneyWithoutWallets = Object.fromEntries(
      Object.entries(MONEY_PANEL).filter(([key]) => key !== 'wallets')
    );
    expect(() =>
      customer360ViewSchema.parse({
        ...C360,
        panels: { ...C360.panels, money: { ok: true, data: moneyWithoutWallets } },
      })
    ).toThrow();
  });
});

const MODEL_ROW = {
  modelId: 'openai/gpt-5',
  name: 'GPT-5',
  family: 'language',
  zdrReachable: true,
  adminDisabledAt: null,
};

describe('adminModelsWireSchema', () => {
  it('parses the catalog page with disabled and null-projection rows', () => {
    const parsed = adminModelsWireSchema.parse({
      models: [
        MODEL_ROW,
        {
          modelId: 'broken/descriptor',
          name: null,
          family: null,
          zdrReachable: null,
          adminDisabledAt: '2026-07-13T12:00:00.000Z',
        },
      ],
      truncated: false,
    });
    expect(parsed.models[0]?.family).toBe('language');
    expect(parsed.models[1]?.adminDisabledAt).toBe('2026-07-13T12:00:00.000Z');
    expect(parsed.truncated).toBe(false);
  });

  it('parses a truncated page (server cut at the model cap)', () => {
    const parsed = adminModelsWireSchema.parse({ models: [], truncated: true });
    expect(parsed.truncated).toBe(true);
  });

  it('rejects a family outside the call-shape set', () => {
    expect(() =>
      adminModelsWireSchema.parse({
        models: [{ ...MODEL_ROW, family: 'audio' }],
        truncated: false,
      })
    ).toThrow();
  });

  it('rejects a page missing the truncation flag', () => {
    expect(() => adminModelsWireSchema.parse({ models: [MODEL_ROW] })).toThrow();
  });
});

const JOB_ROW = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  type: 'media.reclaimUser.v1',
  shard: 'bulk',
  status: 'dead',
  discarded: false,
  failures: 8,
  claims: 9,
  payload: { userId: '018f6b3a-0000-7000-8000-000000000001' },
  errors: [{ at: '2026-07-14T10:00:00.000Z', claim: 1, error: 'storage unavailable' }],
  nextAttemptAt: '2026-07-14T11:00:00.000Z',
  createdAt: '2026-07-14T09:00:00.000Z',
  finishedAt: null,
};

describe('jobQueueWireSchema', () => {
  it('parses a cursor page of job rows', () => {
    const parsed = jobQueueWireSchema.parse({
      rows: [JOB_ROW],
      nextCursor: '018f6b3a-0000-7000-8000-00000000000b',
    });
    expect(parsed.rows[0]?.type).toBe('media.reclaimUser.v1');
    expect(parsed.nextCursor).toBe('018f6b3a-0000-7000-8000-00000000000b');
  });

  it('parses the last page with a null cursor', () => {
    const parsed = jobQueueWireSchema.parse({ rows: [], nextCursor: null });
    expect(parsed.nextCursor).toBeNull();
  });

  it('rejects a page whose rows drift from the job row shape', () => {
    expect(() =>
      jobQueueWireSchema.parse({ rows: [{ ...JOB_ROW, failures: 'many' }], nextCursor: null })
    ).toThrow();
  });
});

describe('auditSearchWireSchema', () => {
  const AUDIT_ROW = {
    id: '018f6b3a-0000-7000-8000-00000000000c',
    actor: 'ops@hushbox.test',
    action: 'job.discard',
    targetType: 'job',
    targetId: '018f6b3a-0000-7000-8000-00000000000a',
    details: { input: { reason: 'superseded' }, effects: [], inverseInput: null },
    undoes: null,
    undoneBy: null,
    createdAt: '2026-07-14T10:00:00.000Z',
  };

  it('parses a cursor page of threaded audit rows', () => {
    const parsed = auditSearchWireSchema.parse({ rows: [AUDIT_ROW], nextCursor: null });
    expect(parsed.rows[0]?.action).toBe('job.discard');
    expect(parsed.nextCursor).toBeNull();
  });

  it('rejects a page missing the cursor field', () => {
    expect(() => auditSearchWireSchema.parse({ rows: [AUDIT_ROW] })).toThrow();
  });
});

describe('sqlPanelResultWireSchema', () => {
  it('parses a result page with heterogeneous row values', () => {
    const parsed = sqlPanelResultWireSchema.parse({
      rows: [{ id: 'a', failures: 3, finished_at: null }],
      rowCount: 1,
      truncated: false,
    });
    expect(parsed.rows[0]?.['failures']).toBe(3);
    expect(parsed.truncated).toBe(false);
  });

  it('parses a truncated page (server cut at the row cap)', () => {
    const parsed = sqlPanelResultWireSchema.parse({ rows: [], rowCount: 200, truncated: true });
    expect(parsed.truncated).toBe(true);
  });

  it('rejects a result missing the truncation flag', () => {
    expect(() => sqlPanelResultWireSchema.parse({ rows: [], rowCount: 0 })).toThrow();
  });
});
