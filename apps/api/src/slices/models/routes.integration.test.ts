import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { ERROR_CODES, modelsListResponseSchema } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { acquireModelCatalogLock } from './__tests__/model-catalog-lock.js';
import { listModels } from './domain/list-models.js';
import { createModelsManifest } from './index.js';
import type { ModelsListResponse } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields, Telemetry, TelemetryEnv } from '../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_REST_* are required for models route integration tests'
  );
}

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// Serialize catalog critical sections against the other model_catalog suites
// (this suite's route reads the catalog globally). Held per test via the
// crash-safe Redis TTL lock.
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
const RUN_PREFIX = `mdl-rt-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

interface SeedOverrides {
  readonly outputs?: string[];
  readonly pricing?: Record<string, string | Record<string, string>>;
  readonly limits?: Record<string, number>;
  readonly zdrReachable?: boolean;
  readonly releasedAt?: number;
}

/** Insert one wire-form descriptor row (NanoUSD string rates, jsonb). */
async function seedDescriptor(modelId: string, overrides: SeedOverrides = {}): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: RUN_PREFIX,
        version: '1',
        inputs: ['text'],
        outputs: overrides.outputs ?? ['text'],
        parameters: {},
        behaviors: [],
        limits: overrides.limits ?? { contextLength: 128_000 },
        pricing: overrides.pricing ?? { inputPerToken: '100', outputPerToken: '200' },
        zdrReachable: overrides.zdrReachable ?? true,
        releasedAt: overrides.releasedAt ?? 1_600_000_000,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

function createApp(): Hono<AppEnv> {
  const manifest = createModelsManifest();
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function fetchList(): Promise<ModelsListResponse> {
  const res = await createApp().request('/models', {}, testEnv);
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  // The wire body carries exactly the shared contract's two keys.
  expect(
    Object.keys(body as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))
  ).toEqual(['models', 'premiumModelIds']);
  return modelsListResponseSchema.parse(body);
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('GET /models (public)', () => {
  it('serves the exposed catalog to an unauthenticated caller in the shared shape', async () => {
    const exposed = freshModelId('exposed');
    await seedDescriptor(exposed);
    const body = await fetchList();
    const model = body.models.find((entry) => entry.id === exposed);
    expect(model).toBeDefined();
    expect(model?.modality).toBe('text');
    expect(model?.contextLength).toBe(128_000);
    // BASE nano rate, verbatim from the seeded descriptor (no fee, no markup).
    expect(model?.pricing.inputPerToken).toBe('100');
  });

  it('never lists a ZDR-unreachable or unpriced model', async () => {
    const exposed = freshModelId('mixed-exposed');
    const zdrHidden = freshModelId('mixed-no-zdr');
    const unpriced = freshModelId('mixed-unpriced');
    await seedDescriptor(exposed);
    await seedDescriptor(zdrHidden, { zdrReachable: false });
    await seedDescriptor(unpriced, { pricing: {} });
    const body = await fetchList();
    const ids = body.models.map((entry) => entry.id);
    expect(ids).toContain(exposed);
    expect(ids).not.toContain(zdrHidden);
    expect(ids).not.toContain(unpriced);
    expect(body.premiumModelIds).not.toContain(zdrHidden);
    expect(body.premiumModelIds).not.toContain(unpriced);
  });

  it('classifies recent text models and media models premium', async () => {
    const recent = freshModelId('recent');
    const image = freshModelId('image');
    await seedDescriptor(recent, { releasedAt: Math.floor(Date.now() / 1000) - 1000 });
    await seedDescriptor(image, {
      outputs: ['image'],
      pricing: { perImage: '40000000' },
      limits: {},
    });
    const body = await fetchList();
    expect(body.premiumModelIds).toContain(recent);
    expect(body.premiumModelIds).toContain(image);
    expect(body.models.some((entry) => entry.id === image)).toBe(true);
  });

  it('hides an exposed descriptor whose wire projection fails, with an alert', async () => {
    // Exposed by every listDescriptors gate (ZDR, priced, language family)
    // but unprojectable: a text model without a context length fails the
    // shared modelSchema refine, so the list drops it and alerts.
    const unprojectable = freshModelId('no-context');
    await seedDescriptor(unprojectable, { limits: {} });
    const errors: { msg: string; fields: SafeLogFields | undefined }[] = [];
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
    const result = await listModels({ db, telemetry }, Date.now());
    const response = result._unsafeUnwrap();
    expect(response.models.some((entry) => entry.id === unprojectable)).toBe(false);
    const alert = errors.find((line) => line.fields?.modelName === unprojectable);
    expect(alert?.fields?.errorCode).toBe('model_projection_invalid');
  });

  it('answers 503 when the database is unreachable', async () => {
    const deadDbEnv = {
      ...testEnv,
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
    };
    const res = await createApp().request('/models', {}, deadDbEnv);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});
