import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { sealData } from 'iron-session';
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
  sharedMessages,
  users,
} from '@hushbox/db';
import { applyPipeline } from './middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from './middleware/pipeline-session.js';
import { createPresignReaders } from './adapters/presign-readers.js';
import { createLinkResolutionAdapter } from './adapters/link-resolution.js';
import { createMediaManifest } from './slices/media/index.js';
import { mediaObjectKey } from './slices/media/ports/index.js';
import { createScratchBucket, unwrap } from './slices/media/adapters/test-fixtures.js';
import type { Database } from '@hushbox/db';
import type { AppEnv, Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';
import type { ScratchBucket } from './slices/media/adapters/test-fixtures.js';

// This is the end-to-end proof that the composition-root readers back the real
// mounted manifest: real Postgres rows drive `createPresignReaders`, a scratch
// MinIO bucket backs the presign, and `createLinkResolutionAdapter` gates the
// share carve-out — the exact wiring `app.ts` installs, exercised over HTTP.

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for media mount tests');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for media mount tests`);
  }
  return value;
}

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings &
  TelemetryEnv & { FRONTEND_URL: string; MARKETING_URL: string; FRONTEND_PREVIEW_URL: string } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  FRONTEND_URL: requiredEnv('FRONTEND_URL'),
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
};

const db: Database = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([7, 7, 7]);
const grantSchema = z.object({ downloadUrl: z.string(), expiresAt: z.string() });

const createdConversationIds: string[] = [];
const createdUserIds: string[] = [];

interface Seeded {
  readonly memberUserId: string;
  readonly outsiderUserId: string;
  readonly contentItemId: string;
  readonly storageKey: string;
  readonly sharedMessageId: string;
}

function firstId(rows: readonly { readonly id: string }[], label: string): string {
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`${label} seed failed`);
  return id;
}

async function seedUser(publicKey: Uint8Array): Promise<string> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userId = firstId(
    await db
      .insert(users)
      .values({
        email: `${username}@media-mount.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
      })
      .returning({ id: users.id }),
    'user'
  );
  createdUserIds.push(userId);
  return userId;
}

/**
 * Seeds a full media graph: an epoch member (can presign), a conversation
 * member with NO epoch row (must be denied blind), a media content item, and a
 * standalone shared message (no link, no revoke).
 */
async function seedGraph(): Promise<Seeded> {
  const memberPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const memberUserId = await seedUser(memberPublicKey);
  const outsiderUserId = await seedUser(crypto.getRandomValues(new Uint8Array(32)));

  const conversationId = firstId(
    await db.insert(conversations).values({ userId: memberUserId, title: BYTES }).returning({
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

  // The member holds both a conversation row and an epoch row; the outsider
  // holds only the conversation row, so the epoch gate must deny them.
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId: memberUserId, visibleFromEpoch: 0 });
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId: outsiderUserId, visibleFromEpoch: 0 });
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey, wrap: BYTES, visibleFromEpoch: 0 });

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

  const storageKey = mediaObjectKey({
    conversationId,
    messageId,
    objectId: crypto.randomUUID(),
  });
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
      .values({ messageId, createdBy: memberUserId, wrappedContentKey: BYTES })
      .returning({ id: sharedMessages.id }),
    'shared message'
  );

  return { memberUserId, outsiderUserId, contentItemId, storageKey, sharedMessageId };
}

async function sessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: `session-${crypto.randomUUID()}`,
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

describe('media presign manifest wired with real composition-root readers', () => {
  let scratch: ScratchBucket;

  function mount(): Hono<AppEnv> {
    const manifest = createMediaManifest({
      readers: createPresignReaders,
      storage: () => scratch.storage,
      linkResolution: (requestDb) => createLinkResolutionAdapter(requestDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  beforeAll(async () => {
    scratch = await createScratchBucket();
  });

  afterAll(async () => {
    await scratch.destroy();
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await db.$client.end();
  });

  it('a member presigns its own conversation media', async () => {
    const seed = await seedGraph();
    await unwrap(
      scratch.storage.put(seed.storageKey, BYTES, { contentType: 'application/octet-stream' })
    );

    const response = await mount().request(
      `/media/${seed.contentItemId}/download-url`,
      { headers: { cookie: await sessionCookie(seed.memberUserId) } },
      testEnv
    );

    expect(response.status).toBe(200);
    grantSchema.parse(await response.json());
  });

  it('a conversation member outside the epoch is denied blind', async () => {
    const seed = await seedGraph();

    const response = await mount().request(
      `/media/${seed.contentItemId}/download-url`,
      { headers: { cookie: await sessionCookie(seed.outsiderUserId) } },
      testEnv
    );

    expect(response.status).toBe(404);
  });

  it('the share path presigns a shared message with no authentication', async () => {
    const seed = await seedGraph();
    await unwrap(
      scratch.storage.put(seed.storageKey, BYTES, { contentType: 'application/octet-stream' })
    );

    const response = await mount().request(
      `/media/shared/${seed.sharedMessageId}/${seed.contentItemId}/download-url`,
      {},
      testEnv
    );

    expect(response.status).toBe(200);
    grantSchema.parse(await response.json());
  });
});
