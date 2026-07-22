import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  modelCatalog,
  users,
  wallets,
} from '@hushbox/db';
import { createBillingStores } from '../../billing/index.js';
import { createConversationsStores } from '../../conversations/index.js';
import { withModelCatalogLock } from '../../models/__tests__/model-catalog-lock.js';
import { resolveTurnContext } from './turn-context.js';
import { buildTurnDefinition } from './turn-definition.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for turn-definition integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([3, 3, 3]);
// The `chat-route` prefix survives the chat route suite's foreign-row catalog
// isolation delete, so a concurrent run never drops this suite's model.
const MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
const REASONING_MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL, REASONING_MODEL]));
  await db.$client.end();
});

/** Base rates 2500 / 10_000 nano-USD per token, context window 128_000. */
async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2500', outputPerToken: '10000' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

/** Same rates/window as {@link seedModel}, plus open-effort reasoning metadata. */
async function seedReasoningModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: REASONING_MODEL,
      descriptor: {
        id: REASONING_MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2500', outputPerToken: '10000' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
        reasoning: { supportedEfforts: null },
      },
    })
    .onConflictDoNothing();
}

async function seedUser(balanceNanoUsd: bigint): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@turn-ceiling.test`,
      username: `tc${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  await db.insert(wallets).values({ userId: id, type: 'purchased', balanceNanoUsd });
  return id;
}

async function seedConversation(userId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = rows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return conversationId;
}

/** The chat turn path: context (payer funding) → definition → answer node. */
async function builtAnswerParams(balanceNanoUsd: bigint): Promise<Record<string, unknown>> {
  const userId = await seedUser(balanceNanoUsd);
  const conversationId = await seedConversation(userId);
  const context = await resolveTurnContext(
    { conversations: createConversationsStores, billing: createBillingStores() },
    db,
    { conversationId, sender: { kind: 'user', userId }, now: new Date() }
  );
  const funding = context._unsafeUnwrap().funding;
  // Seed and build under the shared catalog lock: an unlocked insert would
  // land inside another suite's locked clear-the-catalog window (the dev-routes
  // 404 test wipes the whole table and asserts "no text model"), and that
  // suite's wipe could equally drop this model between seed and read.
  const definition = await withModelCatalogLock(redis, async () => {
    await seedModel();
    return buildTurnDefinition({ db, telemetry: silentTelemetry }, MODEL, {
      budget: { promptCharacterCount: 'hello world'.length, funding },
    });
  });
  const answer = definition._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
  if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
  return answer.params;
}

describe('the chat turn path output-token ceiling', () => {
  it('builds a low-balance payer a capped modelCall (the legacy budget derivation)', async () => {
    // $0.10 balance: estInput = ceil(11/4) = 3; fixed = 3×2875 + 11×300 =
    // 11_925; variable = 11_500 + 600 = 12_100; effective = 100_000_000 +
    // 500_000_000 cushion → maxOutputTokens = floor(599_988_075/12_100) = 49_585.
    const params = await builtAnswerParams(100_000_000n);
    expect(params).toEqual({ maxOutputTokens: 49_585 });
  });

  it('omits the ceiling for a rich payer whose budget covers the context window', async () => {
    // $10_000 balance: the affordable output budget exceeds the remaining
    // 128_000-token context, so the model default applies (no param).
    const params = await builtAnswerParams(10_000_000_000_000n);
    expect(params).toEqual({});
  });
});

describe('the reasoning turn build fail-fasts', () => {
  it('refuses a reasoning build with no payer budget (no sizing basis for the explicit cap)', async () => {
    const result = await withModelCatalogLock(redis, async () => {
      await seedReasoningModel();
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
        reasoningEffort: 'low',
      });
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('caps an unaffordable reasoning turn at B plus the minimum answer so admission refuses it', async () => {
    // A free payer whose funds cannot cover B + the 1000-token minimum answer:
    // the build keeps an EXPLICIT B + MINIMUM cap (G2) with no reconcile guess,
    // and admission's balance gate — not a silent effort downgrade — refuses.
    const result = await withModelCatalogLock(redis, async () => {
      await seedReasoningModel();
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
        budget: {
          promptCharacterCount: 5,
          funding: { kind: 'free', remainingNanoUsd: 1_000_000n },
        },
        reasoningEffort: 'low',
      });
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    expect(answer.params).toEqual({
      // low B = 4096 + the 1000-token minimum answer allocation.
      maxOutputTokens: 5096,
      reasoning: { effort: 'low' },
    });
  });
});

describe("the hard-off ('none') turn build", () => {
  async function noneAnswerParams(
    options: Parameters<typeof buildTurnDefinition>[2]
  ): Promise<Record<string, unknown>> {
    const result = await withModelCatalogLock(redis, async () => {
      await seedReasoningModel();
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
        ...options,
        reasoningEffort: 'none',
      });
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    return answer.params;
  }

  it('wires { enabled: false } with exactly the reasoning-free answer cap (B=0, cap = H)', async () => {
    // Same $0.10 payer as the reasoning-free derivation test: the cap must be
    // byte-identical to a plain turn's — the off wire adds no B term.
    const params = await noneAnswerParams({
      budget: {
        promptCharacterCount: 'hello world'.length,
        funding: { kind: 'purchased', remainingNanoUsd: 100_000_000n },
      },
    });
    expect(params).toEqual({ maxOutputTokens: 49_585, reasoning: { enabled: false } });
  });

  it('builds a budget-less (trial) hard-off turn uncapped, like a plain trial turn', async () => {
    const params = await noneAnswerParams({});
    expect(params).toEqual({ reasoning: { enabled: false } });
  });
});
