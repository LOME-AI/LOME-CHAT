import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
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
import { resolveTurnContext } from './turn-context.js';
import { buildTurnDefinition } from './turn-definition.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for turn-definition integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([3, 3, 3]);
// The `chat-route` prefix survives the chat route suite's foreign-row catalog
// isolation delete, so a concurrent run never drops this suite's model.
const MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
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
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL]));
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
  const definition = await buildTurnDefinition({ db, telemetry: silentTelemetry }, MODEL, {
    budget: { promptCharacterCount: 'hello world'.length, funding },
  });
  const answer = definition._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
  if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
  return answer.params;
}

describe('the chat turn path output-token ceiling', () => {
  it('builds a low-balance payer a capped modelCall (the legacy budget derivation)', async () => {
    await seedModel();
    // $0.10 balance: estInput = ceil(11/4) = 3; fixed = 3×2875 + 11×300 =
    // 11_925; variable = 11_500 + 600 = 12_100; effective = 100_000_000 +
    // 500_000_000 cushion → maxOutputTokens = floor(599_988_075/12_100) = 49_585.
    const params = await builtAnswerParams(100_000_000n);
    expect(params).toEqual({ maxOutputTokens: 49_585 });
  });

  it('omits the ceiling for a rich payer whose budget covers the context window', async () => {
    await seedModel();
    // $10_000 balance: the affordable output budget exceeds the remaining
    // 128_000-token context, so the model default applies (no param).
    const params = await builtAnswerParams(10_000_000_000_000n);
    expect(params).toEqual({});
  });
});
