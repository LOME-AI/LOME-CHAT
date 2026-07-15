import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  jobs,
  users,
} from '@hushbox/db';
import { lockedUserFactory, userFactory } from '@hushbox/db/factories';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import {
  checkSessionLiveness,
  createIdentityStores,
  createSessionRevokeJobRegistration,
  issueSession,
  revokeAllSessions,
} from '../../../identity/index.js';
import { createAppJobRegistry } from '../../../../lib/jobs/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminUserOperations } from './index.js';
import type { EvictUserPort } from '../../../identity/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingAction } from '../describe-admin-op.js';
import type { AdminUserDeps } from './user.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Redis env are required for admin user op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const identityStores = createIdentityStores(db);
const adminStores = createAdminStores();
const SESSION_SECRET = 'secret-at-least-32-characters-long!!';

const LOCK_CONTRACT = ADMIN_OP_CONTRACTS['user.lock'];
const UNLOCK_CONTRACT = ADMIN_OP_CONTRACTS['user.unlock'];
const REVOKE_ALL_CONTRACT = ADMIN_OP_CONTRACTS['sessions.revokeAll'];

/** Every user the harnesses create — their enqueued revoke jobs are cleared below. */
const createdUserIds: string[] = [];

afterAll(async () => {
  // admin_audit is append-only (actor-isolated); user rows are uuid-isolated.
  // Only the engine-claim key rows are removed; the session keys carry TTLs.
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/user.%'));
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/sessions.%'));
  // The lock/revokeAll ops commit session.revoke.v1 rows (bulk shard); clear
  // them so they never linger claimable on the shared jobs table.
  if (createdUserIds.length > 0) {
    await db.delete(jobs).where(
      inArray(
        jobs.dedupeKey,
        createdUserIds.map((id) => `session-revoke:${id}`)
      )
    );
  }
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

interface EvictProbeState {
  readonly evicted: string[];
  armed: boolean;
}

/**
 * The ops' post-commit ephemeral seam: a recording eviction port that logs
 * each landed eviction and, when armed, rejects before recording (so the
 * battery can prove an ephemeral failure never fails the committed op).
 */
function probeEvict(state: EvictProbeState): EvictUserPort {
  return {
    evictUser: (userId: string): Promise<void> => {
      if (state.armed) return Promise.reject(new Error('evict probe armed to fail'));
      state.evicted.push(userId);
      return Promise.resolve();
    },
  };
}

interface UserHarness extends AdminOpHarnessInstance {
  readonly userId: string;
  readonly evicted: string[];
  /** The enqueued session.revoke.v1 row for this user, or undefined if none. */
  enqueuedRevoke(): Promise<{ type: string; shard: string } | undefined>;
  /** Runs the enqueued revoke job's handler — the work the dispatcher performs. */
  runEnqueuedRevoke(): Promise<void>;
}

async function createUserHarness(
  options: { hooks?: AdminOpEngineHooks } = {},
  seed: { locked?: boolean; lockReason?: 'chargeback' | 'admin' } = {}
): Promise<UserHarness> {
  const values =
    seed.locked === true
      ? lockedUserFactory.build({ lockReason: seed.lockReason ?? 'chargeback' })
      : userFactory.build();
  const [user] = await db.insert(users).values(values).returning({ id: users.id });
  if (user === undefined) throw new Error('user harness: user insert returned no row');
  createdUserIds.push(user.id);
  const actor = `admin-user-test-${crypto.randomUUID()}@hushbox.ai`;
  const probe: EvictProbeState = { evicted: [], armed: false };
  const evictPort = probeEvict(probe);
  // The durable revocation cutoff runs through this registration (real Redis
  // watermark bump), exactly as the live dispatcher would; the op only enqueues
  // it in-tx. The eviction port is shared so the job's best-effort eviction and
  // the op's prompt one land in one recorded log.
  const sessionRevokeRegistration = createSessionRevokeJobRegistration({
    redis,
    evictUser: evictPort,
    now: () => Date.now(),
  });
  const jobRegistry = createAppJobRegistry([sessionRevokeRegistration]);
  const deps: AdminUserDeps = {
    identityStores,
    jobRegistry,
    evictUser: evictPort,
  };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminUserDeps>([...adminUserOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    executorId: `admin-user-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    userId: user.id,
    evicted: probe.evicted,
    projection: async (): Promise<{ locked: boolean; lockReason: string | null }> => {
      const rows = await db
        .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
        .from(users)
        .where(eq(users.id, user.id));
      const row = rows[0];
      if (row === undefined) throw new Error('user harness: projection user is gone');
      return { locked: row.lockedAt !== null, lockReason: row.lockReason };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    enqueuedRevoke: async (): Promise<{ type: string; shard: string } | undefined> => {
      const rows = await db
        .select({ type: jobs.type, shard: jobs.shard })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `session-revoke:${user.id}`));
      return rows[0];
    },
    runEnqueuedRevoke: async (): Promise<void> => {
      const rows = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.dedupeKey, `session-revoke:${user.id}`));
      const row = rows[0];
      if (row === undefined) throw new Error('user harness: no session.revoke.v1 job enqueued');
      await sessionRevokeRegistration.handler({
        jobId: row.id,
        payload: { userId: user.id },
        claims: 1,
        heartbeat: () => Promise.reject(new Error('heartbeat unexpectedly invoked')),
        completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
      });
    },
    ephemeral: {
      log: () => probe.evicted,
      armFailure: () => {
        probe.armed = true;
      },
    },
  };
}

function userOf(harness: AdminOpHarnessInstance): string {
  return (harness as UserHarness).userId;
}

async function livenessOf(inputs: {
  userId: string;
  sessionId: string;
  createdAt: number;
}): Promise<'active' | 'revoked'> {
  const result = await checkSessionLiveness(redis, inputs);
  return result._unsafeUnwrap();
}

async function issueFullSession(userId: string, createdAt: number): Promise<string> {
  const result = await issueSession({
    request: new Request('http://localhost/auth/login/finish'),
    response: new Response(),
    redis,
    secret: SESSION_SECRET,
    isProduction: false,
    userId,
    kind: 'full',
    now: createdAt,
  });
  return result._unsafeUnwrap().sessionId;
}

/**
 * Seeded session-churn interleavings. Lock state (the projection) is durable
 * and admin-owned; session activity is the ephemeral state `user.lock`'s
 * containment touches — churning it between op and undo proves the pair's
 * durable delta nets to zero regardless. A chargeback-lock action is
 * deliberately excluded: it is a non-commutative write to the same flag the
 * op owns (the Charter's feasibility rule excludes conflicting actions).
 */
const sessionChurnActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-logs-in',
    run: async (harness, rng) => {
      await issueFullSession(userOf(harness), Date.now() + Math.floor(rng() * 10_000));
    },
  },
  {
    name: 'user-logs-out-everywhere',
    run: async (harness, rng) => {
      const revoked = await revokeAllSessions(
        redis,
        userOf(harness),
        Date.now() + Math.floor(rng() * 10_000)
      );
      revoked._unsafeUnwrap();
    },
  },
];

const lockTarget = { userId: '' };
describeAdminOp({
  contract: LOCK_CONTRACT,
  createHarness: async (options) => {
    const harness = await createUserHarness(options);
    lockTarget.userId = harness.userId;
    return harness;
  },
  validInput: () => ({
    userId: lockTarget.userId,
    lockReason: 'admin',
    reason: `contain account ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', lockReason: 'admin', reason: 'x' },
  hasEphemeralEffects: true,
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      userId: userOf(harness),
      lockReason: 'admin',
      reason: `interleaving lock ${crypto.randomUUID()}`,
    }),
    actions: sessionChurnActions,
  },
});

const unlockTarget = { userId: '' };
describeAdminOp({
  contract: UNLOCK_CONTRACT,
  createHarness: async (options) => {
    const harness = await createUserHarness(options, { locked: true, lockReason: 'chargeback' });
    unlockTarget.userId = harness.userId;
    return harness;
  },
  validInput: () => ({
    userId: unlockTarget.userId,
    reason: `dispute resolved ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', reason: 'x' },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      userId: userOf(harness),
      reason: `interleaving unlock ${crypto.randomUUID()}`,
    }),
    actions: sessionChurnActions,
  },
});

const revokeAllTarget = { userId: '' };
describeAdminOp({
  contract: REVOKE_ALL_CONTRACT,
  createHarness: async (options) => {
    const harness = await createUserHarness(options);
    revokeAllTarget.userId = harness.userId;
    return harness;
  },
  validInput: () => ({
    userId: revokeAllTarget.userId,
    reason: `suspected session theft ${crypto.randomUUID()}`,
  }),
  invalidInput: { userId: 'not-a-uuid', reason: 'x' },
  hasEphemeralEffects: true,
});

async function executeOk(
  harness: UserHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): Promise<{ auditId: string; inverseInput: Record<string, unknown> | null }> {
  const result = await harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
    ...(undoes === undefined ? {} : { undoes }),
  });
  return result._unsafeUnwrap();
}

describe('user.lock / user.unlock / sessions.revokeAll semantics', () => {
  it('kills a live session at the next request when the user is locked (full containment)', async () => {
    const harness = await createUserHarness();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(harness.userId, createdAt);
    const inputs = { userId: harness.userId, sessionId, createdAt };
    expect(await livenessOf(inputs)).toBe('active');

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'containment probe',
    });

    // The durable cutoff is the enqueued session.revoke.v1 job (committed in the
    // settlement tx), not a post-commit watermark bump — so the session stays
    // live until the job runs; the ephemeral evicted the socket for promptness.
    expect(harness.evicted).toEqual([harness.userId]);
    expect(await harness.enqueuedRevoke()).toEqual({ type: 'session.revoke.v1', shard: 'bulk' });
    expect(await livenessOf(inputs)).toBe('active');

    // The dispatcher runs the job: its watermark bump is what revokes the session.
    await harness.runEnqueuedRevoke();
    expect(await livenessOf(inputs)).toBe('revoked');
  });

  it('enqueues the session.revoke.v1 cutoff in the settlement tx and never in preview', async () => {
    const harness = await createUserHarness();

    const previewed = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'preview only' },
      actor: harness.actor,
      mode: 'preview',
    });
    previewed._unsafeUnwrap();
    expect(await harness.enqueuedRevoke()).toBeUndefined();

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'commit the lock',
    });
    expect(await harness.enqueuedRevoke()).toEqual({ type: 'session.revoke.v1', shard: 'bulk' });
  });

  it('restores the ORIGINAL lock reason when an unlock is undone (chargeback, not admin)', async () => {
    const harness = await createUserHarness({}, { locked: true, lockReason: 'chargeback' });

    const unlocked = await executeOk(harness, 'user.unlock', {
      userId: harness.userId,
      reason: 'dispute resolved',
    });
    expect(await harness.projection()).toEqual({ locked: false, lockReason: null });
    if (unlocked.inverseInput === null) throw new Error('expected inverseInput');
    expect(unlocked.inverseInput['lockReason']).toBe('chargeback');

    await executeOk(harness, 'user.lock', unlocked.inverseInput, unlocked.auditId);

    expect(await harness.projection()).toEqual({ locked: true, lockReason: 'chargeback' });
  });

  it('refuses to clobber a standing lock — already-locked is a conflict, nothing committed', async () => {
    const harness = await createUserHarness({}, { locked: true, lockReason: 'chargeback' });

    const result = await harness.engine.run({
      name: 'user.lock',
      input: { userId: harness.userId, lockReason: 'admin', reason: 'double lock' },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.projection()).toEqual({ locked: true, lockReason: 'chargeback' });
    expect(await harness.auditCount()).toBe(0);
    // A refused lock commits nothing — no revoke job is enqueued.
    expect(await harness.enqueuedRevoke()).toBeUndefined();
  });

  it('refuses to unlock an unlocked user with a typed conflict', async () => {
    const harness = await createUserHarness();

    const result = await harness.engine.run({
      name: 'user.unlock',
      input: { userId: harness.userId, reason: 'nothing to unlock' },
      actor: harness.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an unknown user with a typed not-found on every user op', async () => {
    const harness = await createUserHarness();
    const missing = crypto.randomUUID();
    const attempts: [string, Record<string, unknown>][] = [
      ['user.lock', { userId: missing, lockReason: 'admin', reason: 'missing' }],
      ['user.unlock', { userId: missing, reason: 'missing' }],
      ['sessions.revokeAll', { userId: missing, reason: 'missing' }],
    ];

    for (const [name, input] of attempts) {
      const result = await harness.engine.run({
        name,
        input,
        actor: harness.actor,
        mode: 'execute',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(result.isErr() && result.error.code).toBe('not_found');
    }
    expect(await harness.auditCount()).toBe(0);
  });

  it('does not restore sessions on unlock — a lock-revoked session stays dead', async () => {
    const harness = await createUserHarness();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(harness.userId, createdAt);
    const inputs = { userId: harness.userId, sessionId, createdAt };

    await executeOk(harness, 'user.lock', {
      userId: harness.userId,
      lockReason: 'admin',
      reason: 'lock first',
    });
    await harness.runEnqueuedRevoke();
    await executeOk(harness, 'user.unlock', {
      userId: harness.userId,
      reason: 'unlock after',
    });

    expect(await livenessOf(inputs)).toBe('revoked');
  });

  it('sessions.revokeAll kills a live session through the durable job and evicts best-effort', async () => {
    const harness = await createUserHarness();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(harness.userId, createdAt);
    const inputs = { userId: harness.userId, sessionId, createdAt };
    expect(await livenessOf(inputs)).toBe('active');

    const executed = await executeOk(harness, 'sessions.revokeAll', {
      userId: harness.userId,
      reason: 'revoke everything',
    });

    expect(executed.inverseInput).toBeNull();
    expect(harness.evicted).toEqual([harness.userId]);
    expect(await harness.enqueuedRevoke()).toEqual({ type: 'session.revoke.v1', shard: 'bulk' });
    await harness.runEnqueuedRevoke();
    expect(await livenessOf(inputs)).toBe('revoked');
    expect(await harness.projection()).toEqual({ locked: false, lockReason: null });
  });

  it('registers lock/unlock as an inverse pair and revokeAll alone (Iron Law gate)', () => {
    const registry = createAdminOpRegistry<AdminUserDeps>([...adminUserOperations]);

    expect(registry.get('user.lock')?.contract.inverse).toBe('user.unlock');
    expect(registry.get('user.unlock')?.contract.inverse).toBe('user.lock');
    expect(registry.get('sessions.revokeAll')?.contract.inverse).toBeNull();

    const loneLock = adminUserOperations.filter(
      (operation) => operation.contract.name === 'user.lock'
    );
    expect(() => createAdminOpRegistry<AdminUserDeps>(loneLock)).toThrow(/Reversibility Iron Law/);
  });
});
