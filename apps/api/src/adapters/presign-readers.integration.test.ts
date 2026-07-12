import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  messages,
  sharedLinks,
  sharedMessages,
  users,
} from '@hushbox/db';
import { createPresignReaders } from './presign-readers.js';
import type { Database } from '@hushbox/db';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for presign readers tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const readers = createPresignReaders(db);
const BYTES = new Uint8Array([7, 7, 7]);

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

interface Seeded {
  readonly userId: string;
  readonly userPublicKey: Uint8Array;
  readonly conversationId: string;
  readonly epochId: string;
  readonly linkId: string;
  readonly linkPublicKey: Uint8Array;
  readonly contentItemId: string;
  readonly storageKey: string;
  readonly sharedMessageId: string;
}

function firstId(rows: readonly { readonly id: string }[], label: string): string {
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`${label} seed failed`);
  return id;
}

async function seedFullGraph(): Promise<Seeded> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const userId = firstId(
    await db
      .insert(users)
      .values({
        email: `${username}@presign-readers.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: userPublicKey,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
      })
      .returning({ id: users.id }),
    'user'
  );
  createdUserIds.push(userId);

  const conversationId = firstId(
    await db.insert(conversations).values({ userId, title: BYTES }).returning({
      id: conversations.id,
    }),
    'conversation'
  );
  createdConversationIds.push(conversationId);

  const epochId = firstId(
    await db
      .insert(epochs)
      .values({
        conversationId,
        epochNumber: 0,
        epochPublicKey: crypto.getRandomValues(new Uint8Array(32)),
        confirmationHash: BYTES,
      })
      .returning({ id: epochs.id }),
    'epoch'
  );

  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 0 });
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey: userPublicKey, wrap: BYTES, visibleFromEpoch: 0 });

  const linkPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const linkId = firstId(
    await db
      .insert(sharedLinks)
      .values({ conversationId, linkPublicKey })
      .returning({ id: sharedLinks.id }),
    'shared link'
  );
  await db.insert(conversationMembers).values({ conversationId, linkId, visibleFromEpoch: 0 });
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey: linkPublicKey, wrap: BYTES, visibleFromEpoch: 0 });

  const messageId = firstId(
    await db
      .insert(messages)
      .values({
        conversationId,
        senderType: 'assistant',
        wrappedContentKey: BYTES,
        epochNumber: 0,
        sequenceNumber: 1,
      })
      .returning({ id: messages.id }),
    'message'
  );

  const storageKey = `media/${conversationId}/m/${crypto.randomUUID()}`;
  const contentItemId = firstId(
    await db
      .insert(contentItems)
      .values({
        messageId,
        contentType: 'image',
        position: 0,
        storageKey,
        mimeType: 'image/png',
        sizeBytes: 3,
      })
      .returning({ id: contentItems.id }),
    'content item'
  );

  const sharedMessageId = firstId(
    await db
      .insert(sharedMessages)
      .values({ messageId, createdBy: userId, wrappedContentKey: BYTES })
      .returning({ id: sharedMessages.id }),
    'shared message'
  );

  return {
    userId,
    userPublicKey,
    conversationId,
    epochId,
    linkId,
    linkPublicKey,
    contentItemId,
    storageKey,
    sharedMessageId,
  };
}

/**
 * A minimal query-builder stand-in that yields queued row sets by select-call
 * order — the reads run sequentially, so this drives findContentItemForPresign
 * then resolveEpochRowId independently. It exists only to reach the defensive
 * unresolvable-epoch branch that the messages→epochs foreign key makes
 * impossible to reach with real rows. Only the presign findMediaTarget path
 * (`.from`/`.innerJoin`/`.where`) is exercised through it.
 */
function fakeDbReturning(resultsByCall: readonly (readonly unknown[])[]): Database {
  let call = 0;
  const chainFor = (rows: readonly unknown[]): unknown => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => Promise.resolve(rows),
    };
    return chain;
  };
  return {
    select: () => chainFor(resultsByCall[call++] ?? []),
  } as unknown as Database;
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

describe('createPresignReaders — findMediaTarget', () => {
  it('resolves a content item to a MediaTarget with the epoch ROW id filled in', async () => {
    const seed = await seedFullGraph();
    const result = await readers.contentItems.findMediaTarget(seed.contentItemId);
    expect(result._unsafeUnwrap()).toEqual({
      contentItemId: seed.contentItemId,
      conversationId: seed.conversationId,
      epochId: seed.epochId,
      contentType: 'image',
      storageKey: seed.storageKey,
    });
  });

  it('returns null when the content item does not exist', async () => {
    const result = await readers.contentItems.findMediaTarget(crypto.randomUUID());
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns null when the content item resolves but its epoch cannot be resolved', async () => {
    const contentRow = {
      contentItemId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      epochNumber: 0,
      contentType: 'image',
      storageKey: 'media/x/y/z',
    };
    const decoupled = createPresignReaders(fakeDbReturning([[contentRow], []]));
    const result = await decoupled.contentItems.findMediaTarget(contentRow.contentItemId);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('createPresignReaders — membership', () => {
  it('delegates active membership and epoch membership for a user', async () => {
    const seed = await seedFullGraph();
    const active = await readers.membership.isActiveMember(seed.conversationId, {
      kind: 'user',
      userId: seed.userId,
    });
    const epochMember = await readers.membership.isEpochMember(seed.epochId, {
      kind: 'user',
      userId: seed.userId,
    });
    expect(active._unsafeUnwrap()).toBe(true);
    expect(epochMember._unsafeUnwrap()).toBe(true);
  });

  it('delegates active membership and epoch membership for a link guest', async () => {
    const seed = await seedFullGraph();
    const active = await readers.membership.isActiveMember(seed.conversationId, {
      kind: 'linkGuest',
      linkId: seed.linkId,
    });
    const epochMember = await readers.membership.isEpochMember(seed.epochId, {
      kind: 'linkGuest',
      linkId: seed.linkId,
    });
    expect(active._unsafeUnwrap()).toBe(true);
    expect(epochMember._unsafeUnwrap()).toBe(true);
  });
});

describe('createPresignReaders — shares', () => {
  it('delegates the standalone share read, scoping to the message content items', async () => {
    const seed = await seedFullGraph();
    const result = await readers.shares.findShare(seed.sharedMessageId);
    const share = result._unsafeUnwrap();
    expect(share?.revokedAt).toBeNull();
    expect(share?.expiresAt).toBeNull();
    expect(share?.contentItemIds).toEqual([seed.contentItemId]);
  });
});
