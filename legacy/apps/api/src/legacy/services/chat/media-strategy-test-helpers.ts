import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  epochs,
  ledgerEntries,
  usageRecords,
  users,
  wallets,
  type Database,
} from '@hushbox/db';
import { conversationFactory, userFactory, walletFactory } from '@hushbox/db/factories';
import {
  beginMessageEnvelope,
  createFirstEpoch,
  decryptBinaryWithContentKey,
  encryptBinaryWithContentKey,
  generateKeyPair,
  type LegacyContentKey,
} from '@hushbox/crypto';
import { createMediaStorage } from '../storage/media-storage.js';
import type { MediaStorage } from '../storage/types.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const R2_S3_ENDPOINT = process.env['R2_S3_ENDPOINT'];
const R2_ACCESS_KEY_ID = process.env['R2_ACCESS_KEY_ID'];
const R2_SECRET_ACCESS_KEY = process.env['R2_SECRET_ACCESS_KEY'];
const R2_BUCKET_MEDIA = process.env['R2_BUCKET_MEDIA'];

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for media strategy integration tests — run pnpm ensure-stack from the repo root'
  );
}
if (!R2_S3_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_MEDIA) {
  throw new Error(
    'R2 env vars (R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_MEDIA) are required for media strategy integration tests — run pnpm ensure-stack from the repo root'
  );
}

const VALIDATED_ENV = {
  DATABASE_URL,
  R2_S3_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_MEDIA,
} as const;

export interface TestSetup {
  user: typeof users.$inferSelect;
  conversation: typeof conversations.$inferSelect;
  epoch: typeof epochs.$inferSelect;
  wallet: typeof wallets.$inferSelect;
  epochPrivateKey: Uint8Array;
}

export interface MediaStrategyTestContext {
  db: Database;
  setup: TestSetup;
  storage: MediaStorage;
  cleanupKeys: string[];
  cleanupUserIds: string[];
}

/** Build a fresh DB user + conversation + epoch + wallet for an integration test. */
export async function createTestSetup(db: Database, balance = '10.00000000'): Promise<TestSetup> {
  const accountKeyPair = generateKeyPair();
  const userData = userFactory.build({ publicKey: accountKeyPair.publicKey });
  const [createdUser] = await db.insert(users).values(userData).returning();
  if (!createdUser) throw new Error('Failed to create test user');

  const convData = conversationFactory.build({ userId: createdUser.id });
  const [createdConv] = await db.insert(conversations).values(convData).returning();
  if (!createdConv) throw new Error('Failed to create test conversation');

  const epochResult = createFirstEpoch([accountKeyPair.publicKey], createdConv.id, 1);
  const [createdEpoch] = await db
    .insert(epochs)
    .values({
      conversationId: createdConv.id,
      epochNumber: 1,
      epochPublicKey: epochResult.epochPublicKey,
      confirmationHash: epochResult.confirmationHash,
    })
    .returning();
  if (!createdEpoch) throw new Error('Failed to create test epoch');

  const walletData = walletFactory.build({
    userId: createdUser.id,
    type: 'purchased',
    balance,
    priority: 0,
  });
  const [createdWallet] = await db.insert(wallets).values(walletData).returning();
  if (!createdWallet) throw new Error('Failed to create test wallet');

  return {
    user: createdUser,
    conversation: createdConv,
    epoch: createdEpoch,
    wallet: createdWallet,
    epochPrivateKey: epochResult.epochPrivateKey,
  };
}

/** Build a media-strategy test context: real DB, real MinIO, fresh user/conv/epoch/wallet. */
export async function setupMediaStrategyTest(): Promise<MediaStrategyTestContext> {
  const db = createDb({
    connectionString: VALIDATED_ENV.DATABASE_URL,
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });
  const storage = createMediaStorage(VALIDATED_ENV);
  const setup = await createTestSetup(db);
  return {
    db,
    setup,
    storage,
    cleanupKeys: [],
    cleanupUserIds: [setup.user.id],
  };
}

export interface EncryptedUploadResult {
  storageKey: string;
  ciphertext: Uint8Array;
  contentKey: LegacyContentKey;
  wrappedContentKey: Uint8Array;
}

/**
 * Encrypt canned plaintext bytes under a fresh content key wrapped to the
 * test setup's epoch public key, then upload the ciphertext to MinIO at a
 * deterministic key derived from conversationId/messageId/contentItemId.
 *
 * Returns everything saveChatTurn needs (storageKey, wrappedContentKey)
 * plus the contentKey + ciphertext so tests can verify the round trip.
 */
export async function encryptAndUploadMedia(params: {
  ctx: MediaStrategyTestContext;
  cannedBytes: Uint8Array;
  conversationId: string;
  messageId: string;
  contentItemId: string;
  mimeType: string;
}): Promise<EncryptedUploadResult> {
  const { ctx, cannedBytes, conversationId, messageId, contentItemId, mimeType } = params;
  const envelope = beginMessageEnvelope(ctx.setup.epoch.epochPublicKey);
  const ciphertext = encryptBinaryWithContentKey(envelope.contentKey, cannedBytes);
  const storageKey = `media/${conversationId}/${messageId}/${contentItemId}.enc`;

  await ctx.storage.put(storageKey, ciphertext, mimeType);
  ctx.cleanupKeys.push(storageKey);

  return {
    storageKey,
    ciphertext,
    contentKey: envelope.contentKey,
    wrappedContentKey: envelope.wrappedContentKey,
  };
}

/** Mint a presigned URL for the storageKey, fetch it, decrypt with contentKey. */
export async function fetchAndDecryptMedia(params: {
  storage: MediaStorage;
  storageKey: string;
  contentKey: LegacyContentKey;
}): Promise<Uint8Array> {
  const { url } = await params.storage.mintDownloadUrl({ key: params.storageKey });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${params.storageKey}: HTTP ${String(response.status)}`);
  }
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  return decryptBinaryWithContentKey(params.contentKey, ciphertext);
}

/**
 * Best-effort cleanup of every R2 object the test wrote. Does NOT touch DB —
 * use {@link cleanupTestUserData} for that.
 */
export async function cleanupMediaTest(ctx: MediaStrategyTestContext): Promise<void> {
  for (const key of ctx.cleanupKeys) {
    try {
      await ctx.storage.delete(key);
    } catch {
      // best effort
    }
  }
  ctx.cleanupKeys = [];
}

/**
 * Delete every DB row owned by a test user, in FK order:
 * ledger_entries → usage_records → wallets → conversations (cascades to
 * messages/content_items/media_generations) → users.
 *
 * Use in afterEach for any integration test that calls saveChatTurn or
 * otherwise charges a wallet — tests must clean up so the next run starts
 * fresh.
 */
export async function cleanupTestUserData(db: Database, userId: string): Promise<void> {
  const userWallets = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(eq(wallets.userId, userId));
  if (userWallets.length > 0) {
    await db.delete(ledgerEntries).where(
      inArray(
        ledgerEntries.walletId,
        userWallets.map((w) => w.id)
      )
    );
  }
  await db.delete(usageRecords).where(eq(usageRecords.userId, userId));
  await db.delete(wallets).where(eq(wallets.userId, userId));
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}
