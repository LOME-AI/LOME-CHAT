import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  users,
} from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import {
  deleteOwnedConversationsWithinTx,
  leaveAllMembershipsWithinTx,
  ownedConversationIdsWithinTx,
} from './account-deletion.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations account-deletion tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zc${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

async function seedUser(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `${PREFIX}u${String(counter)}@conv-deletion.test`,
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
  const [row] = await db
    .insert(conversations)
    .values({ userId: ownerUserId, title: BYTES })
    .returning({ id: conversations.id });
  if (!row) throw new Error('conversation seed failed');
  return row.id;
}

async function seedMembership(
  conversationId: string,
  userId: string,
  leftAt: Date | null = null
): Promise<string> {
  const [row] = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1, leftAt })
    .returning({ id: conversationMembers.id });
  if (!row) throw new Error('membership seed failed');
  return row.id;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Conversations first: their cascade removes membership rows, whose
    // userId-SET-NULL would otherwise trip the identity-or-left check — the
    // exact ordering constraint the deletion executor handles via leftAt.
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('ownedConversationIdsWithinTx', () => {
  it('returns only the conversations the user owns, not the ones they merely joined', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(owner);
    const foreign = await seedConversation(other);
    await seedMembership(foreign, owner);

    const ids = await runSettlement(db, (tx) => ownedConversationIdsWithinTx(tx, owner));

    expect([...ids]).toEqual([owned]);
  });

  it('returns an empty list for a user owning no conversations', async () => {
    const loner = await seedUser();

    const ids = await runSettlement(db, (tx) => ownedConversationIdsWithinTx(tx, loner));

    expect(ids).toEqual([]);
  });
});

describe('deleteOwnedConversationsWithinTx', () => {
  it("removes the user's owned conversations and leaves foreign ones standing", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(owner);
    const foreign = await seedConversation(other);

    await runSettlement(db, (tx) => deleteOwnedConversationsWithinTx(tx, owner));

    const remaining = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.id, [owned, foreign]));
    expect(remaining).toEqual([{ id: foreign }]);
  });
});

describe('leaveAllMembershipsWithinTx', () => {
  it('stamps leftAt on every ACTIVE membership of the user and no one else', async () => {
    const leaver = await seedUser();
    const bystander = await seedUser();
    const host = await seedUser();
    const conversationA = await seedConversation(host);
    const conversationB = await seedConversation(host);
    const activeA = await seedMembership(conversationA, leaver);
    const activeB = await seedMembership(conversationB, leaver);
    const bystanderRow = await seedMembership(conversationA, bystander);
    const now = new Date();

    await runSettlement(db, (tx) => leaveAllMembershipsWithinTx(tx, leaver, now));

    const rows = await db
      .select({ id: conversationMembers.id, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(inArray(conversationMembers.id, [activeA, activeB, bystanderRow]));
    const byId = new Map(rows.map((row) => [row.id, row.leftAt]));
    expect(byId.get(activeA)?.getTime()).toBe(now.getTime());
    expect(byId.get(activeB)?.getTime()).toBe(now.getTime());
    expect(byId.get(bystanderRow)).toBeNull();
  });

  it('never rewrites a membership the user already left', async () => {
    const leaver = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    const departedAt = new Date('2026-01-01T00:00:00Z');
    const departedRow = await seedMembership(conversation, leaver, departedAt);

    await runSettlement(db, (tx) => leaveAllMembershipsWithinTx(tx, leaver, new Date()));

    const [row] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, departedRow));
    expect(row?.leftAt?.getTime()).toBe(departedAt.getTime());
  });
});
