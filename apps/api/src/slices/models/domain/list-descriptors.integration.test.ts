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
import { listDescriptors } from './list-descriptors.js';
import { refreshCatalog } from './refresh.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { SafeLogFields, Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for list-descriptors integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

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

async function refreshWith(
  models: unknown[],
  zdrProviders: string[],
  endpoints: Record<string, unknown> = {}
): Promise<void> {
  const fetch = routedFetch({
    config: () => jsonResponse(configFixture(models, zdrProviders)),
    endpoints: () => jsonResponse(endpointsFixture(endpoints)),
  });
  const result = await refreshCatalog({
    db,
    fetch,
    gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
    telemetry: silentTelemetry,
    now: () => new Date('2026-06-12T00:00:00.000Z'),
  });
  result._unsafeUnwrap();
}

/** Scoped to the caller's own model ids: suites on the shared DB run
 * concurrently and the root config retries failures once. */
async function exposedIds(ids: readonly string[]): Promise<string[]> {
  const descriptorsResult = await listDescriptors({ db, telemetry: silentTelemetry });
  const descriptors = descriptorsResult._unsafeUnwrap();
  return descriptors.map((descriptor) => descriptor.id).filter((id) => ids.includes(id));
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
    await db.delete(modelOverrides).where(inArray(modelOverrides.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('listDescriptors', () => {
  it('exposes a newly discovered gateway model with zero code changes', async () => {
    const first = freshModelId('zero-touch-a');
    await refreshWith([modelEntryFixture({ id: first })], ['openai']);
    expect(await exposedIds([first])).toEqual([first]);

    // The fixture grows a model; nothing but data changes.
    const second = freshModelId('zero-touch-b');
    await refreshWith(
      [modelEntryFixture({ id: first }), modelEntryFixture({ id: second })],
      ['openai']
    );
    const exposed = await exposedIds([first, second]);
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(exposed.toSorted(byName)).toEqual([first, second].toSorted(byName));
  });

  it('returns the parsed descriptor for an exposed model', async () => {
    const modelId = freshModelId('parsed');
    await refreshWith([modelEntryFixture({ id: modelId })], ['openai']);
    const descriptorsResult = await listDescriptors({ db, telemetry: silentTelemetry });
    const descriptors = descriptorsResult._unsafeUnwrap();
    const descriptor = descriptors.find((entry: ModelDescriptor) => entry.id === modelId);
    expect(descriptor).toMatchObject({ provider: 'openai', version: '1', zdrReachable: true });
  });

  it('hides a model whose providers are not ZDR-reachable', async () => {
    const modelId = freshModelId('no-zdr');
    await refreshWith([modelEntryFixture({ id: modelId })], ['some-other-provider']);
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides an empty-pricing model without an override', async () => {
    const modelId = freshModelId('unpriced');
    await refreshWith([modelEntryFixture({ id: modelId, pricing: null })], ['openai']);
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('exposes an empty-pricing model once an override supplies pricing', async () => {
    const modelId = freshModelId('override-priced');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: { pricing: { inputPerToken: '2500', outputPerToken: '10000' } },
      })
      .onConflictDoNothing();
    await refreshWith([modelEntryFixture({ id: modelId, pricing: null })], ['openai']);
    expect(await exposedIds([modelId])).toEqual([modelId]);
  });

  it('hides an image model without a dated ZDR verification', async () => {
    const modelId = freshModelId('image-unverified');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: { pricing: { perImage: '40000000' } },
        zdrVerifiedAt: null,
      })
      .onConflictDoNothing();
    await refreshWith(
      [modelEntryFixture({ id: modelId, modelType: 'image', pricing: null })],
      ['openai']
    );
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('exposes an image model with override data and a dated ZDR verification', async () => {
    const modelId = freshModelId('image-verified');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: {
          pricing: { perImage: '40000000' },
          parameters: { size: { type: 'enum', values: ['1024x1024'], wire: 'providerOptions' } },
        },
        zdrVerifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      })
      .onConflictDoNothing();
    await refreshWith(
      [modelEntryFixture({ id: modelId, modelType: 'image', pricing: null })],
      ['openai']
    );
    expect(await exposedIds([modelId])).toEqual([modelId]);
  });

  it('hides a no-text image+video multi-output model without a dated ZDR verification', async () => {
    // The latent-bypass shape: a language-typed gateway entry whose outputs
    // are media-only. The canonical family classifies it image, so the
    // dated-ZDR media gate applies — it must never ride the language path
    // past the gate while the adapter routes it to the image call-shape.
    const modelId = freshModelId('image-video-unverified');
    await refreshWith([modelEntryFixture({ id: modelId })], ['openai'], {
      architecture: { input_modalities: ['text'], output_modalities: ['image', 'video'] },
    });
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('exposes a no-text image+video model once its override carries a dated ZDR verification', async () => {
    const modelId = freshModelId('image-video-verified');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: {},
        zdrVerifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      })
      .onConflictDoNothing();
    await refreshWith([modelEntryFixture({ id: modelId })], ['openai'], {
      architecture: { input_modalities: ['text'], output_modalities: ['image', 'video'] },
    });
    expect(await exposedIds([modelId])).toEqual([modelId]);
  });

  it('hides a priced ZDR-reachable embedding model', async () => {
    // No embedding adapter exists; a listed model that always errors at call
    // time is a product flaw, so the family is hidden until one ships.
    const modelId = freshModelId('embedding');
    await refreshWith([modelEntryFixture({ id: modelId, modelType: 'embedding' })], ['openai']);
    expect(await exposedIds([modelId])).toEqual([]);
  });

  it('hides a model whose outputs match no call-shape family and alerts', async () => {
    const modelId = freshModelId('audio-only');
    await refreshWith([modelEntryFixture({ id: modelId })], ['openai'], {
      architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
    });
    const recorder = recordingTelemetry();
    const listResult = await listDescriptors({ db, telemetry: recorder.telemetry });
    const descriptors = listResult._unsafeUnwrap();
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    const alert = recorder.errors.find((line) => line.fields?.modelName === modelId);
    expect(alert?.fields?.errorCode).toBe('model_family_unclassifiable');
  });

  it('skips a stored descriptor that breaks the contract and alerts', async () => {
    const modelId = freshModelId('corrupt');
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        version: 1,
        descriptor: { id: modelId, nonsense: true },
      })
      .onConflictDoNothing();
    const recorder = recordingTelemetry();
    const listResult = await listDescriptors({ db, telemetry: recorder.telemetry });
    const descriptors = listResult._unsafeUnwrap();
    expect(descriptors.some((entry: ModelDescriptor) => entry.id === modelId)).toBe(false);
    const alert = recorder.errors.find((line) => line.fields?.modelName === modelId);
    expect(alert).toBeDefined();
  });
});
