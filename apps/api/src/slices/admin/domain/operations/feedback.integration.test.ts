import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  feedback,
  idempotencyKeys,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminFeedbackOperations } from './index.js';
import type { FeedbackStatus } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type {
  AdminOpHarnessInstance,
  AdminOpInterleavingAction,
  AdminOpInterleavingConfig,
} from '../describe-admin-op.js';
import type { AdminFeedbackDeps } from './feedback.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin feedback op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const adminStores = createAdminStores();

const SET_STATUS_CONTRACT = ADMIN_OP_CONTRACTS['feedback.setStatus'];

afterAll(async () => {
  // Users/feedback rows are uuid-isolated (feedback cascades on the user);
  // only the engine's key rows need explicit removal.
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/feedback.%'));
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

interface FeedbackHarness extends AdminOpHarnessInstance {
  readonly feedbackId: string;
}

async function createFeedbackHarness(
  options: { hooks?: AdminOpEngineHooks } = {}
): Promise<FeedbackHarness> {
  const inserted = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  const user = inserted[0];
  if (user === undefined) throw new Error('feedback harness: user insert returned no row');
  const seeded = await db
    .insert(feedback)
    .values({ userId: user.id, kind: 'bug', body: 'triage me', status: 'new' })
    .returning({ id: feedback.id });
  const row = seeded[0];
  if (row === undefined) throw new Error('feedback harness: feedback insert returned no row');
  const actor = `admin-feedback-test-${crypto.randomUUID()}@hushbox.ai`;
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminFeedbackDeps>([...adminFeedbackOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: {},
    executorId: `admin-feedback-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    feedbackId: row.id,
    /** The Iron Law projection: the triage status of THIS harness's row. */
    projection: async (): Promise<{ status: FeedbackStatus }> => {
      const rows = await db
        .select({ status: feedback.status })
        .from(feedback)
        .where(eq(feedback.id, row.id));
      const found = rows[0];
      if (found === undefined) throw new Error('feedback harness: projection row is gone');
      return { status: found.status };
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

/**
 * Interleaving `U₁…Uₙ` actions for setStatus. Status is last-write-wins, not
 * additive, so an action that rewrote THIS row's status would make the op's
 * undo legitimately clobber it (a feasibility divergence the Iron Law
 * accepts) — the invariant-preserving actions are ones orthogonal to the
 * projection: other users submitting their own feedback, which never touches
 * the harness row's status.
 */
const feedbackInterleavingActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-submits-feedback',
    run: async (): Promise<void> => {
      const inserted = await db
        .insert(users)
        .values(userFactory.build())
        .returning({ id: users.id });
      const other = inserted[0];
      if (other === undefined) {
        throw new Error('feedback interleaving: user insert returned no row');
      }
      await db
        .insert(feedback)
        .values({ userId: other.id, kind: 'idea', body: 'unrelated feedback', status: 'new' });
    },
  },
];

function feedbackInterleavingConfig(): AdminOpInterleavingConfig {
  return {
    seeds: [13, 31, 59],
    stepsPerSeed: 5,
    opInput: (harness) => ({
      feedbackId: (harness as FeedbackHarness).feedbackId,
      status: 'triaged',
      reason: `interleaving triage ${crypto.randomUUID()}`,
    }),
    actions: feedbackInterleavingActions,
  };
}

const setStatusTarget = { feedbackId: '' };
describeAdminOp({
  contract: SET_STATUS_CONTRACT,
  createHarness: async (options) => {
    const harness = await createFeedbackHarness(options);
    setStatusTarget.feedbackId = harness.feedbackId;
    return harness;
  },
  validInput: () => ({
    feedbackId: setStatusTarget.feedbackId,
    status: 'triaged',
    reason: `triaging ${crypto.randomUUID()}`,
  }),
  invalidInput: { feedbackId: 'not-a-uuid', status: 'triaged', reason: 'x' },
  interleaving: feedbackInterleavingConfig(),
});

function runSetStatus(
  harness: FeedbackHarness,
  feedbackId: string,
  status: FeedbackStatus
): ReturnType<FeedbackHarness['engine']['run']> {
  return harness.engine.run({
    name: 'feedback.setStatus',
    input: { feedbackId, status, reason: `semantic probe ${crypto.randomUUID()}` },
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
  });
}

describe('feedback.setStatus semantics', () => {
  it('flips the status and snapshots the prior status into the inverse input', async () => {
    const harness = await createFeedbackHarness();

    const result = await runSetStatus(harness, harness.feedbackId, 'resolved');

    const run = result._unsafeUnwrap();
    expect(run.effects).toEqual([{ label: 'feedback.status', before: 'new', after: 'resolved' }]);
    // Inverse snapshot semantics: the inverse re-sets the PRIOR status, so an
    // undo restores 'new', not a default — the op is its own registered inverse.
    expect(run.inverseInput).toMatchObject({ feedbackId: harness.feedbackId, status: 'new' });
    expect(await harness.projection()).toEqual({ status: 'resolved' });
  });

  it('refuses an unknown feedback id with a typed not-found and no audit row', async () => {
    const harness = await createFeedbackHarness();

    const result = await runSetStatus(harness, crypto.randomUUID(), 'triaged');

    expect(result.isErr() && result.error.code).toBe('not_found');
    expect(await harness.auditCount()).toBe(0);
  });

  it('registers feedback.setStatus as its own inverse (Iron Law self-inverse)', () => {
    const registry = createAdminOpRegistry<AdminFeedbackDeps>([...adminFeedbackOperations]);

    expect(registry.get('feedback.setStatus')?.contract.inverse).toBe('feedback.setStatus');
    expect(registry.list()).toHaveLength(1);
  });
});
