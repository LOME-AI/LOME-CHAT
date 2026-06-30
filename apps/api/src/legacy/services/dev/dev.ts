import { like, eq, count, inArray, and } from 'drizzle-orm';
import {
  users,
  wallets,
  ledgerEntries,
  conversations,
  messages,
  projects,
  epochs,
  epochMembers,
  conversationMembers,
  type Database,
  type DatabaseClient,
} from '@hushbox/db';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN, type DevPersona } from '@hushbox/shared';
import {
  createFirstEpoch,
  encryptTextForEpoch,
  beginMessageEnvelope,
  encryptBinaryWithContentKey,
} from '@hushbox/crypto';
import { checkUserBalance } from '../billing/index.js';
import { createOrGetConversation } from '../conversations/index.js';
import { saveUserOnlyMessage } from '../chat/index.js';
import {
  insertEnvelopeTextMessage,
  insertEnvelopeMediaMessage,
  assignSequenceNumbers,
  fetchEpochPublicKey,
} from '../chat/message-helpers.js';
import {
  TEST_IMAGE_BYTES,
  TEST_IMAGE_MIME,
  TEST_IMAGE_WIDTH,
  TEST_IMAGE_HEIGHT,
  TEST_VIDEO_BYTES,
  TEST_VIDEO_MIME,
  TEST_VIDEO_WIDTH,
  TEST_VIDEO_HEIGHT,
  TEST_VIDEO_DURATION_MS,
} from '../ai/mock-fixtures/index.js';
import { REDIS_REGISTRY } from '../../lib/redis-registry.js';
import type { MediaStorage } from '../storage/index.js';
import type { Redis } from '@upstash/redis';

export interface ResetTrialUsageResult {
  deleted: number;
}

export interface CleanupResult {
  conversations: number;
  messages: number;
}

/**
 * List dev or test personas with their stats.
 */
export async function listDevPersonas(db: Database, type: 'dev' | 'test'): Promise<DevPersona[]> {
  const emailDomain = type === 'test' ? TEST_EMAIL_DOMAIN : DEV_EMAIL_DOMAIN;

  const devUsers = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(like(users.email, `%@${emailDomain}`));

  const personas: DevPersona[] = await Promise.all(
    devUsers.map(async (user) => {
      const [convCount] = await db
        .select({ count: count() })
        .from(conversations)
        .where(eq(conversations.userId, user.id));

      const [msgCount] = await db
        .select({ count: count() })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.userId, user.id));

      const [projCount] = await db
        .select({ count: count() })
        .from(projects)
        .where(eq(projects.userId, user.id));

      const balanceResult = await checkUserBalance(db, user.id);
      const balanceNumber = Number.parseFloat(balanceResult.currentBalance);
      const formattedCredits = `$${balanceNumber.toFixed(2)}`;

      return {
        id: user.id,
        username: user.username,
        email: user.email ?? '', // Dev personas always have email (filtered by email domain)
        emailVerified: user.emailVerified,
        stats: {
          conversationCount: convCount?.count ?? 0,
          messageCount: msgCount?.count ?? 0,
          projectCount: projCount?.count ?? 0,
        },
        credits: formattedCredits,
      };
    })
  );

  return personas;
}

/**
 * Clean up test user data (conversations and messages).
 * Returns count of deleted items.
 */
export async function cleanupTestData(db: Database): Promise<CleanupResult> {
  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${TEST_EMAIL_DOMAIN}`));

  const testUserIds = testUsers.map((u) => u.id);

  if (testUserIds.length === 0) {
    return { conversations: 0, messages: 0 };
  }

  const testConvs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.userId, testUserIds));

  const convIds = testConvs.map((conv) => conv.id);

  if (convIds.length === 0) {
    return { conversations: 0, messages: 0 };
  }

  // Delete messages first (FK constraint)
  const msgResult = await db.delete(messages).where(inArray(messages.conversationId, convIds));
  const deletedMessages = msgResult.rowCount ?? 0;

  const convResult = await db.delete(conversations).where(inArray(conversations.id, convIds));
  const deletedConversations = convResult.rowCount ?? 0;

  return { conversations: deletedConversations, messages: deletedMessages };
}

/**
 * SCAN `count` hint for the dev reset endpoints. Far above the production
 * default: each SCAN is one HTTP round-trip through the Serverless Redis HTTP
 * proxy, and under E2E saturation that round-trip count — not Redis CPU — is the
 * cost. The usage reset runs before every test on every worker, so a high count
 * collapses each prefix's keyspace traversal to one or two round-trips instead
 * of dozens, keeping a saturated run's resets well inside the setup budget.
 * Server-side MATCH still scopes the response to matching keys, so the shared
 * dev Worker isolate never holds the whole keyspace in memory. Dev-only; never
 * runs against a production Redis.
 */
const RESET_SCAN_COUNT = 1000;

/**
 * Reset all trial usage records for testing purposes.
 * Scans Redis for trial:token:* and trial:ip:* keys and deletes them.
 */
export async function resetTrialUsage(redis: Redis): Promise<ResetTrialUsageResult> {
  let deleted = 0;
  let cursor: string | number = 0;

  do {
    const [nextCursor, keys]: [string, string[]] = await redis.scan(cursor, {
      match: 'trial:*',
      count: RESET_SCAN_COUNT,
    });
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');

  return { deleted };
}

export interface ResetAuthRateLimitsResult {
  deleted: number;
}

/**
 * Reset all auth-related rate limits, lockouts, and TOTP replay keys for testing.
 * Scans Redis for each auth-related prefix and deletes matching keys.
 */
export async function resetAuthRateLimits(redis: Redis): Promise<ResetAuthRateLimitsResult> {
  const prefixes = [
    'login:*:ratelimit:*',
    'login:lockout:*',
    'register:*:ratelimit:*',
    '2fa:*:ratelimit:*',
    '2fa:lockout:*',
    'recovery:*:ratelimit:*',
    'recovery:lockout:*',
    'verify:*:ratelimit:*',
    'resend-verify:*:ratelimit:*',
    'totp:used:*',
  ];

  return deleteRedisKeysByPrefixes(redis, prefixes);
}

export interface ResetUsageRateLimitsResult {
  deleted: number;
}

/**
 * Reset per-user usage rate limits and speculative balance reservations
 * between tests. Excludes IP-scoped and trial-scoped buckets whose tests
 * exercise the limit firing.
 *
 * Reservation prefixes are included so `setWalletBalance` produces an
 * available balance equal to the wallet value — without clearing them, a
 * leftover reservation from a prior request would subtract from the new
 * wallet for up to its 180s TTL, leaving the UI's raw-balance view and the
 * billing path's reservation-adjusted view out of sync.
 */
export async function resetUsageRateLimits(redis: Redis): Promise<ResetUsageRateLimitsResult> {
  const prefixes = [
    'chat:stream:user:ratelimit:*',
    'media:download:user:ratelimit:*',
    'share:create:user:ratelimit:*',
    'chat:reserved:*',
    'chat:group-reserved:*',
    'chat:conversation-reserved:*',
  ];

  return deleteRedisKeysByPrefixes(redis, prefixes);
}

async function deleteRedisKeysByPrefixes(
  redis: Redis,
  prefixes: readonly string[]
): Promise<{ deleted: number }> {
  let deleted = 0;

  for (const prefix of prefixes) {
    let cursor: string | number = 0;
    do {
      const [nextCursor, keys]: [string, string[]] = await redis.scan(cursor, {
        match: prefix,
        count: RESET_SCAN_COUNT,
      });
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
  }

  return { deleted };
}

export interface CreateDevConversationParams {
  ownerEmail: string;
  /**
   * Model id to stamp on seeded AI messages — passed in by the dev route
   * after a live catalog lookup (see `pickValueTextModel`). Required so seeds
   * never hardcode a model that has been retired from the gateway; a stale
   * seed model breaks retry, since the client picks the existing AI's
   * `modelName` as the retry model.
   */
  seedAiModel: string;
  messages?:
    | {
        content: string;
        senderType: 'user' | 'ai';
      }[]
    | undefined;
}

export interface CreateDevConversationResult {
  conversationId: string;
}

/**
 * Create a single-user conversation for E2E testing.
 * Uses production services (createOrGetConversation, saveUserOnlyMessage) to avoid
 * duplicating DB insertion logic. Server-side crypto generation via createFirstEpoch.
 */
export async function createDevConversation(
  db: Database,
  params: CreateDevConversationParams
): Promise<CreateDevConversationResult> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(eq(users.email, params.ownerEmail));

  if (!user) {
    throw new Error(`User not found: ${params.ownerEmail}`);
  }

  const epochResult = createFirstEpoch([user.publicKey]);
  const conversationId = crypto.randomUUID();

  const result = await createOrGetConversation(db, user.id, {
    id: conversationId,
    epochPublicKey: epochResult.epochPublicKey,
    confirmationHash: epochResult.confirmationHash,
    memberWrap: (() => {
      const wrap = epochResult.memberWraps[0];
      if (!wrap) throw new Error('invariant: missing member wrap');
      return wrap.wrap;
    })(),
    userPublicKey: user.publicKey,
  });

  if (!result) {
    throw new Error('Failed to create conversation');
  }

  if (params.messages && params.messages.length > 0) {
    let lastMessageId: string | null = null;

    for (const msg of params.messages) {
      const messageId = crypto.randomUUID();

      if (msg.senderType === 'user') {
        await saveUserOnlyMessage(db, {
          conversationId: result.conversation.id,
          userId: user.id,
          senderId: user.id,
          messageId,
          content: msg.content,
          parentMessageId: lastMessageId,
        });
      } else {
        await db.transaction(async (tx) => {
          const txDb = tx;
          const { sequences, currentEpoch } = await assignSequenceNumbers(
            txDb,
            result.conversation.id,
            1
          );
          const seq = sequences[0];
          if (seq === undefined) throw new Error('invariant: expected sequence number');

          const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
            txDb,
            result.conversation.id,
            currentEpoch
          );

          await insertEnvelopeTextMessage(txDb, {
            id: messageId,
            conversationId: result.conversation.id,
            textContent: msg.content,
            epochPublicKey,
            epochNumber,
            sequenceNumber: seq,
            senderType: 'ai',
            modelName: params.seedAiModel,
            parentMessageId: lastMessageId,
          });
        });
      }

      lastMessageId = messageId;
    }
  }

  return { conversationId: result.conversation.id };
}

export interface CreateDevMultiModelConversationParams {
  ownerEmail: string;
  /** The single user prompt the fan-out responds to. */
  userContent: string;
  /**
   * One entry per sibling AI tile. Each carries its own resolved `modelName`
   * (distinct, live-catalog ids supplied by the route) and a non-null `cost`
   * so the rendered tiles get distinct nametags and visible cost badges.
   */
  aiResponses: { content: string; modelName: string; cost: string }[];
}

/**
 * Seed a multi-model fan-out turn for E2E testing: one user message and N
 * sibling AI text messages, all persisted in a single transaction with the
 * exact shape `saveChatTurn` writes for a multi-model send — one shared
 * `batchId` across the user message and every AI sibling, each AI sibling
 * parented to the user message, sequential sequence numbers.
 *
 * The shared `batchId` + common `parentMessageId` is load-bearing: the client's
 * fork-filter only renders same-parent assistants as multi-model peers when
 * their `batchId` also matches (`use-fork-messages.ts`), and the regenerate
 * path keys retry-all vs replace-one off the shared parent.
 */
export async function createDevMultiModelConversation(
  db: Database,
  params: CreateDevMultiModelConversationParams
): Promise<CreateDevConversationResult> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(eq(users.email, params.ownerEmail));

  if (!user) {
    throw new Error(`User not found: ${params.ownerEmail}`);
  }

  const epochResult = createFirstEpoch([user.publicKey]);
  const conversationId = crypto.randomUUID();

  const result = await createOrGetConversation(db, user.id, {
    id: conversationId,
    epochPublicKey: epochResult.epochPublicKey,
    confirmationHash: epochResult.confirmationHash,
    memberWrap: (() => {
      const wrap = epochResult.memberWraps[0];
      if (!wrap) throw new Error('invariant: missing member wrap');
      return wrap.wrap;
    })(),
    userPublicKey: user.publicKey,
  });

  if (!result) {
    throw new Error('Failed to create conversation');
  }

  const userMessageId = crypto.randomUUID();
  // One batch id per turn, stamped on the user message and every AI sibling —
  // mirrors saveChatTurn so the persisted rows are structurally identical.
  const batchId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    const total = 1 + params.aiResponses.length;
    const { sequences, currentEpoch } = await assignSequenceNumbers(
      tx,
      result.conversation.id,
      total
    );

    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx,
      result.conversation.id,
      currentEpoch
    );

    const userSeq = sequences[0];
    if (userSeq === undefined) throw new Error('invariant: expected user sequence number');

    await insertEnvelopeTextMessage(tx, {
      id: userMessageId,
      conversationId: result.conversation.id,
      textContent: params.userContent,
      epochPublicKey,
      epochNumber,
      sequenceNumber: userSeq,
      senderType: 'user',
      senderId: user.id,
      parentMessageId: null,
      batchId,
    });

    for (const [index, ai] of params.aiResponses.entries()) {
      const seq = sequences[index + 1];
      if (seq === undefined) throw new Error('invariant: expected AI sequence number');

      await insertEnvelopeTextMessage(tx, {
        id: crypto.randomUUID(),
        conversationId: result.conversation.id,
        textContent: ai.content,
        epochPublicKey,
        epochNumber,
        sequenceNumber: seq,
        senderType: 'ai',
        modelName: ai.modelName,
        cost: ai.cost,
        parentMessageId: userMessageId,
        batchId,
      });
    }
  });

  return { conversationId: result.conversation.id };
}

export type DevMediaType = 'image' | 'video';

/**
 * The mock gateway's CC0 sample bytes — reusing them makes a seeded turn
 * byte-identical to a generated one, so it decodes across every browser.
 */
const DEV_MEDIA_FIXTURES = {
  image: {
    contentType: 'image' as const,
    bytes: TEST_IMAGE_BYTES,
    mimeType: TEST_IMAGE_MIME,
    width: TEST_IMAGE_WIDTH,
    height: TEST_IMAGE_HEIGHT,
    durationMs: undefined as number | undefined,
  },
  video: {
    contentType: 'video' as const,
    bytes: TEST_VIDEO_BYTES,
    mimeType: TEST_VIDEO_MIME,
    width: TEST_VIDEO_WIDTH,
    height: TEST_VIDEO_HEIGHT,
    durationMs: TEST_VIDEO_DURATION_MS as number | undefined,
  },
} as const;

export interface CreateDevMediaConversationParams {
  ownerEmail: string;
  /** The user prompt the generation responds to. */
  userContent: string;
  mediaType: DevMediaType;
  /** Model id stamped on the content item; resolved by the route from the catalog. */
  modelName: string;
  /** Decimal `numeric` cost string for the content item's cost badge. */
  cost: string;
}

export interface CreateDevMediaConversationResult {
  conversationId: string;
  assistantMessageId: string;
}

/**
 * Seed a finished image/video turn for E2E, mirroring the generation pipeline:
 * one envelope's content key both wraps into the message and encrypts the bytes
 * stored in R2/MinIO (production storage-key layout), so the client unwraps once
 * and decrypts the download.
 */
export async function createDevMediaConversation(
  db: Database,
  mediaStorage: MediaStorage,
  params: CreateDevMediaConversationParams
): Promise<CreateDevMediaConversationResult> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(eq(users.email, params.ownerEmail));

  if (!user) {
    throw new Error(`User not found: ${params.ownerEmail}`);
  }

  const epochResult = createFirstEpoch([user.publicKey]);
  const conversationId = crypto.randomUUID();

  const result = await createOrGetConversation(db, user.id, {
    id: conversationId,
    epochPublicKey: epochResult.epochPublicKey,
    confirmationHash: epochResult.confirmationHash,
    memberWrap: (() => {
      const wrap = epochResult.memberWraps[0];
      if (!wrap) throw new Error('invariant: missing member wrap');
      return wrap.wrap;
    })(),
    userPublicKey: user.publicKey,
  });

  if (!result) {
    throw new Error('Failed to create conversation');
  }

  const fixture = DEV_MEDIA_FIXTURES[params.mediaType];
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const contentItemId = crypto.randomUUID();
  const storageKey = `media/${result.conversation.id}/${assistantMessageId}/${contentItemId}.enc`;

  // One content key both encrypts the stored bytes and wraps into the message.
  const { contentKey, wrappedContentKey } = beginMessageEnvelope(epochResult.epochPublicKey);
  const ciphertext = encryptBinaryWithContentKey(contentKey, fixture.bytes);

  // Store before persisting rows; a later failure leaves an orphan the GC reclaims.
  await mediaStorage.put(storageKey, ciphertext, 'application/octet-stream');

  await db.transaction(async (tx) => {
    const { sequences, currentEpoch } = await assignSequenceNumbers(tx, result.conversation.id, 2);
    const { epochPublicKey, epochNumber } = await fetchEpochPublicKey(
      tx,
      result.conversation.id,
      currentEpoch
    );

    const userSeq = sequences[0];
    const aiSeq = sequences[1];
    if (userSeq === undefined || aiSeq === undefined) {
      throw new Error('invariant: expected sequence numbers');
    }

    await insertEnvelopeTextMessage(tx, {
      id: userMessageId,
      conversationId: result.conversation.id,
      textContent: params.userContent,
      epochPublicKey,
      epochNumber,
      sequenceNumber: userSeq,
      senderType: 'user',
      senderId: user.id,
      parentMessageId: null,
    });

    await insertEnvelopeMediaMessage(tx, {
      id: assistantMessageId,
      conversationId: result.conversation.id,
      wrappedContentKey,
      epochNumber,
      sequenceNumber: aiSeq,
      senderType: 'ai',
      parentMessageId: userMessageId,
      mediaItems: [
        {
          id: contentItemId,
          contentType: fixture.contentType,
          position: 0,
          storageKey,
          mimeType: fixture.mimeType,
          sizeBytes: ciphertext.byteLength,
          width: fixture.width,
          height: fixture.height,
          ...(fixture.durationMs !== undefined && { durationMs: fixture.durationMs }),
          modelName: params.modelName,
          cost: params.cost,
          isSmartModel: false,
        },
      ],
    });
  });

  return { conversationId: result.conversation.id, assistantMessageId };
}

interface InsertGroupChatMessagesParams {
  txDb: DatabaseClient;
  conversationId: string;
  epochPublicKey: Uint8Array;
  msgs: { senderEmail?: string; content: string; senderType: 'user' | 'ai' }[];
  orderedUsers: { id: string; email: string | null }[];
  seedAiModel: string;
}

async function insertGroupChatMessages(params: InsertGroupChatMessagesParams): Promise<void> {
  const { txDb, conversationId, epochPublicKey, msgs, orderedUsers, seedAiModel } = params;
  const messageIds = msgs.map(() => crypto.randomUUID());

  for (const [index, msg] of msgs.entries()) {
    const senderId =
      msg.senderType === 'user' && msg.senderEmail
        ? (orderedUsers.find((u) => u.email != null && u.email === msg.senderEmail)?.id ?? null)
        : null;

    const msgId = messageIds[index];
    if (!msgId) throw new Error(`invariant: messageIds[${String(index)}] is undefined`);

    const parentMessageId =
      index > 0
        ? (() => {
            const parentId = messageIds[index - 1];
            if (!parentId)
              throw new Error(`invariant: messageIds[${String(index - 1)}] is undefined`);
            return parentId;
          })()
        : null;

    await insertEnvelopeTextMessage(txDb, {
      id: msgId,
      conversationId,
      textContent: msg.content,
      epochPublicKey,
      epochNumber: 1,
      sequenceNumber: index + 1,
      senderType: msg.senderType,
      ...(senderId !== null && { senderId }),
      ...(msg.senderType === 'ai' && { modelName: seedAiModel }),
      parentMessageId,
    });
  }

  // Keep nextSequence in sync so saveChatTurn assigns non-overlapping sequences
  await txDb
    .update(conversations)
    .set({ nextSequence: msgs.length + 1 })
    .where(eq(conversations.id, conversationId));
}

export interface CreateDevGroupChatParams {
  ownerEmail: string;
  memberEmails: string[];
  /**
   * Members who should be created with `acceptedAt = null` — they appear as
   * pending invitees and can `/decline` the invite. Must be a subset of
   * `memberEmails`. Used by E2E tests that exercise the decline-invite flow.
   */
  pendingMemberEmails?: string[];
  /**
   * Model id to stamp on seeded AI messages — see
   * {@link CreateDevConversationParams.seedAiModel} for context.
   */
  seedAiModel: string;
  messages?: {
    senderEmail?: string;
    content: string;
    senderType: 'user' | 'ai';
  }[];
}

export interface CreateDevGroupChatResult {
  conversationId: string;
  members: { userId: string; username: string; email: string }[];
}

/**
 * Create a group conversation with epoch crypto for E2E testing.
 * Mirrors the seed script's createConversationEpochData pattern.
 */
export async function createDevGroupChat(
  db: Database,
  params: CreateDevGroupChatParams
): Promise<CreateDevGroupChatResult> {
  const allEmails = [params.ownerEmail, ...params.memberEmails];

  const foundUsers = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(inArray(users.email, allEmails));

  const owner = foundUsers.find((u) => u.email === params.ownerEmail);
  if (!owner) {
    throw new Error(`Owner not found: ${params.ownerEmail}`);
  }

  // Order: owner first, then members in request order
  const orderedUsers = [
    owner,
    ...params.memberEmails.map((email) => {
      const found = foundUsers.find((u) => u.email === email);
      if (!found) throw new Error(`Member not found: ${email}`);
      return found;
    }),
  ];

  const publicKeys = orderedUsers.map((u) => u.publicKey);
  const epochResult = createFirstEpoch(publicKeys);

  const conversationId = crypto.randomUUID();
  const epochId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      title: encryptTextForEpoch(epochResult.epochPublicKey, ''),
    });

    await tx.insert(epochs).values({
      id: epochId,
      conversationId,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
      chainLink: null,
    });

    await tx.insert(epochMembers).values(
      orderedUsers.map((user, index) => {
        const memberWrap = epochResult.memberWraps[index];
        if (!memberWrap)
          throw new Error(`invariant: member wrap missing at index ${String(index)}`);
        return {
          id: crypto.randomUUID(),
          epochId,
          memberPublicKey: user.publicKey,
          wrap: memberWrap.wrap,
          privilege: index === 0 ? 'owner' : ('admin' as string),
          visibleFromEpoch: 1,
        };
      })
    );

    // Insert conversation members. By default `acceptedAt` is stamped so the
    // member is fully joined. Emails listed in `pendingMemberEmails` keep
    // `acceptedAt = null` so they appear as pending invitees — used to seed
    // the decline-invite flow in E2E tests.
    const pendingSet = new Set(params.pendingMemberEmails);
    await tx.insert(conversationMembers).values(
      orderedUsers.map((user, index) => ({
        id: crypto.randomUUID(),
        conversationId,
        userId: user.id,
        privilege: index === 0 ? 'owner' : ('admin' as string),
        visibleFromEpoch: 1,
        // Owner is never pending; otherwise honour the pendingMemberEmails list.
        // user.email may be null (deleted users) — treat as never pending.
        acceptedAt:
          index === 0 || user.email === null || !pendingSet.has(user.email) ? new Date() : null,
      }))
    );

    // Insert messages if provided — one wrap-once envelope per message
    if (params.messages && params.messages.length > 0) {
      await insertGroupChatMessages({
        txDb: tx,
        conversationId,
        epochPublicKey: epochResult.epochPublicKey,
        msgs: params.messages,
        orderedUsers,
        seedAiModel: params.seedAiModel,
      });
    }
  });

  return {
    conversationId,
    members: orderedUsers.map((u) => ({
      userId: u.id,
      username: u.username,
      email: u.email ?? '', // Dev users always have email (looked up by email)
    })),
  };
}

export interface SetWalletBalanceParams {
  email: string;
  walletType: 'purchased' | 'free_tier';
  balance: string;
}

export interface SetWalletBalanceResult {
  newBalance: string;
}

/**
 * Set a user's wallet balance to an exact value.
 * Dev/test only — used by E2E tests to manipulate wallet state.
 */
export async function setWalletBalance(
  db: Database,
  params: SetWalletBalanceParams
): Promise<SetWalletBalanceResult> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.email.toLowerCase()));

  if (!user) {
    throw new Error(`User not found: ${params.email}`);
  }

  const [updated] = await db
    .update(wallets)
    .set({ balance: params.balance })
    .where(and(eq(wallets.userId, user.id), eq(wallets.type, params.walletType)))
    .returning({ id: wallets.id, balance: wallets.balance });

  if (!updated) {
    throw new Error(`Wallet not found: ${params.walletType} for ${params.email}`);
  }

  await db
    .insert(ledgerEntries)
    .values({
      walletId: updated.id,
      amount: params.balance,
      balanceAfter: updated.balance,
      entryType: 'adjustment',
      sourceWalletId: updated.id,
    })
    .returning({ id: ledgerEntries.id });

  return { newBalance: updated.balance };
}

export interface ClearTotpReplayResult {
  deleted: number;
}

/**
 * Delete a user's TOTP replay markers (`totp:used:{userId}:{code}`) so a
 * previously-accepted code can be presented again without waiting for the next
 * 30-second window. The markers enforce one-time use; clearing them lets a flow
 * reuse the current code while the real replay check and crypto verification
 * still run against it. Dev/test only.
 */
export async function clearTotpReplay(
  db: Database,
  redis: Redis,
  email: string
): Promise<ClearTotpReplayResult> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()));

  if (!user) {
    throw new Error(`User not found: ${email}`);
  }

  const markerPrefix = `${REDIS_REGISTRY.totpUsedCode.buildKey(user.id, '')}*`;
  return deleteRedisKeysByPrefixes(redis, [markerPrefix]);
}
