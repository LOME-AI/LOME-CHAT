import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  messages,
  conversations,
  conversationForks,
  epochs,
  type Database,
} from '@hushbox/db';
import { userFactory, conversationFactory, messageFactory } from '@hushbox/db/factories';
import { applyTreeAction } from './tree-action.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

interface TestSetup {
  user: typeof users.$inferSelect;
  conversation: typeof conversations.$inferSelect;
}

async function createTestSetup(db: Database): Promise<TestSetup> {
  const userData = userFactory.build();
  const [createdUser] = await db.insert(users).values(userData).returning();
  if (!createdUser) throw new Error('Failed to create test user');

  const convData = conversationFactory.build({ userId: createdUser.id });
  const [createdConv] = await db.insert(conversations).values(convData).returning();
  if (!createdConv) throw new Error('Failed to create test conversation');

  await db.insert(epochs).values({
    conversationId: createdConv.id,
    epochNumber: 1,
    epochPublicKey: new Uint8Array(32),
    confirmationHash: new Uint8Array(32),
  });

  return { user: createdUser, conversation: createdConv };
}

async function insertMsg(
  db: Database,
  overrides: Partial<typeof messages.$inferSelect> & {
    conversationId: string;
    sequenceNumber: number;
  }
): Promise<typeof messages.$inferSelect> {
  const data = messageFactory.build({
    senderType: 'user',
    epochNumber: 1,
    ...overrides,
  });
  const [msg] = await db.insert(messages).values(data).returning();
  if (!msg) throw new Error('Failed to insert message');
  return msg;
}

describe('applyTreeAction', () => {
  let db: Database;
  const createdUserIds: string[] = [];

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      const convIds = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(inArray(conversations.userId, createdUserIds));
      const ids = convIds.map((c) => c.id);
      if (ids.length > 0) {
        await db.delete(conversationForks).where(inArray(conversationForks.conversationId, ids));
        await db.delete(messages).where(inArray(messages.conversationId, ids));
        await db.delete(epochs).where(inArray(epochs.conversationId, ids));
      }
      await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
  });

  describe('fresh-send', () => {
    it('returns the new user message as the assistant parent', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'fresh-send',
          userMessage: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', content: 'hi' },
          parentMessageId: null,
        })
      );

      expect(result.parentMessageIdForAssistants).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      expect(result.userMessageInsert).toEqual({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        content: 'hi',
        parentMessageId: null,
      });
      expect(result.forkTipExpectedMessageId).toBeNull();
    });

    it('forwards parentMessageId as the fork-tip guard when supplied', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const root = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'fresh-send',
          userMessage: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', content: 'next' },
          parentMessageId: root.id,
        })
      );

      expect(result.parentMessageIdForAssistants).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      expect(result.forkTipExpectedMessageId).toBe(root.id);
    });

    it('rejects null parent when conversation already has messages', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'fresh-send',
            userMessage: { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', content: 'no' },
            parentMessageId: null,
          })
        )
      ).rejects.toThrow();
    });

    it('rejects non-null parent that does not belong to the conversation', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'fresh-send',
            userMessage: { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', content: 'no' },
            parentMessageId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          })
        )
      ).rejects.toThrow();
    });

    it('does not delete or insert anything during the mutation step', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const root = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'fresh-send',
          userMessage: { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', content: 'next' },
          parentMessageId: root.id,
        })
      );

      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(root.id);
    });
  });

  describe('regenerate', () => {
    it('deletes messages after the anchor and preserves the anchor', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
        })
      );

      expect(result.parentMessageIdForAssistants).toBe(userMsg.id);
      expect(result.userMessageInsert).toBeUndefined();
      expect(result.forkTipExpectedMessageId).toBeNull();

      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      const ids = remaining.map((m) => m.id);
      expect(ids).toContain(userMsg.id);
      expect(ids).not.toContain(aiMsg.id);
    });

    it('forwards forkTipMessageId for fork-aware deletion and as fork-tip guard', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
          forkTipMessageId: aiMsg.id,
        })
      );

      expect(result.forkTipExpectedMessageId).toBe(aiMsg.id);

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(userMsg.id);
      expect(ids).not.toContain(aiMsg.id);
    });

    it('returns forkTipExpectedMessageId=null when forkId is passed and the cascade nulls the tip', async () => {
      // Regression: deleting a fork's tip message used to cascade `ON DELETE
      // SET NULL` on conversation_forks.tip_message_id WITHIN the regenerate
      // transaction, then the saveChatTurn updateForkTip call would compare
      // against the OLD tip id and find zero rows, throwing
      // ForkTipConflictError. The fix locks the fork row up front (SELECT
      // FOR UPDATE), validates the expected tip, then returns null so the
      // downstream optimistic UPDATE matches the cascaded NULL.
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const [fork] = await db
        .insert(conversationForks)
        .values({ conversationId: setup.conversation.id, name: 'Main', tipMessageId: aiMsg.id })
        .returning({ id: conversationForks.id });
      if (!fork) throw new Error('fork insert failed');

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
          forkId: fork.id,
          forkTipMessageId: aiMsg.id,
        })
      );

      expect(result.forkTipExpectedMessageId).toBeNull();

      // The fork tip should be NULL post-cascade (the AI message we pointed
      // to was deleted as part of the regenerate).
      const [forkAfter] = await db
        .select({ tipMessageId: conversationForks.tipMessageId })
        .from(conversationForks)
        .where(eq(conversationForks.id, fork.id));
      expect(forkAfter?.tipMessageId).toBeNull();
    });

    it('throws ForkTipConflictError when forkId is passed but the observed tip diverges from the expected tip', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const oldTip = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });
      const newTip = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const [fork] = await db
        .insert(conversationForks)
        .values({ conversationId: setup.conversation.id, name: 'Main', tipMessageId: newTip.id })
        .returning({ id: conversationForks.id });
      if (!fork) throw new Error('fork insert failed');

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'regenerate',
            anchorUserMessageId: userMsg.id,
            forkId: fork.id,
            forkTipMessageId: oldTip.id, // stale snapshot
          })
        )
      ).rejects.toMatchObject({ code: 'FORK_TIP_CONFLICT' });
    });

    it('is a no-op when the anchor has no descendants', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });

      await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'regenerate',
          anchorUserMessageId: userMsg.id,
        })
      );

      const remaining = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(userMsg.id);
    });

    describe('with replaceAssistantId (regenerate-one)', () => {
      it('deletes only the named assistant, preserving siblings under the same parent', async () => {
        const setup = await createTestSetup(db);
        createdUserIds.push(setup.user.id);

        const userMsg = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 1,
          senderId: setup.user.id,
          parentMessageId: null,
        });
        const m1 = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 2,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });
        const m2 = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 3,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });
        const m3 = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 4,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });

        const result = await db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'regenerate',
            anchorUserMessageId: userMsg.id,
            replaceAssistantId: m1.id,
          })
        );

        expect(result.parentMessageIdForAssistants).toBe(userMsg.id);
        expect(result.userMessageInsert).toBeUndefined();

        const remaining = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, setup.conversation.id));
        const ids = remaining.map((r) => r.id);
        expect(ids).toContain(userMsg.id);
        expect(ids).toContain(m2.id);
        expect(ids).toContain(m3.id);
        expect(ids).not.toContain(m1.id);
      });

      it('is a no-op when replaceAssistantId does not exist (idempotent retry)', async () => {
        const setup = await createTestSetup(db);
        createdUserIds.push(setup.user.id);

        const userMsg = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 1,
          senderId: setup.user.id,
          parentMessageId: null,
        });
        const surviving = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 2,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });

        await db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'regenerate',
            anchorUserMessageId: userMsg.id,
            replaceAssistantId: '00000000-0000-0000-0000-000000000000',
          })
        );

        const remaining = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, setup.conversation.id));
        const byId = (a: string, b: string): number => a.localeCompare(b);
        expect(remaining.map((r) => r.id).toSorted(byId)).toEqual(
          [userMsg.id, surviving.id].toSorted(byId)
        );
      });

      it('does not touch messages outside the conversation', async () => {
        const setup = await createTestSetup(db);
        createdUserIds.push(setup.user.id);

        const userMsg = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 1,
          senderId: setup.user.id,
          parentMessageId: null,
        });
        const target = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 2,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });

        // Set up a parallel conversation owned by the same user, with an
        // assistant message that happens to be the regenerate target's twin
        // by everything but conversation_id. Confirms the WHERE clause
        // includes conversation_id.
        const otherConv = await db
          .insert(conversations)
          .values({ userId: setup.user.id, title: new Uint8Array([1]) })
          .returning();
        if (!otherConv[0]) throw new Error('other conv insert failed');
        await db.insert(epochs).values({
          conversationId: otherConv[0].id,
          epochNumber: 1,
          epochPublicKey: new Uint8Array(32),
          confirmationHash: new Uint8Array(32),
        });
        const decoy = await insertMsg(db, {
          conversationId: otherConv[0].id,
          sequenceNumber: 1,
          senderType: 'ai',
          senderId: null,
          parentMessageId: null,
        });

        await db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'regenerate',
            anchorUserMessageId: userMsg.id,
            replaceAssistantId: target.id,
          })
        );

        const decoyAfter = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.id, decoy.id));
        expect(decoyAfter).toHaveLength(1);
      });

      it('returns forkTipExpectedMessageId=null when fork tip is the replaced assistant', async () => {
        const setup = await createTestSetup(db);
        createdUserIds.push(setup.user.id);

        const userMsg = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 1,
          senderId: setup.user.id,
          parentMessageId: null,
        });
        const tip = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 2,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });

        const [fork] = await db
          .insert(conversationForks)
          .values({ conversationId: setup.conversation.id, name: 'Main', tipMessageId: tip.id })
          .returning({ id: conversationForks.id });
        if (!fork) throw new Error('fork insert failed');

        const result = await db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'regenerate',
            anchorUserMessageId: userMsg.id,
            replaceAssistantId: tip.id,
            forkId: fork.id,
            forkTipMessageId: tip.id,
          })
        );

        // Cascade nulls the tip → downstream optimistic UPDATE expects NULL.
        expect(result.forkTipExpectedMessageId).toBeNull();
      });

      it('returns forkTipExpectedMessageId=current tip when fork tip survives the replacement', async () => {
        const setup = await createTestSetup(db);
        createdUserIds.push(setup.user.id);

        const userMsg = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 1,
          senderId: setup.user.id,
          parentMessageId: null,
        });
        const m1 = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 2,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });
        const tip = await insertMsg(db, {
          conversationId: setup.conversation.id,
          sequenceNumber: 3,
          senderType: 'ai',
          senderId: null,
          parentMessageId: userMsg.id,
        });

        const [fork] = await db
          .insert(conversationForks)
          .values({ conversationId: setup.conversation.id, name: 'Main', tipMessageId: tip.id })
          .returning({ id: conversationForks.id });
        if (!fork) throw new Error('fork insert failed');

        const result = await db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'regenerate',
            anchorUserMessageId: userMsg.id,
            replaceAssistantId: m1.id, // not the tip
            forkId: fork.id,
            forkTipMessageId: tip.id,
          })
        );

        // Tip wasn't touched; downstream optimistic UPDATE should expect the
        // original tip id, not NULL.
        expect(result.forkTipExpectedMessageId).toBe(tip.id);
      });
    });
  });

  describe('edit', () => {
    it('replaces a non-root user message: deletes target+descendants, returns new user insert', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userA = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiA = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userA.id,
      });
      const userB = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 3,
        senderId: setup.user.id,
        parentMessageId: aiA.id,
      });
      const aiB = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 4,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userB.id,
      });

      const newUserId = '11111111-1111-1111-1111-111111111111';

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'edit',
          anchorUserMessageId: userB.id,
          newUserMessage: { id: newUserId, content: 'edited' },
        })
      );

      expect(result.parentMessageIdForAssistants).toBe(newUserId);
      expect(result.userMessageInsert).toEqual({
        id: newUserId,
        content: 'edited',
        parentMessageId: aiA.id,
      });
      expect(result.forkTipExpectedMessageId).toBeNull();

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(userA.id);
      expect(ids).toContain(aiA.id);
      expect(ids).not.toContain(userB.id);
      expect(ids).not.toContain(aiB.id);
    });

    it('replaces a root user message: deletes target+descendants, returns null parent', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const root = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const child = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: root.id,
      });

      const newUserId = '22222222-2222-2222-2222-222222222222';

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'edit',
          anchorUserMessageId: root.id,
          newUserMessage: { id: newUserId, content: 'edited root' },
        })
      );

      expect(result.parentMessageIdForAssistants).toBe(newUserId);
      expect(result.userMessageInsert).toEqual({
        id: newUserId,
        content: 'edited root',
        parentMessageId: null,
      });

      const remaining = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, setup.conversation.id));
      expect(remaining.map((r) => r.id)).not.toContain(root.id);
      expect(remaining.map((r) => r.id)).not.toContain(child.id);
    });

    it('throws when the target message does not exist', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      await expect(
        db.transaction(async (tx) =>
          applyTreeAction(tx, setup.conversation.id, {
            kind: 'edit',
            anchorUserMessageId: '99999999-9999-9999-9999-999999999999',
            newUserMessage: {
              id: '33333333-3333-3333-3333-333333333333',
              content: 'edited',
            },
          })
        )
      ).rejects.toThrow('Target message not found');
    });

    it('forwards forkTipMessageId as the fork-tip guard', async () => {
      const setup = await createTestSetup(db);
      createdUserIds.push(setup.user.id);

      const userMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 1,
        senderId: setup.user.id,
        parentMessageId: null,
      });
      const aiMsg = await insertMsg(db, {
        conversationId: setup.conversation.id,
        sequenceNumber: 2,
        senderType: 'ai',
        senderId: null,
        parentMessageId: userMsg.id,
      });

      const result = await db.transaction(async (tx) =>
        applyTreeAction(tx, setup.conversation.id, {
          kind: 'edit',
          anchorUserMessageId: userMsg.id,
          newUserMessage: {
            id: '44444444-4444-4444-4444-444444444444',
            content: 'edited',
          },
          forkTipMessageId: aiMsg.id,
        })
      );

      expect(result.forkTipExpectedMessageId).toBe(aiMsg.id);
    });
  });
});
