import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { toBase64 } from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, sharedLinks, users } from '@hushbox/db';
import { createConversationsStores } from '../adapters/stores.js';
import { assertWrapEpochByMemberWithinTx } from './wrap-epoch.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for wrap-epoch member-keyed assertion tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createConversationsStores(db);

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

/** Seeds a user + owned conversation; the conversation defaults to currentEpoch 1. */
async function seedUserAndConversation(): Promise<{
  userId: string;
  conversationId: string;
  publicKey: Uint8Array;
}> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const userRows = await db
    .insert(users)
    .values({
      email: `${username}@wrap-epoch.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  return { userId, conversationId, publicKey };
}

/** Inserts the conversation's current epoch (number 1) and returns its row id. */
async function seedCurrentEpoch(conversationId: string): Promise<string> {
  const inserted = await stores.epochs.insert({
    conversationId,
    epochNumber: 1,
    previousEpochId: null,
    epochPublicKey: crypto.getRandomValues(new Uint8Array(32)),
    confirmationHash: crypto.getRandomValues(new Uint8Array(32)),
    chainLink: null,
  });
  return inserted._unsafeUnwrap().id;
}

/** Wraps a member public key into an epoch (the epoch_members row). */
async function seedEpochMember(epochId: string, memberPublicKey: Uint8Array): Promise<void> {
  const wrapped = await stores.epochs.insertWraps([
    { epochId, memberPublicKey, wrap: BYTES, visibleFromEpoch: 1 },
  ]);
  wrapped._unsafeUnwrap();
}

async function seedGuestKey(conversationId: string): Promise<Uint8Array> {
  const linkPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(sharedLinks)
    .values({ conversationId, linkPublicKey })
    .returning({ id: sharedLinks.id });
  const linkId = rows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  const seated = await stores.members.insertLinkMember({
    conversationId,
    linkId,
    privilege: 'write',
    visibleFromEpoch: 1,
  });
  if (seated._unsafeUnwrap() === null) throw new Error('guest seat failed');
  return linkPublicKey;
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('assertWrapEpochByMemberWithinTx', () => {
  it('passes for an active user member public key at the current epoch', async () => {
    const { conversationId, publicKey } = await seedUserAndConversation();
    const epochId = await seedCurrentEpoch(conversationId);
    await seedEpochMember(epochId, publicKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(publicKey),
    });

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('passes for an active link-guest member public key at the current epoch', async () => {
    const { conversationId } = await seedUserAndConversation();
    const epochId = await seedCurrentEpoch(conversationId);
    const guestKey = await seedGuestKey(conversationId);
    await seedEpochMember(epochId, guestKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(guestKey),
    });

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('refuses a missing conversation with not_found', async () => {
    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId: crypto.randomUUID(),
      expectedEpoch: 1,
      memberPublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    });

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses a target epoch that no longer matches currentEpoch with conflict', async () => {
    const { conversationId, publicKey } = await seedUserAndConversation();
    const epochId = await seedCurrentEpoch(conversationId);
    await seedEpochMember(epochId, publicKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 2,
      memberPublicKey: toBase64(publicKey),
    });

    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('refuses a public key that is not a member of the current epoch with forbidden', async () => {
    const { conversationId, publicKey } = await seedUserAndConversation();
    const epochId = await seedCurrentEpoch(conversationId);
    await seedEpochMember(epochId, publicKey);

    const result = await assertWrapEpochByMemberWithinTx(stores, {
      conversationId,
      expectedEpoch: 1,
      memberPublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    });

    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
  });
});
