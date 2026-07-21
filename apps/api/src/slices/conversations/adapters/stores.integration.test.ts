import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  sharedLinks,
  users,
} from '@hushbox/db';
import { createConversationsStores } from './stores.js';
import { isActiveConversationMember } from './presign-reads.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations store tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createConversationsStores(db);

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUserAndConversation(): Promise<{ userId: string; conversationId: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values({
      email: `${username}@fork-stores.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
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
  return { userId, conversationId };
}

async function seedConversation(): Promise<string> {
  const seeded = await seedUserAndConversation();
  return seeded.conversationId;
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

/**
 * The real Postgres error chains behind the fork-name catch mapping. The
 * domain pre-checks make these unreachable through the routes (the byKey
 * transaction would abort), so the raw-client store contract is proven here.
 */
describe('fork store unique-violation mapping (real error chains)', () => {
  it('maps the fork-name unique violation to name-taken on insert', async () => {
    const conversationId = await seedConversation();
    const first = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Dup',
      tipMessageId: null,
    });
    expect(first._unsafeUnwrap()).not.toBe('name-taken');
    const second = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Dup',
      tipMessageId: null,
    });
    expect(second._unsafeUnwrap()).toBe('name-taken');
  });

  it('maps the fork-name unique violation to name-taken on rename', async () => {
    const conversationId = await seedConversation();
    const seeded = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'One',
      tipMessageId: null,
    });
    expect(seeded._unsafeUnwrap()).not.toBe('name-taken');
    const other = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Two',
      tipMessageId: null,
    });
    const otherRecord = other._unsafeUnwrap();
    if (otherRecord === 'name-taken') throw new Error('seed fork collided');
    const renamed = await stores.forks.rename({
      conversationId,
      forkId: otherRecord.id,
      name: 'One',
    });
    expect(renamed._unsafeUnwrap()).toBe('name-taken');
  });

  it('answers unavailable for a non-unique constraint failure', async () => {
    const result = await stores.forks.insert({
      id: null,
      conversationId: crypto.randomUUID(),
      name: 'Orphan',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('single-statement contract arms unreachable through the domain', () => {
  it('converges a member insert lost to the active-unique index to null', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const insert = {
      conversationId,
      userId,
      privilege: 'write' as const,
      visibleFromEpoch: 1,
      acceptedAt: null,
      invitedByUserId: null,
    };
    const first = await stores.members.insert(insert);
    expect(first._unsafeUnwrap()).not.toBeNull();
    const second = await stores.members.insert(insert);
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('answers null when marking an unknown member left', async () => {
    const conversationId = await seedConversation();
    const result = await stores.members.markLeft({
      conversationId,
      memberId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('answers null for a missing epoch number', async () => {
    const conversationId = await seedConversation();
    const missing = await stores.epochs.byNumber(conversationId, 99);
    expect(missing._unsafeUnwrap()).toBeNull();
  });

  it('answers null for the latest message of an empty conversation', async () => {
    const conversationId = await seedConversation();
    const latest = await stores.messages.latestId(conversationId);
    expect(latest._unsafeUnwrap()).toBeNull();
  });
});

async function seedLink(conversationId: string): Promise<string> {
  const rows = await db
    .insert(sharedLinks)
    .values({ conversationId, linkPublicKey: crypto.getRandomValues(new Uint8Array(32)) })
    .returning({ id: sharedLinks.id });
  const linkId = rows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  return linkId;
}

describe('link-guest member helpers', () => {
  it('seats a link guest (userId null, accepted) and converges a duplicate active insert', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const first = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    expect(first._unsafeUnwrap()).not.toBeNull();
    const row = await db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, linkId), isNull(conversationMembers.leftAt)));
    expect(row[0]?.userId).toBeNull();
    expect(row[0]?.privilege).toBe('read');
    expect(row[0]?.acceptedAt).not.toBeNull();
    // A second active insert converges to null on the link-active unique index.
    const second = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('marks the link guest left and denies the presign member gate thereafter', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    expect(seated._unsafeUnwrap()).not.toBeNull();
    const before = await isActiveConversationMember(db, conversationId, {
      kind: 'linkGuest',
      linkId,
    });
    expect(before._unsafeUnwrap()).toBe(true);

    const left = await stores.members.markLeftByLink({ conversationId, linkId });
    expect(left._unsafeUnwrap()).not.toBeNull();
    const row = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkId));
    expect(row[0]?.leftAt).not.toBeNull();
    // Security invariant: the presign member path (leftAt-only) now denies the guest.
    const after = await isActiveConversationMember(db, conversationId, {
      kind: 'linkGuest',
      linkId,
    });
    expect(after._unsafeUnwrap()).toBe(false);
  });

  it('answers null when marking an already-left link guest', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const result = await stores.members.markLeftByLink({ conversationId, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('link privilege and display-name writes', () => {
  it('updates the active guest member privilege and returns its id', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    const memberId = seated._unsafeUnwrap()?.id;
    const updated = await stores.members.updatePrivilegeByLink({
      conversationId,
      linkId,
      privilege: 'write',
    });
    expect(updated._unsafeUnwrap()).toEqual({ id: memberId });
    const row = await db
      .select({ privilege: conversationMembers.privilege })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, linkId), isNull(conversationMembers.leftAt)));
    expect(row[0]?.privilege).toBe('write');
  });

  it('returns null updating a link with no active guest member', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const updated = await stores.members.updatePrivilegeByLink({
      conversationId,
      linkId,
      privilege: 'write',
    });
    expect(updated._unsafeUnwrap()).toBeNull();
  });

  it('renames a live link and reports true', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const result = await stores.sharedLinks.updateDisplayName({
      conversationId,
      linkId,
      displayName: 'renamed',
    });
    expect(result._unsafeUnwrap()).toBe(true);
    const row = await db
      .select({ displayName: sharedLinks.displayName })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row[0]?.displayName).toBe('renamed');
  });

  it('reports false renaming a revoked link', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.updateDisplayName({
      conversationId,
      linkId,
      displayName: 'nope',
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });
});

describe('shared-link unrevoke claim', () => {
  it('clears revokedAt on a revoked link and returns the live record', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.unrevoke({ conversationId, linkId });
    expect(result._unsafeUnwrap()?.revokedAt).toBeNull();
    const row = await db
      .select({ revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row[0]?.revokedAt).toBeNull();
  });

  it('answers null unrevoking a live link (0 rows claimed)', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const result = await stores.sharedLinks.unrevoke({ conversationId, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('answers null for a link of another conversation', async () => {
    const conversationId = await seedConversation();
    const other = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.unrevoke({ conversationId: other, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('listForConversation privilege projection', () => {
  async function seatLink(conversationId: string, privilege: 'read' | 'write'): Promise<string> {
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege,
      visibleFromEpoch: 1,
    });
    seated._unsafeUnwrap();
    return linkId;
  }

  it('projects a freshly seated link guest privilege (write)', async () => {
    const conversationId = await seedConversation();
    const linkId = await seatLink(conversationId, 'write');
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === linkId)?.privilege).toBe('write');
  });

  it('projects a read link guest privilege', async () => {
    const conversationId = await seedConversation();
    const linkId = await seatLink(conversationId, 'read');
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === linkId)?.privilege).toBe('read');
  });

  it('falls back to the write default for a link with no active guest member', async () => {
    const conversationId = await seedConversation();
    const linkId = await seatLink(conversationId, 'read');
    // Revoking marks the guest left; the link then has no active member row.
    const left = await stores.members.markLeftByLink({ conversationId, linkId });
    left._unsafeUnwrap();
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === linkId)?.privilege).toBe('write');
  });

  it('excludes a revoked link from the list', async () => {
    const conversationId = await seedConversation();
    const liveId = await seedLink(conversationId);
    const revokedId = await seedLink(conversationId);
    await db
      .update(sharedLinks)
      .set({ revokedAt: new Date() })
      .where(eq(sharedLinks.id, revokedId));
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === revokedId)).toBeUndefined();
    expect(links.find((l) => l.id === liveId)).toBeDefined();
  });
});

describe('conversation budget exposure', () => {
  it('surfaces the configured per-conversation budget on the record', async () => {
    const { userId } = await seedUserAndConversation();
    const rows = await db
      .insert(conversations)
      .values({ userId, title: BYTES, conversationBudgetNanoUsd: 3_000_000_000n })
      .returning({ id: conversations.id });
    const conversationId = rows[0]?.id;
    if (conversationId === undefined) throw new Error('budget conversation seed failed');
    createdConversationIds.push(conversationId);

    const found = await stores.conversations.get(conversationId);
    expect(found._unsafeUnwrap()?.conversationBudgetNanoUsd).toBe(3_000_000_000n);
  });

  it('defaults an unconfigured conversation budget to zero (unlimited)', async () => {
    const conversationId = await seedConversation();
    const found = await stores.conversations.get(conversationId);
    expect(found._unsafeUnwrap()?.conversationBudgetNanoUsd).toBe(0n);
  });
});
