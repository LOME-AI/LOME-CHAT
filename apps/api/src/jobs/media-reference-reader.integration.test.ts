import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createContentItemReferenceReader } from './media-reference-reader.js';
import type { DbTransaction } from '../lib/idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for media reference reader integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

class Rollback extends Error {}

async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

/** Seeds the full ownership chain and returns a live content item's storage key. */
async function seedReferencedStorageKey(tx: DbTransaction): Promise<string> {
  const username = `media-ref-${crypto.randomUUID().slice(0, 8)}`;
  const userRows = await tx
    .insert(users)
    .values({
      email: `${username}@media-ref.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  const conversationRows = await tx
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  await tx.insert(epochs).values({
    conversationId,
    epochNumber: 1,
    epochPublicKey: BYTES,
    confirmationHash: BYTES,
  });
  const messageRows = await tx
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      senderId: userId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) throw new Error('message seed failed');
  const storageKey = `media/${conversationId}/${messageId}/${crypto.randomUUID()}`;
  await tx.insert(contentItems).values({
    messageId,
    contentType: 'image',
    storageKey,
    mimeType: 'image/webp',
    sizeBytes: BYTES.length,
  });
  return storageKey;
}

afterAll(async () => {
  await db.$client.end();
});

describe('createContentItemReferenceReader', () => {
  it('returns exactly the keys a live content item references', async () => {
    const observed = await withRollback(async (tx) => {
      const liveKey = await seedReferencedStorageKey(tx);
      const orphanKey = `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
      const reader = createContentItemReferenceReader(tx);
      const result = await reader.referencedStorageKeys([liveKey, orphanKey]);
      return { referenced: result._unsafeUnwrap(), liveKey, orphanKey };
    });
    expect(observed.referenced.has(observed.liveKey)).toBe(true);
    expect(observed.referenced.has(observed.orphanKey)).toBe(false);
  });

  it('answers an empty key list without touching the database', async () => {
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error('empty-input reads must not touch the database');
        },
      }
    ) as DbTransaction;
    const reader = createContentItemReferenceReader(poisoned);
    const result = await reader.referencedStorageKeys([]);
    expect(result._unsafeUnwrap().size).toBe(0);
  });

  it('fails typed when the read fails', async () => {
    const broken = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      }
    ) as DbTransaction;
    const reader = createContentItemReferenceReader(broken);
    const result = await reader.referencedStorageKeys(['media/a/b/c']);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
