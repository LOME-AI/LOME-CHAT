import { eq, inArray } from 'drizzle-orm';
import { contentItems, conversations, users } from '@hushbox/db';
import {
  asEpochPublicKey,
  createFirstEpoch,
  encryptContentEnvelope,
  encryptTextForEpoch,
  generateContentKey,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import { runSettlement } from '../../lib/idempotency/index.js';
import {
  createConversationsStores,
  reserveSequenceBlockWithinTx,
} from '../../slices/conversations/index.js';
import { createChatStores } from '../../slices/chat/index.js';
import { mediaObjectKey } from '../../slices/media/index.js';
import { listDescriptors } from '../../slices/models/index.js';
import { DEV_MEDIA_FIXTURES } from './media-fixtures.js';
import type { Database } from '@hushbox/db';
import type { Storage } from '../../slices/media/index.js';
import type { SettlementTx } from '../../lib/idempotency/index.js';
import type { Result } from '../../lib/result/index.js';
import type { DomainError } from '../../lib/errors/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';

/**
 * Dev/E2E seed factories over the NEW schema, composed from the slices'
 * published surfaces (conversations stores for conversations/epochs/members,
 * chat stores for messages/content, crypto for the envelope) so seeded rows
 * are structurally identical to what the real pipeline writes: wrap-once
 * content keys, full-location AAD, batchId turn grouping, reserved
 * sequence blocks.
 */

/** Raised for the legacy 404/400 cases (unknown persona emails). */
export class DevSeedError extends Error {}

/**
 * Raised when a seed step's underlying infra (storage/R2) is unavailable — a
 * distinct class from `DevSeedError` so `liftDevWork` can surface it as a
 * truthful 503 UNAVAILABLE instead of laundering a storage outage into an
 * opaque 404. Infra unavailability is not a missing target.
 */
export class DevSeedStorageUnavailableError extends Error {}

/** Result unwrap for seed steps: an infra failure aborts the whole seed. */
export function unwrapSeed<T, E>(result: Result<T, E>, step: string): T {
  if (result.isErr()) throw new DevSeedError(`dev seed: ${step} failed`);
  return result.value;
}

/**
 * Result unwrap for a seed's storage put: an availability-class failure
 * (`unavailable`/`timeout` from the storage adapter's Result channel) aborts
 * the seed with the distinct `DevSeedStorageUnavailableError`; any other code
 * is an ordinary seed failure. Keeps a storage outage from being reported as a
 * missing target.
 */
export function unwrapStoragePut<T>(result: Result<T, DomainError>, step: string): T {
  if (result.isErr()) {
    const { code } = result.error;
    if (code === 'unavailable' || code === 'timeout') {
      throw new DevSeedStorageUnavailableError(`dev seed: ${step} unavailable (${code})`);
    }
    throw new DevSeedError(`dev seed: ${step} failed`);
  }
  return result.value;
}

/** Non-null unwrap for seed invariants (missing sequence, conflicting insert). */
export function requireSeed<T>(value: T | null | undefined, step: string): T {
  if (value === null || value === undefined) {
    throw new DevSeedError(`dev seed: ${step} missing`);
  }
  return value;
}

interface SeedUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly publicKey: Uint8Array;
}

async function findUsersByEmail(db: Database, emails: readonly string[]): Promise<SeedUser[]> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(inArray(users.email, [...emails]));
  return rows;
}

async function requireUser(db: Database, email: string): Promise<SeedUser> {
  const [user] = await findUsersByEmail(db, [email]);
  if (user === undefined) throw new DevSeedError(`User not found: ${email}`);
  return user;
}

/**
 * Pinned-id idempotence: the profile seed re-runs against a populated DB,
 * so a factory called with a deterministic id short-circuits when that
 * conversation already exists (the first run's rows, including messages,
 * stand). Random-id callers (`/dev` routes) never hit this.
 */
async function pinnedConversationExists(db: Database, id: string | undefined): Promise<boolean> {
  if (id === undefined) return false;
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, id));
  return rows.length > 0;
}

/**
 * The seed model ids are resolved from the live catalog (never hardcoded)
 * so a retired model id can never break the E2E retry path, which picks the
 * existing AI message's model. Cycles when fewer than `count` text models
 * are exposed.
 */
export async function pickSeedTextModels(
  db: Database,
  telemetry: Telemetry,
  requested: number
): Promise<string[]> {
  const descriptors = await listDescriptors({ db, telemetry });
  const textIds = descriptors
    .unwrapOr([])
    .filter((descriptor) => descriptor.outputs.includes('text'))
    .map((descriptor) => descriptor.id)
    .toSorted((a, b) => a.localeCompare(b));
  if (textIds.length === 0) {
    throw new DevSeedError('dev seed: no text models exposed in the model catalog');
  }
  return Array.from({ length: requested }, (_, index) =>
    requireSeed(textIds[index % textIds.length], 'model pick')
  );
}

interface EpochSetup {
  readonly conversationId: string;
  readonly epochPublicKey: Uint8Array;
}

/**
 * Creates the conversation row, first epoch, wraps and member rows for an
 * ordered member set (owner first) through the conversations stores.
 */
async function seedConversationShell(
  db: Database,
  members: readonly SeedUser[],
  pendingEmails: ReadonlySet<string>,
  // A caller may pin a deterministic conversation id (the marketing seed
  // navigates screenshots to a known `/chat/{id}`); runtime `/dev` callers
  // pass none and get a fresh random id.
  conversationId: string = crypto.randomUUID()
): Promise<EpochSetup> {
  const owner = requireSeed(members[0], 'owner');
  const stores = createConversationsStores(db);
  const epoch = createFirstEpoch(
    members.map((member) => member.publicKey),
    conversationId,
    1
  );

  requireSeed(
    unwrapSeed(
      await stores.conversations.insert({
        id: conversationId,
        ownerUserId: owner.id,
        title: encryptTextForEpoch(epoch.epochPublicKey, ''),
      }),
      'conversation insert'
    ),
    'conversation row'
  );

  const epochRow = unwrapSeed(
    await stores.epochs.insert({
      conversationId,
      epochNumber: 1,
      previousEpochId: null,
      epochPublicKey: epoch.epochPublicKey,
      confirmationHash: epoch.confirmationHash,
      chainLink: null,
    }),
    'epoch insert'
  );

  unwrapSeed(
    await stores.epochs.insertWraps(
      epoch.memberWraps.map((wrap) => ({
        epochId: epochRow.id,
        memberPublicKey: wrap.memberPublicKey,
        wrap: wrap.wrap,
        visibleFromEpoch: 1,
      }))
    ),
    'epoch wraps insert'
  );

  for (const [index, member] of members.entries()) {
    unwrapSeed(
      await stores.members.insert({
        conversationId,
        userId: member.id,
        privilege: index === 0 ? 'owner' : 'admin',
        visibleFromEpoch: 1,
        // Owner is never pending; otherwise honour the pending set (used to
        // seed the decline-invite E2E flow).
        acceptedAt: index === 0 || !pendingEmails.has(member.email) ? new Date() : null,
        invitedByUserId: index === 0 ? null : owner.id,
      }),
      'member insert'
    );
  }

  return { conversationId, epochPublicKey: epoch.epochPublicKey };
}

function resolveParentId(
  parent: SeedMessage['parent'],
  messageIds: readonly string[]
): string | null {
  if (parent === 'none') return null;
  // 'first' siblings always follow the seeded user message.
  if (parent === 'first') return requireSeed(messageIds[0], 'fan-out parent');
  return messageIds.at(-1) ?? null;
}

interface SeedMessage {
  readonly senderType: 'user' | 'ai';
  readonly senderId: string;
  readonly content: string;
  readonly modelId: string | null;
  readonly costNanoUsd: bigint | null;
  /** 'chain' parents onto the previous message; 'first' parents onto message 0. */
  readonly parent: 'chain' | 'first' | 'none';
  readonly batchId: string;
}

/**
 * Persists seed messages exactly the way settlement does: a reserved
 * sequence block, a fresh wrap-once content key per message, and the
 * full-location AAD (including senderId) on every content envelope.
 */
async function persistSeedMessages(
  db: Database,
  setup: EpochSetup,
  seedMessages: readonly SeedMessage[]
): Promise<string[]> {
  if (seedMessages.length === 0) return [];
  const chatStores = createChatStores();
  const textEncoder = new TextEncoder();
  const epochPublicKey = asEpochPublicKey(setup.epochPublicKey);

  return runSettlement(db, async (tx: SettlementTx) => {
    const txConversations = createConversationsStores(tx);
    const block = unwrapSeed(
      await reserveSequenceBlockWithinTx(txConversations, {
        conversationId: setup.conversationId,
        count: seedMessages.length,
      }),
      'sequence reservation'
    );

    const messageIds: string[] = [];
    for (const [index, seed] of seedMessages.entries()) {
      const sequenceNumber = requireSeed(block[index], 'sequence number');
      const messageId = crypto.randomUUID();
      const parentMessageId = resolveParentId(seed.parent, messageIds);

      const contentKey = generateContentKey();
      const wrappedContentKey = wrapContentKeyToEpoch(epochPublicKey, contentKey);
      await chatStores.insertMessageWithinTx(tx, {
        id: messageId,
        conversationId: setup.conversationId,
        senderType: seed.senderType === 'ai' ? 'assistant' : 'user',
        senderId: seed.senderId,
        wrappedContentKey,
        epochNumber: 1,
        sequenceNumber,
        parentMessageId,
        batchId: seed.batchId,
      });

      const contentItemId = crypto.randomUUID();
      const encryptedBlob = encryptContentEnvelope(
        contentKey,
        wrappedContentKey,
        {
          conversationId: setup.conversationId,
          messageId,
          contentItemId,
          position: 0,
          epochNumber: 1,
          senderId: seed.senderId,
        },
        textEncoder.encode(seed.content)
      );
      await chatStores.insertContentItemWithinTx(tx, {
        id: contentItemId,
        messageId,
        position: 0,
        encryptedBlob,
        modelId: seed.modelId,
        providerName: seed.modelId === null ? null : 'dev',
        costNanoUsd: seed.costNanoUsd,
      });
      messageIds.push(messageId);
    }
    return messageIds;
  });
}

export interface CreateDevConversationParams {
  readonly ownerEmail: string;
  readonly seedAiModel: string;
  readonly messages?: readonly { content: string; senderType: 'user' | 'ai' }[] | undefined;
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

export interface CreateDevConversationResult {
  readonly conversationId: string;
}

/** Single-user conversation, optionally pre-populated with a linear chain of messages. */
export async function createDevConversation(
  db: Database,
  params: CreateDevConversationParams
): Promise<CreateDevConversationResult> {
  if (params.id !== undefined && (await pinnedConversationExists(db, params.id))) {
    return { conversationId: params.id };
  }
  const owner = await requireUser(db, params.ownerEmail);
  const setup = await seedConversationShell(db, [owner], new Set(), params.id);
  const batchId = crypto.randomUUID();
  await persistSeedMessages(
    db,
    setup,
    (params.messages ?? []).map((message) => ({
      senderType: message.senderType,
      senderId: owner.id,
      content: message.content,
      modelId: message.senderType === 'ai' ? params.seedAiModel : null,
      costNanoUsd: null,
      parent: 'chain',
      batchId,
    }))
  );
  return { conversationId: setup.conversationId };
}

export interface CreateDevMultiModelConversationParams {
  readonly ownerEmail: string;
  readonly userContent: string;
  readonly aiResponses: readonly { content: string; modelName: string; costNanoUsd: bigint }[];
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

/**
 * One user message and N sibling AI messages persisted in one settlement —
 * the exact shape the multi-model turn writes: one shared batchId across
 * the user message and every AI sibling, each sibling parented onto the
 * user message, sequential sequence numbers, a visible cost per sibling.
 */
export async function createDevMultiModelConversation(
  db: Database,
  params: CreateDevMultiModelConversationParams
): Promise<CreateDevConversationResult> {
  if (params.id !== undefined && (await pinnedConversationExists(db, params.id))) {
    return { conversationId: params.id };
  }
  const owner = await requireUser(db, params.ownerEmail);
  const setup = await seedConversationShell(db, [owner], new Set(), params.id);
  const batchId = crypto.randomUUID();
  await persistSeedMessages(db, setup, [
    {
      senderType: 'user',
      senderId: owner.id,
      content: params.userContent,
      modelId: null,
      costNanoUsd: null,
      parent: 'none',
      batchId,
    },
    ...params.aiResponses.map(
      (response): SeedMessage => ({
        senderType: 'ai',
        senderId: owner.id,
        content: response.content,
        modelId: response.modelName,
        costNanoUsd: response.costNanoUsd,
        parent: 'first',
        batchId,
      })
    ),
  ]);
  return { conversationId: setup.conversationId };
}

export interface CreateDevGroupChatParams {
  readonly ownerEmail: string;
  readonly memberEmails: readonly string[];
  readonly pendingMemberEmails?: readonly string[];
  readonly seedAiModel: string;
  readonly messages?: readonly {
    senderEmail?: string | undefined;
    content: string;
    senderType: 'user' | 'ai';
  }[];
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

export interface CreateDevGroupChatResult {
  readonly conversationId: string;
  readonly members: { userId: string; username: string; email: string }[];
}

/** Group conversation with first-epoch wraps for every member. */
export async function createDevGroupChat(
  db: Database,
  params: CreateDevGroupChatParams
): Promise<CreateDevGroupChatResult> {
  const allEmails = [params.ownerEmail, ...params.memberEmails];
  const found = await findUsersByEmail(db, allEmails);
  const owner = found.find((user) => user.email === params.ownerEmail);
  if (owner === undefined) throw new DevSeedError(`Owner not found: ${params.ownerEmail}`);
  const ordered = [
    owner,
    ...params.memberEmails.map((email) => {
      const member = found.find((user) => user.email === email);
      if (member === undefined) throw new DevSeedError(`Member not found: ${email}`);
      return member;
    }),
  ];

  if (params.id !== undefined && (await pinnedConversationExists(db, params.id))) {
    return {
      conversationId: params.id,
      members: ordered.map((member) => ({
        userId: member.id,
        username: member.username,
        email: member.email,
      })),
    };
  }

  const setup = await seedConversationShell(
    db,
    ordered,
    new Set(params.pendingMemberEmails),
    params.id
  );
  const batchId = crypto.randomUUID();
  await persistSeedMessages(
    db,
    setup,
    (params.messages ?? []).map((message) => ({
      senderType: message.senderType,
      // AAD binds senderId; an unattributed legacy message (no senderEmail)
      // is attributed to the owner in the new shape (senderId is required).
      senderId:
        message.senderType === 'user' && message.senderEmail !== undefined
          ? (ordered.find((user) => user.email === message.senderEmail)?.id ?? owner.id)
          : owner.id,
      content: message.content,
      modelId: message.senderType === 'ai' ? params.seedAiModel : null,
      costNanoUsd: null,
      parent: 'chain',
      batchId,
    }))
  );

  return {
    conversationId: setup.conversationId,
    members: ordered.map((user) => ({
      userId: user.id,
      username: user.username,
      email: user.email,
    })),
  };
}

export interface CreateDevMediaConversationParams {
  readonly ownerEmail: string;
  readonly userContent: string;
  readonly mediaType: 'image' | 'video';
  readonly modelId: string;
  readonly costNanoUsd: bigint;
  /** Optional deterministic conversation id; defaults to a fresh random uuid. */
  readonly id?: string | undefined;
}

export interface CreateDevMediaConversationResult {
  readonly conversationId: string;
  readonly assistantMessageId: string;
}

/**
 * Seeds a finished image/video turn mirroring the generation pipeline: one
 * envelope's content key both wraps into the assistant message and encrypts
 * the bytes stored under the production `media/{conv}/{msg}/{uuid}` key, so
 * the client unwraps once and decrypts the download.
 *
 * The content-item row is written directly (raw insert): the chat slice
 * publishes no media content persist yet (the media turn's settlement path
 * is not built), so this is the one dev-seed write without a published API.
 */
export async function createDevMediaConversation(
  db: Database,
  storage: Storage,
  params: CreateDevMediaConversationParams
): Promise<CreateDevMediaConversationResult> {
  const owner = await requireUser(db, params.ownerEmail);
  const setup = await seedConversationShell(db, [owner], new Set(), params.id);
  const fixture = DEV_MEDIA_FIXTURES[params.mediaType];
  const epochPublicKey = asEpochPublicKey(setup.epochPublicKey);
  const batchId = crypto.randomUUID();

  const userMessage = await persistSeedMessages(db, setup, [
    {
      senderType: 'user',
      senderId: owner.id,
      content: params.userContent,
      modelId: null,
      costNanoUsd: null,
      parent: 'none',
      batchId,
    },
  ]);

  const assistantMessageId = crypto.randomUUID();
  const contentItemId = crypto.randomUUID();
  const storageKey = mediaObjectKey({
    conversationId: setup.conversationId,
    messageId: assistantMessageId,
    objectId: contentItemId,
  });

  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(epochPublicKey, contentKey);
  // Same wrap-once envelope as text content (full-location AAD): the client
  // unwraps the message's content key once and decrypts the download.
  const ciphertext = encryptContentEnvelope(
    contentKey,
    wrappedContentKey,
    {
      conversationId: setup.conversationId,
      messageId: assistantMessageId,
      contentItemId,
      position: 0,
      epochNumber: 1,
      senderId: owner.id,
    },
    fixture.bytes
  );

  // Store before persisting rows; a later failure leaves an orphan the GC
  // reclaims (min-age grace protects the fresh object).
  unwrapStoragePut(
    await storage.put(storageKey, ciphertext, { contentType: 'application/octet-stream' }),
    'media upload'
  );

  const chatStores = createChatStores();
  await runSettlement(db, async (tx: SettlementTx) => {
    const txConversations = createConversationsStores(tx);
    const block = unwrapSeed(
      await reserveSequenceBlockWithinTx(txConversations, {
        conversationId: setup.conversationId,
        count: 1,
      }),
      'sequence reservation'
    );
    const sequenceNumber = requireSeed(block[0], 'sequence number');

    await chatStores.insertMessageWithinTx(tx, {
      id: assistantMessageId,
      conversationId: setup.conversationId,
      senderType: 'assistant',
      senderId: owner.id,
      wrappedContentKey,
      epochNumber: 1,
      sequenceNumber,
      parentMessageId: requireSeed(userMessage[0], 'user message id'),
      batchId,
    });
    await tx.insert(contentItems).values({
      id: contentItemId,
      messageId: assistantMessageId,
      contentType: fixture.contentType,
      position: 0,
      storageKey,
      mimeType: fixture.mimeType,
      sizeBytes: ciphertext.byteLength,
      width: fixture.width,
      height: fixture.height,
      durationMs: fixture.durationMs ?? null,
      modelId: params.modelId,
      providerName: 'dev',
      costNanoUsd: params.costNanoUsd,
      isSmartModel: false,
    });
  });

  return { conversationId: setup.conversationId, assistantMessageId };
}
