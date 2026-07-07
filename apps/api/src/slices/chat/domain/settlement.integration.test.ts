import { afterAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  decryptContentEnvelope,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationForks,
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
import { createConversationsStores } from '../../conversations/index.js';
import { errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createChatStores } from '../adapters/stores.js';
import { CHAT_TURN_ROUTE } from './constants.js';
import { ASSISTANT_SENDER_ID, createChatSettlementCommit } from './settlement.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type { RegenerateAction, SettlementCharge, SettlementRequest } from '@hushbox/shared';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ChatStores } from '../ports/stores.js';

/**
 * Saved ⟺ billed, atomically. The chat settlement commit persists the linear
 * message tree — the initiator's user message chained onto the conversation
 * tip, then the assistant reply chained onto the user message, sharing one
 * batch id and a contiguous sequence block — plus every content item, and
 * charges every billable generation inside the ONE fenced settlement
 * transaction. A throw before commit leaves ZERO committed rows. The persisted
 * content is a real epoch-wrapped envelope that decrypts with the epoch key.
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
const PROMPT = 'ask:hello world';
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

function decryptItem(
  fixture: Fixture,
  message: { readonly id: string; readonly wrappedContentKey: Uint8Array | null },
  content: { readonly id: string; readonly encryptedBlob: Uint8Array | null },
  senderId: string
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
      senderId,
    },
    content.encryptedBlob
  );
  return decoder.decode(plaintext);
}

function commitFor(
  fixture: Fixture,
  runId: string,
  stores: ChatStores,
  options: {
    readonly userMessage?: { readonly id: string; readonly content: string };
    readonly forkId?: string;
    readonly regenerate?: RegenerateAction;
    readonly conversationsStores?: (
      tx: SettlementTx
    ) => ReturnType<typeof createConversationsStores>;
  } = {}
): ReturnType<typeof createChatSettlementCommit> {
  return createChatSettlementCommit({
    identity: {
      conversationId: fixture.conversationId,
      epochNumber: 1,
      walletId: fixture.walletId,
      userId: fixture.userId,
      runId,
      userMessage: options.userMessage ?? { id: crypto.randomUUID(), content: PROMPT },
      ...(options.forkId === undefined ? {} : { forkId: options.forkId }),
      ...(options.regenerate === undefined ? {} : { regenerate: options.regenerate }),
    },
    stores,
    billingStores: createBillingStores(),
    readEpochPublicKey,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
    ...(options.conversationsStores === undefined
      ? {}
      : { conversationsStores: options.conversationsStores }),
  });
}

async function seedFork(
  conversationId: string,
  tipMessageId: string | null,
  name = 'Main'
): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name, tipMessageId })
    .returning({ id: conversationForks.id });
  const forkId = rows[0]?.id;
  if (forkId === undefined) throw new Error('fork seed failed');
  return forkId;
}

async function forkTip(forkId: string): Promise<string | null> {
  const rows = await db
    .select({ tip: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));
  return rows[0]?.tip ?? null;
}

async function messagesInOrder(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sequenceNumber));
}

describe('chat settlement commit (saved ⟺ billed, linear tree)', () => {
  it('persists the user + assistant messages, chained and batched, and charges once', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const userMessageId = crypto.randomUUID();

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      }),
    });
    await hook(request(runKey));

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    const [userMessage, assistantMessage] = rows;
    if (!userMessage || !assistantMessage) throw new Error('expected two messages');

    // The user message: client-supplied id, sender = initiator, root parent
    // (empty conversation), lowest sequence in the reserved block.
    expect(userMessage.id).toBe(userMessageId);
    expect(userMessage.senderType).toBe('user');
    expect(userMessage.senderId).toBe(fixture.userId);
    expect(userMessage.parentMessageId).toBeNull();

    // The assistant message: reserved sentinel sender, chained onto the user
    // message, next sequence in the block, and sharing the turn's batch id.
    expect(assistantMessage.senderType).toBe('assistant');
    expect(assistantMessage.senderId).toBe(ASSISTANT_SENDER_ID);
    expect(assistantMessage.parentMessageId).toBe(userMessage.id);
    expect(assistantMessage.sequenceNumber).toBe(userMessage.sequenceNumber + 1);
    expect(assistantMessage.batchId).toBe(userMessage.batchId);

    // The user content carries no model/cost; the assistant content mirrors the
    // charged (post-markup) cost.
    const userContent = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, userMessage.id)),
      'user content'
    );
    expect(userContent.modelId).toBeNull();
    expect(userContent.costNanoUsd).toBeNull();

    const assistantContent = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistantMessage.id)),
      'assistant content'
    );
    expect(assistantContent.modelId).toBe(MODEL_ID);
    expect(assistantContent.costNanoUsd).toBe(applyMarkup(BASE_COST));

    // Exactly one charge, keyed to the run.
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST));

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

    // Both persisted envelopes decrypt: the user's prompt under the initiator's
    // AAD sender, the assistant's answer under the sentinel.
    expect(decryptItem(fixture, userMessage, userContent, fixture.userId)).toBe(PROMPT);
    expect(decryptItem(fixture, assistantMessage, assistantContent, ASSISTANT_SENDER_ID)).toBe(
      ANSWER
    );
  });

  it('chains a second turn onto the prior assistant tip with a fresh batch id', async () => {
    const fixture = await seedFixture();
    const firstRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, firstRunId, createChatStores())(tx, request('k1'))
    );
    const secondRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, secondRunId, createChatStores())(tx, request('k2'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(4);
    const [turn1User, turn1Assistant, turn2User, turn2Assistant] = rows;
    if (!turn1User || !turn1Assistant || !turn2User || !turn2Assistant) {
      throw new Error('expected four messages');
    }
    // Turn 2's user message chains onto turn 1's assistant tip; turn 2's
    // assistant onto turn 2's user.
    expect(turn2User.parentMessageId).toBe(turn1Assistant.id);
    expect(turn2Assistant.parentMessageId).toBe(turn2User.id);
    // Sequences are monotonic and never reused across turns.
    expect(rows.map((r) => r.sequenceNumber)).toEqual([
      turn1User.sequenceNumber,
      turn1User.sequenceNumber + 1,
      turn1User.sequenceNumber + 2,
      turn1User.sequenceNumber + 3,
    ]);
    // Each turn carries its own batch id.
    expect(turn1User.batchId).toBe(turn1Assistant.batchId);
    expect(turn2User.batchId).toBe(turn2Assistant.batchId);
    expect(turn1User.batchId).not.toBe(turn2User.batchId);
  });

  it('persists and charges nothing when the run produced no billable content', async () => {
    const fixture = await seedFixture();
    const emptyRequest: SettlementRequest = { runKey: 'k', outputs: {}, charges: [] };
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, emptyRequest)
    );
    // No billable content means no user message either — a failed turn persists
    // nothing.
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
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
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
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
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
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
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
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

    // Zero committed rows: no message (user or assistant), no content, no usage.
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    // The key row was never flipped — a retry can still re-execute.
    const keyRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id));
    expect(keyRows[0]?.status).toBe('claimed');
  });

  it('rejects a re-executed commit on the client-supplied user-message id (no duplicate persist or charge)', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const userMessageId = crypto.randomUUID();

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      }),
    });
    await hook(request(runKey));

    // Re-running the same commit re-inserts the fixed user-message id, which the
    // primary key rejects — the client-supplied id is the idempotency guard, so
    // no duplicate user message and no second charge can land.
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          userMessage: { id: userMessageId, content: PROMPT },
        })(tx, request(runKey))
      )
    ).rejects.toThrow();

    expect(
      await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.conversationId, fixture.conversationId), eq(messages.senderType, 'user'))
        )
    ).toHaveLength(1);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      1
    );
  });
});

describe('chat settlement commit (fresh-send onto a fork)', () => {
  it('chains onto the fork tip and advances the tip to the new assistant reply', async () => {
    const fixture = await seedFixture();
    // A prior linear turn establishes a message the fork tips at.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k-seed'))
    );
    const seeded = await messagesInOrder(fixture.conversationId);
    const priorAssistant = seeded.at(-1);
    if (!priorAssistant) throw new Error('expected a seeded assistant tip');
    const forkId = await seedFork(fixture.conversationId, priorAssistant.id, 'Branch');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { forkId })(tx, request('k-fork'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const forkUser = rows[2];
    const forkAssistant = rows[3];
    if (!forkUser || !forkAssistant) throw new Error('expected the fork turn messages');
    // The fork turn's user message chains onto the fork's prior tip; the
    // assistant onto the user message.
    expect(forkUser.parentMessageId).toBe(priorAssistant.id);
    expect(forkAssistant.parentMessageId).toBe(forkUser.id);
    // The fork tip advanced to the new assistant reply inside the settlement tx.
    expect(await forkTip(forkId)).toBe(forkAssistant.id);
  });

  it('resolves a null-tipped fork to a root-parented user message and advances the tip', async () => {
    const fixture = await seedFixture();
    const forkId = await seedFork(fixture.conversationId, null, 'Empty branch');
    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { forkId })(tx, request('k-empty-fork'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const [user, assistant] = rows;
    if (!user || !assistant) throw new Error('expected two messages');
    expect(user.parentMessageId).toBeNull();
    expect(await forkTip(forkId)).toBe(assistant.id);
  });

  it('terminal-fails and persists nothing when the fork vanished mid-run', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const missingForkId = crypto.randomUUID();
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { forkId: missingForkId })(tx, request('k'))
      )
    ).rejects.toThrow(/fork/i);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });
});

/** Runs `count` fresh-send turns, returning the persisted messages in order. */
async function seedTurns(
  fixture: Fixture,
  count: number
): Promise<Awaited<ReturnType<typeof messagesInOrder>>> {
  for (let index = 0; index < count; index += 1) {
    await runSettlement(db, (tx) =>
      commitFor(
        fixture,
        crypto.randomUUID(),
        createChatStores()
      )(tx, request(`k-seed-${String(index)}`))
    );
  }
  return messagesInOrder(fixture.conversationId);
}

/** Manually grafts an extra assistant sibling under `parentId` (multi-model peer). */
async function insertSiblingAssistant(
  fixture: Fixture,
  parentId: string,
  sequenceNumber: number
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId: fixture.conversationId,
      senderType: 'assistant',
      senderId: ASSISTANT_SENDER_ID,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber,
      parentMessageId: parentId,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sibling assistant seed failed');
  return id;
}

function ids(rows: readonly { readonly id: string }[]): string[] {
  return rows.map((row) => row.id);
}

describe('chat settlement commit (regenerate / edit — linear)', () => {
  it('retry-all deletes every reply below the anchor and re-parents a fresh reply', async () => {
    const fixture = await seedFixture();
    const seeded = await seedTurns(fixture, 2);
    const [u1, a1, u2, a2] = seeded;
    if (!u1 || !a1 || !u2 || !a2) throw new Error('expected four seeded messages');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
      })(tx, request('k-retry-all'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    // The anchor user message survives; a1, u2, a2 are gone; one fresh reply
    // re-parents onto the anchor with a strictly higher sequence.
    expect(ids(rows)).toEqual([u1.id, expect.any(String)]);
    const reply = rows[1];
    if (!reply) throw new Error('expected a fresh reply');
    expect(reply.senderType).toBe('assistant');
    expect(reply.parentMessageId).toBe(u1.id);
    expect(reply.sequenceNumber).toBeGreaterThan(a2.sequenceNumber);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      1
    );
  });

  it('retry-one deletes only the named reply and keeps its siblings', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    // Far above the monotonic counter, so the manual sequence never collides
    // with a counter-reserved one.
    const sibling = await insertSiblingAssistant(fixture, u1.id, a1.sequenceNumber + 100_000);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id, replaceAssistantId: a1.id },
      })(tx, request('k-retry-one'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).toContain(u1.id);
    expect(surviving).toContain(sibling); // untouched sibling survives
    expect(surviving).not.toContain(a1.id); // only the named reply is gone
    const fresh = rows.find((row) => row.id !== u1.id && row.id !== sibling);
    expect(fresh?.parentMessageId).toBe(u1.id);
  });

  it('edit deletes from the anchor down and inserts a re-parented user message', async () => {
    const fixture = await seedFixture();
    const seeded = await seedTurns(fixture, 2);
    const [u1, a1, u2, a2] = seeded;
    if (!u1 || !a1 || !u2 || !a2) throw new Error('expected four seeded messages');
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: editedId, content: 'edited prompt' },
        regenerate: { action: 'edit', targetMessageId: u2.id },
      })(tx, request('k-edit'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).toContain(u1.id);
    expect(surviving).toContain(a1.id);
    expect(surviving).not.toContain(u2.id); // the edited user message is replaced
    expect(surviving).not.toContain(a2.id);
    const editedUser = rows.find((row) => row.id === editedId);
    // The new user message re-parents onto the anchor's parent (a1), not the anchor.
    expect(editedUser?.parentMessageId).toBe(a1.id);
    expect(editedUser?.senderType).toBe('user');
  });

  it('edit of a root anchor deletes the anchor and roots the replacement', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    expect(u1.parentMessageId).toBeNull();
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: editedId, content: 'edited root' },
        regenerate: { action: 'edit', targetMessageId: u1.id },
      })(tx, request('k-edit-root'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).not.toContain(u1.id);
    expect(surviving).not.toContain(a1.id);
    const editedUser = rows.find((row) => row.id === editedId);
    expect(editedUser?.parentMessageId).toBeNull(); // re-rooted
  });

  it('retains the original charge (content FK nulled) while charging the new generation', async () => {
    const fixture = await seedFixture();
    const seedRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, seedRunId, createChatStores())(tx, request('k-money-seed'))
    );
    const [u1] = await messagesInOrder(fixture.conversationId);
    if (!u1) throw new Error('expected the seeded user message');

    const retryRunId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, retryRunId, createChatStores(), {
        regenerate: { action: 'retry', targetMessageId: u1.id },
      })(tx, request('k-money-retry'))
    );

    // The original charge row is retained (financial retention), only its
    // content FK is nulled by the cascade — the ledger legs stand.
    const oldUsage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, seedRunId)),
      'original usage'
    );
    expect(oldUsage.contentItemId).toBeNull();
    const oldLegs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, oldUsage.id));
    expect(oldLegs).toHaveLength(2);
    // The new generation is charged in full.
    const newUsage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, retryRunId)),
      'new usage'
    );
    expect(newUsage.costNanoUsd).toBe(applyMarkup(BASE_COST));
    expect(newUsage.contentItemId).not.toBeNull();
  });

  it('terminal-fails a retry whose linear anchor vanished before settlement', async () => {
    const fixture = await seedFixture();
    // A retry-all against a target that no longer exists finds no reply to
    // delete, then FK-fails when the new reply tries to chain onto the missing
    // anchor — nothing persists (saved ⟺ billed).
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          regenerate: { action: 'retry', targetMessageId: crypto.randomUUID() },
        })(tx, request('k-retry-missing'))
      )
    ).rejects.toThrow();
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('terminal-fails an edit whose target vanished before settlement', async () => {
    const fixture = await seedFixture();
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          userMessage: { id: crypto.randomUUID(), content: 'edited' },
          regenerate: { action: 'edit', targetMessageId: crypto.randomUUID() },
        })(tx, request('k-edit-missing'))
      )
    ).rejects.toThrow(/edit target message not found/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('rolls back the delete when the regenerate persist throws (saved ⟺ billed)', async () => {
    const fixture = await seedFixture();
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');

    const throwingStores: ChatStores = {
      ...createChatStores(),
      insertContentItemWithinTx: () => {
        throw new Error('regenerate persist boom');
      },
    };
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), throwingStores, {
          regenerate: { action: 'retry', targetMessageId: u1.id },
        })(tx, request('k-rollback'))
      )
    ).rejects.toThrow(/boom/);

    // The delete rolled back with the failed persist: the original reply survives.
    const surviving = ids(await messagesInOrder(fixture.conversationId));
    expect(surviving).toEqual([u1.id, a1.id]);
  });
});

describe('chat settlement commit (regenerate / edit — fork, cascade-aware tip)', () => {
  async function seedForkTip(
    fixture: Fixture
  ): Promise<{ forkId: string; forkUser: string; forkAssistant: string }> {
    const [, a1] = await seedTurns(fixture, 1);
    if (!a1) throw new Error('expected a seeded assistant');
    const forkId = await seedFork(fixture.conversationId, a1.id, 'Branch');
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), { forkId })(tx, request('k-fork'))
    );
    const rows = await messagesInOrder(fixture.conversationId);
    const forkAssistant = rows.at(-1);
    const forkUser = rows.at(-2);
    if (!forkAssistant || !forkUser) throw new Error('expected the fork turn messages');
    return { forkId, forkUser: forkUser.id, forkAssistant: forkAssistant.id };
  }

  it('rolls the whole settlement back when the fork parent-chain read fails (saved ⟺ billed)', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    const before = ids(await messagesInOrder(fixture.conversationId));

    // A fork retry-all computes its deletable tail from the parent chain; an
    // infra read failure there throws inside the settlement transaction, which
    // must roll the whole commit back — nothing deleted, nothing persisted.
    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        messages: {
          ...real.messages,
          parentChainRows: () => errAsync(unavailableError('parent-chain read boom')),
        },
      };
    };

    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores(), {
          forkId,
          regenerate: { action: 'retry', targetMessageId: forkUser },
          conversationsStores: faultingConversationsStores,
        })(tx, request('k-fork-chain-fault'))
      )
    ).rejects.toThrow(/parent-chain read failed/);

    // The delete never committed: the exact prior message set survives.
    const after = ids(await messagesInOrder(fixture.conversationId));
    expect(after).toEqual(before);
    expect(after).toContain(forkAssistant);
  });

  it('retry-all deletes the fork tail and advances the tip off the nulled tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: { action: 'retry', targetMessageId: forkUser },
      })(tx, request('k-fork-retry'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).toContain(forkUser);
    expect(surviving).not.toContain(forkAssistant); // the old tip reply is gone
    const reply = rows.find((row) => row.parentMessageId === forkUser);
    // The cascade nulled the tip; the CAS advanced it to the fresh reply.
    expect(await forkTip(forkId)).toBe(reply?.id);
  });

  it('retry-one advances the tip only when the replaced reply WAS the tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          replaceAssistantId: forkAssistant,
        },
      })(tx, request('k-fork-retry-one'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const reply = rows.find((row) => row.parentMessageId === forkUser && row.id !== forkAssistant);
    expect(reply).toBeDefined();
    expect(await forkTip(forkId)).toBe(reply?.id); // advanced (replaced WAS the tip)
    expect(ids(rows)).not.toContain(forkAssistant);
  });

  it('retry-one keeps the tip when the replaced reply was NOT the tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    // Graft a sibling reply and point the fork at it: the tip is now the sibling,
    // so replacing the ORIGINAL reply must not move the tip.
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const maxSeq = Math.max(...rowsBefore.map((row) => row.sequenceNumber));
    const sibling = await insertSiblingAssistant(fixture, forkUser, maxSeq + 100_000);
    await db
      .update(conversationForks)
      .set({ tipMessageId: sibling })
      .where(eq(conversationForks.id, forkId));

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          replaceAssistantId: forkAssistant,
        },
      })(tx, request('k-fork-retry-one-nontip'))
    );

    // The tip stayed on the surviving sibling; the replaced reply is gone.
    expect(await forkTip(forkId)).toBe(sibling);
    expect(ids(await messagesInOrder(fixture.conversationId))).not.toContain(forkAssistant);
  });

  it('retry-all on a bare fork tip (no reply to delete) advances the tip from the anchor', async () => {
    const fixture = await seedFixture();
    // A fork whose tip IS a user message with no reply below it: the tail is
    // empty, so the CAS expects the unchanged tip, not the cascade-null.
    const [, a1] = await seedTurns(fixture, 1);
    if (!a1) throw new Error('expected a seeded assistant');
    const forkId = await seedFork(fixture.conversationId, a1.id, 'Bare');
    // The fork tips at a1 (an assistant with no fork reply); regenerate-all from
    // a1 finds no tail below it.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        regenerate: { action: 'retry', targetMessageId: a1.id },
      })(tx, request('k-fork-bare'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const reply = rows.find((row) => row.parentMessageId === a1.id);
    expect(reply).toBeDefined();
    expect(await forkTip(forkId)).toBe(reply?.id);
  });

  it('edit of a root anchor on a fork deletes the anchor and re-roots the reply', async () => {
    const fixture = await seedFixture();
    // A fork tipping at the reply below a ROOT user message; editing that root
    // deletes the whole branch (tail + the root anchor) and re-roots the edit.
    const [u1, a1] = await seedTurns(fixture, 1);
    if (!u1 || !a1) throw new Error('expected the seeded turn');
    expect(u1.parentMessageId).toBeNull();
    const forkId = await seedFork(fixture.conversationId, a1.id, 'RootBranch');
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        userMessage: { id: editedId, content: 'edited root on fork' },
        regenerate: { action: 'edit', targetMessageId: u1.id },
      })(tx, request('k-fork-edit-root'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).not.toContain(u1.id);
    expect(surviving).not.toContain(a1.id);
    const editedUser = rows.find((row) => row.id === editedId);
    expect(editedUser?.parentMessageId).toBeNull();
    expect(await forkTip(forkId)).toBe(rows.find((row) => row.parentMessageId === editedId)?.id);
  });

  it('edit on a fork deletes the tail and re-parents the new user message', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const forkUserParent = rowsBefore.find((row) => row.id === forkUser)?.parentMessageId ?? null;
    const editedId = crypto.randomUUID();

    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        forkId,
        userMessage: { id: editedId, content: 'edited on fork' },
        regenerate: { action: 'edit', targetMessageId: forkUser },
      })(tx, request('k-fork-edit'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const surviving = ids(rows);
    expect(surviving).not.toContain(forkUser);
    expect(surviving).not.toContain(forkAssistant);
    const editedUser = rows.find((row) => row.id === editedId);
    expect(editedUser?.parentMessageId).toBe(forkUserParent);
    expect(await forkTip(forkId)).toBe(rows.find((row) => row.parentMessageId === editedId)?.id);
  });
});
