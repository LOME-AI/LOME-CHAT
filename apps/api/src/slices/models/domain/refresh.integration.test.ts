import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { acquireModelCatalogLock } from '../__tests__/model-catalog-lock.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
  modelEntryFixture,
  videoModelFixture,
} from './gateway-fixtures.js';
import { createCatalogSightingRecorder } from '../adapters/catalog-lifecycle.js';
import { refreshCatalog } from './refresh.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { SafeLogFields } from '../../../lib/telemetry/index.js';
import type { RefreshCatalogDeps, RefreshSummary } from './refresh.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

async function unwrap(result: ResultAsync<RefreshSummary, DomainError>): Promise<RefreshSummary> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

async function isOk(result: ResultAsync<RefreshSummary, DomainError>): Promise<boolean> {
  const settled = await result;
  return settled.isOk();
}

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_REST_* are required for refresh integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// Serialize every catalog critical section against the other model_catalog
// suites (this suite refreshes the shared catalog); held per test via a
// crash-safe Redis TTL lock (see helper).
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
const RUN_PREFIX = `mdl-rf-${crypto.randomUUID().slice(0, 8)}`;
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

interface TelemetryRecorder {
  readonly telemetry: Telemetry;
  readonly warns: RecordedLine[];
  readonly capturedCodes: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const warns: RecordedLine[] = [];
  const capturedCodes: string[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: () => {},
    emitMetric: () => {},
    captureError: (_error, errorCode) => {
      capturedCodes.push(errorCode);
    },
  };
  return { telemetry, warns, capturedCodes };
}

const NOW = new Date('2026-06-12T00:00:00.000Z');

function depsFor(
  fetch: typeof globalThis.fetch,
  overrides: Partial<RefreshCatalogDeps> = {}
): RefreshCatalogDeps {
  return {
    db,
    fetch,
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: recordingTelemetry().telemetry,
    now: () => NOW,
    recordSighting: createCatalogSightingRecorder(overrides.db ?? db),
    ...overrides,
  };
}

const DEFAULT_TOKEN_PRICING = { prompt: '0.0000025', completion: '0.00001' };

function languageFetch(
  modelId: string,
  pricing: unknown = DEFAULT_TOKEN_PRICING
): typeof globalThis.fetch {
  return catalogFetch({
    models: [modelEntryFixture({ id: modelId, pricing })],
    zdrModelIds: [modelId],
  });
}

async function descriptorsFor(modelId: string): Promise<unknown[]> {
  const rows = await db
    .select()
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [modelId]));
  return rows.map((row) => row.descriptor);
}

interface LifecycleRow {
  readonly excludedReason: string | null;
  readonly excludedAt: Date | null;
  readonly lastSeenAt: Date;
  readonly adminDisabledAt: Date | null;
}

async function lifecycleFor(modelId: string): Promise<LifecycleRow | undefined> {
  const rows = await db
    .select({
      excludedReason: modelCatalog.excludedReason,
      excludedAt: modelCatalog.excludedAt,
      lastSeenAt: modelCatalog.lastSeenAt,
      adminDisabledAt: modelCatalog.adminDisabledAt,
    })
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [modelId]));
  return rows[0];
}

async function rankFor(modelId: string): Promise<number | null | undefined> {
  const rows = await db
    .select()
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [modelId]));
  return rows[0]?.popularityRank;
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('refreshCatalog', () => {
  it('persists a newly discovered model as one row', async () => {
    const modelId = freshModelId('discover');
    const summary = await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(summary.written).toBeGreaterThanOrEqual(1);
    const rows = await descriptorsFor(modelId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: modelId, zdrReachable: true });
  });

  it('threads a caller-supplied endpoint concurrency through the fetch', async () => {
    const modelId = freshModelId('concurrency');
    const summary = await unwrap(
      refreshCatalog(depsFor(languageFetch(modelId), { endpointConcurrency: 8 }))
    );
    expect(summary.written).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(1);
  });

  it('rewrites no descriptor when a second refresh sees identical metadata', async () => {
    const modelId = freshModelId('unchanged');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const second = await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(1);
  });

  it('overwrites the row in place when metadata changes', async () => {
    const modelId = freshModelId('changed');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const changed = languageFetch(modelId, { prompt: '0.000005', completion: '0.00001' });
    const summary = await unwrap(refreshCatalog(depsFor(changed)));
    expect(summary.written).toBe(1);
    const rows = await descriptorsFor(modelId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pricing: { inputPerToken: '5750' } });
  });

  it('persists a discovered image model with per-image pricing', async () => {
    const modelId = freshModelId('image');
    const fetch = catalogFetch({
      images: [imageModelFixture({ id: modelId })],
      imageEndpoints: () =>
        imageEndpointsFixture([{ billable: 'output_image', unit: 'image', cost_usd: '0.04' }]),
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch)));
    expect(summary.written).toBe(1);
    const rows = await descriptorsFor(modelId);
    expect(rows[0]).toMatchObject({ outputs: ['image'], pricing: { perImage: '46000000' } });
  });

  it('resolves a duplicate id across endpoints to one stable exclusion decision', async () => {
    // A slug advertised on both /models (text output) and /images (image output)
    // folds to a single multi-output descriptor, which no turn can run, so
    // admission excludes it as non-runnable — quietly. The point this pins is
    // one decision per id (no two racing rows, no oscillation between refreshes),
    // which under the runnability contract means exactly one exclusion, not a row.
    const modelId = freshModelId('dup');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      models: [modelEntryFixture({ id: modelId })],
      images: [imageModelFixture({ id: modelId })],
      imageEndpoints: () =>
        imageEndpointsFixture([{ billable: 'output_image', unit: 'image', cost_usd: '0.04' }]),
      zdrModelIds: [modelId],
    });
    const first = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    // One exclusion decision, not two racing overwrites — and never a written row.
    expect(first.written).toBe(0);
    expect(first.excludedByReason['non-runnable-shape']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    // Quiet, expected exclusion — no alert, no captured defect code.
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
    // Stability guard: a second refresh of the same fixture reaches the same
    // single decision (still no row, no oscillation).
    const second = await unwrap(refreshCatalog(depsFor(fetch)));
    expect(second.written).toBe(0);
    expect(second.excludedByReason['non-runnable-shape']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
  });

  it('excludes an unclassifiable-modality model with a telemetry alert and no crash', async () => {
    const modelId = freshModelId('unclassifiable');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      models: [modelEntryFixture({ id: modelId, architecture: { output_modalities: ['smell'] } })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.msg).toContain('excluded');
    expect(alert?.fields?.errorCode).toBe('model_type_unknown');
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a video model with an unknown pricing unit and alerts', async () => {
    const modelId = freshModelId('bad-video');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      videos: [videoModelFixture({ id: modelId, pricing_skus: { per_video_token: '0.001' } })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_pricing_unit_unknown');
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a model with no release date with a telemetry alert', async () => {
    const modelId = freshModelId('no-release-date');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      models: [modelEntryFixture({ id: modelId, created: null })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_release_date_missing');
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes an image model with no release date with a telemetry alert', async () => {
    const modelId = freshModelId('image-no-date');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      images: [imageModelFixture({ id: modelId, created: null })],
      imageEndpoints: () =>
        imageEndpointsFixture([{ billable: 'output_image', unit: 'image', cost_usd: '0.04' }]),
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_release_date_missing');
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a video model with no release date with a telemetry alert', async () => {
    const modelId = freshModelId('video-no-date');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      videos: [videoModelFixture({ id: modelId, created: null })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_release_date_missing');
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a deprecated model without alerting', async () => {
    const modelId = freshModelId('deprecated');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      models: [modelEntryFixture({ id: modelId, expiration_date: '2026-01-01' })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(summary.excludedByReason.deprecated).toBe(1);
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes commercially unsellable models quietly, counted by reason', async () => {
    // The three catalog-admission reasons ride the quiet-expected group: a
    // model that cannot be sold profitably is an expected outcome, so it is
    // counted and never persisted, and nothing alerts. The wide-context anchor
    // is what keeps the other three outside the top-context exemption.
    const recentCreated = Math.trunc(NOW.getTime() / 1000) - 1;
    const freeId = freshModelId('free');
    const cheapId = freshModelId('cheap');
    const staleId = freshModelId('stale');
    const anchorId = freshModelId('wide-context');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      models: [
        modelEntryFixture({
          id: freeId,
          context_length: 8000,
          created: recentCreated,
          pricing: { prompt: '0', completion: '0' },
        }),
        modelEntryFixture({
          id: cheapId,
          context_length: 8001,
          created: recentCreated,
          pricing: { prompt: '0.000000099', completion: '0.0000001' },
        }),
        modelEntryFixture({ id: staleId, context_length: 8002, created: 1_700_000_000 }),
        modelEntryFixture({ id: anchorId, context_length: 1_000_000, created: recentCreated }),
      ],
      zdrModelIds: [freeId, cheapId, staleId, anchorId],
    });

    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));

    expect(summary.excluded).toBe(3);
    expect(summary.excludedByReason['zero-priced']).toBe(1);
    expect(summary.excludedByReason['below-price-floor']).toBe(1);
    expect(summary.excludedByReason['too-old']).toBe(1);
    expect(await descriptorsFor(freeId)).toHaveLength(0);
    expect(await descriptorsFor(cheapId)).toHaveLength(0);
    expect(await descriptorsFor(staleId)).toHaveLength(0);
    expect(await descriptorsFor(anchorId)).toHaveLength(1);
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a token-priced image model quietly and counts it by reason', async () => {
    const modelId = freshModelId('token-image');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      images: [imageModelFixture({ id: modelId })],
      imageEndpoints: () =>
        imageEndpointsFixture([{ billable: 'output_image', unit: 'token', cost_usd: '0.00003' }]),
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(summary.excludedByReason['token-priced-image']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    // Quiet: a growing, expected pricing shape, never a page.
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a token-priced video model quietly and counts it by reason', async () => {
    const modelId = freshModelId('token-video');
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      videos: [videoModelFixture({ id: modelId, pricing_skus: { video_tokens: '0.001' } })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(summary.excludedByReason['token-priced-video']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a model absent from the ZDR set quietly and counts it as non-zdr', async () => {
    const modelId = freshModelId('non-zdr');
    const recorder = recordingTelemetry();
    // Discovered on /models but NOT in the ZDR set → never persisted.
    const fetch = catalogFetch({ models: [modelEntryFixture({ id: modelId })], zdrModelIds: [] });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(summary.excludedByReason['non-zdr']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    // Quiet: an expected exclusion, never a page.
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('excludes a non-conversational specialty model quietly and counts it', async () => {
    // Banned code-tooling provider (`morph`), ZDR-reachable — excluded anyway.
    const modelId = `morph/${RUN_PREFIX}-tool`;
    createdModelIds.push(modelId);
    const recorder = recordingTelemetry();
    const fetch = catalogFetch({
      models: [modelEntryFixture({ id: modelId })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.excluded).toBe(1);
    expect(summary.excludedByReason['non-conversational']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
    expect(recorder.warns).toHaveLength(0);
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('writes a video model priced by fallback and raises the loud fallback alert', async () => {
    const modelId = freshModelId('video-fallback');
    const recorder = recordingTelemetry();
    // Declares 1080p but only prices 480p → 1080p substitutes the max rate.
    const fetch = catalogFetch({
      videos: [
        videoModelFixture({
          id: modelId,
          supported_resolutions: ['1080p'],
          pricing_skus: { text_to_video_duration_seconds_480p: '0.05' },
        }),
      ],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry })));
    expect(summary.written).toBe(1);
    expect(summary.excluded).toBe(0);
    const rows = await descriptorsFor(modelId);
    expect(rows[0]).toMatchObject({
      pricing: { perSecondByResolution: { '1080p': '57500000' } },
    });
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_video_resolution_fallback');
    expect(recorder.capturedCodes).toHaveLength(0);
  });

  it('persists the language model gateway index as its popularity rank', async () => {
    const modelId = freshModelId('rank');
    await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(await rankFor(modelId)).toBe(0);
  });

  it('writes on a rank-only change even when descriptor content is identical', async () => {
    const target = freshModelId('rank-only');
    const other = freshModelId('rank-only-other');
    const first = catalogFetch({
      models: [modelEntryFixture({ id: other }), modelEntryFixture({ id: target })],
      zdrModelIds: [other, target],
    });
    await unwrap(refreshCatalog(depsFor(first)));
    expect(await rankFor(target)).toBe(1);
    // Same descriptor content, reordered gateway response → target moves to rank 0.
    const reordered = catalogFetch({
      models: [modelEntryFixture({ id: target }), modelEntryFixture({ id: other })],
      zdrModelIds: [target, other],
    });
    const summary = await unwrap(refreshCatalog(depsFor(reordered)));
    expect(summary.written).toBeGreaterThanOrEqual(1);
    expect(await rankFor(target)).toBe(0);
  });

  it('skips a refresh whose content and rank are both identical', async () => {
    const modelId = freshModelId('rank-stable');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const second = await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
  });

  it('rewrites a stored v1 row on the next refresh — version is in the content hash', async () => {
    const modelId = freshModelId('rebake');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const [stored] = (await descriptorsFor(modelId)) as [Record<string, unknown>];
    await db
      .update(modelCatalog)
      .set({ descriptor: { ...stored, version: '1' } })
      .where(inArray(modelCatalog.modelId, [modelId]));
    const second = await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(second.written).toBe(1);
    expect(second.unchanged).toBe(0);
    const rows = await descriptorsFor(modelId);
    expect(rows[0]).toMatchObject({ version: '2' });
  });

  it('converges concurrent refreshes onto one row per model', async () => {
    const modelId = freshModelId('race');
    const [a, b] = await Promise.all([
      refreshCatalog(depsFor(languageFetch(modelId))),
      refreshCatalog(depsFor(languageFetch(modelId), { db: rival })),
    ]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    expect(await descriptorsFor(modelId)).toHaveLength(1);
  });

  it('waits the jittered delay before fetching', async () => {
    const modelId = freshModelId('jitter');
    const slept: number[] = [];
    const deps = depsFor(languageFetch(modelId), {
      jitter: {
        maxMs: 60_000,
        random: () => 0.5,
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    });
    expect(await isOk(refreshCatalog(deps))).toBe(true);
    expect(slept).toEqual([30_000]);
  });

  it('fails unavailable when the catalog write itself fails', async () => {
    const modelId = freshModelId('write-fails');
    const failingDb = new Proxy(db, {
      get(target, property, receiver): unknown {
        if (property === 'insert') {
          return () => ({
            values: () => ({
              onConflictDoUpdate: () => Promise.reject(new Error('write failed')),
            }),
          });
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (value as (...inner: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const result = await refreshCatalog(depsFor(languageFetch(modelId), { db: failingDb }));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('overwrites a corrupt stored descriptor in place', async () => {
    const modelId = freshModelId('corrupt-stored');
    await db
      .insert(modelCatalog)
      .values({ modelId, descriptor: 'not-an-object' })
      .onConflictDoNothing();
    const summary = await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(summary.written).toBe(1);
    const rows = await descriptorsFor(modelId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: modelId, version: '2' });
  });

  it('fails unavailable when the database is unreachable', async () => {
    const modelId = freshModelId('db-down');
    const closed = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closed.$client.end();
    const result = await refreshCatalog(depsFor(languageFetch(modelId), { db: closed }));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

/**
 * A zero combined rate — the one commercial exclusion with no exemption
 * (BILLING.md §Catalog Admission 1). The price floor and the age cutoff both
 * yield to the top-context exemption, and a single-model fixture IS its own top
 * context percentile, so only an unconditional reason is reachable here.
 */
const UNSELLABLE = { prompt: '0', completion: '0' };

/** A handle whose UPDATE rejects, so the sighting write's error channel is real. */
const failingUpdateDb = new Proxy(db, {
  get(target, property, receiver): unknown {
    if (property === 'update') {
      return () => ({ set: () => ({ where: () => Promise.reject(new Error('update failed')) }) });
    }
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === 'function'
      ? (value as (...inner: unknown[]) => unknown).bind(target)
      : value;
  },
});
const LATER = new Date('2026-06-12T01:00:00.000Z');

describe('refreshCatalog exclusion lifecycle', () => {
  it('marks an already-persisted model that becomes inadmissible', async () => {
    const modelId = freshModelId('becomes-excluded');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const summary = await unwrap(
      refreshCatalog(depsFor(languageFetch(modelId, UNSELLABLE), { now: () => LATER }))
    );
    expect(summary.excludedByReason['zero-priced']).toBe(1);
    expect(await lifecycleFor(modelId)).toMatchObject({
      excludedReason: 'zero-priced',
      excludedAt: LATER,
      lastSeenAt: LATER,
    });
  });

  it('keeps the marked row rather than deleting it', async () => {
    const modelId = freshModelId('mark-keeps-row');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId, UNSELLABLE))))).toBe(true);
    expect(await descriptorsFor(modelId)).toHaveLength(1);
  });

  it('clears the mark when a marked model becomes admissible again', async () => {
    const modelId = freshModelId('returns');
    await db.insert(modelCatalog).values({
      modelId,
      descriptor: 'stale',
      excludedReason: 'zero-priced',
      excludedAt: NOW,
    });
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId), { now: () => LATER })))).toBe(
      true
    );
    expect(await lifecycleFor(modelId)).toMatchObject({
      excludedReason: null,
      excludedAt: null,
      lastSeenAt: LATER,
    });
  });

  it('leaves admin_disabled_at untouched when it clears the mark', async () => {
    const modelId = freshModelId('clear-keeps-kill-switch');
    const disabledAt = new Date('2026-05-01T00:00:00.000Z');
    await db.insert(modelCatalog).values({
      modelId,
      descriptor: 'stale',
      excludedReason: 'zero-priced',
      excludedAt: NOW,
      adminDisabledAt: disabledAt,
    });
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    expect(await lifecycleFor(modelId)).toMatchObject({
      excludedReason: null,
      adminDisabledAt: disabledAt,
    });
  });

  it('leaves admin_disabled_at untouched when it marks a row excluded', async () => {
    const modelId = freshModelId('mark-keeps-kill-switch');
    const disabledAt = new Date('2026-05-01T00:00:00.000Z');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    await db
      .update(modelCatalog)
      .set({ adminDisabledAt: disabledAt })
      .where(inArray(modelCatalog.modelId, [modelId]));
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId, UNSELLABLE))))).toBe(true);
    expect(await lifecycleFor(modelId)).toMatchObject({
      excludedReason: 'zero-priced',
      adminDisabledAt: disabledAt,
    });
  });

  it('writes no row for a model that was never admissible', async () => {
    const modelId = freshModelId('never-admitted');
    const summary = await unwrap(refreshCatalog(depsFor(languageFetch(modelId, UNSELLABLE))));
    expect(summary.excludedByReason['zero-priced']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
  });

  it('writes no row for a model whose descriptor is unbuildable', async () => {
    const modelId = freshModelId('unbuildable');
    const fetch = catalogFetch({
      models: [modelEntryFixture({ id: modelId, created: 0 })],
      zdrModelIds: [modelId],
    });
    const summary = await unwrap(refreshCatalog(depsFor(fetch)));
    expect(summary.excludedByReason['missing-release-date']).toBe(1);
    expect(await descriptorsFor(modelId)).toHaveLength(0);
  });

  it('keeps the first excluded_at across repeat refreshes', async () => {
    const modelId = freshModelId('excluded-since');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId, UNSELLABLE))))).toBe(true);
    expect(
      await isOk(refreshCatalog(depsFor(languageFetch(modelId, UNSELLABLE), { now: () => LATER })))
    ).toBe(true);
    expect(await lifecycleFor(modelId)).toMatchObject({ excludedAt: NOW, lastSeenAt: LATER });
  });

  it('clears the mark on a row whose descriptor is unchanged', async () => {
    const modelId = freshModelId('returns-unchanged');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    await db
      .update(modelCatalog)
      .set({ excludedReason: 'non-conversational', excludedAt: NOW })
      .where(inArray(modelCatalog.modelId, [modelId]));
    const summary = await unwrap(refreshCatalog(depsFor(languageFetch(modelId))));
    expect(summary.unchanged).toBe(1);
    expect(await lifecycleFor(modelId)).toMatchObject({
      excludedReason: null,
      excludedAt: null,
    });
  });

  it('fails unavailable when marking an excluded row fails', async () => {
    const modelId = freshModelId('mark-fails');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const result = await refreshCatalog(
      depsFor(languageFetch(modelId, UNSELLABLE), {
        recordSighting: createCatalogSightingRecorder(failingUpdateDb),
      })
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails unavailable when re-sighting an unchanged row fails', async () => {
    const modelId = freshModelId('sighting-fails');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const result = await refreshCatalog(
      depsFor(languageFetch(modelId), {
        recordSighting: createCatalogSightingRecorder(failingUpdateDb),
      })
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('advances last_seen_at for a model whose descriptor is unchanged', async () => {
    const modelId = freshModelId('seen-unchanged');
    expect(await isOk(refreshCatalog(depsFor(languageFetch(modelId))))).toBe(true);
    const summary = await unwrap(
      refreshCatalog(depsFor(languageFetch(modelId), { now: () => LATER }))
    );
    expect(summary.unchanged).toBe(1);
    expect(await lifecycleFor(modelId)).toMatchObject({ lastSeenAt: LATER });
  });
});
