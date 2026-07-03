import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, sharedLinks, users } from '@hushbox/db';
import { createLinkResolutionAdapter } from './link-resolution.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('DATABASE_URL is required for the link-resolution adapter tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUser(): Promise<string> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@link-resolution.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversation(userId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(id);
  return id;
}

async function seedLink(params: {
  readonly conversationId: string;
  readonly revokedAt?: Date;
  readonly expiresAt?: Date;
}): Promise<{ linkId: string; linkPublicKey: Uint8Array }> {
  const linkPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(sharedLinks)
    .values({
      conversationId: params.conversationId,
      linkPublicKey,
      displayName: null,
      expiresAt: params.expiresAt ?? null,
      ...(params.revokedAt === undefined ? {} : { revokedAt: params.revokedAt }),
    })
    .returning({ id: sharedLinks.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('shared link seed failed');
  return { linkId: id, linkPublicKey };
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

describe('createLinkResolutionAdapter', () => {
  it('resolves a live link to its link and conversation ids', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkId, linkPublicKey } = await seedLink({ conversationId });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkPublicKey);
    expect(result.isOk() && result.value).toEqual({ linkId, conversationId });
  });

  it('resolves a live link whose expiry is still in the future', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkId, linkPublicKey } = await seedLink({
      conversationId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkPublicKey);
    expect(result.isOk() && result.value).toEqual({ linkId, conversationId });
  });

  it('answers null for an unknown credential', async () => {
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(
      crypto.getRandomValues(new Uint8Array(32))
    );
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for a revoked link', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkPublicKey } = await seedLink({ conversationId, revokedAt: new Date() });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkPublicKey);
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for a link expiring at the exact resolution instant (inclusive expiry)', async () => {
    const conversationId = await seedConversation(await seedUser());
    const expiresAt = new Date();
    const { linkPublicKey } = await seedLink({ conversationId, expiresAt });
    const result = await createLinkResolutionAdapter(db, () => expiresAt).resolveLinkCredential(
      linkPublicKey
    );
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for an expired link', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkPublicKey } = await seedLink({
      conversationId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkPublicKey);
    expect(result.isOk() && result.value).toBe(null);
  });
});
