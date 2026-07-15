import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  modelCatalog,
} from '@hushbox/db';
import { Redis } from '@upstash/redis';
import { and, eq, like } from 'drizzle-orm';
import { createAdminAuditReads } from '../../adapters/audit-reads.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { acquireModelCatalogLock } from '../../../models/__tests__/model-catalog-lock.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminModelOperations } from './index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingConfig } from '../describe-admin-op.js';
import type { AdminModelDeps } from './model.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for admin model op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const adminStores = createAdminStores();

const DISABLE_CONTRACT = ADMIN_OP_CONTRACTS['model.disable'];
const ENABLE_CONTRACT = ADMIN_OP_CONTRACTS['model.enable'];

const insertedModelIds: string[] = [];

// This suite inserts and mutates real `model_catalog` rows, so it holds the
// cross-suite catalog lock for its whole run — a concurrent suite's
// clear-the-catalog section (the dev-routes 404 test) would otherwise race
// these rows in both directions.
let releaseCatalogLock: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseCatalogLock = await acquireModelCatalogLock(redis);
}, 20_000);

afterAll(async () => {
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/model.%'));
  for (const modelId of insertedModelIds) {
    await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
  }
  await releaseCatalogLock?.();
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    emitMetric: noop,
    captureError: noop,
  };
}

interface ModelHarness extends AdminOpHarnessInstance {
  readonly modelId: string;
}

async function createModelHarness(
  options: { hooks?: AdminOpEngineHooks } = {},
  seed: { disabled?: boolean } = {}
): Promise<ModelHarness> {
  const modelId = `admin-op-test/${crypto.randomUUID()}`;
  insertedModelIds.push(modelId);
  await db.insert(modelCatalog).values({
    modelId,
    descriptor: { id: modelId },
    ...(seed.disabled === true ? { adminDisabledAt: new Date() } : {}),
  });
  const actor = `admin-model-test-${crypto.randomUUID()}@hushbox.ai`;
  const deps: AdminModelDeps = { clock: { now: (): Date => new Date() } };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminModelDeps>([...adminModelOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    executorId: `admin-model-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    modelId,
    /** Catalog exposure plus the refresh-owned descriptor: the interleaving
     * proves the kill switch and the refresh column evolve independently. */
    projection: async (): Promise<{ adminDisabled: boolean; descriptor: unknown }> => {
      const rows = await db
        .select({
          adminDisabledAt: modelCatalog.adminDisabledAt,
          descriptor: modelCatalog.descriptor,
        })
        .from(modelCatalog)
        .where(eq(modelCatalog.modelId, modelId));
      const row = rows[0];
      if (row === undefined) throw new Error('model harness: projection model is gone');
      return { adminDisabled: row.adminDisabledAt !== null, descriptor: row.descriptor };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
  };
}

function modelOf(harness: AdminOpHarnessInstance): string {
  return (harness as ModelHarness).modelId;
}

/** The one meaningful catalog interleaving: a refresh-shaped descriptor
 * rewrite (the refresh upsert touches ONLY `descriptor`, never the kill
 * switch). Seeded values keep control and op runs byte-identical. */
function modelInterleaving(): AdminOpInterleavingConfig {
  return {
    seeds: [17, 37, 53],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      modelId: modelOf(harness),
      reason: `interleaving kill switch ${crypto.randomUUID()}`,
    }),
    actions: [
      {
        name: 'catalog-refresh-rewrite',
        // The written descriptor carries no per-instance id: the control and
        // op harnesses are distinct rows, and the projection must compare
        // equal across fresh instances.
        run: async (harness, rng) => {
          await db
            .update(modelCatalog)
            .set({ descriptor: { refreshStamp: Math.floor(rng() * 1e9) } })
            .where(eq(modelCatalog.modelId, modelOf(harness)));
        },
      },
    ],
  };
}

const disableTarget = { modelId: '' };
describeAdminOp({
  contract: DISABLE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createModelHarness(options);
    disableTarget.modelId = harness.modelId;
    return harness;
  },
  validInput: () => ({
    modelId: disableTarget.modelId,
    reason: `provider incident ${crypto.randomUUID()}`,
  }),
  invalidInput: { modelId: '', reason: 'x' },
  interleaving: modelInterleaving(),
});

const enableTarget = { modelId: '' };
describeAdminOp({
  contract: ENABLE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createModelHarness(options, { disabled: true });
    enableTarget.modelId = harness.modelId;
    return harness;
  },
  validInput: () => ({
    modelId: enableTarget.modelId,
    reason: `incident resolved ${crypto.randomUUID()}`,
  }),
  invalidInput: { modelId: '', reason: 'x' },
  interleaving: modelInterleaving(),
});

function runOp(
  harness: ModelHarness,
  name: string,
  modelId: string
): ReturnType<ModelHarness['engine']['run']> {
  return harness.engine.run({
    name,
    input: { modelId, reason: `semantic probe ${crypto.randomUUID()}` },
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
  });
}

describe('model.disable / model.enable semantics', () => {
  it('refuses to disable an already-disabled model — the first disable timestamp is never clobbered', async () => {
    const harness = await createModelHarness({}, { disabled: true });

    const result = await runOp(harness, 'model.disable', harness.modelId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses to enable an already-enabled model with a typed conflict', async () => {
    const harness = await createModelHarness();

    const result = await runOp(harness, 'model.enable', harness.modelId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an unknown model with a typed not-found on both ops', async () => {
    const harness = await createModelHarness();
    const missing = `admin-op-test/${crypto.randomUUID()}`;

    for (const name of ['model.disable', 'model.enable']) {
      const result = await runOp(harness, name, missing);
      expect(result.isErr() && result.error.code).toBe('not_found');
    }
    expect(await harness.auditCount()).toBe(0);
  });

  it('keeps the kill switch set across a refresh-shaped descriptor rewrite', async () => {
    const harness = await createModelHarness();

    const disabled = await runOp(harness, 'model.disable', harness.modelId);
    expect(disabled.isOk()).toBe(true);
    await db
      .update(modelCatalog)
      .set({ descriptor: { id: harness.modelId, refreshed: true } })
      .where(eq(modelCatalog.modelId, harness.modelId));

    expect(await harness.projection()).toEqual({
      adminDisabled: true,
      descriptor: { id: harness.modelId, refreshed: true },
    });
  });

  it('writes the model id string as the audit target on both ops', async () => {
    const harness = await createModelHarness();

    const disabled = await runOp(harness, 'model.disable', harness.modelId);
    expect(disabled.isOk()).toBe(true);
    const enabled = await runOp(harness, 'model.enable', harness.modelId);
    expect(enabled.isOk()).toBe(true);

    const rows = await db
      .select({ action: adminAudit.action })
      .from(adminAudit)
      .where(and(eq(adminAudit.targetType, 'model'), eq(adminAudit.targetId, harness.modelId)))
      .orderBy(adminAudit.createdAt);
    expect(rows.map((row) => row.action)).toEqual(['model.disable', 'model.enable']);
  });

  it('makes a disabled model findable in the audit trail by target search', async () => {
    const harness = await createModelHarness();

    const disabled = await runOp(harness, 'model.disable', harness.modelId);
    expect(disabled.isOk()).toBe(true);

    const found = await createAdminAuditReads().search(db, {
      targetType: 'model',
      targetId: harness.modelId,
      limit: 10,
    });
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]).toMatchObject({
      action: 'model.disable',
      targetType: 'model',
      targetId: harness.modelId,
    });
  });

  it('registers disable/enable as an inverse pair (Iron Law gate)', () => {
    const registry = createAdminOpRegistry<AdminModelDeps>([...adminModelOperations]);

    expect(registry.get('model.disable')?.contract.inverse).toBe('model.enable');
    expect(registry.get('model.enable')?.contract.inverse).toBe('model.disable');

    const loneDisable = adminModelOperations.filter(
      (operation) => operation.contract.name === 'model.disable'
    );
    expect(() => createAdminOpRegistry<AdminModelDeps>(loneDisable)).toThrow(
      /Reversibility Iron Law/
    );
  });
});
