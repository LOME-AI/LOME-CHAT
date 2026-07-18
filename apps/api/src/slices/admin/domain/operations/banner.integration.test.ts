import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  bannerConfig,
  createDb,
  idempotencyKeys,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS, adminOpPrefillResultSchema } from '@hushbox/shared';
import { createAnnouncementsStores } from '../../../announcements/index.js';
import { getActiveBanner } from '../../../announcements/domain/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminBannerOperations } from './index.js';
import { bannerSet } from './banner.js';
import type { BannerResponse } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingAction } from '../describe-admin-op.js';
import type { AdminBannerDeps } from './banner.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin banner op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const adminStores = createAdminStores();
const announcementsStores = createAnnouncementsStores(db);

const SET_CONTRACT = ADMIN_OP_CONTRACTS['banner.set'];

const createdUserIds: string[] = [];

/**
 * Dedicated session for the cross-file advisory lock. It must not come from
 * `db` — that pool is sized to one connection, and a permanently checked-out
 * lock client there would starve every query in the file.
 */
const lockDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

interface LockSession {
  query(text: string): Promise<unknown>;
  release(): void;
}

let lockSession: LockSession | undefined;

// `banner_config` is a global single-row table this file wipes wholesale, so
// every file that commits rows to it holds this lock for its whole duration
// (the announcements routes + adapters store suites are the other holders) —
// vitest runs files in parallel. Generous hook timeout: acquisition
// legitimately waits for a rival file's entire run.
beforeAll(async () => {
  // Checked out (never idle) so the pool cannot cull the session and
  // silently drop the lock mid-file.
  lockSession = await lockDb.$client.connect();
  await lockSession.query("select pg_advisory_lock(hashtext('announcements.banner_config'))");
}, 120_000);

beforeEach(async () => {
  await db.delete(bannerConfig);
});

afterAll(async () => {
  await db.delete(bannerConfig);
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/banner.%'));
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  // Ending the lock session is what releases the advisory lock.
  lockSession?.release();
  await lockDb.$client.end();
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

interface BannerHarness extends AdminOpHarnessInstance {
  readonly userId: string;
}

async function createBannerHarness(
  options: { hooks?: AdminOpEngineHooks } = {}
): Promise<BannerHarness> {
  const inserted = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  const user = inserted[0];
  if (user === undefined) throw new Error('banner harness: user insert returned no row');
  createdUserIds.push(user.id);
  const actor = `admin-banner-test-${crypto.randomUUID()}@hushbox.ai`;
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminBannerDeps>([...adminBannerOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: { bannerConfig: announcementsStores.config },
    executorId: `admin-banner-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    userId: user.id,
    /**
     * The Iron Law projection is the EFFECTIVE public banner (the salvaged
     * `getActiveBanner` response), not the raw row: `{enabled:true,
     * messages:[]}` and `{enabled:false, messages:[]}` render identically,
     * and the op's inverse normalizes to the disabled spelling.
     */
    projection: async (): Promise<BannerResponse> => {
      const read = await getActiveBanner(announcementsStores.config);
      return read._unsafeUnwrap().response;
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

function userOf(harness: AdminOpHarnessInstance): string {
  return (harness as BannerHarness).userId;
}

/** The public banner projection the semantics tests assert against. */
async function publicBanner(): Promise<BannerResponse> {
  const read = await getActiveBanner(announcementsStores.config);
  return read._unsafeUnwrap().response;
}

function validSetInput(): Record<string, unknown> {
  return {
    enabled: true,
    messages: [
      {
        variant: 'warning',
        text: `maintenance window ${crypto.randomUUID()}`,
        href: 'https://status.hushbox.ai/incident',
      },
    ],
    reason: `banner test ${crypto.randomUUID()}`,
  };
}

/**
 * Seeded dismissal churn: dismissing (and re-reading) the banner is the one
 * user action in the announcements domain, and it never touches the config
 * projection — proving the set/undo pair's durable delta nets to zero while
 * per-user dismissal state churns underneath.
 */
const dismissalChurnActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-dismisses-banner',
    run: async (harness, rng) => {
      const upserted = await announcementsStores.dismissals.upsertDismissal(
        userOf(harness),
        `dismissed-hash-${String(Math.floor(rng() * 1_000_000_000))}`
      );
      upserted._unsafeUnwrap();
    },
  },
  {
    name: 'user-rereads-banner',
    run: async (_harness, rng) => {
      rng();
      await publicBanner();
    },
  },
];

describeAdminOp({
  contract: SET_CONTRACT,
  createHarness: (options) => createBannerHarness(options),
  validInput: validSetInput,
  invalidInput: {
    enabled: false,
    messages: [{ variant: 'info', text: 'x', href: 'javascript:alert(1)' }],
    reason: 'x',
  },
  interleaving: {
    seeds: [7, 19, 31],
    stepsPerSeed: 4,
    opInput: () => validSetInput(),
    actions: dismissalChurnActions,
  },
});

function runSet(
  harness: BannerHarness,
  input: Record<string, unknown>,
  options?: { mode?: 'preview' | 'execute'; undoes?: string }
): ReturnType<BannerHarness['engine']['run']> {
  const mode = options?.mode ?? 'execute';
  return harness.engine.run({
    name: 'banner.set',
    input,
    actor: harness.actor,
    mode,
    ...(mode === 'execute' ? { idempotencyKey: crypto.randomUUID() } : {}),
    ...(options?.undoes === undefined ? {} : { undoes: options.undoes }),
  });
}

describe('banner.set semantics', () => {
  it('refuses an enabled banner with zero messages at preview', async () => {
    const harness = await createBannerHarness();
    const input = { enabled: true, messages: [], reason: 'enable nothing' };

    const result = await runSet(harness, input, { mode: 'preview' });

    expect(result.isErr() && result.error.code).toBe('validation');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an enabled banner with zero messages at execute with no committed effect', async () => {
    const harness = await createBannerHarness();
    const before = await harness.projection();
    const input = { enabled: true, messages: [], reason: 'enable nothing' };

    const result = await runSet(harness, input);

    expect(result.isErr() && result.error.code).toBe('validation');
    expect(await harness.projection()).toEqual(before);
    expect(await harness.auditCount()).toBe(0);
  });

  it('round-trips a message href through the jsonb row into the public read', async () => {
    const harness = await createBannerHarness();
    const href = 'https://status.hushbox.ai/incident-42';

    const result = await runSet(harness, {
      enabled: true,
      messages: [{ variant: 'critical', text: 'linked incident', href }],
      reason: 'link round-trip',
    });

    result._unsafeUnwrap();
    const response = await publicBanner();
    expect(response.messages).toEqual([{ variant: 'critical', text: 'linked incident', href }]);
    expect(response.hash).not.toBeNull();
  });

  it('round-trips a message linkText through the jsonb row into the public read', async () => {
    const harness = await createBannerHarness();

    const result = await runSet(harness, {
      enabled: true,
      messages: [
        {
          variant: 'info',
          text: 'release notes are out',
          href: 'https://hushbox.ai/changelog',
          linkText: 'Read the changelog',
        },
      ],
      reason: 'linkText round-trip',
    });

    result._unsafeUnwrap();
    const response = await publicBanner();
    expect(response.messages).toEqual([
      {
        variant: 'info',
        text: 'release notes are out',
        href: 'https://hushbox.ai/changelog',
        linkText: 'Read the changelog',
      },
    ]);
  });

  it('preserves a prior message linkText through the inverse snapshot and undo', async () => {
    const harness = await createBannerHarness();
    const priorMessage = {
      variant: 'warning',
      text: 'planned maintenance',
      href: 'https://status.hushbox.ai',
      linkText: 'Status page',
    };
    const seeded = await runSet(harness, {
      enabled: true,
      messages: [priorMessage],
      reason: 'seed prior',
    });
    seeded._unsafeUnwrap();

    const replaceResult = await runSet(harness, {
      enabled: true,
      messages: [{ variant: 'critical', text: 'incident live' }],
      reason: 'replace it',
    });
    const replaced = replaceResult._unsafeUnwrap();
    expect(replaced.inverseInput).toMatchObject({ enabled: true, messages: [priorMessage] });

    const undone = await runSet(harness, replaced.inverseInput!, {
      mode: 'execute',
      undoes: replaced.auditId,
    });
    undone._unsafeUnwrap();
    const response = await publicBanner();
    expect(response.messages).toEqual([priorMessage]);
  });

  it('snapshots a prior strict-safe href into the inverse input', async () => {
    const harness = await createBannerHarness();
    const href = 'https://hushbox.ai/changelog';
    const seeded = await runSet(harness, {
      enabled: true,
      messages: [{ variant: 'info', text: 'prior banner', href }],
      reason: 'seed prior state',
    });
    seeded._unsafeUnwrap();

    const result = await runSet(harness, {
      enabled: true,
      messages: [{ variant: 'warning', text: 'replacement banner' }],
      reason: 'replace it',
    });

    const run = result._unsafeUnwrap();
    expect(run.inverseInput).toMatchObject({
      enabled: true,
      messages: [{ variant: 'info', text: 'prior banner', href }],
    });
  });

  it('drops a legacy relative href from the inverse snapshot but keeps text and variant', async () => {
    const harness = await createBannerHarness();
    // Operator-edited legacy row: the public salvage path admits a relative
    // href, but the strict admin contract does not.
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ variant: 'warning', text: 'legacy notice', href: '/status' }],
    });

    const result = await runSet(harness, {
      enabled: false,
      messages: [],
      reason: 'take the banner down',
    });

    const run = result._unsafeUnwrap();
    expect(run.inverseInput).toMatchObject({
      enabled: true,
      messages: [{ variant: 'warning', text: 'legacy notice' }],
    });
    const inverseMessages = run.inverseInput?.['messages'] as { href?: string }[];
    expect(inverseMessages[0]).not.toHaveProperty('href');
  });

  it('normalizes an enabled prior row whose messages all salvage away to a disabled inverse', async () => {
    const harness = await createBannerHarness();
    // No usable text: the salvaging public schema drops the message, so the
    // strict inverse cannot both stay enabled and carry zero messages.
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ variant: 'info' }],
    });

    const result = await runSet(harness, validSetInput());

    const run = result._unsafeUnwrap();
    expect(run.inverseInput).toMatchObject({ enabled: false, messages: [] });
  });

  it('undo after the first-ever set restores the empty public banner', async () => {
    const harness = await createBannerHarness();

    const executeResult = await runSet(harness, validSetInput());
    const executed = executeResult._unsafeUnwrap();
    expect(executed.inverseInput).toMatchObject({ enabled: false, messages: [] });

    const undone = await runSet(harness, executed.inverseInput!, {
      mode: 'execute',
      undoes: executed.auditId,
    });

    undone._unsafeUnwrap();
    expect(await publicBanner()).toEqual({ hash: null, messages: [] });
  });

  it('prefills the current enabled config with href and linkText intact', async () => {
    const message = {
      variant: 'warning',
      text: 'planned maintenance',
      href: 'https://status.hushbox.ai',
      linkText: 'Status page',
    };
    await db.insert(bannerConfig).values({ enabled: true, messages: [message] });
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const result = await bannerSet.prefill({ bannerConfig: announcementsStores.config });

    expect(result._unsafeUnwrap()).toEqual({ enabled: true, messages: [message] });
  });

  it('prefills a disabled config as disabled with its messages retained', async () => {
    const message = { variant: 'info', text: 'draft notice' };
    await db.insert(bannerConfig).values({ enabled: false, messages: [message] });
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const result = await bannerSet.prefill({ bannerConfig: announcementsStores.config });

    expect(result._unsafeUnwrap()).toEqual({ enabled: false, messages: [message] });
  });

  it('drops a legacy relative href from the prefill but keeps text and variant', async () => {
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ variant: 'warning', text: 'legacy notice', href: '/status' }],
    });
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const result = await bannerSet.prefill({ bannerConfig: announcementsStores.config });

    const input = result._unsafeUnwrap();
    expect(input).toEqual({
      enabled: true,
      messages: [{ variant: 'warning', text: 'legacy notice' }],
    });
  });

  it('prefills the empty state when no config row exists', async () => {
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const result = await bannerSet.prefill({ bannerConfig: announcementsStores.config });

    expect(result._unsafeUnwrap()).toEqual({ enabled: false, messages: [] });
  });

  it('never includes reason in the prefill', async () => {
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ variant: 'critical', text: 'incident live', href: 'https://hushbox.ai/x' }],
    });
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const prefillResult = await bannerSet.prefill({ bannerConfig: announcementsStores.config });

    expect(prefillResult._unsafeUnwrap()).not.toHaveProperty('reason');
  });

  it('produces a prefill that parses the wire result schema', async () => {
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ variant: 'critical', text: 'incident live', href: 'https://hushbox.ai/x' }],
    });
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const prefillResult = await bannerSet.prefill({ bannerConfig: announcementsStores.config });
    const input = prefillResult._unsafeUnwrap();

    expect(adminOpPrefillResultSchema.parse({ input })).toEqual({ input });
  });

  it('turns contract-valid once a reason is added to the prefill', async () => {
    await db.insert(bannerConfig).values({
      enabled: true,
      messages: [{ variant: 'critical', text: 'incident live', href: 'https://hushbox.ai/x' }],
    });
    if (bannerSet.prefill === undefined) throw new Error('banner.set registers no prefill');

    const prefillResult = await bannerSet.prefill({ bannerConfig: announcementsStores.config });
    const input = prefillResult._unsafeUnwrap();

    expect(() => SET_CONTRACT.input.parse({ ...input, reason: 'operator-typed' })).not.toThrow();
  });

  it('registers banner.set as its own inverse (Iron Law self-inverse)', () => {
    const registry = createAdminOpRegistry<AdminBannerDeps>([...adminBannerOperations]);

    expect(registry.get('banner.set')?.contract.inverse).toBe('banner.set');
    expect(registry.list()).toHaveLength(1);
  });
});
