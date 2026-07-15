import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, messages, users } from '@hushbox/db';
import { generateKeyPair } from '@hushbox/crypto';
import { createR2StorageFromEnv } from '../../slices/media/index.js';
import {
  createDevConversation,
  createDevGroupChat,
  createDevMediaConversation,
  createDevMultiModelConversation,
} from './factories.js';
import type { EnvContext } from '@hushbox/shared';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for factory integration tests`);
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });
const storageEnv: EnvContext & Record<string, unknown> = {
  NODE_ENV: 'development',
  R2_S3_ENDPOINT: requiredEnv('R2_S3_ENDPOINT'),
  R2_BUCKET_MEDIA: requiredEnv('R2_BUCKET_MEDIA'),
  R2_ACCESS_KEY_ID: requiredEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredEnv('R2_SECRET_ACCESS_KEY'),
};
const storage = createR2StorageFromEnv(storageEnv, db);

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

async function seedUser(): Promise<{ id: string; email: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const keys = generateKeyPair();
  const email = `factory-${suffix}@factory-dev.test`;
  const rows = await db
    .insert(users)
    .values({
      email,
      username: `f${suffix}`,
      opaqueRegistration: new Uint8Array([1]),
      publicKey: keys.publicKey,
      passwordWrappedPrivateKey: new Uint8Array([1]),
      recoveryWrappedPrivateKey: new Uint8Array([1]),
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return { id, email };
}

describe('createDevConversation with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedUser();
    const id = crypto.randomUUID();
    const result = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
      id,
    });
    expect(result.conversationId).toBe(id);
    const rows = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(rows).toHaveLength(1);
  });

  it('is idempotent on a pinned-id re-run (the profile seed re-runs)', async () => {
    const owner = await seedUser();
    const id = crypto.randomUUID();
    const params = {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
      id,
      messages: [{ content: 'hello', senderType: 'user' as const }],
    };
    const first = await createDevConversation(db, params);
    const second = await createDevConversation(db, params);
    expect(second.conversationId).toBe(first.conversationId);
    const messageRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, id));
    expect(messageRows).toHaveLength(1);
  });

  it('mints a fresh random id when none is supplied', async () => {
    const owner = await seedUser();
    const a = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
    });
    const b = await createDevConversation(db, {
      ownerEmail: owner.email,
      seedAiModel: 'dev/model',
    });
    expect(a.conversationId).toMatch(UUID_RE);
    expect(b.conversationId).toMatch(UUID_RE);
    expect(a.conversationId).not.toBe(b.conversationId);
  });
});

describe('createDevMultiModelConversation with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedUser();
    const id = crypto.randomUUID();
    const result = await createDevMultiModelConversation(db, {
      ownerEmail: owner.email,
      userContent: 'compare',
      aiResponses: [{ content: 'a', modelName: 'dev/model', costNanoUsd: 1_000_000n }],
      id,
    });
    expect(result.conversationId).toBe(id);
  });
});

describe('createDevGroupChat with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const id = crypto.randomUUID();
    const result = await createDevGroupChat(db, {
      ownerEmail: owner.email,
      memberEmails: [member.email],
      seedAiModel: 'dev/model',
      id,
    });
    expect(result.conversationId).toBe(id);
  });

  it('is idempotent on a pinned-id re-run (the profile seed re-runs)', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const id = crypto.randomUUID();
    const params = {
      ownerEmail: owner.email,
      memberEmails: [member.email],
      seedAiModel: 'dev/model',
      id,
    };
    const first = await createDevGroupChat(db, params);
    const second = await createDevGroupChat(db, params);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.members.map((m) => m.email)).toEqual(first.members.map((m) => m.email));
  });
});

describe('createDevMediaConversation with an explicit id', () => {
  it('uses the supplied conversation id verbatim', async () => {
    const owner = await seedUser();
    const id = crypto.randomUUID();
    const result = await createDevMediaConversation(db, storage, {
      ownerEmail: owner.email,
      userContent: 'draw a cat',
      mediaType: 'image',
      modelId: 'dev/model',
      costNanoUsd: 3_000_000n,
      id,
    });
    expect(result.conversationId).toBe(id);
  });
});
