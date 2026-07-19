import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DecryptionFailedError,
  decryptContentEnvelope,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
} from '@hushbox/crypto';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createR2Storage } from '../../media/index.js';
import { ASSISTANT_SENDER_ID } from './settlement.js';
import { createMediaPersistRun } from './media-persist.js';
import type { MediaPersistRun } from './media-persist.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type { Storage } from '../../media/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required for media persist integration tests — run via pnpm test:api`
    );
  }
  return value;
}

const db = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  await db.$client.end();
});

// isCI: false — no evidence assertions here, so the evidence write no-ops.
const storage: Storage = createR2Storage({
  endpoint: requireEnv('R2_S3_ENDPOINT'),
  bucket: requireEnv('R2_BUCKET_MEDIA'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
  defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  db,
  isCI: false,
});

const CONVERSATION_ID = crypto.randomUUID();
const EPOCH_NUMBER = 1;
const EPOCH_KEYS = generateEpochKeyPair();
const NODE_ID = 'answer';
const PLAINTEXT = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

let run: MediaPersistRun;
let storedKey: string;
let storedByteLength: number;

beforeAll(async () => {
  run = createMediaPersistRun(
    {
      storage,
      db,
      readEpochPublicKey: () => Promise.resolve(EPOCH_KEYS.publicKey as Uint8Array),
      newId: () => crypto.randomUUID(),
    },
    { conversationId: CONVERSATION_ID, epochNumber: EPOCH_NUMBER },
    [{ id: NODE_ID, params: { aspectRatio: '1:1' } }]
  );
  await run.mint();
  const mapper = run.mapFilePartFor(NODE_ID);
  const [, done] = mapper!({ mediaType: 'image/png', data: PLAINTEXT }, 0);
  storedKey = done.value.ref;
  storedByteLength = done.value.byteLength;
  await run.flushPuts();
});

async function downloadStored(): Promise<Uint8Array> {
  const presigned = await storage.presignGet(storedKey);
  const url = presigned._unsafeUnwrap().url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

describe('media persist against MinIO', () => {
  it('stores the ciphertext under the exact media/{conv}/{msg}/{item} key with the ciphertext size', async () => {
    const plan = run.plans.get(NODE_ID)!;
    expect(storedKey).toBe(
      `media/${CONVERSATION_ID}/${plan.assistantMessageId}/${plan.contentItemId}`
    );
    const stat = await storage.head(storedKey);
    const found = stat._unsafeUnwrap();
    expect(found).not.toBeNull();
    expect(found?.size).toBe(storedByteLength);
    expect(found?.size).not.toBe(PLAINTEXT.length);
  });

  it('round-trips: the epoch-unwrapped content key decrypts the stored blob at the full location tuple', async () => {
    const plan = run.plans.get(NODE_ID)!;
    const wrapped = plan.wrappedContentKey as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(EPOCH_KEYS.privateKey, wrapped);
    const blob = await downloadStored();
    const decrypted = decryptContentEnvelope(
      contentKey,
      wrapped,
      {
        conversationId: CONVERSATION_ID,
        messageId: plan.assistantMessageId,
        contentItemId: plan.contentItemId,
        position: 0,
        epochNumber: EPOCH_NUMBER,
        senderId: ASSISTANT_SENDER_ID,
      },
      blob
    );
    expect(decrypted).toEqual(PLAINTEXT);
  });

  it('fails to decrypt under a user senderId — the AAD binds the assistant sentinel', async () => {
    // Pins the landmine: the dev factory binds the OWNER's id; production
    // assistant content must bind the nil-uuid sentinel instead, or deletion
    // of the initiator would orphan the artifact for co-members.
    const plan = run.plans.get(NODE_ID)!;
    const wrapped = plan.wrappedContentKey as WrappedSecret;
    const contentKey = unwrapContentKeyFromEpoch(EPOCH_KEYS.privateKey, wrapped);
    const blob = await downloadStored();
    expect(() =>
      decryptContentEnvelope(
        contentKey,
        wrapped,
        {
          conversationId: CONVERSATION_ID,
          messageId: plan.assistantMessageId,
          contentItemId: plan.contentItemId,
          position: 0,
          epochNumber: EPOCH_NUMBER,
          senderId: crypto.randomUUID(),
        },
        blob
      )
    ).toThrow(DecryptionFailedError);
  });
});
