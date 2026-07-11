import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import {
  captureContentStorageKeysWithinTx,
  detachMessageSendersWithinTx,
} from './account-deletion.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat account-deletion tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zh${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

async function seedUser(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `${PREFIX}u${String(counter)}@chat-deletion.test`,
      username: `${PREFIX}u${String(counter)}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  if (!row) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row.id;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({ userId: ownerUserId, title: BYTES })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('conversation seed failed');
  await db.insert(epochs).values({
    conversationId: conversation.id,
    epochNumber: 1,
    epochPublicKey: BYTES,
    confirmationHash: BYTES,
  });
  return conversation.id;
}

let sequence = 0;

async function seedMessage(conversationId: string, senderId: string): Promise<string> {
  sequence += 1;
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      senderId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: sequence,
    })
    .returning({ id: messages.id });
  if (!row) throw new Error('message seed failed');
  return row.id;
}

function mediaKey(): string {
  return `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
}

async function seedMediaItem(messageId: string, storageKey: string): Promise<void> {
  await db.insert(contentItems).values({
    messageId,
    contentType: 'image',
    storageKey,
    mimeType: 'image/png',
    sizeBytes: 3,
  });
}

async function seedTextItem(messageId: string): Promise<void> {
  await db.insert(contentItems).values({
    messageId,
    contentType: 'text',
    encryptedBlob: BYTES,
  });
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('captureContentStorageKeysWithinTx', () => {
  it('captures the distinct non-null storage keys of exactly the given conversations', async () => {
    const owner = await seedUser();
    const owned = await seedConversation(owner);
    const foreign = await seedConversation(owner);
    const ownedMessage = await seedMessage(owned, owner);
    const foreignMessage = await seedMessage(foreign, owner);
    const keyA = mediaKey();
    const keyB = mediaKey();
    const foreignKey = mediaKey();
    await seedMediaItem(ownedMessage, keyA);
    await seedMediaItem(ownedMessage, keyB);
    await seedTextItem(ownedMessage);
    await seedMediaItem(foreignMessage, foreignKey);

    const keys = await runSettlement(db, (tx) => captureContentStorageKeysWithinTx(tx, [owned]));

    expect([...keys].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [keyA, keyB].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('answers an empty conversation list with no keys and no query', async () => {
    const keys = await runSettlement(db, (tx) => captureContentStorageKeysWithinTx(tx, []));
    expect(keys).toEqual([]);
  });
});

describe('detachMessageSendersWithinTx', () => {
  it("nulls the user's senderId outside the excluded conversations and nowhere else", async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const ownedByLeaver = await seedConversation(leaver);
    const foreign = await seedConversation(other);
    const keepSender = await seedMessage(ownedByLeaver, leaver);
    const detach = await seedMessage(foreign, leaver);
    const untouched = await seedMessage(foreign, other);

    await runSettlement(db, (tx) => detachMessageSendersWithinTx(tx, leaver, [ownedByLeaver]));

    const rows = await db
      .select({ id: messages.id, senderId: messages.senderId })
      .from(messages)
      .where(inArray(messages.id, [keepSender, detach, untouched]));
    const byId = new Map(rows.map((row) => [row.id, row.senderId]));
    expect(byId.get(keepSender)).toBe(leaver);
    expect(byId.get(detach)).toBeNull();
    expect(byId.get(untouched)).toBe(other);
  });

  it('detaches every message of a user who owns no conversations', async () => {
    const leaver = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other);
    const detach = await seedMessage(foreign, leaver);

    await runSettlement(db, (tx) => detachMessageSendersWithinTx(tx, leaver, []));

    const [row] = await db
      .select({ senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, detach));
    expect(row?.senderId).toBeNull();
  });
});
