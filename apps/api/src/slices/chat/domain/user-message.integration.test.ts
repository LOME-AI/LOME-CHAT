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
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import {
  createConversationsStores,
  reserveSequenceBlockWithinTx,
} from '../../conversations/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createChatStores } from '../adapters/stores.js';
import { broadcastUserMessageNew, saveUserOnlyMessage } from './user-message.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type { RealtimeEvent } from '@hushbox/realtime';
import type { RealtimeBroadcast } from '../../conversations/index.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { SaveUserOnlyMessageDeps } from './user-message.js';

/**
 * The runless Pattern-A user-only send: one transaction resolves the parent
 * tip, reserves one sequence, wraps the content to the CURRENT epoch through
 * the shared insert primitive, and inserts the message + text content item.
 * A duplicate messageId (or the sequence unique backstop) converges on the
 * one existing row and reports `duplicate` — never a second insert.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat user-message integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([7, 7, 7]);
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

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

interface Fixture {
  readonly userId: string;
  readonly conversationId: string;
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values({
      email: `${suffix}@user-msg.test`,
      username: `um${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = first(userRows, 'user').id;
  createdUserIds.push(userId);

  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = first(conversationRows, 'conversation').id;
  createdConversationIds.push(conversationId);

  const keyPair = generateEpochKeyPair();
  await db.insert(epochs).values({
    conversationId,
    epochNumber: 1,
    epochPublicKey: keyPair.publicKey,
    confirmationHash: BYTES,
  });
  return { userId, conversationId, epochPrivateKey: keyPair.privateKey };
}

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

function deps(overrides: Partial<SaveUserOnlyMessageDeps> = {}): SaveUserOnlyMessageDeps {
  return {
    db,
    stores: createChatStores(),
    readEpochPublicKey,
    newId: () => crypto.randomUUID(),
    ...overrides,
  };
}

async function seedFork(
  conversationId: string,
  tipMessageId: string | null,
  name = 'Branch'
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

describe('saveUserOnlyMessage', () => {
  it('persists the message and its text content item at the reserved sequence', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();

    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId,
      content: 'hello without ai',
    });

    const outcome = result._unsafeUnwrap();
    expect(outcome).toEqual({
      saved: true,
      messageId,
      sequenceNumber: 1,
      epochNumber: 1,
    });

    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    const message = first(messageRows, 'message');
    expect(message.senderType).toBe('user');
    expect(message.senderId).toBe(fixture.userId);
    expect(message.epochNumber).toBe(1);
    expect(message.sequenceNumber).toBe(1);
    expect(message.parentMessageId).toBeNull();
    expect(message.batchId).toBeTruthy();

    // The content decrypts with the epoch key under the shared primitive's AAD.
    const contentRows = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, messageId));
    const content = first(contentRows, 'content item');
    expect(content.modelId).toBeNull();
    expect(content.costNanoUsd).toBeNull();
    if (content.encryptedBlob === null) throw new Error('expected an encrypted blob');
    const wrapped = message.wrappedContentKey as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(fixture.epochPrivateKey, wrapped);
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: fixture.conversationId,
        messageId,
        contentItemId: content.id,
        position: 0,
        epochNumber: 1,
        senderId: fixture.userId,
      },
      content.encryptedBlob
    );
    expect(decoder.decode(plaintext)).toBe('hello without ai');
  });

  it('chains onto the conversation tip (highest-sequence message)', async () => {
    const fixture = await seedFixture();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    const seeded = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: firstId,
      content: 'one',
    });
    expect(seeded.isOk()).toBe(true);
    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: secondId,
      content: 'two',
    });

    expect(result._unsafeUnwrap()).toMatchObject({ saved: true, sequenceNumber: 2 });
    const rows = await db.select().from(messages).where(eq(messages.id, secondId));
    expect(first(rows, 'message').parentMessageId).toBe(firstId);
  });

  it('parents a fork send onto the fork tip, not the linear tip, and advances that tip', async () => {
    const fixture = await seedFixture();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    // Two linear messages: the conversation's linear tip becomes `secondId`.
    const seededFirst = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: firstId,
      content: 'one',
    });
    expect(seededFirst.isOk()).toBe(true);
    const seededSecond = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: secondId,
      content: 'two',
    });
    expect(seededSecond.isOk()).toBe(true);
    // A branch whose tip is `firstId` (diverges from the linear tip `secondId`).
    const forkId = await seedFork(fixture.conversationId, firstId);

    const forkMessageId = crypto.randomUUID();
    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: forkMessageId,
      content: 'on the branch',
      forkId,
    });

    expect(result._unsafeUnwrap()).toMatchObject({ saved: true });
    const rows = await db.select().from(messages).where(eq(messages.id, forkMessageId));
    // Parents onto the FORK tip (firstId), NOT the linear tip (secondId): the
    // tip→root fork walk therefore still reaches it after a refetch.
    expect(first(rows, 'message').parentMessageId).toBe(firstId);
    // And the fork's own tip advances to the new message.
    expect(await forkTip(forkId)).toBe(forkMessageId);
  });

  it('chains onto a null-tipped fork (parent null) and advances the tip', async () => {
    const fixture = await seedFixture();
    const seedId = crypto.randomUUID();
    const seeded = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: seedId,
      content: 'linear',
    });
    expect(seeded.isOk()).toBe(true);
    const forkId = await seedFork(fixture.conversationId, null, 'Empty branch');

    const forkMessageId = crypto.randomUUID();
    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: forkMessageId,
      content: 'root of branch',
      forkId,
    });

    expect(result._unsafeUnwrap()).toMatchObject({ saved: true });
    const rows = await db.select().from(messages).where(eq(messages.id, forkMessageId));
    expect(first(rows, 'message').parentMessageId).toBeNull();
    expect(await forkTip(forkId)).toBe(forkMessageId);
  });

  it('answers not_found for a forkId absent at persist', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId,
      content: 'branch gone',
      forkId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(0);
  });

  it('surfaces a conflict when the fork-tip CAS advances zero rows', async () => {
    const fixture = await seedFixture();
    const forkId = await seedFork(fixture.conversationId, null, 'Raced branch');
    const messageId = crypto.randomUUID();
    const result = await saveUserOnlyMessage(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            forks: {
              ...real.forks,
              // The CAS finds zero rows (tip moved under us); the fork still
              // exists, so the re-read disambiguates to a conflict.
              updateTip: () => okAsync(null),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId,
        content: 'raced advance',
        forkId,
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
    // The whole transaction rolled back: no message persisted.
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(0);
  });

  it('reports duplicate for a resent messageId without a second insert', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const send = (): ReturnType<typeof saveUserOnlyMessage> =>
      saveUserOnlyMessage(deps(), {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId,
        content: 'same message',
      });

    const firstSend = await send();
    expect(firstSend._unsafeUnwrap()).toMatchObject({ saved: true });
    const secondSend = await send();
    expect(secondSend._unsafeUnwrap()).toEqual({ saved: false, reason: 'duplicate' });

    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
    // The duplicate's rolled-back transaction returns its reserved sequence:
    // the next fresh send lands at sequence 2, not 3.
    const next = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: crypto.randomUUID(),
      content: 'after duplicate',
    });
    expect(next._unsafeUnwrap()).toMatchObject({ saved: true, sequenceNumber: 2 });
  });

  it('maps the (conversation, sequence) unique backstop to duplicate', async () => {
    const fixture = await seedFixture();
    const seeded = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: crypto.randomUUID(),
      content: 'seed tip',
    });
    expect(seeded.isOk()).toBe(true);
    // A writer that bypassed the counter occupies the NEXT sequence slot (2):
    // the reservation then collides on the unique index, the 409 backstop.
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: fixture.conversationId,
      senderType: 'user',
      senderId: fixture.userId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 2,
    });

    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: crypto.randomUUID(),
      content: 'collides',
    });
    expect(result._unsafeUnwrap()).toEqual({ saved: false, reason: 'duplicate' });
  });

  it('does not collide with a concurrently reserved settlement block', async () => {
    const fixture = await seedFixture();
    // A live run's settlement reserves its block first (user + two siblings).
    const block = await reserveSequenceBlockWithinTx(createConversationsStores(db), {
      conversationId: fixture.conversationId,
      count: 3,
    });
    expect(block._unsafeUnwrap()).toEqual([1, 2, 3]);

    const result = await saveUserOnlyMessage(deps(), {
      conversationId: fixture.conversationId,
      senderId: fixture.userId,
      messageId: crypto.randomUUID(),
      content: 'during a run',
    });
    // Disjoint blocks: the user-only send lands after the run's reservation,
    // never violating the (conversation, sequence) unique constraint.
    expect(result._unsafeUnwrap()).toMatchObject({ saved: true, sequenceNumber: 4 });
  });

  it('wraps to the CURRENT epoch when a rotation commits inside the race window', async () => {
    const fixture = await seedFixture();
    const rotatedKeyPair = generateEpochKeyPair();
    const messageId = crypto.randomUUID();
    let rotated = false;
    // A rotation committing on a separate connection at the sequence-reservation
    // seam — the exact window the unlocked ordering left open between its epoch
    // read and the row-locking reservation. The fixed ordering reserves first,
    // so this rotation lands BEFORE the lock and the epoch read must see it.
    const commitRotation = async (): Promise<void> => {
      if (rotated) return;
      rotated = true;
      // Dedicated connection: the writer's transaction holds the shared one.
      const rotationDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
      try {
        await rotationDb.insert(epochs).values({
          conversationId: fixture.conversationId,
          epochNumber: 2,
          epochPublicKey: rotatedKeyPair.publicKey,
          confirmationHash: BYTES,
        });
        await rotationDb
          .update(conversations)
          .set({ currentEpoch: 2 })
          .where(eq(conversations.id, fixture.conversationId));
      } finally {
        await rotationDb.$client.end();
      }
    };

    const result = await saveUserOnlyMessage(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              reserveSequenceBlock: (params) =>
                fromPromise(commitRotation(), (cause) =>
                  unavailableError('rotation injection failed', cause)
                ).andThen(() => real.conversations.reserveSequenceBlock(params)),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId,
        content: 'raced by rotation',
      }
    );

    // Epoch-at-persist: the send must wrap to the rotation-final epoch (2) —
    // never the superseded epoch a removed member's key material still opens.
    expect(result._unsafeUnwrap()).toEqual({
      saved: true,
      messageId,
      sequenceNumber: 1,
      epochNumber: 2,
    });
    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    const message = first(messageRows, 'message');
    expect(message.epochNumber).toBe(2);
    // The wrap key matches too: the content decrypts with the ROTATED epoch key.
    const contentRows = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.messageId, messageId));
    const content = first(contentRows, 'content item');
    if (content.encryptedBlob === null) throw new Error('expected an encrypted blob');
    const wrapped = message.wrappedContentKey as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(rotatedKeyPair.privateKey, wrapped);
    const plaintext = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: fixture.conversationId,
        messageId,
        contentItemId: content.id,
        position: 0,
        epochNumber: 2,
        senderId: fixture.userId,
      },
      content.encryptedBlob
    );
    expect(decoder.decode(plaintext)).toBe('raced by rotation');
  });

  it('answers not_found for a missing conversation', async () => {
    const result = await saveUserOnlyMessage(deps(), {
      conversationId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: 'nowhere',
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('fails unavailable when the epoch wrap key is missing (defect guard)', async () => {
    const fixture = await seedFixture();
    const result = await saveUserOnlyMessage(
      deps({ readEpochPublicKey: () => Promise.resolve(null) }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId: crypto.randomUUID(),
        content: 'no wrap key',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('answers not_found when the post-lock row read yields no conversation', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const result = await saveUserOnlyMessage(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              get: () => okAsync(null),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId,
        content: 'row vanished',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(0);
  });

  it('propagates a conversation-read failure as the store error', async () => {
    const fixture = await seedFixture();
    const result = await saveUserOnlyMessage(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              get: () => errAsync(unavailableError('conversations down')),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId: crypto.randomUUID(),
        content: 'store failure',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('propagates a sequence-reservation failure and persists nothing', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const result = await saveUserOnlyMessage(
      deps({
        conversationsStores: (tx) => {
          const real = createConversationsStores(tx);
          return {
            ...real,
            conversations: {
              ...real.conversations,
              reserveSequenceBlock: () => errAsync(unavailableError('counter down')),
            },
          };
        },
      }),
      {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId,
        content: 'reservation failure',
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(0);
  });

  it('keeps monotonic ordering across sends (never reuses a sequence)', async () => {
    const fixture = await seedFixture();
    for (const content of ['a', 'b', 'c']) {
      const result = await saveUserOnlyMessage(deps(), {
        conversationId: fixture.conversationId,
        senderId: fixture.userId,
        messageId: crypto.randomUUID(),
        content,
      });
      expect(result.isOk()).toBe(true);
    }
    const rows = await db
      .select({ sequenceNumber: messages.sequenceNumber })
      .from(messages)
      .where(eq(messages.conversationId, fixture.conversationId))
      .orderBy(asc(messages.sequenceNumber));
    expect(rows.map((row) => row.sequenceNumber)).toEqual([1, 2, 3]);
  });
});

describe('broadcastUserMessageNew', () => {
  function capturingRealtime(events: RealtimeEvent[]): RealtimeBroadcast {
    return {
      broadcast: (_conversationId, event) => {
        events.push(event);
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
      evict: () => okAsync(0),
      presence: () => okAsync([]),
      startRun: () => okAsync({ started: false, code: 'CONCURRENT_RUN' }),
      stopRun: () => okAsync(false),
      upgrade: () => okAsync(new Response(null, { status: 200 })),
    };
  }

  it('broadcasts message:new with the user sender and sequence', async () => {
    const events: RealtimeEvent[] = [];
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const senderId = crypto.randomUUID();

    const result = await broadcastUserMessageNew(capturingRealtime(events), {
      conversationId,
      messageId,
      senderId,
      sequenceNumber: 5,
    });

    expect(result.isOk()).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'message:new',
        conversationId,
        messageId,
        senderType: 'user',
        senderId,
        sequenceNumber: 5,
      }),
    ]);
  });

  it('surfaces a broadcast failure as the Result error (best-effort at the caller)', async () => {
    const failing: RealtimeBroadcast = {
      ...capturingRealtime([]),
      broadcast: () => errAsync(unavailableError('room unreachable')),
    };
    const result = await broadcastUserMessageNew(failing, {
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      sequenceNumber: 1,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
