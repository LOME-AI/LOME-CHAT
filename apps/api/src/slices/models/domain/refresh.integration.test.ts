import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog, modelOverrides } from '@hushbox/db';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TEST_GATEWAY_BASE_URL,
  configFixture,
  endpointsFixture,
  jsonResponse,
  modelEntryFixture,
  routedFetch,
} from './gateway-fixtures.js';
import { refreshCatalog } from './refresh.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { SafeLogFields } from '../../../lib/telemetry/index.js';
import type { RefreshCatalogDeps } from './refresh.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for refresh integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

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
  readonly errors: RecordedLine[];
  readonly capturedCodes: string[];
}

function recordingTelemetry(): TelemetryRecorder {
  const warns: RecordedLine[] = [];
  const errors: RecordedLine[] = [];
  const capturedCodes: string[] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: (msg: string, fields?: SafeLogFields) => {
      errors.push({ msg, fields });
    },
    emitMetric: () => {},
    captureError: (_error, errorCode) => {
      capturedCodes.push(errorCode);
    },
  };
  return { telemetry, warns, errors, capturedCodes };
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
    ...overrides,
  };
}

const DEFAULT_TOKEN_PRICING = { input: '0.0000025', output: '0.00001' };

function languageFetch(
  modelId: string,
  pricing: unknown = DEFAULT_TOKEN_PRICING
): typeof globalThis.fetch {
  return routedFetch({
    config: () =>
      jsonResponse(configFixture([modelEntryFixture({ id: modelId, pricing })], ['openai'])),
    endpoints: () => jsonResponse(endpointsFixture()),
  });
}

async function catalogRowsFor(
  modelId: string
): Promise<{ version: number; descriptor: unknown }[]> {
  const rows = await db
    .select()
    .from(modelCatalog)
    .where(inArray(modelCatalog.modelId, [modelId]));
  return rows
    .map((row) => ({ version: row.version, descriptor: row.descriptor }))
    .toSorted((a, b) => a.version - b.version);
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
    await db.delete(modelOverrides).where(inArray(modelOverrides.modelId, createdModelIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('refreshCatalog', () => {
  it('persists a newly discovered gateway model as version one', async () => {
    const modelId = freshModelId('discover');
    const summaryResult = await refreshCatalog(depsFor(languageFetch(modelId)));
    const summary = summaryResult._unsafeUnwrap();
    expect(summary.written).toBeGreaterThanOrEqual(1);
    const rows = await catalogRowsFor(modelId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.descriptor).toMatchObject({ id: modelId, zdrReachable: true });
  });

  it('writes no new version when a second refresh sees identical metadata', async () => {
    const modelId = freshModelId('unchanged');
    const seeded = await refreshCatalog(depsFor(languageFetch(modelId)));
    expect(seeded.isOk()).toBe(true);
    const secondResult = await refreshCatalog(depsFor(languageFetch(modelId)));
    const second = secondResult._unsafeUnwrap();
    expect(second.written).toBe(0);
    const rows = await catalogRowsFor(modelId);
    expect(rows).toHaveLength(1);
  });

  it('writes exactly one new version when metadata changes', async () => {
    const modelId = freshModelId('changed');
    const seeded = await refreshCatalog(depsFor(languageFetch(modelId)));
    expect(seeded.isOk()).toBe(true);
    const changed = languageFetch(modelId, { input: '0.000005', output: '0.00001' });
    const summaryResult = await refreshCatalog(depsFor(changed));
    const summary = summaryResult._unsafeUnwrap();
    expect(summary.written).toBe(1);
    const rows = await catalogRowsFor(modelId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ version: 2 });
    expect(rows[1]?.descriptor).toMatchObject({ pricing: { inputPerToken: '5000' } });
  });

  it('excludes an unknown gateway model type with a telemetry alert and no crash', async () => {
    const modelId = freshModelId('reranker');
    const recorder = recordingTelemetry();
    const fetch = routedFetch({
      config: () =>
        jsonResponse(
          configFixture([modelEntryFixture({ id: modelId, modelType: 'reranking' })], ['openai'])
        ),
      endpoints: () => jsonResponse(endpointsFixture()),
    });
    const summaryResult = await refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry }));
    const summary = summaryResult._unsafeUnwrap();
    expect(summary.excluded).toBe(1);
    expect(await catalogRowsFor(modelId)).toHaveLength(0);
    const alert = recorder.errors.find((line) => line.fields?.modelName === modelId);
    expect(alert?.msg).toContain('excluded');
    expect(alert?.fields?.errorCode).toBe('model_type_unknown');
    expect(recorder.capturedCodes).toContain('model_type_unknown');
  });

  it('converges concurrent refreshes onto one version row per model', async () => {
    const modelId = freshModelId('race');
    const [a, b] = await Promise.all([
      refreshCatalog(depsFor(languageFetch(modelId))),
      refreshCatalog(depsFor(languageFetch(modelId), { db: rival })),
    ]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    const rows = await catalogRowsFor(modelId);
    expect(rows).toHaveLength(1);
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
    const refreshed = await refreshCatalog(deps);
    expect(refreshed.isOk()).toBe(true);
    expect(slept).toEqual([30_000]);
  });

  it('alerts on an override row that breaks the contract and refreshes without it', async () => {
    const modelId = freshModelId('bad-override');
    await db
      .insert(modelOverrides)
      .values({ modelId, overrides: { surprise: 1 } })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const result = await refreshCatalog(
      depsFor(languageFetch(modelId), { telemetry: recorder.telemetry })
    );
    expect(result.isOk()).toBe(true);
    const alert = recorder.warns.find((line) => line.fields?.modelName === modelId);
    expect(alert?.msg).toContain('override');
  });

  it('converges when a rival writes the same version between read and insert', async () => {
    const modelId = freshModelId('mid-race');
    let interceptedOnce = false;
    const interceptedDb = new Proxy(db, {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === 'transaction' && typeof value === 'function') {
          return async (...args: unknown[]): Promise<unknown> => {
            if (!interceptedOnce) {
              interceptedOnce = true;
              const rivalWrite = await refreshCatalog(
                depsFor(languageFetch(modelId), { db: rival })
              );
              expect(rivalWrite.isOk()).toBe(true);
            }
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function'
          ? (value as (...inner: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const summaryResult = await refreshCatalog(
      depsFor(languageFetch(modelId), { db: interceptedDb })
    );
    const summary = summaryResult._unsafeUnwrap();
    expect(summary.written).toBe(0);
    expect(summary.unchanged).toBe(1);
    const rows = await catalogRowsFor(modelId);
    expect(rows).toHaveLength(1);
  });

  it('fails unavailable when the catalog write itself fails', async () => {
    const modelId = freshModelId('write-fails');
    const failingDb = new Proxy(db, {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === 'transaction') {
          return (): Promise<never> => Promise.reject(new Error('connection reset'));
        }
        return typeof value === 'function'
          ? (value as (...inner: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const result = await refreshCatalog(depsFor(languageFetch(modelId), { db: failingDb }));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('replaces a corrupt stored descriptor with a new version', async () => {
    const modelId = freshModelId('corrupt-stored');
    await db
      .insert(modelCatalog)
      .values({ modelId, version: 1, descriptor: 'not-an-object' })
      .onConflictDoNothing();
    const summaryResult = await refreshCatalog(depsFor(languageFetch(modelId)));
    expect(summaryResult._unsafeUnwrap().written).toBe(1);
    const rows = await catalogRowsFor(modelId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.descriptor).toMatchObject({ id: modelId, version: '2' });
  });

  it('fails unavailable when the database is unreachable', async () => {
    const modelId = freshModelId('db-down');
    const closed = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closed.$client.end();
    const result = await refreshCatalog(depsFor(languageFetch(modelId), { db: closed }));
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('alerts when an exposed media model carries an aged ZDR verification', async () => {
    const modelId = freshModelId('aged-image');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: { pricing: { perImage: '40000000' } },
        // 91 days before NOW.
        zdrVerifiedAt: new Date('2026-03-13T00:00:00.000Z'),
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const fetch = routedFetch({
      config: () =>
        jsonResponse(
          configFixture(
            [modelEntryFixture({ id: modelId, modelType: 'image', pricing: null })],
            ['openai']
          )
        ),
      endpoints: () => jsonResponse(endpointsFixture()),
    });
    const result = await refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry }));
    expect(result.isOk()).toBe(true);
    const alert = recorder.errors.find(
      (line) => line.fields?.modelName === modelId && line.msg.includes('aged')
    );
    expect(alert).toBeDefined();
    expect(recorder.capturedCodes).toContain('model_zdr_verification_aged_image');
  });

  it('alerts aged ZDR for a media-classified model the gateway types as language', async () => {
    // The bypass shape: a language-typed gateway entry with media-only
    // outputs. The exposure gate media-classifies it via the canonical
    // descriptor derivation, so its aged verification must alert too.
    const modelId = freshModelId('aged-bypass');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: {},
        // 91 days before NOW.
        zdrVerifiedAt: new Date('2026-03-13T00:00:00.000Z'),
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture({ id: modelId })], ['openai'])),
      endpoints: () =>
        jsonResponse(
          endpointsFixture({
            architecture: { input_modalities: ['text'], output_modalities: ['image', 'video'] },
          })
        ),
    });
    const result = await refreshCatalog(depsFor(fetch, { telemetry: recorder.telemetry }));
    expect(result.isOk()).toBe(true);
    const alert = recorder.errors.find(
      (line) => line.fields?.modelName === modelId && line.msg.includes('aged')
    );
    expect(alert?.fields?.errorCode).toBe('model_zdr_verification_aged_image');
    expect(recorder.capturedCodes).toContain('model_zdr_verification_aged_image');
  });
});
