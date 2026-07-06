import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  decryptContentEnvelope,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  idempotencyKeys,
  ledgerEntries,
  messages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { createFencedSettlementHook, keyRowCompletion } from '../../workflows/index.js';
import { applyMarkup, createBillingStores } from '../../billing/index.js';
import { claimKeyRow, runSettlement } from '../../../lib/idempotency/index.js';
import { createChatStores } from '../adapters/stores.js';
import { CHAT_TURN_ROUTE } from './constants.js';
import { ASSISTANT_SENDER_ID, createChatSettlementCommit } from './settlement.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type { SettlementCharge, SettlementRequest } from '@hushbox/shared';
import type { ChatStores } from '../ports/stores.js';

/**
 * Saved ⟺ billed, atomically. The chat settlement commit persists the
 * assistant message + content items and charges every billable generation
 * inside the ONE fenced settlement transaction; a throw before commit leaves
 * ZERO committed rows. The persisted content is a real epoch-wrapped envelope
 * that decrypts with the epoch private key.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat settlement integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([9, 9, 9]);
const NOW = new Date('2026-07-05T12:00:00Z');
const MODEL_ID = 'chat-settle/model';
const PROVIDER_NAME = 'chat-settle-provider';
const ANSWER = 'echo:hello world';
const BASE_COST = 1000n;
const decoder = new TextDecoder();
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

async function seedFixture(options: { readonly seedEpoch?: boolean } = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values({
      email: `${suffix}@chat-settle.test`,
      username: `cs${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);

  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n })
    .returning({ id: wallets.id });
  const walletId = walletRows[0]?.id;
  if (walletId === undefined) throw new Error('wallet seed failed');

  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);

  const keyPair = generateEpochKeyPair();
  if (options.seedEpoch !== false) {
    await db.insert(epochs).values({
      conversationId,
      epochNumber: 1,
      epochPublicKey: keyPair.publicKey,
      confirmationHash: BYTES,
    });
  }
  // The epoch-at-persist gate reads active membership; the initiator is a
  // member of epoch 1 (the conversation's default current epoch).
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return { userId, walletId, conversationId, epochPrivateKey: keyPair.privateKey };
}

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

function charge(): SettlementCharge {
  return {
    key: 'answer',
    modelId: MODEL_ID,
    providerName: PROVIDER_NAME,
    modality: 'text',
    generationId: 'gen-1',
    baseCostNanoUsd: BASE_COST,
    isEstimated: false,
  };
}

function request(runKey: string): SettlementRequest {
  return {
    runKey,
    outputs: { answer: { kind: 'text', text: ANSWER } },
    charges: [charge()],
  };
}

async function claimFence(
  userId: string,
  runKey: string,
  runId: string
): Promise<{ id: string; executorId: string; claims: number }> {
  const executorId = crypto.randomUUID();
  const claimed = await claimKeyRow(db, {
    scope: { userId, route: CHAT_TURN_ROUTE, key: runKey },
    kind: 'run',
    bodyHash: 'body-hash',
    executorId,
    leaseSeconds: 90,
    runId,
  });
  const claim = claimed._unsafeUnwrap();
  if (claim.outcome !== 'executor') throw new Error('expected a fresh executor claim');
  return { id: claim.row.id, executorId, claims: claim.row.claims };
}

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

function decryptPersisted(
  fixture: Fixture,
  message: { readonly id: string; readonly wrappedContentKey: Uint8Array | null },
  content: { readonly id: string; readonly encryptedBlob: Uint8Array | null }
): string {
  if (!message.wrappedContentKey || !content.encryptedBlob) throw new Error('ciphertext missing');
  const wrapped = message.wrappedContentKey as WrappedSecret;
  const contentKey = unwrapContentKeyFromEpoch(fixture.epochPrivateKey, wrapped);
  const plaintext = decryptContentEnvelope(
    contentKey,
    wrapped,
    {
      conversationId: fixture.conversationId,
      messageId: message.id,
      contentItemId: content.id,
      position: 0,
      epochNumber: 1,
      senderId: ASSISTANT_SENDER_ID,
    },
    content.encryptedBlob
  );
  return decoder.decode(plaintext);
}

function commitFor(
  fixture: Fixture,
  runId: string,
  stores: ChatStores
): ReturnType<typeof createChatSettlementCommit> {
  return createChatSettlementCommit({
    identity: {
      conversationId: fixture.conversationId,
      epochNumber: 1,
      walletId: fixture.walletId,
      userId: fixture.userId,
      runId,
    },
    stores,
    billingStores: createBillingStores(),
    readEpochPublicKey,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  });
}

describe('chat settlement commit (saved ⟺ billed)', () => {
  it('persists the message + content and charges once, in one fenced transaction', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
    });
    await hook(request(runKey));

    const message = first(
      await db.select().from(messages).where(eq(messages.conversationId, fixture.conversationId)),
      'message'
    );
    expect(message.senderType).toBe('assistant');

    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, message.id)),
      'content'
    );
    expect(content.modelId).toBe(MODEL_ID);
    expect(content.costNanoUsd).toBe(applyMarkup(BASE_COST));

    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST));
    expect(usage.isEstimated).toBe(false);

    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, usage.id));
    expect(legs).toHaveLength(2);
    expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);

    const keyRow = first(
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id)),
      'key'
    );
    expect(keyRow.status).toBe('succeeded');

    // The persisted content is a real epoch-wrapped envelope.
    expect(decryptPersisted(fixture, message, content)).toBe(ANSWER);
  });

  it('persists and charges nothing when the run produced no billable content', async () => {
    const fixture = await seedFixture();
    const emptyRequest: SettlementRequest = { runKey: 'k', outputs: {}, charges: [] };
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, emptyRequest)
    );
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, fixture.conversationId))
    ).toHaveLength(0);
  });

  it('skips a charge whose output is not text (no content, no charge)', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const mediaRequest: SettlementRequest = {
      runKey: 'k',
      outputs: {
        answer: {
          kind: 'media',
          value: {
            ref: 'r',
            mimeType: 'image/png',
            modality: 'image',
            byteLength: 1,
            metadata: {},
          },
        },
      },
      charges: [charge()],
    };
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores())(tx, mediaRequest)
    );
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('persists ZERO rows when the epoch rotated between send and settlement', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // A rotation (e.g. a member removal) advances currentEpoch after send; the
    // turn was authorized against epoch 1. The epoch-at-persist gate must
    // terminal-fail the run — content must never wrap to the superseded epoch.
    await db
      .update(conversations)
      .set({ currentEpoch: 2 })
      .where(eq(conversations.id, fixture.conversationId));
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, request('k')))
    ).rejects.toThrow(/wrap-epoch/);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, fixture.conversationId))
    ).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('throws when the wrap-target epoch row is absent (inconsistent state)', async () => {
    // currentEpoch points at epoch 1 and the member is active, so the gate
    // passes, but the epoch row is missing — the wrap-key read fails closed.
    const fixture = await seedFixture({ seedEpoch: false });
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k'))
      )
    ).rejects.toThrow(/no epoch/);
  });

  it('persists ZERO rows when the initiator is no longer an epoch member', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // The initiator left/was removed without a rotation reaching settlement:
    // currentEpoch still matches, but they are no longer an active member.
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.conversationId, fixture.conversationId));
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, request('k')))
    ).rejects.toThrow(/wrap-epoch/);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, fixture.conversationId))
    ).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('commits nothing when the persist throws before settlement completes', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);

    const throwingStores: ChatStores = {
      ...createChatStores(),
      insertContentItemWithinTx: () => {
        throw new Error('persist boom before settlement completes');
      },
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, throwingStores),
    });
    await expect(hook(request(runKey))).rejects.toThrow(/persist boom/);

    // Zero committed rows: no message, no content, no usage, no ledger legs.
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, fixture.conversationId))
    ).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    // The key row was never flipped — a retry can still re-execute.
    const keyRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id));
    expect(keyRows[0]?.status).toBe('claimed');
  });

  it('does not double-charge when the same settlement replays', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);

    // The fenced settlement runs once (persists + charges + flips the key row);
    // a replay of the same commit charges on the same idempotency key
    // (`${runId}:answer`), so no second usage/ledger row is written.
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
    });
    await hook(request(runKey));
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores())(tx, request(runKey))
    );

    const usageRows = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usageRows).toHaveLength(1);
  });
});
