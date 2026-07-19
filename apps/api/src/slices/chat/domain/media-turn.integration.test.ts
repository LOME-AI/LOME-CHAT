import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, eq, inArray } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  messages,
  modelCatalog,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { createR2Storage } from '../../media/index.js';
import { refreshCatalog } from '../../models/index.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
} from '../../models/domain/gateway-fixtures.js';
import { acquireModelCatalogLock } from '../../models/__tests__/model-catalog-lock.js';
import { createConversationRuntime } from './runtime.js';
import { buildMediaTurnDefinition } from './turn-definition.js';
import { CHAT_TURN_INPUT } from './constants.js';
import { createChatStores } from '../adapters/stores.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { Storage } from '../../media/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { FlowRunOutcome, RunContext } from '@hushbox/shared';

/**
 * The FULL single-model media turn through the REAL conversation runtime: a
 * real image definition (built from the seeded catalog), the deterministic mock
 * provider, real R2/MinIO puts, and the real chat settlement — the seam the
 * e2e media suite exercises and the unit/isolated integration tests never wire
 * together end to end. Reproduces the live `workflow_settlement_defect`.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for media turn integration tests — run via pnpm test:api`);
  }
  return value;
}

const db = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({
  url: requireEnv('UPSTASH_REDIS_REST_URL'),
  token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
});
const BYTES = new Uint8Array([5, 5, 5]);

const storage: Storage = createR2Storage({
  endpoint: requireEnv('R2_S3_ENDPOINT'),
  bucket: requireEnv('R2_BUCKET_MEDIA'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
  defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  db,
  isCI: false,
});

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

function telemetry(): Telemetry & { captureError: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    emitMetric: vi.fn(),
    captureError: vi.fn(),
  };
}

const MODEL_ID = `google/test-image-${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedFixture(): Promise<{
  userId: string;
  walletId: string;
  conversationId: string;
  epochPublicKey: Uint8Array;
}> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values({
      email: `${suffix}@media-turn.test`,
      username: `mt${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = userRows[0]!.id;
  createdUserIds.push(userId);

  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000_000n })
    .returning({ id: wallets.id });
  const walletId = walletRows[0]!.id;

  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]!.id;
  createdConversationIds.push(conversationId);

  const keyPair = generateEpochKeyPair();
  const epochRows = await db
    .insert(epochs)
    .values({
      conversationId,
      epochNumber: 1,
      epochPublicKey: keyPair.publicKey,
      confirmationHash: BYTES,
    })
    .returning({ id: epochs.id });
  await db.insert(epochMembers).values({
    epochId: epochRows[0]!.id,
    memberPublicKey: BYTES,
    wrap: BYTES,
    visibleFromEpoch: 1,
  });
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1 });

  return { userId, walletId, conversationId, epochPublicKey: keyPair.publicKey };
}

let releaseLock: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseLock = await acquireModelCatalogLock(redis);
  const result = await refreshCatalog({
    db,
    fetch: catalogFetch({
      images: [imageModelFixture({ id: MODEL_ID })],
      zdrModelIds: [MODEL_ID],
      imageEndpoints: () => imageEndpointsFixture(),
    }),
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: telemetry(),
    now: () => new Date('2026-07-19T00:00:00.000Z'),
  });
  result._unsafeUnwrap();
});

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(eq(modelCatalog.modelId, MODEL_ID));
  const release = releaseLock;
  releaseLock = undefined;
  await release?.();
  await db.$client.end();
});

describe('single-model image turn (real runtime end to end)', () => {
  it('generates, persists, and bills an image through the real settlement', async () => {
    const fixture = await seedFixture();
    const tele = telemetry();
    const rt = createConversationRuntime({
      db,
      redis,
      telemetry: tele,
      apiKey: 'mock-key',
      isCI: false,
      mockProviderEnabled: true,
      chatStores: createChatStores(),
      storage,
      readEpochPublicKey,
    });

    const definition = (
      await buildMediaTurnDefinition(
        { db, telemetry: tele },
        [MODEL_ID],
        'image',
        { aspectRatio: '1:1' }
      )
    )._unsafeUnwrap();

    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const identity = {
      mode: 'paid' as const,
      userId: fixture.userId,
      senderId: fixture.userId,
      conversationId: fixture.conversationId,
      walletId: fixture.walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'a sunset over mountains' },
    };
    const claim = await rt.claimRun({ runKey, runId, bodyHash: 'body-hash', identity });
    if (claim.outcome !== 'executor') throw new Error(`expected executor claim, got ${claim.outcome}`);

    const context: RunContext = {
      ...identity,
      runId,
      fence: claim.fence,
      mockDirectives: {},
    };
    const hooks = rt.bindHooks(context, definition);

    const handle = rt.executor.start({
      definition,
      inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: 'a sunset over mountains' } },
      hooks,
      runKey,
      mockDirectives: {},
      emit: () => {},
    });
    const outcome: FlowRunOutcome = await handle.done;

    const captured = tele.captureError.mock.calls.map((c) => String(c[0]));
    expect(outcome.outcome, `run failed; captured: ${JSON.stringify(captured)}`).toBe('succeeded');

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, fixture.conversationId));
    expect(rows.length).toBe(2);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage.length).toBe(1);
    const items = await db
      .select()
      .from(contentItems)
      .where(inArray(contentItems.messageId, rows.map((r) => r.id)));
    expect(items.some((i) => i.contentType === 'image')).toBe(true);
  }, 30_000);
});
