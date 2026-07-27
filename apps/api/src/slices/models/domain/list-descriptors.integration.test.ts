import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { acquireModelCatalogLock } from '../__tests__/model-catalog-lock.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
  modelEntryFixture,
} from './gateway-fixtures.js';
import { listDescriptors } from './list-descriptors.js';
import { refreshCatalog } from './refresh.js';
import { createCatalogSightingRecorder } from '../adapters/catalog-lifecycle.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { SafeLogFields, Telemetry } from '../../../lib/telemetry/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

async function unwrap(
  result: ResultAsync<ModelDescriptor[], DomainError>
): Promise<ModelDescriptor[]> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_REST_* are required for list-descriptors integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// Serialize every catalog critical section against the other model_catalog
// suites: this suite reads the catalog globally, and a concurrent suite's seeds
// (or the chat suite's foreign-row cleanup) would otherwise race the read. Held
// per test via a crash-safe Redis TTL lock (see helper).
let releaseModelCatalogLock: (() => Promise<void>) | undefined;
beforeEach(async () => {
  releaseModelCatalogLock = await acquireModelCatalogLock(redis);
});
afterEach(async () => {
  const release = releaseModelCatalogLock;
  releaseModelCatalogLock = undefined;
  await release?.();
});

/** Unique per test run so concurrent suites on the shared DB never collide. */
const RUN_PREFIX = `mdl-ls-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

function recordingTelemetry(): { telemetry: Telemetry; errors: RecordedLine[] } {
  const errors: RecordedLine[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    emitMetric: () => {},
    captureError: () => {},
  };
  return { telemetry, errors };
}

const silentTelemetry: Telemetry = recordingTelemetry().telemetry;

async function refresh(fetch: typeof globalThis.fetch): Promise<void> {
  const result = await refreshCatalog({
    db,
    fetch,
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: silentTelemetry,
    now: () => new Date('2026-06-12T00:00:00.000Z'),
    recordSighting: createCatalogSightingRecorder(db),
  });
  result._unsafeUnwrap();
}

/** Scoped to the caller's own model ids: suites on the shared DB run
 * concurrently and the root config retries failures once. */
async function exposedIds(ids: readonly string[]): Promise<string[]> {
  const descriptors = await unwrap(listDescriptors({ db, telemetry: silentTelemetry }));
  return descriptors.map((descriptor) => descriptor.id).filter((id) => ids.includes(id));
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('listDescriptors', () => {
  it('exposes newly discovered models with zero code changes', async () => {
    const first = freshModelId('zero-touch-a');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: first })], zdrModelIds: [first] })
    );
    expect(await exposedIds([first])).toEqual([first]);

    const second = freshModelId('zero-touch-b');
    await refresh(
      catalogFetch({
        models: [modelEntryFixture({ id: first }), modelEntryFixture({ id: second })],
        zdrModelIds: [first, second],
      })
    );
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const exposed = await exposedIds([first, second]);
    expect(exposed.toSorted(byName)).toEqual([first, second].toSorted(byName));
  });

  it('returns the parsed descriptor for an exposed model', async () => {
    const modelId = freshModelId('parsed');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    const descriptors = await unwrap(listDescriptors({ db, telemetry: silentTelemetry }));
    const descriptor = descriptors.find((entry: ModelDescriptor) => entry.id === modelId);
    // Provider is derived from the model id's first path segment.
    expect(descriptor).toMatchObject({ provider: RUN_PREFIX, version: '2', zdrReachable: true });
  });

  it('injects the persisted popularity rank onto the exposed descriptor', async () => {
    const modelId = freshModelId('rank');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    const descriptors = await unwrap(listDescriptors({ db, telemetry: silentTelemetry }));
    const descriptor = descriptors.find((entry: ModelDescriptor) => entry.id === modelId);
    expect(descriptor?.popularityRank).toBe(0);
  });

  it('hides a model that is not in the ZDR set', async () => {
    const modelId = freshModelId('no-zdr');
    await refresh(catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [] }));
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides an empty-pricing model', async () => {
    const modelId = freshModelId('unpriced');
    await refresh(
      catalogFetch({
        models: [modelEntryFixture({ id: modelId, pricing: null })],
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('exposes a ZDR-reachable, priced image model without any manual step', async () => {
    const modelId = freshModelId('image');
    await refresh(
      catalogFetch({
        images: [imageModelFixture({ id: modelId })],
        imageEndpoints: () =>
          imageEndpointsFixture([{ billable: 'output_image', unit: 'image', cost_usd: '0.04' }]),
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);
  });

  it('hides a ZDR-reachable image model with no usable pricing', async () => {
    const modelId = freshModelId('image-unpriced');
    await refresh(
      catalogFetch({
        images: [imageModelFixture({ id: modelId })],
        imageEndpoints: () =>
          imageEndpointsFixture([
            { billable: 'output_image', unit: 'megapixel', cost_usd: '0.01' },
          ]),
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides a priced ZDR-reachable embedding model', async () => {
    // No embedding adapter exists; a listed model that always errors at call
    // time is a product flaw, so the family is hidden until one ships.
    const modelId = freshModelId('embedding');
    await refresh(
      catalogFetch({
        models: [
          modelEntryFixture({
            id: modelId,
            architecture: { input_modalities: ['text'], output_modalities: ['embedding'] },
          }),
        ],
        zdrModelIds: [modelId],
      })
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides an admin-disabled model without alerting (deliberate, not corrupt)', async () => {
    const modelId = freshModelId('admin-disabled');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);

    await db
      .update(modelCatalog)
      .set({ adminDisabledAt: new Date() })
      .where(eq(modelCatalog.modelId, modelId));
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('hides a soft-deleted model without alerting (a derived verdict, not corrupt)', async () => {
    const modelId = freshModelId('excluded');
    await refresh(
      catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [modelId] })
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);

    await db
      .update(modelCatalog)
      .set({ excludedReason: 'below-price-floor', excludedAt: new Date() })
      .where(eq(modelCatalog.modelId, modelId));
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('hides a stored descriptor whose outputs match no call-shape family and alerts', async () => {
    const modelId = freshModelId('audio-only');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '2',
          inputs: ['text'],
          outputs: ['audio'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: { perSecond: '1' },
          zdrReachable: true,
          releasedAt: 1_700_000_000,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    const alert = recorder.errors.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_family_unclassifiable');
  });

  it('hides a persisted non-runnable (multi-output) descriptor without alerting', async () => {
    // Defense-in-depth: a dual-output row persisted before admission gained the
    // runnability gate (its outputs classify to a family, so the family gate
    // does not catch it) must still be hidden from every consumer.
    const modelId = freshModelId('multi-output');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '2',
          inputs: ['text'],
          outputs: ['text', 'image'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: { inputPerToken: '1', outputPerToken: '1' },
          zdrReachable: true,
          releasedAt: 1_700_000_000,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('hides a persisted embedding descriptor without alerting', async () => {
    // Defense-in-depth: an embedding row that is ZDR-reachable and priced
    // classifies to the `embedding` family (so the unclassifiable gate does not
    // catch it) but has no adapter, so `isExposed` hides it — no alert, since a
    // classified family is not data corruption.
    const modelId = freshModelId('embedding-persisted');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '2',
          inputs: ['text'],
          outputs: ['embedding'],
          parameters: {},
          behaviors: [],
          limits: {},
          pricing: { inputPerToken: '1' },
          zdrReachable: true,
          releasedAt: 1_700_000_000,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    expect(recorder.errors.filter((line) => line.fields?.modelName === modelId)).toEqual([]);
  });

  it('skips a stored descriptor that breaks the contract and alerts', async () => {
    const modelId = freshModelId('corrupt');
    await db
      .insert(modelCatalog)
      .values({ modelId, descriptor: { id: modelId, nonsense: true } })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const descriptors = await unwrap(listDescriptors({ db, telemetry: recorder.telemetry }));
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    const alert = recorder.errors.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_descriptor_invalid');
  });

  it('fails the whole read fast on an unbaked v1 descriptor row — never a silent skip', async () => {
    // A v1 row carries PRE-fee provider rates; serving it would price turns
    // below billable. The read refuses outright (cheap structural
    // enforcement — zero-users ruling: no migration tooling).
    const modelId = freshModelId('unbaked-v1');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'x',
          version: '1',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: ['streaming'],
          limits: {},
          pricing: { inputPerToken: '2500' },
          zdrReachable: true,
          releasedAt: 1_700_000_000,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
    try {
      const result = await listDescriptors({ db, telemetry: silentTelemetry });
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('unavailable');
      expect(error.message).toMatch(/version/);
    } finally {
      // Remove the poison row before releasing the catalog lock so no other
      // suite's whole-table read trips over it.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    }
  });
});
