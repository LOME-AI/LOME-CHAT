import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, idempotencyKeys } from '@hushbox/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { err, ok } from '../../../lib/result/index.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminOpEngine, resolveClaimForExecute } from './engine.js';
import { describeAdminOp } from './describe-admin-op.js';
import {
  FIXTURE_AMOUNT_CAP_NANO_USD,
  createAdminFixtureRegistry,
  fixtureMarkContract,
  fixturePingContract,
  fixtureUnmarkContract,
} from './fixture-ops.js';
import { createAdminOpRegistry } from './registry.js';
import type { AdminOpContract } from '@hushbox/shared';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from './engine.js';
import type { AdminOpHarnessInstance } from './describe-admin-op.js';
import type { AdminFixtureDeps, AdminFixtureScratch } from './fixture-ops.js';
import type { AdminOpImplementation } from './registry.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin engine integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
// A second client (its own connection) for the fence-steal rival: the main
// client's connection is held by the in-flight settlement transaction.
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createAdminStores();

interface RecordingTelemetry {
  readonly telemetry: Telemetry;
  readonly capturedCodes: string[];
}

function createRecordingTelemetry(): RecordingTelemetry {
  const capturedCodes: string[] = [];
  const noop = (): void => undefined;
  return {
    capturedCodes,
    telemetry: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      emitMetric: noop,
      captureError: (_error, errorCode) => {
        capturedCodes.push(errorCode);
      },
    },
  };
}

const fixtureRoutes: string[] = [];

/** Durable scratch effect: one idempotency_keys row per marked target under
 * a per-harness route (the same scratch-row trick the idempotency wrapper's
 * own integration tests use — no FKs, trivially observable). */
function createScratch(route: string): AdminFixtureScratch {
  return {
    async markWithinTx(tx, targetId): Promise<'marked' | 'already-marked'> {
      const writer = tx as DbTransaction;
      const existing = await writer
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, targetId)));
      if (existing.length > 0) return 'already-marked';
      await writer.insert(idempotencyKeys).values({
        userId: targetId,
        route,
        key: targetId,
        kind: 'request',
        bodyHash: 'fixture',
        claimedBy: 'fixture',
      });
      return 'marked';
    },
    async unmarkWithinTx(tx, targetId): Promise<void> {
      const writer = tx as DbTransaction;
      await writer
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, targetId)));
    },
  };
}

interface FixtureHarness extends AdminOpHarnessInstance {
  readonly deps: AdminFixtureDeps;
  readonly recording: RecordingTelemetry;
  readonly route: string;
}

function createFixtureHarness(options: { hooks?: AdminOpEngineHooks } = {}): FixtureHarness {
  const route = `/admin-fixture/${crypto.randomUUID()}`;
  fixtureRoutes.push(route);
  const actor = `admin-engine-test-${crypto.randomUUID()}@hushbox.ai`;
  const deps: AdminFixtureDeps = {
    scratch: createScratch(route),
    ephemeralLog: [],
    ephemeralFailure: { armed: false },
  };
  const recording = createRecordingTelemetry();
  const engine = createAdminOpEngine({
    db,
    registry: createAdminFixtureRegistry(),
    stores,
    telemetry: recording.telemetry,
    opDeps: deps,
    executorId: `admin-engine-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    deps,
    recording,
    route,
    projection: async (): Promise<readonly string[]> => {
      const rows = await db
        .select({ key: idempotencyKeys.key })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.route, route));
      return rows.map((row) => row.key).toSorted((a, b) => a.localeCompare(b));
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: () => deps.ephemeralLog,
      armFailure: () => {
        deps.ephemeralFailure.armed = true;
      },
    },
  };
}

afterAll(async () => {
  // admin_audit is append-only by trigger — audit rows stay (actor-isolated);
  // the scratch and engine-claim key rows are removed.
  for (const route of fixtureRoutes) {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.route, route));
  }
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/fixture.%'));
});

function validMarkInput(): Record<string, unknown> {
  return {
    targetId: crypto.randomUUID(),
    amountNanoUsd: '1000',
    reason: 'engine integration test',
  };
}

// The reusable battery, proven against the durable fixture pair…
describeAdminOp({
  contract: fixtureMarkContract,
  createHarness: (options) => Promise.resolve(createFixtureHarness(options)),
  validInput: validMarkInput,
  invalidInput: { targetId: 'not-a-uuid', amountNanoUsd: '1000', reason: 'x' },
  overGuardrailInput: () => ({
    targetId: crypto.randomUUID(),
    amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
    reason: 'over the cap',
  }),
  hasEphemeralEffects: true,
});

// …and against the ephemeral fixture op (no inverse, post-commit effect only).
describeAdminOp({
  contract: fixturePingContract,
  createHarness: (options) => Promise.resolve(createFixtureHarness(options)),
  validInput: () => ({ targetId: crypto.randomUUID(), reason: 'ping test' }),
  invalidInput: { targetId: 'not-a-uuid', reason: 'x' },
  hasEphemeralEffects: true,
});

// …and against the inverse direction (unmark), whose harness pre-marks the
// target so undo (re-mark) nets the projection back to the marked baseline.
const unmarkTarget = { current: '' };
describeAdminOp({
  contract: fixtureUnmarkContract,
  createHarness: async (options) => {
    const harness = createFixtureHarness(options);
    unmarkTarget.current = crypto.randomUUID();
    await db.insert(idempotencyKeys).values({
      userId: unmarkTarget.current,
      route: harness.route,
      key: unmarkTarget.current,
      kind: 'request',
      bodyHash: 'fixture',
      claimedBy: 'fixture',
    });
    return harness;
  },
  validInput: () => ({
    targetId: unmarkTarget.current,
    amountNanoUsd: '1000',
    reason: 'unmark test',
  }),
  invalidInput: { targetId: 'not-a-uuid', amountNanoUsd: '1000', reason: 'x' },
  overGuardrailInput: () => ({
    targetId: unmarkTarget.current,
    amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
    reason: 'over the cap',
  }),
});

describe('createAdminOpEngine.run', () => {
  it('refuses an unregistered op name', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.unknown',
      input: {},
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
  });

  it('requires an idempotency key in execute mode', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
    });

    expect(result.isErr() && result.error.code).toBe('validation');
  });

  it('passes an op-body domain refusal through and commits nothing', async () => {
    const harness = createFixtureHarness();
    const input = validMarkInput();
    const first = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(first.isOk()).toBe(true);

    // Same target, fresh key: the op body itself refuses (already marked).
    const second = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(second.isErr() && second.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(1);
    expect(await harness.projection()).toEqual([input['targetId']]);
  });

  it('refuses a reused key with a different body', async () => {
    const harness = createFixtureHarness();
    const key = crypto.randomUUID();
    const first = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: key,
    });
    expect(first.isOk()).toBe(true);

    const second = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: key,
    });

    expect(second.isErr() && second.error.code).toBe('conflict');
  });

  it('audits the guardrail refusal with the violated field', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: {
        targetId: crypto.randomUUID(),
        amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
        reason: 'over the cap',
      },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    const rows = await db.select().from(adminAudit).where(eq(adminAudit.actor, harness.actor));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({ refusal: 'amountNanoUsd exceeds maxAmountNanoUsd' });
  });

  it('captures a failed ephemeral effect without failing the op', async () => {
    const harness = createFixtureHarness();
    harness.deps.ephemeralFailure.armed = true;

    const result = await harness.engine.run({
      name: 'fixture.ping',
      input: { targetId: crypto.randomUUID(), reason: 'ping' },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isOk()).toBe(true);
    expect(harness.recording.capturedCodes).toEqual(['admin_ephemeral_effect_failed']);
  });

  it('rejects a read-kind contract as a wiring defect', async () => {
    const readContract: AdminOpContract = {
      name: 'fixture.read',
      title: 'Fixture read',
      kind: 'read',
      input: z.object({}),
      inverse: null,
      effectClass: 'ephemeral',
    };
    const implementation: AdminOpImplementation<Record<string, never>> = {
      contract: readContract,
      execute: () => Promise.resolve(ok({ effects: [] })),
    };
    const recording = createRecordingTelemetry();
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry([implementation]),
      stores,
      telemetry: recording.telemetry,
      opDeps: {},
      executorId: 'defect-test',
    });

    await expect(
      engine.run({ name: 'fixture.read', input: {}, actor: 'defect@hushbox.ai', mode: 'preview' })
    ).rejects.toThrow(/not a mutation/);
  });

  it('rejects a durable op returning no inverseInput as a defect (Iron Law)', async () => {
    const engine = craftedDurableEngine(() => Promise.resolve(ok({ effects: [{ label: 'x' }] })));

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor: 'defect@hushbox.ai',
        mode: 'preview',
      })
    ).rejects.toThrow(/inverseInput/);
  });

  it('rejects non-JSON audit details as a defect', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(
        ok({
          effects: [{ label: 'x' }],
          inverseInput: { amount: 5n as unknown as string },
        })
      )
    );

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor: 'defect@hushbox.ai',
        mode: 'preview',
      })
    ).rejects.toThrow(/non-JSON audit details/);
  });

  it('previews a crafted op with no declared target (nullable audit target)', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(ok({ effects: [{ label: 'targetless' }], inverseInput: {} }))
    );

    const result = await engine.run({
      name: 'fixture.lawless',
      input: { targetId: crypto.randomUUID(), reason: 'x' },
      actor: 'defect@hushbox.ai',
      mode: 'preview',
    });

    expect(result.isOk() && result.value.effects).toEqual([{ label: 'targetless' }]);
  });

  it('answers in-progress when a rival steals the completion fence mid-run', async () => {
    const key = crypto.randomUUID();
    const scopeRoute = 'admin/ops/fixture.mark';
    const harness = createFixtureHarness({
      hooks: {
        // Runs inside the settlement transaction, before the key-row flip:
        // a rival re-claim bumps `claims`, so the fence write finds 0 rows.
        afterAudit: async () => {
          await rival
            .update(idempotencyKeys)
            .set({ claims: 2, claimedBy: 'rival' })
            .where(and(eq(idempotencyKeys.route, scopeRoute), eq(idempotencyKeys.key, key)));
        },
      },
    });
    const before = await harness.projection();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: key,
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.projection()).toEqual(before);
    expect(await harness.auditCount()).toBe(0);
  });

  it('surfaces an op-body preview refusal without committing anything', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(err({ code: 'forbidden', message: 'refused by the op body' }))
    );

    const result = await engine.run({
      name: 'fixture.lawless',
      input: { targetId: crypto.randomUUID(), reason: 'x' },
      actor: 'defect@hushbox.ai',
      mode: 'preview',
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
  });
});

describe('undo target validation', () => {
  async function executedMark(
    harness: FixtureHarness
  ): Promise<{ auditId: string; input: Record<string, unknown> }> {
    const input = validMarkInput();
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });
    return { auditId: result._unsafeUnwrap().auditId, input };
  }

  it('refuses an undo whose op is not the registered inverse of the target action', async () => {
    const harness = createFixtureHarness();
    const { auditId } = await executedMark(harness);

    // fixture.mark's registered inverse is fixture.unmark — running mark
    // itself as the undo is a wrong-op target.
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(1);
  });

  it('refuses an undo targeting a guardrail-refusal audit row', async () => {
    const harness = createFixtureHarness();
    const refused = await harness.engine.run({
      name: 'fixture.mark',
      input: {
        targetId: crypto.randomUUID(),
        amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
        reason: 'over the cap',
      },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(refused.isErr()).toBe(true);
    const rows = await db
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    const refusalAuditId = rows[0]?.id;
    if (refusalAuditId === undefined) throw new Error('expected a refusal audit row');

    // fixture.unmark IS fixture.mark's registered inverse — only the target
    // row's shape (a refusal, no executed effect) makes this undo invalid.
    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
      undoes: refusalAuditId,
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(1);
  });

  it('refuses an undo of a nonexistent audit id with the typed not-found error', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
      undoes: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses a malformed undo target id as validation, never a database defect', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
      undoes: 'not-a-uuid',
    });

    expect(result.isErr() && result.error.code).toBe('validation');
    expect(await harness.auditCount()).toBe(0);
  });

  it('permits undoing an undo row — redo via the inverse chain', async () => {
    const harness = createFixtureHarness();
    const { auditId, input } = await executedMark(harness);
    const undone = await harness.engine.run({
      name: 'fixture.unmark',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });
    const undoAuditId = undone._unsafeUnwrap().auditId;

    const redone = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
      undoes: undoAuditId,
    });

    expect(redone.isOk()).toBe(true);
    expect(await harness.projection()).toEqual([input['targetId']]);
    expect(await harness.auditCount()).toBe(3);
  });
});

describe('audit details input shape', () => {
  it('stores only the contract schema’s known input keys in the executed audit row', async () => {
    const harness = createFixtureHarness();
    const base = validMarkInput();
    const input = { ...base, sneaky: 'unvalidated payload' };

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isOk()).toBe(true);
    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    const details = rows[0]?.details as { input: Record<string, unknown> };
    expect(details.input).not.toHaveProperty('sneaky');
    expect(details.input).toMatchObject({
      targetId: base['targetId'],
      amountNanoUsd: '1000',
      reason: 'engine integration test',
    });
  });

  it('stores only known input keys in a guardrail-refusal audit row', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: {
        targetId: crypto.randomUUID(),
        amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
        reason: 'over the cap',
        sneaky: 'unvalidated payload',
      },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr()).toBe(true);
    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    const details = rows[0]?.details as { input: Record<string, unknown> };
    expect(details.input).not.toHaveProperty('sneaky');
    expect(details.input).toHaveProperty('reason', 'over the cap');
  });
});

describe('resolveClaimForExecute', () => {
  it('throws on an attach outcome (request-kind claims never attach)', () => {
    const row = { id: crypto.randomUUID(), claims: 1 } as never;

    expect(() => resolveClaimForExecute({ outcome: 'attach', row }, 'executor')).toThrow(/attach/);
  });
});

/** A durable pair whose primary body is crafted per test (defect probes). */
function craftedDurableEngine(
  execute: AdminOpImplementation<Record<string, never>>['execute']
): ReturnType<typeof createAdminOpEngine<Record<string, never>>> {
  const reason = z.string().trim().min(1);
  const input = z.object({ targetId: z.uuid(), reason });
  const lawless: AdminOpContract = {
    name: 'fixture.lawless',
    title: 'Crafted durable op',
    kind: 'mutation',
    input,
    inverse: 'fixture.lawless-inverse',
    effectClass: 'durable',
  };
  const inverse: AdminOpContract = {
    name: 'fixture.lawless-inverse',
    title: 'Crafted inverse',
    kind: 'mutation',
    input,
    inverse: 'fixture.lawless',
    effectClass: 'durable',
  };
  const inverseExecute: AdminOpImplementation<Record<string, never>>['execute'] = () =>
    Promise.resolve(ok({ effects: [{ label: 'inverse' }], inverseInput: {} }));
  return createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<Record<string, never>>([
      { contract: lawless, execute },
      { contract: inverse, execute: inverseExecute },
    ]),
    stores,
    telemetry: createRecordingTelemetry().telemetry,
    opDeps: {},
    executorId: 'crafted-test',
  });
}
