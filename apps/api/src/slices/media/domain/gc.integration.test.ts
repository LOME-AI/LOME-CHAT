import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEADLINE_CLASS_MS } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import {
  INPUTS_STAGING_TTL_SECONDS,
  mediaObjectKey,
  stagingInputKey,
  stagingInputMetadata,
} from '../ports/index.js';
import { createScratchBucket } from '../adapters/test-fixtures.js';
import { MEDIA_GC_GRACE_MARGIN_SECONDS, MEDIA_GC_MIN_AGE_SECONDS, runMediaGc } from './gc.js';
import type { ScratchBucket } from '../adapters/test-fixtures.js';
import type { MediaGcDeps } from './gc.js';
import type { MediaReferenceReader } from '../ports/index.js';

/**
 * GC against a scratch MinIO bucket (isolated per test file so age-based
 * sweeps can never touch objects owned by other suites or concurrent runs).
 * The reference reader is a fake of this slice's own port interface; the
 * storage adapter and every delete are real.
 */

const OCTET_STREAM = 'application/octet-stream';
const BYTES = new Uint8Array([1, 2, 3, 4]);

function newMediaKey(): string {
  return mediaObjectKey({
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
  });
}

function referencesOf(referenced: readonly string[]): MediaReferenceReader {
  const set = new Set(referenced);
  return {
    referencedStorageKeys: (keys) => okAsync(new Set(keys.filter((key) => set.has(key)))),
  };
}

/** A clock far enough ahead that every object in the bucket is past the grace. */
function afterGrace(): () => Date {
  const graceMs = (MEDIA_GC_MIN_AGE_SECONDS + 60) * 1000;
  return () => new Date(Date.now() + graceMs);
}

function afterStagingTtl(): () => Date {
  const ttlMs = (INPUTS_STAGING_TTL_SECONDS + 60) * 1000;
  return () => new Date(Date.now() + ttlMs);
}

describe('media GC constants', () => {
  it('grace period covers the longest flow deadline plus the margin', () => {
    const maxDeadlineSeconds = Math.max(...Object.values(DEADLINE_CLASS_MS)) / 1000;
    expect(MEDIA_GC_MIN_AGE_SECONDS).toBeGreaterThanOrEqual(
      maxDeadlineSeconds + MEDIA_GC_GRACE_MARGIN_SECONDS
    );
  });

  it('staging TTL exceeds the grace period so live-run inputs are never reclaimed first', () => {
    expect(INPUTS_STAGING_TTL_SECONDS).toBeGreaterThanOrEqual(MEDIA_GC_MIN_AGE_SECONDS);
  });
});

describe('media GC against MinIO', () => {
  let scratch: ScratchBucket;

  // A fresh bucket per test: age-based sweeps reclaim everything eligible in
  // the bucket, so shared state would leak earlier tests' survivors into
  // later tests' exact counts.
  beforeEach(async () => {
    scratch = await createScratchBucket();
  });

  afterEach(async () => {
    await scratch.destroy();
  });

  function deps(overrides: Partial<MediaGcDeps>): MediaGcDeps {
    return {
      storage: scratch.storage,
      references: referencesOf([]),
      now: () => new Date(),
      ...overrides,
    };
  }

  async function put(key: string): Promise<void> {
    const metadata = key.startsWith('inputs/')
      ? stagingInputMetadata({
          runId: key.split('/')[1] ?? '',
          objectId: key.split('/')[2] ?? '',
        })
      : undefined;
    const result = await scratch.storage.put(key, BYTES, {
      contentType: OCTET_STREAM,
      ...(metadata === undefined ? {} : { metadata }),
    });
    result._unsafeUnwrap();
  }

  async function exists(key: string): Promise<boolean> {
    const stat = await scratch.storage.head(key);
    return stat._unsafeUnwrap() !== null;
  }

  it('reclaims an orphaned media object once it is past the grace period', async () => {
    const orphan = newMediaKey();
    await put(orphan);

    const report = await runMediaGc(deps({ now: afterGrace() }));

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(1);
    expect(await exists(orphan)).toBe(false);
  });

  it('a just-uploaded object survives a GC pass that runs before its finalize commits', async () => {
    const inFlight = newMediaKey();
    await put(inFlight);

    const report = await runMediaGc(deps({}));

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(0);
    expect(await exists(inFlight)).toBe(true);
  });

  it('a referenced media object past the grace period survives', async () => {
    const referenced = newMediaKey();
    await put(referenced);

    const report = await runMediaGc(
      deps({ references: referencesOf([referenced]), now: afterGrace() })
    );

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(0);
    expect(await exists(referenced)).toBe(true);
  });

  it("reclaims a deleted account's group-conversation media on the next GC run", async () => {
    // Hard deletion cascades the content rows at commit, so the group
    // conversation's objects answer as unreferenced here; the next pass
    // (past grace) reclaims the ciphertext.
    const groupObjects = [newMediaKey(), newMediaKey()];
    for (const key of groupObjects) await put(key);

    const report = await runMediaGc(deps({ now: afterGrace() }));

    expect(report._unsafeUnwrap().mediaReclaimed).toBe(2);
    expect(await exists(groupObjects[0] ?? '')).toBe(false);
    expect(await exists(groupObjects[1] ?? '')).toBe(false);
  });

  it("reclaims a crashed upload's staging object once past the staging TTL", async () => {
    const crashed = stagingInputKey({
      runId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
    });
    await put(crashed);

    const report = await runMediaGc(deps({ now: afterStagingTtl() }));

    expect(report._unsafeUnwrap().stagingReclaimed).toBe(1);
    expect(await exists(crashed)).toBe(false);
  });

  it('a staging object inside the staging TTL survives', async () => {
    const live = stagingInputKey({
      runId: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
    });
    await put(live);

    const report = await runMediaGc(deps({}));

    expect(report._unsafeUnwrap().stagingReclaimed).toBe(0);
    expect(await exists(live)).toBe(true);
  });

  it('walks every listing page when the sweep spans multiple pages', async () => {
    const orphans = [newMediaKey(), newMediaKey(), newMediaKey()];
    for (const key of orphans) await put(key);

    const report = await runMediaGc(deps({ now: afterGrace(), pageSize: 1 }));

    const unwrapped = report._unsafeUnwrap();
    expect(unwrapped.mediaScanned).toBe(3);
    expect(unwrapped.mediaReclaimed).toBe(3);
    for (const key of orphans) {
      expect(await exists(key)).toBe(false);
    }
  });

  it('reports scanned counts alongside reclaimed counts', async () => {
    const referenced = newMediaKey();
    const orphan = newMediaKey();
    await put(referenced);
    await put(orphan);

    const report = await runMediaGc(
      deps({ references: referencesOf([referenced]), now: afterGrace() })
    );

    const unwrapped = report._unsafeUnwrap();
    expect(unwrapped.mediaScanned).toBe(2);
    expect(unwrapped.mediaReclaimed).toBe(1);
  });
});
