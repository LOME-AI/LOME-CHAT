import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  conversationMembers,
  conversations,
  createDb,
  idempotencyKeys,
  sharedLinks,
  users,
} from '@hushbox/db';
import {
  placeholderBytes,
  revokedSharedLinkFactory,
  sharedLinkFactory,
  userFactory,
} from '@hushbox/db/factories';
import { eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { createConversationsStores } from '../../../conversations/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminShareOperations } from './index.js';
import type { MembershipRevoker, RealtimeBroadcast } from '../../../conversations/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from '../engine.js';
import type { AdminOpHarnessInstance, AdminOpInterleavingConfig } from '../describe-admin-op.js';
import type { AdminShareDeps } from './share.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin share op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const adminStores = createAdminStores();

const REVOKE_CONTRACT = ADMIN_OP_CONTRACTS['share.revoke'];
const UNREVOKE_CONTRACT = ADMIN_OP_CONTRACTS['share.unrevoke'];

afterAll(async () => {
  // Users/conversations/links are uuid-isolated; only engine key rows go.
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/share.%'));
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

interface EvictionProbeState {
  readonly log: string[];
  readonly invalidated: string[];
  armed: boolean;
}

function probeRevoker(state: EvictionProbeState): MembershipRevoker {
  return {
    invalidate: (conversationId, principalId) => {
      if (state.armed) {
        return errAsync(unavailableError('eviction probe armed to fail'));
      }
      state.invalidated.push(`${conversationId}:${principalId}`);
      return okAsync();
    },
  };
}

function probeRealtime(state: EvictionProbeState): RealtimeBroadcast {
  const unexpected = (method: string) => (): never => {
    throw new Error(`${method} unexpectedly invoked by a share op`);
  };
  return {
    broadcast: unexpected('broadcast'),
    presence: unexpected('presence'),
    startRun: unexpected('startRun'),
    stopRun: unexpected('stopRun'),
    upgrade: unexpected('upgrade'),
    evict: (conversationId, principalId) => {
      state.log.push(`${conversationId}:${principalId}`);
      return okAsync(1);
    },
  };
}

interface ShareHarness extends AdminOpHarnessInstance {
  readonly conversationId: string;
  readonly linkId: string;
  readonly evictions: readonly string[];
  readonly invalidations: readonly string[];
}

async function createShareHarness(
  options: { hooks?: AdminOpEngineHooks } = {},
  seed: { revoked?: boolean; seatGuest?: boolean } = {}
): Promise<ShareHarness> {
  const [owner] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (owner === undefined) throw new Error('share harness: owner insert returned no row');
  const [conversation] = await db
    .insert(conversations)
    .values({ userId: owner.id, title: placeholderBytes(16) })
    .returning({ id: conversations.id });
  if (conversation === undefined) throw new Error('share harness: conversation insert failed');
  const linkValues =
    seed.revoked === true
      ? revokedSharedLinkFactory.build({ conversationId: conversation.id })
      : sharedLinkFactory.build({ conversationId: conversation.id });
  const [link] = await db.insert(sharedLinks).values(linkValues).returning({ id: sharedLinks.id });
  if (link === undefined) throw new Error('share harness: link insert failed');
  if (seed.seatGuest === true) {
    await db.insert(conversationMembers).values({
      conversationId: conversation.id,
      linkId: link.id,
      visibleFromEpoch: 1,
    });
  }
  const actor = `admin-share-test-${crypto.randomUUID()}@hushbox.ai`;
  const probe: EvictionProbeState = { log: [], invalidated: [], armed: false };
  const deps: AdminShareDeps = {
    conversationsStores: createConversationsStores,
    membershipRevoker: probeRevoker(probe),
    realtime: probeRealtime(probe),
  };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminShareDeps>([...adminShareOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    executorId: `admin-share-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    conversationId: conversation.id,
    linkId: link.id,
    evictions: probe.log,
    invalidations: probe.invalidated,
    /** Share validity (the Iron Law projection). Guest membership is
     * deliberately excluded: admin revoke departs the guest and unrevoke
     * restores AUTHORIZATION only — re-entry is the normal link flow
     * (founder-settled authorization-only semantics). */
    projection: async (): Promise<{ revoked: boolean }> => {
      const rows = await db
        .select({ revokedAt: sharedLinks.revokedAt })
        .from(sharedLinks)
        .where(eq(sharedLinks.id, link.id));
      const row = rows[0];
      if (row === undefined) throw new Error('share harness: projection link is gone');
      return { revoked: row.revokedAt !== null };
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: () => probe.log,
      armFailure: () => {
        probe.armed = true;
      },
    },
  };
}

function shareOf(harness: AdminOpHarnessInstance): ShareHarness {
  return harness as ShareHarness;
}

/** Per-link isolation churn: a sibling link on the same conversation is
 * minted and revoked around the op — the projection tracks only the
 * harness link, which sibling-link writes must never touch. */
function shareInterleaving(): AdminOpInterleavingConfig {
  return {
    seeds: [3, 41, 59],
    stepsPerSeed: 4,
    opInput: (harness) => ({
      linkId: shareOf(harness).linkId,
      reason: `interleaving share disposition ${crypto.randomUUID()}`,
    }),
    actions: [
      {
        name: 'sibling-link-minted-then-revoked',
        run: async (harness, rng) => {
          const { conversationId } = shareOf(harness);
          const values = sharedLinkFactory.build({ conversationId });
          const [sibling] = await db
            .insert(sharedLinks)
            .values(values)
            .returning({ id: sharedLinks.id });
          if (sibling !== undefined && rng() < 0.5) {
            await db
              .update(sharedLinks)
              .set({ revokedAt: new Date() })
              .where(eq(sharedLinks.id, sibling.id));
          }
        },
      },
    ],
  };
}

const revokeTarget = { linkId: '' };
describeAdminOp({
  contract: REVOKE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createShareHarness(options, { seatGuest: true });
    revokeTarget.linkId = harness.linkId;
    return harness;
  },
  validInput: () => ({
    linkId: revokeTarget.linkId,
    reason: `abusive guest ${crypto.randomUUID()}`,
  }),
  invalidInput: { linkId: 'not-a-uuid', reason: 'x' },
  hasEphemeralEffects: true,
  interleaving: shareInterleaving(),
});

const unrevokeTarget = { linkId: '' };
describeAdminOp({
  contract: UNREVOKE_CONTRACT,
  createHarness: async (options) => {
    const harness = await createShareHarness(options, { revoked: true });
    unrevokeTarget.linkId = harness.linkId;
    return harness;
  },
  validInput: () => ({
    linkId: unrevokeTarget.linkId,
    reason: `revoked in error ${crypto.randomUUID()}`,
  }),
  invalidInput: { linkId: 'not-a-uuid', reason: 'x' },
  interleaving: shareInterleaving(),
});

function runOp(
  harness: ShareHarness,
  name: string,
  linkId: string
): ReturnType<ShareHarness['engine']['run']> {
  return harness.engine.run({
    name,
    input: { linkId, reason: `semantic probe ${crypto.randomUUID()}` },
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
  });
}

describe('share.revoke / share.unrevoke semantics', () => {
  it('evicts the returned principals post-commit — cache invalidated and sockets closed', async () => {
    const harness = await createShareHarness({}, { seatGuest: true });

    const previewed = await harness.engine.run({
      name: 'share.revoke',
      input: { linkId: harness.linkId, reason: 'eviction probe' },
      actor: harness.actor,
      mode: 'preview',
    });
    expect(previewed.isOk()).toBe(true);
    expect(harness.evictions).toEqual([]);

    const result = await runOp(harness, 'share.revoke', harness.linkId);

    expect(result.isOk()).toBe(true);
    const expected = [`${harness.conversationId}:${harness.linkId}`];
    expect(harness.invalidations).toEqual(expected);
    expect(harness.evictions).toEqual(expected);
  });

  it('departs the seated guest on revoke and does NOT restore membership on unrevoke', async () => {
    const harness = await createShareHarness({}, { seatGuest: true });

    const revoked = await runOp(harness, 'share.revoke', harness.linkId);
    expect(revoked._unsafeUnwrap().effects).toContainEqual({
      label: 'sharedLink.guestMember',
      before: 'seated',
      after: 'departed',
    });

    const unrevoked = await runOp(harness, 'share.unrevoke', harness.linkId);
    expect(unrevoked.isOk()).toBe(true);

    const members = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, harness.linkId));
    expect(members).toHaveLength(1);
    expect(members[0]?.leftAt).not.toBeNull();
    expect(await harness.projection()).toEqual({ revoked: false });
  });

  it('reports no guest departure when the link seats no active guest', async () => {
    const harness = await createShareHarness();

    const result = await runOp(harness, 'share.revoke', harness.linkId);

    const effects = result._unsafeUnwrap().effects;
    expect(effects).toEqual([{ label: 'sharedLink.revokedAt', before: null, after: 'revoked' }]);
  });

  it('refuses to revoke an already-revoked link with a typed conflict', async () => {
    const harness = await createShareHarness({}, { revoked: true });

    const result = await runOp(harness, 'share.revoke', harness.linkId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(harness.evictions).toEqual([]);
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses to unrevoke a live link with a typed conflict', async () => {
    const harness = await createShareHarness();

    const result = await runOp(harness, 'share.unrevoke', harness.linkId);

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an unknown link with a typed not-found on both ops', async () => {
    const harness = await createShareHarness();
    const missing = crypto.randomUUID();

    for (const name of ['share.revoke', 'share.unrevoke']) {
      const result = await runOp(harness, name, missing);
      expect(result.isErr() && result.error.code).toBe('not_found');
    }
    expect(await harness.auditCount()).toBe(0);
  });

  it('never fails the committed revoke when the socket eviction half fails (telemetry sees it)', async () => {
    const base = await createShareHarness({}, { seatGuest: true });
    const captured: string[] = [];
    const telemetry = {
      ...noopTelemetry(),
      captureError: (error: Error): void => {
        captured.push(error.message);
      },
    };
    const failingEvict: RealtimeBroadcast = {
      ...probeRealtime({ log: [], invalidated: [], armed: false }),
      evict: () => errAsync(unavailableError('DO unreachable')),
    };
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry<AdminShareDeps>([...adminShareOperations]),
      stores: adminStores,
      telemetry,
      opDeps: {
        conversationsStores: createConversationsStores,
        membershipRevoker: probeRevoker({ log: [], invalidated: [], armed: false }),
        realtime: failingEvict,
      },
      executorId: `admin-share-test-${crypto.randomUUID()}`,
    });

    const result = await engine.run({
      name: 'share.revoke',
      input: { linkId: base.linkId, reason: 'evict failure probe' },
      actor: base.actor,
      mode: 'execute',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isOk()).toBe(true);
    expect(await base.projection()).toEqual({ revoked: true });
    expect(captured).toEqual(['share revoke eviction: socket eviction failed: unavailable']);
  });

  it('maps a composed-write refusal and a store failure to typed errors', async () => {
    const base = await createShareHarness();
    const goneConversationStores: AdminShareDeps['conversationsStores'] = (writer) => {
      const stores = createConversationsStores(writer);
      return {
        ...stores,
        conversations: { ...stores.conversations, lockForUpdate: () => okAsync(null) },
      };
    };
    const failingByIdStores: AdminShareDeps['conversationsStores'] = (writer) => {
      const stores = createConversationsStores(writer);
      return {
        ...stores,
        sharedLinks: {
          ...stores.sharedLinks,
          byId: () => errAsync(unavailableError('link read failed')),
        },
      };
    };
    const engineWith = (
      conversationsStores: AdminShareDeps['conversationsStores']
    ): ReturnType<typeof createAdminOpEngine> =>
      createAdminOpEngine({
        db,
        registry: createAdminOpRegistry<AdminShareDeps>([...adminShareOperations]),
        stores: adminStores,
        telemetry: noopTelemetry(),
        opDeps: {
          conversationsStores,
          membershipRevoker: probeRevoker({ log: [], invalidated: [], armed: false }),
          realtime: probeRealtime({ log: [], invalidated: [], armed: false }),
        },
        executorId: `admin-share-test-${crypto.randomUUID()}`,
      });
    const attempt = async (engine: ReturnType<typeof createAdminOpEngine>): Promise<string> => {
      const result = await engine.run({
        name: 'share.revoke',
        input: { linkId: base.linkId, reason: 'error mapping probe' },
        actor: base.actor,
        mode: 'execute',
        idempotencyKey: crypto.randomUUID(),
      });
      return result._unsafeUnwrapErr().code;
    };

    // The write's own refusal (conversation gone under the lock) → not_found.
    expect(await attempt(engineWith(goneConversationStores))).toBe('not_found');
    // A failing store read passes through as the typed unavailable error.
    expect(await attempt(engineWith(failingByIdStores))).toBe('unavailable');
    expect(await base.projection()).toEqual({ revoked: false });
  });

  it('registers revoke/unrevoke as an inverse pair (Iron Law gate)', () => {
    const registry = createAdminOpRegistry<AdminShareDeps>([...adminShareOperations]);

    expect(registry.get('share.revoke')?.contract.inverse).toBe('share.unrevoke');
    expect(registry.get('share.unrevoke')?.contract.inverse).toBe('share.revoke');

    const loneRevoke = adminShareOperations.filter(
      (operation) => operation.contract.name === 'share.revoke'
    );
    expect(() => createAdminOpRegistry<AdminShareDeps>(loneRevoke)).toThrow(
      /Reversibility Iron Law/
    );
  });
});
