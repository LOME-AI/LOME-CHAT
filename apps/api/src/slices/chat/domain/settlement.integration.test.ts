import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ERROR_CODES } from '@hushbox/shared';
import {
  decryptContentEnvelope,
  generateContentKey,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationForks,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  epochMembers,
  epochs,
  idempotencyKeys,
  ledgerEntries,
  memberBudgets,
  messages,
  sharedLinks,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import {
  SettlementConflictError,
  createFencedSettlementHook,
  keyRowCompletion,
} from '../../workflows/index.js';
import {
  admitRun,
  applyMarkup,
  createBillingStores,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  resolveBudgetScopes,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '../../billing/index.js';
import { claimKeyRow, runSettlement } from '../../../lib/idempotency/index.js';
import { createConversationsStores } from '../../conversations/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { domainWireCode, unavailableError } from '../../../lib/errors/index.js';
import { createChatStores } from '../adapters/stores.js';
import { CHAT_TURN_ROUTE } from './constants.js';
import { ASSISTANT_SENDER_ID, createChatSettlementCommit } from './settlement.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type {
  ContentValue,
  MediaPersistPlan,
  RegenerateAction,
  SenderPrincipal,
  SettlementCharge,
  SettlementRequest,
} from '@hushbox/shared';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
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
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for chat settlement integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([9, 9, 9]);
const NOW = new Date('2026-07-05T12:00:00Z');
const MODEL_ID = 'chat-settle/model';
const PROVIDER_NAME = 'chat-settle-provider';
const PROMPT = 'ask:hello world';
const ANSWER = 'echo:hello world';
const BASE_COST = 1000n;
/**
 * The additive (never-marked-up) storage fee for a standard PROMPT→ANSWER turn:
 * the new user prompt plus the single assistant response, at the per-char rate.
 * The usage record's charged cost is the marked-up model cost PLUS this.
 */
const PROMPT_ANSWER_STORAGE =
  BigInt(PROMPT.length + ANSWER.length) * STORAGE_COST_PER_CHARACTER_NANO;
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
  readonly memberId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
  readonly epochPublicKey: ReturnType<typeof generateEpochKeyPair>['publicKey'];
}

async function insertTestUser(): Promise<string> {
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
  const userId = first(userRows, 'user').id;
  createdUserIds.push(userId);
  return userId;
}

async function seedFixture(options: { readonly seedEpoch?: boolean } = {}): Promise<Fixture> {
  const userId = await insertTestUser();

  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n })
    .returning({ id: wallets.id });
  const walletId = first(walletRows, 'wallet').id;

  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = first(conversationRows, 'conversation').id;
  createdConversationIds.push(conversationId);

  const keyPair = generateEpochKeyPair();
  if (options.seedEpoch !== false) {
    const epochRows = await db
      .insert(epochs)
      .values({
        conversationId,
        epochNumber: 1,
        epochPublicKey: keyPair.publicKey,
        confirmationHash: BYTES,
      })
      .returning({ id: epochs.id });
    // The member-keyed epoch-at-persist gate verifies the sender's public key
    // against the authoritative `epoch_members` wrap-set; the initiator's key
    // (users.publicKey === BYTES) is a member of epoch 1.
    await db.insert(epochMembers).values({
      epochId: first(epochRows, 'epoch').id,
      memberPublicKey: BYTES,
      wrap: BYTES,
      visibleFromEpoch: 1,
    });
  }
  // The epoch-at-persist gate reads active membership; the initiator is a
  // member of epoch 1 (the conversation's default current epoch).
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = first(memberRows, 'member').id;
  return {
    userId,
    walletId,
    conversationId,
    memberId,
    epochPrivateKey: keyPair.privateKey,
    epochPublicKey: keyPair.publicKey,
  };
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

/** A multi-model turn: two selected models, two sibling generations. */
function multiModelRequest(runKey: string, baseA: bigint, baseB: bigint): SettlementRequest {
  return {
    runKey,
    outputs: {
      'model-a': { kind: 'text', text: `${ANSWER} a` },
      'model-b': { kind: 'text', text: `${ANSWER} b` },
    },
    charges: [
      {
        key: 'model-a',
        modelId: MODEL_ID,
        providerName: PROVIDER_NAME,
        modality: 'text',
        generationId: 'gen-a',
        baseCostNanoUsd: baseA,
        isEstimated: false,
      },
      {
        key: 'model-b',
        modelId: MODEL_ID,
        providerName: PROVIDER_NAME,
        modality: 'text',
        generationId: 'gen-b',
        baseCostNanoUsd: baseB,
        isEstimated: false,
      },
    ],
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

/**
 * Runs a settlement expected to terminal-fail on an ordinary concurrency race
 * and asserts it threw the typed `SettlementConflictError` sentinel projecting
 * to the given client wire code — so the engine reroutes it to a friendly
 * `{code}` outcome with no Sentry event, never `INTERNAL` + a defect capture.
 */
async function expectSettlementConflict(
  run: Promise<unknown>,
  expectedCode: (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
): Promise<void> {
  const thrown = await run.then(
    () => {
      throw new Error('expected the settlement to reject');
    },
    (error: unknown) => error
  );
  expect(thrown).toBeInstanceOf(SettlementConflictError);
  expect(domainWireCode((thrown as SettlementConflictError).domainError)).toBe(expectedCode);
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
    /** The pre-minted media persistence identities, keyed by charge key. */
    readonly mediaPlans?: ReadonlyMap<string, MediaPersistPlan>;
    /** The recovered funding decision; defaults to personal (no group accrual). */
    readonly ownerFunded?: ResultAsync<boolean, never>;
    /** The resolved sender principal (a link guest, or a member ≠ the payer). */
    readonly sender?: SenderPrincipal;
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
      ...(options.sender === undefined ? {} : { sender: options.sender }),
      runId,
      userMessage: options.userMessage ?? { id: crypto.randomUUID(), content: PROMPT },
      ...(options.forkId === undefined ? {} : { forkId: options.forkId }),
      ...(options.regenerate === undefined ? {} : { regenerate: options.regenerate }),
      ...(options.mediaPlans === undefined ? {} : { mediaPlans: options.mediaPlans }),
    },
    stores,
    billingStores: createBillingStores(),
    ownerFunded: options.ownerFunded ?? okAsync(false),
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
    // Displayed cost EQUALS the wallet debit: marked-up model cost PLUS the
    // additive prompt+response storage fee (the same value the charge debits).
    expect(assistantContent.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);

    // Exactly one charge, keyed to the run.
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    // Marked-up model cost PLUS the additive prompt+response storage fee.
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
    // Display equals debit: the persisted content cost is exactly what the wallet paid.
    expect(assistantContent.costNanoUsd).toBe(usage.costNanoUsd);
    // The run's conversation is stamped onto the usage record (per-conversation
    // spend analytics), even for this solo turn where the charge path itself
    // never carries a conversationId.
    expect(usage.conversationId).toBe(fixture.conversationId);

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

  it('settles a Smart Model turn: one assistant message, classifier + answer both billed against it', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const classifierBase = 40n;

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores()),
    });
    // The interpreter's smartModel charge shape: the answer under the node key
    // (flagged `smartModelRan` — the routing pipeline ran), the classifier
    // generation under the suffixed key with no output and no chip flag of its own.
    await hook({
      runKey,
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [
        { ...charge(), smartModelRan: true },
        {
          key: 'answer#classifier',
          modelId: 'chat-settle/classifier',
          providerName: PROVIDER_NAME,
          modality: 'text',
          generationId: 'gen-cls',
          baseCostNanoUsd: classifierBase,
          isEstimated: false,
        },
      ],
    });

    // ONE assistant message whose content carries the RESOLVED answer model —
    // the classifier persisted no content of its own.
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    const assistantMessage = rows[1];
    if (!assistantMessage) throw new Error('expected an assistant message');
    const assistantContents = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, assistantMessage.id));
    expect(assistantContents).toHaveLength(1);
    const answerContent = first(assistantContents, 'assistant content');
    expect(answerContent.modelId).toBe(MODEL_ID);
    // Display equals the FULL debit: the answer content mirrors its own charge
    // (marked-up model cost + prompt+response storage) PLUS the classifier charge
    // anchored to the same content item, and the item is flagged a Smart Model turn.
    expect(answerContent.costNanoUsd).toBe(
      applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE + applyMarkup(classifierBase)
    );
    expect(answerContent.isSmartModel).toBe(true);

    // TWO usage records — classifier + answer — both FK'd to the one persisted
    // answer content item (saved ⟺ billed), each with its own generation.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    for (const record of usage) {
      expect(record.contentItemId).toBe(answerContent.id);
    }
    const byModel = new Map(usage.map((record) => [record.modelId, record]));
    // The answer (primary charge) carries the prompt+response storage; the
    // classifier persists no content of its own, so it carries no storage.
    expect(byModel.get(MODEL_ID)?.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
    // Display equals debit: the answer content's stored cost is exactly the SUM of
    // both usage records (answer + classifier) FK'd to it.
    expect(answerContent.costNanoUsd).toBe(
      usage.reduce((sum, record) => sum + record.costNanoUsd, 0n)
    );
    expect(byModel.get(MODEL_ID)?.generationId).toBe('gen-1');
    expect(byModel.get('chat-settle/classifier')?.costNanoUsd).toBe(applyMarkup(classifierBase));
    expect(byModel.get('chat-settle/classifier')?.generationId).toBe('gen-cls');

    // Every charge's ledger legs sum to zero, and the fence flipped once.
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(
        inArray(
          ledgerEntries.usageRecordId,
          usage.map((record) => record.id)
        )
      );
    expect(legs).toHaveLength(4);
    for (const record of usage) {
      const recordLegs = legs.filter((leg) => leg.usageRecordId === record.id);
      expect(recordLegs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    }
    const keyRow = first(
      await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id)),
      'key'
    );
    expect(keyRow.status).toBe('succeeded');
  });

  it('badges a smartModel answer whose classifier failed — smartModelRan, no classifier charge', async () => {
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
    // A classifier that failed and fell back produces NO classifier charge, only
    // the answer charge flagged `smartModelRan`. The chip must still badge — it
    // reads "the pipeline ran", not "the classifier billed".
    await hook({
      runKey,
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [{ ...charge(), smartModelRan: true }],
    });

    const rows = await messagesInOrder(fixture.conversationId);
    const assistant = rows.find((row) => row.senderType === 'assistant');
    if (!assistant) throw new Error('expected an assistant message');
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistant.id)),
      'assistant content'
    );
    expect(content.isSmartModel).toBe(true);
    // Only the answer billed — the failed classifier charged nothing.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(1);
    expect(content.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
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

  it('terminal-fails and persists nothing when no generation produced a charge', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // Zero charges is the all-failed signal: a succeeded generation always
    // produces a charge, so no charges means every selected model failed. The
    // commit throws to roll the settlement back — nothing saved, nothing billed.
    const emptyRequest: SettlementRequest = { runKey: 'k', outputs: {}, charges: [] };
    await expect(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, emptyRequest))
    ).rejects.toThrow(/no model produced content/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
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
    // An ordinary rotation race → friendly CONFLICT, never INTERNAL + Sentry.
    await expectSettlementConflict(
      runSettlement(db, (tx) => commitFor(fixture, runId, createChatStores())(tx, request('k'))),
      ERROR_CODES.CONFLICT
    );
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('throws when the wrap-target epoch row is absent (inconsistent state)', async () => {
    // currentEpoch points at epoch 1 and the member is active, but neither the
    // epoch row nor its `epoch_members` wrap-set exists — the member-keyed epoch
    // gate finds the sender's key in no epoch and fails closed (rolls back).
    const fixture = await seedFixture({ seedEpoch: false });
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k'))
      )
    ).rejects.toThrow(/wrap-epoch/);
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
    // A fork deleted mid-run is an expected race → friendly FORK_TIP_CONFLICT,
    // never INTERNAL + Sentry.
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { forkId: missingForkId })(tx, request('k'))
      ),
      ERROR_CODES.FORK_TIP_CONFLICT
    );
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
    expect(newUsage.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
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
          regenerate: {
            action: 'retry',
            targetMessageId: forkUser,
            observedForkTipId: forkAssistant,
          },
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
        regenerate: {
          action: 'retry',
          targetMessageId: forkUser,
          observedForkTipId: forkAssistant,
        },
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
        regenerate: { action: 'retry', targetMessageId: a1.id, observedForkTipId: a1.id },
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
        regenerate: { action: 'edit', targetMessageId: u1.id, observedForkTipId: a1.id },
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
        regenerate: { action: 'edit', targetMessageId: forkUser, observedForkTipId: forkAssistant },
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

  /** Seeds a message row with one content item under `parentId`; returns both ids. */
  async function seedBranchMessage(
    fixture: Fixture,
    parentId: string,
    sequenceNumber: number,
    sender: { readonly senderType: 'user' | 'assistant'; readonly senderId: string | null }
  ): Promise<{ readonly messageId: string; readonly contentItemId: string }> {
    const messageRows = await db
      .insert(messages)
      .values({
        conversationId: fixture.conversationId,
        senderType: sender.senderType,
        senderId: sender.senderId,
        wrappedContentKey: BYTES,
        epochNumber: 1,
        sequenceNumber,
        parentMessageId: parentId,
      })
      .returning({ id: messages.id });
    const messageId = messageRows[0]?.id;
    if (messageId === undefined) throw new Error('branch message seed failed');
    const contentRows = await db
      .insert(contentItems)
      .values({ messageId, contentType: 'text', position: 0, encryptedBlob: BYTES })
      .returning({ id: contentItems.id });
    const contentItemId = contentRows[0]?.id;
    if (contentItemId === undefined) throw new Error('branch content seed failed');
    return { messageId, contentItemId };
  }

  it('terminal-fails and deletes nothing when the live fork tip moved off the guard-observed tip', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser, forkAssistant } = await seedForkTip(fixture);
    // A co-member appends a branch onto the fork's tip; the attacker then
    // repoints the fork tip onto that victim branch. The guard validated the
    // deletable tail against the OLD tip (`forkAssistant`); the delete would now
    // be computed from the MOVED tip and sweep the victim's messages.
    const rowsBefore = await messagesInOrder(fixture.conversationId);
    const maxSeq = Math.max(...rowsBefore.map((row) => row.sequenceNumber));
    const victimUser = await seedBranchMessage(fixture, forkAssistant, maxSeq + 1, {
      senderType: 'user',
      senderId: ASSISTANT_SENDER_ID,
    });
    const victimAssistant = await seedBranchMessage(fixture, victimUser.messageId, maxSeq + 2, {
      senderType: 'assistant',
      senderId: ASSISTANT_SENDER_ID,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: victimAssistant.messageId })
      .where(eq(conversationForks.id, forkId));
    const ledgerBefore = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, fixture.walletId));

    const runId = crypto.randomUUID();
    // A co-member spliced the tip after the regenerate guard validated its tail
    // — an ordinary TOCTOU race → friendly FORK_TIP_CONFLICT, never INTERNAL.
    await expectSettlementConflict(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          forkId,
          regenerate: {
            action: 'retry',
            targetMessageId: forkUser,
            observedForkTipId: forkAssistant,
          },
        })(tx, request('k-fork-tip-moved'))
      ),
      ERROR_CODES.FORK_TIP_CONFLICT
    );

    // The victim's messages and content items survive; nothing new persisted.
    const surviving = ids(await messagesInOrder(fixture.conversationId));
    expect(surviving).toContain(victimUser.messageId);
    expect(surviving).toContain(victimAssistant.messageId);
    const survivingContent = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(inArray(contentItems.id, [victimUser.contentItemId, victimAssistant.contentItemId]));
    expect(survivingContent).toHaveLength(2);
    // No charge landed, no ledger legs, and the moved tip was NOT advanced.
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    const ledgerAfter = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, fixture.walletId));
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(await forkTip(forkId)).toBe(victimAssistant.messageId);
  });

  it('terminal-fails when the observed tip is null but the live tip is a real message', async () => {
    const fixture = await seedFixture();
    const { forkId, forkUser } = await seedForkTip(fixture);

    const runId = crypto.randomUUID();
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          forkId,
          regenerate: { action: 'retry', targetMessageId: forkUser, observedForkTipId: null },
        })(tx, request('k-fork-observed-null'))
      )
    ).rejects.toThrow(/fork tip/i);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('settles a null-tipped fork retry-all when the observed tip is also null', async () => {
    const fixture = await seedFixture();
    const [, a1] = await seedTurns(fixture, 1);
    if (!a1) throw new Error('expected a seeded assistant');
    // A fresh fork with no tip yet: the guard observed a null tip, and the live
    // locked tip is null too — the null-safe assertion passes and it settles.
    const forkId = await seedFork(fixture.conversationId, null, 'FreshNull');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        forkId,
        regenerate: { action: 'retry', targetMessageId: a1.id, observedForkTipId: null },
      })(tx, request('k-fork-both-null'))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const reply = rows.find((row) => row.parentMessageId === a1.id);
    expect(reply).toBeDefined();
    expect(await forkTip(forkId)).toBe(reply?.id);
  });
});

function multiCharge(key: string, cost: bigint): SettlementCharge {
  return {
    key,
    modelId: `${key}-model`,
    providerName: PROVIDER_NAME,
    modality: 'text',
    generationId: `gen-${key}`,
    baseCostNanoUsd: cost,
    isEstimated: false,
  };
}

/**
 * A multi-model settlement request: one charge + one text output per selected
 * model that produced content. The interpreter surfaces each sibling node's
 * output keyed by its node id (the charge key), which the settlement pairs to
 * the assistant message it mints for that node.
 */
function multiRequest(
  runKey: string,
  entries: readonly { readonly key: string; readonly text: string; readonly cost: bigint }[]
): SettlementRequest {
  const outputs: Record<string, { readonly kind: 'text'; readonly text: string }> = {};
  for (const entry of entries) outputs[entry.key] = { kind: 'text', text: entry.text };
  return { runKey, outputs, charges: entries.map((entry) => multiCharge(entry.key, entry.cost)) };
}

describe('chat settlement commit (multi-model siblings)', () => {
  it('persists one assistant sibling per charge under one user message, batched and consecutive', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const userMessageId = crypto.randomUUID();
    const entries = [
      { key: 'answer0', text: 'from-model-a', cost: 100n },
      { key: 'answer1', text: 'from-model-b', cost: 200n },
      { key: 'answer2', text: 'from-model-c', cost: 300n },
    ] as const;

    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      })(tx, multiRequest('mk', entries))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    // One user message + one assistant sibling per model.
    expect(rows).toHaveLength(4);
    const [user, ...siblings] = rows;
    if (!user || siblings.length !== 3)
      throw new Error('expected a user message and three siblings');
    expect(user.id).toBe(userMessageId);
    expect(user.senderType).toBe('user');

    for (const [index, sibling] of siblings.entries()) {
      // Every sibling is an assistant reply chained onto the ONE user message,
      // sharing the turn's batch id, at the next consecutive sequence.
      expect(sibling.senderType).toBe('assistant');
      expect(sibling.senderId).toBe(ASSISTANT_SENDER_ID);
      expect(sibling.parentMessageId).toBe(user.id);
      expect(sibling.batchId).toBe(user.batchId);
      expect(sibling.sequenceNumber).toBe(user.sequenceNumber + 1 + index);
    }
    // Distinct message ids — each model's answer is independently addressable.
    expect(new Set(ids(siblings)).size).toBe(3);

    // One usage record per successful model, summing the three charged costs.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(3);
    const debitByModel = new Map(usage.map((row) => [row.modelId, row.costNanoUsd]));

    // Each sibling carries exactly its own model's content, and its displayed cost
    // EQUALS the wallet debit that generation posted (marked-up model cost plus its
    // own storage fee — the primary sibling additionally bears the shared prompt).
    for (const [index, sibling] of siblings.entries()) {
      const entry = entries[index];
      if (entry === undefined) throw new Error('missing entry');
      const content = first(
        await db.select().from(contentItems).where(eq(contentItems.messageId, sibling.id)),
        'sibling content'
      );
      expect(content.modelId).toBe(`${entry.key}-model`);
      expect(content.costNanoUsd).toBe(debitByModel.get(`${entry.key}-model`));
    }
    const totalBilled = usage.reduce((sum, row) => sum + row.costNanoUsd, 0n);
    // Storage fee: the shared prompt is stored once (on the primary charge) plus
    // each surviving sibling's own response text — never marked up.
    const multiStorageFee =
      BigInt(
        PROMPT.length + 'from-model-a'.length + 'from-model-b'.length + 'from-model-c'.length
      ) * STORAGE_COST_PER_CHARACTER_NANO;
    expect(totalBilled).toBe(
      applyMarkup(100n) + applyMarkup(200n) + applyMarkup(300n) + multiStorageFee
    );

    // Every charge's ledger legs are double-entry and sum to zero.
    for (const record of usage) {
      const legs = await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.usageRecordId, record.id));
      expect(legs).toHaveLength(2);
      expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
    }
  });

  it('persists and bills only the successful subset when a model produced no charge', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // Model B failed: it surfaced no charge (and no output), so only two of the
    // three selected models appear in the settlement request.
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(
        tx,
        multiRequest('mk', [
          { key: 'answer0', text: 'from-model-a', cost: 100n },
          { key: 'answer2', text: 'from-model-c', cost: 300n },
        ])
      )
    );

    const rows = await messagesInOrder(fixture.conversationId);
    // Only the two successful models produced a message; the failed one did not.
    expect(rows.filter((row) => row.senderType === 'assistant')).toHaveLength(2);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    // Storage fee: shared prompt once plus the two surviving siblings' responses.
    const survivingStorageFee =
      BigInt(PROMPT.length + 'from-model-a'.length + 'from-model-c'.length) *
      STORAGE_COST_PER_CHARACTER_NANO;
    expect(usage.reduce((sum, row) => sum + row.costNanoUsd, 0n)).toBe(
      applyMarkup(100n) + applyMarkup(300n) + survivingStorageFee
    );
  });

  it('advances a fork tip to the LAST sibling of a multi-model batch', async () => {
    const fixture = await seedFixture();
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores())(tx, request('k-seed'))
    );
    const seeded = await messagesInOrder(fixture.conversationId);
    const priorAssistant = seeded.at(-1);
    if (!priorAssistant) throw new Error('expected a seeded assistant tip');
    const forkId = await seedFork(fixture.conversationId, priorAssistant.id, 'Branch');

    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { forkId })(
        tx,
        multiRequest('mk-fork', [
          { key: 'answer0', text: 'a0', cost: 100n },
          { key: 'answer1', text: 'a1', cost: 200n },
        ])
      )
    );

    const rows = await messagesInOrder(fixture.conversationId);
    const siblings = rows.filter(
      (row) => row.senderType === 'assistant' && row.id !== priorAssistant.id
    );
    expect(siblings).toHaveLength(2);
    const lastSibling = siblings.at(-1);
    if (!lastSibling) throw new Error('expected fork siblings');
    // The fork tip advances to the LAST sibling, not the first — the whole batch
    // is the new tip so a subsequent send chains onto it.
    expect(await forkTip(forkId)).toBe(lastSibling.id);
  });

  it('regenerates one sibling of a multi-model batch, leaving the others intact', async () => {
    const fixture = await seedFixture();
    const userMessageId = crypto.randomUUID();
    // Persist a 3-model batch: one user message, three sibling replies chained
    // onto it, each with a distinct id.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
      })(
        tx,
        multiRequest('batch', [
          { key: 'answer0', text: 'a0', cost: 100n },
          { key: 'answer1', text: 'a1', cost: 200n },
          { key: 'answer2', text: 'a2', cost: 300n },
        ])
      )
    );
    const batch = await messagesInOrder(fixture.conversationId);
    const siblings = batch.filter((row) => row.senderType === 'assistant');
    const [first, target, last] = siblings;
    if (!first || !target || !last) throw new Error('expected three siblings');

    // Retry-one targets exactly that sibling: it keeps the user message anchor,
    // deletes only the named sibling, and persists a fresh single reply onto it.
    await runSettlement(db, (tx) =>
      commitFor(fixture, crypto.randomUUID(), createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
        regenerate: {
          action: 'retry',
          targetMessageId: userMessageId,
          replaceAssistantId: target.id,
        },
      })(tx, request('regen'))
    );

    const after = await messagesInOrder(fixture.conversationId);
    const afterIds = new Set(ids(after));
    // The targeted sibling is gone; the other two are untouched.
    expect(afterIds.has(target.id)).toBe(false);
    expect(afterIds.has(first.id)).toBe(true);
    expect(afterIds.has(last.id)).toBe(true);
    // A fresh reply took its place, chained onto the same user message — so the
    // batch still has three sibling replies under the one user message.
    const replies = after.filter(
      (row) => row.senderType === 'assistant' && row.parentMessageId === userMessageId
    );
    expect(replies).toHaveLength(3);
    expect(replies.some((reply) => reply.id === target.id)).toBe(false);
  });
});

describe('group-budget accrual (owner-funded, cumulative)', () => {
  const stores = createBillingStores();
  // The full charged amount for a single-model turn (marked-up model cost + the
  // additive prompt+answer storage fee) — the exact value both the member and
  // conversation spend rows accrue.
  const perTurnCharge = applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE;

  /**
   * A GROUP turn fixture: a distinct owner (the payer, with the wallet) and a
   * distinct sender (a member the owner funds for). The returned `Fixture` binds
   * `userId` to the SENDER and `walletId` to the OWNER's wallet — exactly the
   * split production wires (owner pays, sender is attributed).
   */
  async function seedGroupFixture(options: {
    readonly conversationBudgetNanoUsd: bigint;
    readonly memberBudgetNanoUsd?: bigint;
  }): Promise<Fixture> {
    const owner = await seedFixture();
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: options.conversationBudgetNanoUsd })
      .where(eq(conversations.id, owner.conversationId));
    const senderId = await insertTestUser();
    const memberRows = await db
      .insert(conversationMembers)
      .values({ conversationId: owner.conversationId, userId: senderId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });
    const memberId = first(memberRows, 'member').id;
    if (options.memberBudgetNanoUsd !== undefined) {
      await db.insert(memberBudgets).values({
        memberId,
        budgetNanoUsd: options.memberBudgetNanoUsd,
        spentNanoUsd: 0n,
      });
    }
    return {
      userId: senderId,
      walletId: owner.walletId,
      conversationId: owner.conversationId,
      memberId,
      epochPrivateKey: owner.epochPrivateKey,
      epochPublicKey: owner.epochPublicKey,
    };
  }

  async function memberBudgetRow(memberId: string) {
    const rows = await db
      .select({
        budgetNanoUsd: memberBudgets.budgetNanoUsd,
        spentNanoUsd: memberBudgets.spentNanoUsd,
      })
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, memberId));
    return rows[0] ?? null;
  }

  async function conversationSpendingRow(conversationId: string) {
    const rows = await db
      .select({ spentNanoUsd: conversationSpending.spentNanoUsd })
      .from(conversationSpending)
      .where(eq(conversationSpending.conversationId, conversationId));
    return rows[0] ?? null;
  }

  async function runUsageTotal(runId: string): Promise<bigint> {
    const rows = await db
      .select({ cost: usageRecords.costNanoUsd })
      .from(usageRecords)
      .where(eq(usageRecords.runId, runId));
    return rows.reduce((sum, row) => sum + row.cost, 0n);
  }

  async function settleTurn(
    fixture: Fixture,
    req: SettlementRequest,
    ownerFunded: ResultAsync<boolean, never> = okAsync(true)
  ): Promise<string> {
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, req.runKey, runId);
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        ownerFunded,
      }),
    });
    await hook(req);
    return runId;
  }

  it('accrues the charge cumulatively to the member and conversation rows (no period) and preserves the owner-set cap', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 5_000_000n,
      memberBudgetNanoUsd: 1_000_000n,
    });
    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    // A spend never clobbers the owner-set cap — the ON CONFLICT path touches
    // only spent.
    expect(member?.budgetNanoUsd).toBe(1_000_000n);
    expect(member?.spentNanoUsd).toBe(perTurnCharge);
    const conversation = await conversationSpendingRow(fixture.conversationId);
    expect(conversation?.spentNanoUsd).toBe(perTurnCharge);
  });

  it('creates the member row with the zero insert-default cap when none was pre-configured (insert path)', async () => {
    const fixture = await seedGroupFixture({ conversationBudgetNanoUsd: 5_000_000n });
    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    // The insert-path cap is the zero insert-default 0 — never the permissive
    // conversation budget.
    expect(member?.budgetNanoUsd).toBe(0n);
    expect(member?.spentNanoUsd).toBe(perTurnCharge);
  });

  it('accumulates across successive turns so the admission read refuses once the per-member cap is reached', async () => {
    // Cap = two turns' charge + 700n headroom; two turns consume it down to 700n,
    // so a third turn estimated above 700n is refused by the per-member scope
    // (owner balance and conversation cap are both ample).
    const cap = perTurnCharge * 2n + 700n;
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: perTurnCharge * 10n,
      memberBudgetNanoUsd: cap,
    });
    await settleTurn(fixture, request(crypto.randomUUID()));
    await settleTurn(fixture, request(crypto.randomUUID()));

    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(perTurnCharge * 2n);
    // The cap is unchanged after the accruals — read back from the durable row,
    // never re-derived from the conversation budget.
    expect(member?.budgetNanoUsd).toBe(cap);

    // The production admission read: BOTH group scopes, cap read from the durable
    // member row (no cap argument), then gate the next run.
    const scopesResult = await resolveBudgetScopes(stores, db, {
      now: NOW,
      memberBudget: { memberId: fixture.memberId },
      conversationBudget: {
        conversationId: fixture.conversationId,
        capNanoUsd: perTurnCharge * 10n,
      },
    });
    const scopes = scopesResult._unsafeUnwrap();
    const memberScope = scopes.find((scope) => scope.scopeId.startsWith('member:'));
    expect(memberScope?.remainingNanoUsd).toBe(700n);

    const admissionDeps = { redis, db, stores };
    const overResult = await admitRun(admissionDeps, {
      walletId: fixture.walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: 1000n,
      deadlineSeconds: 300,
      concurrentRunCap: 10,
      budgets: scopes,
      now: NOW,
    });
    expect(overResult._unsafeUnwrap()).toEqual({ admitted: false, reason: 'budget-exceeded' });

    const withinResult = await admitRun(admissionDeps, {
      walletId: fixture.walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: 500n,
      deadlineSeconds: 300,
      concurrentRunCap: 10,
      budgets: scopes,
      now: NOW,
    });
    expect(withinResult._unsafeUnwrap().admitted).toBe(true);
  });

  it('writes no member or conversation spend for an owner-initiated (solo) turn', async () => {
    // Owner == sender: the owner funds and is not member-capped, so no group
    // spend is written (the owner path is personal).
    const fixture = await seedFixture();
    await settleTurn(fixture, request(crypto.randomUUID()));
    expect(await memberBudgetRow(fixture.memberId)).toBeNull();
    expect(await conversationSpendingRow(fixture.conversationId)).toBeNull();
  });

  /**
   * A PERSONAL fall-through group fixture: a distinct owner (conversation +
   * epoch) and a distinct member SENDER who has their OWN purchased wallet and
   * pays for themselves. `walletId` binds to the SENDER's wallet (not the
   * owner's) — exactly the payer the route freezes when the group headroom fell
   * to ≤ 0, so settlement recovers "personal" and accrues no group spend.
   */
  async function seedPersonalGroupFixture(): Promise<Fixture> {
    const owner = await seedFixture();
    const senderId = await insertTestUser();
    const senderWalletRows = await db
      .insert(wallets)
      .values({ userId: senderId, type: 'purchased', balanceNanoUsd: 10_000_000n })
      .returning({ id: wallets.id });
    const senderWalletId = first(senderWalletRows, 'sender wallet').id;
    const memberRows = await db
      .insert(conversationMembers)
      .values({ conversationId: owner.conversationId, userId: senderId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });
    const memberId = first(memberRows, 'member').id;
    return {
      userId: senderId,
      walletId: senderWalletId,
      conversationId: owner.conversationId,
      memberId,
      epochPrivateKey: owner.epochPrivateKey,
      epochPublicKey: owner.epochPublicKey,
    };
  }

  it('self-funds a group turn on the sender own wallet and writes NO group spend (personal fall-through)', async () => {
    // The payer is the SENDER's own wallet (route fell through: group headroom
    // ≤ 0). Settlement recovers "personal", so the charge hits the sender's
    // wallet and neither the member nor the conversation spend row moves.
    const fixture = await seedPersonalGroupFixture();
    const runId = await settleTurn(fixture, request(crypto.randomUUID()), okAsync(false));

    expect(await runUsageTotal(runId)).toBe(perTurnCharge);
    // No group attribution: the (absent) member row stays absent and the
    // conversation spend row is never written.
    expect(await memberBudgetRow(fixture.memberId)).toBeNull();
    expect(await conversationSpendingRow(fixture.conversationId)).toBeNull();
    // The charge landed on the sender's OWN wallet (the personal payer).
    const legs = await db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, fixture.walletId));
    expect(legs.length).toBeGreaterThan(0);
  });

  it('attributes a multi-model turn as the sum of its siblings under one member row and one conversation row', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 10_000_000n,
      memberBudgetNanoUsd: 10_000_000n,
    });
    const runId = await settleTurn(fixture, multiModelRequest(crypto.randomUUID(), 1000n, 2000n));
    const total = await runUsageTotal(runId);

    // Attributed once per generation, never double-counted: the durable member
    // and conversation rows each hold the run's full charged sum.
    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(total);
    const conversation = await conversationSpendingRow(fixture.conversationId);
    expect(conversation?.spentNanoUsd).toBe(total);
    // The sum exceeds the bare marked-up model costs (storage rides along).
    expect(total).toBeGreaterThan(applyMarkup(1000n) + applyMarkup(2000n));
  });

  it('writes no member spend when the settlement transaction rolls back (saved ⟺ billed)', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 5_000_000n,
      memberBudgetNanoUsd: 1_000_000n,
    });
    const runId = crypto.randomUUID();
    const runKey = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    // A persist failure throws inside the settlement transaction, rolling the
    // whole commit back — no message, no charge, and no member spend accrual.
    const boomStores: ChatStores = {
      ...createChatStores(),
      insertMessageWithinTx: () => Promise.reject(new Error('persist boom')),
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, boomStores, {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        ownerFunded: okAsync(true),
      }),
    });
    await expect(hook(request(runKey))).rejects.toThrow(/persist boom/);
    // The pre-seeded row still exists but its spend never moved off zero.
    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(0n);
    expect(await conversationSpendingRow(fixture.conversationId)).toBeNull();
  });

  it('rolls the whole settlement back when the group-attribution read fails', async () => {
    const fixture = await seedGroupFixture({
      conversationBudgetNanoUsd: 5_000_000n,
      memberBudgetNanoUsd: 1_000_000n,
    });
    const runId = crypto.randomUUID();
    const runKey = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    // The conversation read for group attribution runs inside the settlement
    // transaction; an infra failure there throws and rolls the whole commit back
    // — nothing persisted, nothing charged, no spend moved.
    const faultingConversationsStores = (
      tx: SettlementTx
    ): ReturnType<typeof createConversationsStores> => {
      const real = createConversationsStores(tx);
      return {
        ...real,
        conversations: {
          ...real.conversations,
          get: () => errAsync(unavailableError('member-budget read boom')),
        },
      };
    };
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
        ownerFunded: okAsync(true),
        conversationsStores: faultingConversationsStores,
      }),
    });
    await expect(hook(request(runKey))).rejects.toThrow(/member-budget read failed/);
    const member = await memberBudgetRow(fixture.memberId);
    expect(member?.spentNanoUsd).toBe(0n);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  });

  it('owner-funds a link-guest turn: charges the OWNER, records the guest as sender, accrues member spend', async () => {
    const owner = await seedFixture();
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 5_000_000n })
      .where(eq(conversations.id, owner.conversationId));
    // The shared link, its WRITE guest member, and the guest key in epoch 1's
    // authoritative wrap-set (what the member-keyed epoch gate verifies).
    const linkKey = crypto.getRandomValues(new Uint8Array(32));
    const linkRows = await db
      .insert(sharedLinks)
      .values({
        conversationId: owner.conversationId,
        linkPublicKey: linkKey,
        displayName: 'Guest',
      })
      .returning({ id: sharedLinks.id });
    const linkId = first(linkRows, 'shared link').id;
    const guestMemberRows = await db
      .insert(conversationMembers)
      .values({
        conversationId: owner.conversationId,
        linkId,
        privilege: 'write',
        visibleFromEpoch: 1,
      })
      .returning({ id: conversationMembers.id });
    const guestMemberId = first(guestMemberRows, 'guest member').id;
    await db
      .insert(memberBudgets)
      .values({ memberId: guestMemberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });
    const epochRows = await db
      .select({ id: epochs.id })
      .from(epochs)
      .where(and(eq(epochs.conversationId, owner.conversationId), eq(epochs.epochNumber, 1)));
    await db.insert(epochMembers).values({
      epochId: first(epochRows, 'epoch').id,
      memberPublicKey: linkKey,
      wrap: BYTES,
      visibleFromEpoch: 1,
    });

    const runId = crypto.randomUUID();
    const fence = await claimFence(owner.userId, 'guest-run', runId);
    const userMessageId = crypto.randomUUID();
    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      // The OWNER pays (identity.userId + walletId), the guest is the sender.
      commit: commitFor(owner, runId, createChatStores(), {
        userMessage: { id: userMessageId, content: PROMPT },
        sender: { kind: 'linkGuest', linkId, memberId: guestMemberId },
        ownerFunded: okAsync(true),
      }),
    });
    await hook(request('guest-run'));

    // The user message records the GUEST (linkId) as sender, and its content
    // decrypts with the guest bound as the AAD sender.
    const userRows = await db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        wrappedContentKey: messages.wrappedContentKey,
      })
      .from(messages)
      .where(
        and(eq(messages.conversationId, owner.conversationId), eq(messages.senderType, 'user'))
      );
    const userMsg = first(userRows, 'user message');
    expect(userMsg.senderId).toBe(linkId);
    const userContentRows = await db
      .select({ id: contentItems.id, encryptedBlob: contentItems.encryptedBlob })
      .from(contentItems)
      .where(eq(contentItems.messageId, userMsg.id));
    expect(decryptItem(owner, userMsg, first(userContentRows, 'user content'), linkId)).toBe(
      PROMPT
    );

    // The OWNER's wallet is charged (the guest holds none).
    const ownerWalletRows = await db
      .select({ balance: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, owner.walletId));
    expect(first(ownerWalletRows, 'owner wallet').balance).toBe(10_000_000n - perTurnCharge);
    // Per-member and per-conversation spend accrue to the GUEST's member row.
    const guestMember = await memberBudgetRow(guestMemberId);
    expect(guestMember?.spentNanoUsd).toBe(perTurnCharge);
    const conversationSpend = await conversationSpendingRow(owner.conversationId);
    expect(conversationSpend?.spentNanoUsd).toBe(perTurnCharge);
  });
});

describe('chat settlement commit (display-cost mirror invariant)', () => {
  // The denormalized display column (`content_items.cost_nano_usd`) must, per
  // run, sum to the exact total the debit path posts (`usage_records`), for every
  // turn shape. This closes the sole weakness of a denormalized mirror — drift:
  // a forgotten or mis-anchored charge type would break this invariant.
  async function sumAssistantDisplayCost(conversationId: string): Promise<bigint> {
    const rows = await db
      .select({ cost: contentItems.costNanoUsd })
      .from(contentItems)
      .innerJoin(messages, eq(contentItems.messageId, messages.id))
      .where(eq(messages.conversationId, conversationId));
    return rows.reduce((sum, row) => sum + (row.cost ?? 0n), 0n);
  }

  async function sumRunDebit(runId: string): Promise<bigint> {
    const rows = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    return rows.reduce((sum, row) => sum + row.costNanoUsd, 0n);
  }

  async function settleAndAssertInvariant(req: SettlementRequest): Promise<void> {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(tx, req)
    );
    expect(await sumAssistantDisplayCost(fixture.conversationId)).toBe(await sumRunDebit(runId));
  }

  it('mirrors the debit total for a single-model turn', async () => {
    await settleAndAssertInvariant(request('inv-single'));
  });

  it('mirrors the debit total for an agentic pre-summed turn', async () => {
    // Agentic multi-step / web search settles as ONE pre-summed charge — the same
    // settlement shape as a single-model turn, at a distinct cost.
    await settleAndAssertInvariant({
      runKey: 'inv-agentic',
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [{ ...charge(), baseCostNanoUsd: 4242n }],
    });
  });

  it('mirrors the debit total for a multi-model fan-out turn', async () => {
    await settleAndAssertInvariant(multiModelRequest('inv-multi', 111n, 222n));
  });

  it('mirrors the debit total for a Smart Model turn', async () => {
    await settleAndAssertInvariant({
      runKey: 'inv-smart',
      outputs: { answer: { kind: 'text', text: ANSWER } },
      charges: [
        charge(),
        {
          key: 'answer#classifier',
          modelId: 'chat-settle/classifier',
          providerName: PROVIDER_NAME,
          modality: 'text',
          generationId: 'gen-inv-cls',
          baseCostNanoUsd: 77n,
          isEstimated: false,
        },
      ],
    });
  });

  it('excludes a non-anchoring charge from display cost and leaves the item not smart', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    // A text answer plus a standalone MEDIA charge whose node surfaced no output
    // (a media charge WITH an output now persists under its pre-minted plan): the
    // outputless charge anchors to nothing, so it neither debits nor inflates the
    // answer's display cost, and the answer item is not a Smart Model turn.
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        userMessage: { id: crypto.randomUUID(), content: PROMPT },
      })(tx, {
        runKey: 'inv-orphan',
        outputs: {
          answer: { kind: 'text', text: ANSWER },
        },
        charges: [
          charge(),
          {
            key: 'media',
            modelId: 'chat-settle/media',
            providerName: PROVIDER_NAME,
            modality: 'image',
            generationId: 'gen-media',
            baseCostNanoUsd: 500n,
            isEstimated: false,
          },
        ],
      })
    );
    const rows = await messagesInOrder(fixture.conversationId);
    const assistant = rows.find((row) => row.senderType === 'assistant');
    if (!assistant) throw new Error('expected an assistant message');
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistant.id)),
      'assistant content'
    );
    // Only the text answer's own charge — the media charge contributes nothing.
    expect(content.costNanoUsd).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
    expect(content.isSmartModel).toBe(false);
    // The debit path likewise skipped the non-anchoring media charge.
    expect(await sumRunDebit(runId)).toBe(applyMarkup(BASE_COST) + PROMPT_ANSWER_STORAGE);
  });
});

const MEDIA_MODEL_ID = 'chat-settle/media-model';
const MEDIA_BYTES = 4096;
/** The additive storage fee for a single-charge media turn: prompt chars + ciphertext bytes. */
const MEDIA_TURN_STORAGE = (byteLength: number): bigint =>
  BigInt(PROMPT.length) * STORAGE_COST_PER_CHARACTER_NANO +
  BigInt(byteLength) * MEDIA_STORAGE_COST_PER_BYTE_NANO;

/** One media generation's settlement triple: pre-minted plan, charge, and final output. */
interface MediaTurnPiece {
  readonly plan: MediaPersistPlan;
  readonly charge: SettlementCharge;
  readonly output: Extract<ContentValue, { kind: 'media' }>;
}

function mediaTurn(
  fixture: Fixture,
  key: string,
  options: {
    readonly modality?: 'image' | 'video';
    /** The MediaValue's own modality when it must diverge from the charge's. */
    readonly valueModality?: 'image' | 'video' | 'audio';
    readonly isEstimated?: boolean;
    readonly baseCostNanoUsd?: bigint;
    readonly byteLength?: number;
    readonly metadata?: Record<string, unknown>;
  } = {}
): MediaTurnPiece {
  const assistantMessageId = crypto.randomUUID();
  const contentItemId = crypto.randomUUID();
  // The plan's key was wrapped to epoch 1 at run start, exactly as the media
  // mint does — settlement persists it verbatim, never re-wrapping.
  const wrappedContentKey = wrapContentKeyToEpoch(fixture.epochPublicKey, generateContentKey());
  const modality = options.modality ?? 'image';
  const valueModality = options.valueModality ?? modality;
  return {
    plan: { assistantMessageId, contentItemId, epochNumber: 1, wrappedContentKey },
    charge: {
      key,
      modelId: MEDIA_MODEL_ID,
      providerName: PROVIDER_NAME,
      modality,
      generationId: `gen-${key}`,
      baseCostNanoUsd: options.baseCostNanoUsd ?? BASE_COST,
      isEstimated: options.isEstimated ?? true,
    },
    output: {
      kind: 'media',
      value: {
        // The strict full-key equality the persist primitive enforces.
        ref: `media/${fixture.conversationId}/${assistantMessageId}/${contentItemId}`,
        mimeType: modality === 'video' ? 'video/mp4' : 'image/png',
        modality: valueModality,
        byteLength: options.byteLength ?? MEDIA_BYTES,
        metadata: options.metadata ?? {},
      },
    },
  };
}

function mediaRequest(runKey: string, pieces: readonly MediaTurnPiece[]): SettlementRequest {
  return {
    runKey,
    outputs: Object.fromEntries(pieces.map((piece) => [piece.charge.key, piece.output])),
    charges: pieces.map((piece) => piece.charge),
  };
}

function plansOf(pieces: readonly MediaTurnPiece[]): ReadonlyMap<string, MediaPersistPlan> {
  return new Map(pieces.map((piece) => [piece.charge.key, piece.plan]));
}

function bytesOf(value: Uint8Array | null): number[] {
  if (value === null) throw new Error('expected bytes');
  return [...value];
}

describe('chat settlement commit (media persistence)', () => {
  it('persists a media content item under the pre-minted plan and bills its charge', async () => {
    const fixture = await seedFixture();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimFence(fixture.userId, runKey, runId);
    const piece = mediaTurn(fixture, 'image-node');

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) }),
    });
    await hook(mediaRequest(runKey, [piece]));

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    const [userMessage, assistantMessage] = rows;
    if (!userMessage || !assistantMessage) throw new Error('expected two messages');

    // The assistant sibling rides the PRE-MINTED message id and the pre-supplied
    // run-start wrapped content key, batched with the user message it chains onto.
    expect(assistantMessage.id).toBe(piece.plan.assistantMessageId);
    expect(assistantMessage.senderType).toBe('assistant');
    expect(assistantMessage.senderId).toBe(ASSISTANT_SENDER_ID);
    expect(assistantMessage.parentMessageId).toBe(userMessage.id);
    expect(assistantMessage.batchId).toBe(userMessage.batchId);
    expect(bytesOf(assistantMessage.wrappedContentKey)).toEqual([...piece.plan.wrappedContentKey]);

    // The content item: pre-minted id, R2 facts straight from the MediaValue,
    // dims null (empty metadata), no encrypted blob (ciphertext lives in R2).
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.messageId, assistantMessage.id)),
      'media content'
    );
    expect(content.id).toBe(piece.plan.contentItemId);
    expect(content.contentType).toBe('image');
    expect(content.storageKey).toBe(piece.output.value.ref);
    expect(content.mimeType).toBe('image/png');
    expect(content.sizeBytes).toBe(MEDIA_BYTES);
    expect(content.width).toBeNull();
    expect(content.height).toBeNull();
    expect(content.durationMs).toBeNull();
    expect(content.encryptedBlob).toBeNull();
    expect(content.modelId).toBe(MEDIA_MODEL_ID);
    expect(content.providerName).toBe(PROVIDER_NAME);
    expect(content.isSmartModel).toBe(false);

    // BILLED: the charge anchored to the pre-minted item (the pairing), at the
    // deterministic image estimate — marked-up base plus prompt + byte storage.
    const expectedCost = applyMarkup(BASE_COST) + MEDIA_TURN_STORAGE(MEDIA_BYTES);
    expect(content.costNanoUsd).toBe(expectedCost);
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    expect(usage.contentItemId).toBe(piece.plan.contentItemId);
    expect(usage.isEstimated).toBe(true);
    expect(usage.costNanoUsd).toBe(expectedCost);

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
  });

  it('persists a video item with metadata dims and bills its inline (non-estimated) cost', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'video-node', {
      modality: 'video',
      isEstimated: false,
      byteLength: 9999,
      metadata: { width: 1280, height: 720, durationMs: 5000 },
    });
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) })(
        tx,
        mediaRequest('k-video', [piece])
      )
    );
    const content = first(
      await db.select().from(contentItems).where(eq(contentItems.id, piece.plan.contentItemId)),
      'video content'
    );
    expect(content.contentType).toBe('video');
    expect(content.mimeType).toBe('video/mp4');
    expect(content.sizeBytes).toBe(9999);
    expect(content.width).toBe(1280);
    expect(content.height).toBe(720);
    expect(content.durationMs).toBe(5000);
    const usage = first(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, runId)),
      'usage'
    );
    expect(usage.isEstimated).toBe(false);
    expect(usage.costNanoUsd).toBe(applyMarkup(BASE_COST) + MEDIA_TURN_STORAGE(9999));
    expect(content.costNanoUsd).toBe(usage.costNanoUsd);
  });

  it('persists sibling media messages sharing one batch and bills each against its own item', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const firstPiece = mediaTurn(fixture, 'node-a');
    const secondPiece = mediaTurn(fixture, 'node-b', { baseCostNanoUsd: 700n });
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        mediaPlans: plansOf([firstPiece, secondPiece]),
      })(tx, mediaRequest('k-multi', [firstPiece, secondPiece]))
    );

    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(3);
    const [userMessage, siblingA, siblingB] = rows;
    if (!userMessage || !siblingA || !siblingB) throw new Error('expected three messages');
    // Charge-order siblings under the pre-minted ids, all sharing the turn's batch.
    expect(siblingA.id).toBe(firstPiece.plan.assistantMessageId);
    expect(siblingB.id).toBe(secondPiece.plan.assistantMessageId);
    expect(siblingA.parentMessageId).toBe(userMessage.id);
    expect(siblingB.parentMessageId).toBe(userMessage.id);
    expect(siblingA.batchId).toBe(userMessage.batchId);
    expect(siblingB.batchId).toBe(userMessage.batchId);

    // Each charge billed against its own pre-minted content item.
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(2);
    expect(new Set(usage.map((record) => record.contentItemId))).toEqual(
      new Set([firstPiece.plan.contentItemId, secondPiece.plan.contentItemId])
    );
  });

  it('persists and bills only the successful subset when a media sibling failed', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const succeeded = mediaTurn(fixture, 'node-ok');
    const failed = mediaTurn(fixture, 'node-dead');
    // Both nodes were planned at run start, but only one produced a charge +
    // output (the other's provider call failed) — the successful subset settles.
    await runSettlement(db, (tx) =>
      commitFor(fixture, runId, createChatStores(), {
        mediaPlans: plansOf([succeeded, failed]),
      })(tx, mediaRequest('k-subset', [succeeded]))
    );
    const rows = await messagesInOrder(fixture.conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.id).toBe(succeeded.plan.assistantMessageId);
    const items = await db
      .select()
      .from(contentItems)
      .where(inArray(contentItems.id, [succeeded.plan.contentItemId, failed.plan.contentItemId]));
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(succeeded.plan.contentItemId);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
    expect(usage).toHaveLength(1);
  });

  it('terminal-fails a media charge with no persist plan and commits nothing', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'unplanned-node');
    // A media charge whose node was never minted a plan is a defect — the whole
    // settlement rolls back: no message, no content, no charge, no ledger legs.
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores())(tx, mediaRequest('k-noplan', [piece]))
      )
    ).rejects.toThrow(/no media persist plan/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  });

  it('terminal-fails a media plan carrying an empty wrapped content key', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'empty-key-node');
    // A mint-side bug handing settlement an empty wrapped key would persist a
    // permanently undecryptable message — the plan boundary rejects it instead.
    const emptyKeyPlan: MediaPersistPlan = { ...piece.plan, wrappedContentKey: new Uint8Array(0) };
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), {
          mediaPlans: new Map([[piece.charge.key, emptyKeyPlan]]),
        })(tx, mediaRequest('k-emptykey', [piece]))
      )
    ).rejects.toThrow(/empty wrapped content key/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  });

  it('terminal-fails a media output carrying an unsupported modality', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'audio-node', { valueModality: 'audio' });
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) })(
          tx,
          mediaRequest('k-audio', [piece])
        )
      )
    ).rejects.toThrow(/media modality/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
  });

  it('persists ZERO media rows when the epoch rotated between mint and settlement', async () => {
    const fixture = await seedFixture();
    const runId = crypto.randomUUID();
    const piece = mediaTurn(fixture, 'rotated-node');
    // The plan's key was wrapped to epoch 1 at run start; a rotation before
    // settlement must terminal-fail the run — the pre-wrapped key never bypasses
    // the member-keyed epoch-at-persist gate.
    await db
      .update(conversations)
      .set({ currentEpoch: 2 })
      .where(eq(conversations.id, fixture.conversationId));
    await expect(
      runSettlement(db, (tx) =>
        commitFor(fixture, runId, createChatStores(), { mediaPlans: plansOf([piece]) })(
          tx,
          mediaRequest('k-rotated', [piece])
        )
      )
    ).rejects.toThrow(/wrap-epoch/);
    expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.walletId, fixture.walletId))
    ).toHaveLength(0);
  });
});
