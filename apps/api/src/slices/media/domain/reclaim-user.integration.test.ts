import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobRegistry } from '../../../lib/jobs/index.js';
import { errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { mediaObjectKey } from '../ports/index.js';
import { createScratchBucket, unwrap } from '../adapters/test-fixtures.js';
import {
  MEDIA_RECLAIM_HEARTBEAT_CHUNK,
  MEDIA_RECLAIM_USER_JOB_TYPE,
  createMediaReclaimUserJob,
  mediaReclaimUserPayloadSchema,
} from './reclaim-user.js';
import type { z } from 'zod';
import type { JobExecution } from '../../../lib/jobs/index.js';
import type { ScratchBucket } from '../adapters/test-fixtures.js';
import type { Storage } from '../ports/index.js';

/**
 * The deleted-account media sweep handler, exercised directly against a
 * scratch MinIO bucket (the owning-slice invocation seam — the dispatcher
 * wiring is covered by the jobs lib suites).
 */

type Payload = z.infer<typeof mediaReclaimUserPayloadSchema>;

const BYTES = new Uint8Array([7, 7, 7]);

function newMediaKey(): string {
  return mediaObjectKey({
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
  });
}

function payloadOf(storageKeys: readonly string[]): Payload {
  return { userId: crypto.randomUUID(), storageKeys: [...storageKeys] };
}

function executionOf(
  payload: Payload,
  heartbeat: () => Promise<'alive' | 'lost'> = () => Promise.resolve('alive')
): JobExecution<Payload> {
  return {
    jobId: crypto.randomUUID(),
    payload,
    claims: 1,
    heartbeat,
    completeWithinTx: () => {
      throw new Error('natural-class handler must not write its own terminal transition');
    },
  };
}

describe('media.reclaimUser.v1 registration', () => {
  it('registers cleanly with the bulk shard, natural idempotency, and its payload schema', () => {
    const registry = createJobRegistry();
    registry.register(createMediaReclaimUserJob({ storage: {} as Storage }));

    const registered = registry.get(MEDIA_RECLAIM_USER_JOB_TYPE);
    expect(registered?.shard).toBe('bulk');
    expect(registered?.idempotency).toBe('natural');
    expect(registered?.schema).toBe(mediaReclaimUserPayloadSchema);
  });

  it('rejects a payload whose key is outside the media/ class', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse(
      payloadOf(['inputs/not-a-media-key/object'])
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload whose userId is not a uuid', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse({
      userId: 'someone',
      storageKeys: [newMediaKey()],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a payload of well-formed media keys', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse(payloadOf([newMediaKey()]));
    expect(parsed.success).toBe(true);
  });
});

describe('media.reclaimUser.v1 handler against MinIO', () => {
  let scratch: ScratchBucket;

  beforeAll(async () => {
    scratch = await createScratchBucket();
  });

  afterAll(async () => {
    await scratch.destroy();
  });

  async function put(key: string): Promise<void> {
    await unwrap(scratch.storage.put(key, BYTES, { contentType: 'application/octet-stream' }));
  }

  async function exists(key: string): Promise<boolean> {
    return (await unwrap(scratch.storage.head(key))) !== null;
  }

  function handler(storage: Storage = scratch.storage) {
    return createMediaReclaimUserJob({ storage }).handler;
  }

  it("deletes every one of the deleted account's objects", async () => {
    const keys = [newMediaKey(), newMediaKey()];
    for (const key of keys) await put(key);

    const outcome = await handler()(executionOf(payloadOf(keys)));

    expect(outcome).toEqual({ kind: 'ok', result: { reclaimed: 2 } });
    expect(await exists(keys[0] ?? '')).toBe(false);
    expect(await exists(keys[1] ?? '')).toBe(false);
  });

  it('a redelivered payload whose keys are already gone still succeeds', async () => {
    const keys = [newMediaKey()];

    const outcome = await handler()(executionOf(payloadOf(keys)));

    expect(outcome.kind).toBe('ok');
  });

  it('heartbeats once per chunk across a payload larger than one chunk', async () => {
    const keys = Array.from({ length: MEDIA_RECLAIM_HEARTBEAT_CHUNK + 1 }, () => newMediaKey());
    let beats = 0;
    const heartbeat = (): Promise<'alive' | 'lost'> => {
      beats += 1;
      return Promise.resolve('alive');
    };

    const outcome = await handler()(executionOf(payloadOf(keys), heartbeat));

    expect(outcome.kind).toBe('ok');
    expect(beats).toBe(2);
  });

  it('a lost lease stops the pass before any delete in the chunk', async () => {
    const key = newMediaKey();
    await put(key);

    const outcome = await handler()(executionOf(payloadOf([key]), () => Promise.resolve('lost')));

    expect(outcome.kind).toBe('fail');
    expect(await exists(key)).toBe(true);
  });

  it('a failing delete surfaces as a retryable failure carrying the error code', async () => {
    const failing: Storage = {
      ...scratch.storage,
      delete: () => errAsync(unavailableError('storage unreachable')),
    };

    const outcome = await handler(failing)(executionOf(payloadOf([newMediaKey()])));

    expect(outcome).toEqual({ kind: 'fail', error: 'media reclaim delete failed: unavailable' });
  });
});
