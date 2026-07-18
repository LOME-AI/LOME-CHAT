import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { resolveModelProvider } from './resolve-model-provider.js';
import type { Database } from '@hushbox/db';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
  ProviderMetadata,
} from '@hushbox/shared';
import type { ModelProvider } from '../ports/index.js';

/**
 * Shared harness for the REAL AI-inference integration tests (language, image,
 * video). Each modality suite builds the provider through the ONE
 * {@link resolveModelProvider} factory on its real/CI-vitest path (real key +
 * real local-Postgres db + isCI true) and runs a live inference; the factory's
 * evidence wrapper records `openrouter` service-evidence on the first successful
 * event, so `verify:evidence --require=openrouter` has a row to assert. Mirrors
 * the legacy `integration-setup.ts` + `real.integration.test.ts` shape.
 *
 * CI-vitest only. {@link SHOULD_RUN} keys off raw `process.env` at collection
 * time — before any `createEnvUtilities` / db / cassette construction, which all
 * happen inside {@link setupRealProvider} (called from `beforeAll`). Locally
 * (no CI, dev mock key, no db) every suite skips cleanly and stays green,
 * making no real call and never crashing on import. In CI these run under
 * `OPENROUTER_API_KEY_RESTRICTED` and record on a miss (the first uncached call
 * is real, then replays from the actions/cache); a warm cache makes no live call.
 */

/** Mirrors the dev/local `.dev.vars` placeholder — never a recordable real key. */
const DEV_MOCK_OPENROUTER_KEY = 'mock-openrouter-key';

const RAW_KEY = process.env['OPENROUTER_API_KEY'];
const RAW_DATABASE_URL = process.env['DATABASE_URL'];
const IS_CI = Boolean(process.env['CI']);
const IS_E2E = Boolean(process.env['E2E']);
const HAS_REAL_KEY =
  RAW_KEY !== undefined && RAW_KEY.length > 0 && RAW_KEY !== DEV_MOCK_OPENROUTER_KEY;
const HAS_DATABASE = RAW_DATABASE_URL !== undefined && RAW_DATABASE_URL.length > 0;

/** CI-vitest = CI && !E2E, with a real (non-mock) key and a db for evidence. */
export const SHOULD_RUN = IS_CI && !IS_E2E && HAS_REAL_KEY && HAS_DATABASE;

/**
 * The model called per modality. Each MUST be ZDR-reachable at record time:
 * every real call carries OpenRouter's `provider.zdr:true`, which fails closed
 * on a non-ZDR model — so a wrong id fails loudly on the record run, the right
 * place to catch it. (The adapters' own descriptor ZDR guard never fires here —
 * `descriptorFor` hardcodes `zdrReachable: true`, so the operative fail-closed
 * is the per-request `provider.zdr` flag, not the descriptor check.) Hardcoded
 * (not picked from the drifting live catalog) so each inference request hashes
 * stably and its cassette replays deterministically; this is the single place
 * to adjust.
 */
export const REAL_MODEL_IDS = {
  language: 'openai/gpt-4o',
  image: 'google/imagen-4.0-generate-001',
  video: 'google/veo-3.1-generate-001',
} as const;

export interface RealProviderSetup {
  readonly provider: ModelProvider;
  readonly db: Database;
}

/**
 * Build the real provider through the factory. Called only inside `beforeAll`
 * (never at module scope) so a skipped local run constructs nothing. `SHOULD_RUN`
 * guarantees the env vars; the assertions narrow them for the compiler.
 */
export function setupRealProvider(): RealProviderSetup {
  if (RAW_KEY === undefined || RAW_KEY.length === 0) {
    throw new Error('OPENROUTER_API_KEY is required for real AI integration tests in CI-vitest.');
  }
  if (RAW_DATABASE_URL === undefined || RAW_DATABASE_URL.length === 0) {
    throw new Error(
      'DATABASE_URL is required for real AI integration tests — envConfig (mode `ciVitest`) sets it; verify the env-generation step ran.'
    );
  }
  const { isCI } = createEnvUtilities({
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
  });
  const db = createDb(RAW_DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  const provider = resolveModelProvider({ useMock: false, apiKey: RAW_KEY, isCI, db });
  return { provider, db };
}

/** A minimal single-modality descriptor mirroring the adapter unit tests' shape. */
function descriptorFor(
  id: string,
  outputs: ModelDescriptor['outputs'],
  behaviors: string[]
): ModelDescriptor {
  const provider = id.split('/')[0] ?? id;
  return {
    id,
    provider,
    version: '1',
    inputs: ['text'],
    outputs,
    parameters: {},
    behaviors,
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

export function languageDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.language, ['text'], ['streaming']);
}

export function imageDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.image, ['image'], []);
}

export function videoDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.video, ['video'], []);
}

function textInputRequest(
  model: string,
  text: string,
  outputs: ModelDescriptor['outputs']
): InferenceRequest {
  return { model, inputs: [{ modality: 'text', text }], parameters: {}, outputs };
}

export function languageRequest(): InferenceRequest {
  return textInputRequest(REAL_MODEL_IDS.language, 'Reply with a short greeting.', ['text']);
}

export function imageRequest(): InferenceRequest {
  return textInputRequest(REAL_MODEL_IDS.image, 'A small red dot on a white background', ['image']);
}

export function videoRequest(): InferenceRequest {
  return textInputRequest(REAL_MODEL_IDS.video, 'A short panning shot of a calm landscape', [
    'video',
  ]);
}

export interface MediaCapture {
  readonly mapFilePart: FilePartMapper;
  readonly captured: Uint8Array[];
}

/**
 * A real {@link FilePartMapper}: the port makes the caller decide where bytes
 * rest, so this maps each generated file part to media events and captures the
 * real bytes for structural assertions (the tests never persist to R2).
 */
export function makeMediaCapture(modality: 'image' | 'video'): MediaCapture {
  const captured: Uint8Array[] = [];
  const mapFilePart: FilePartMapper = (part, index) => {
    captured.push(part.data);
    const value: MediaValue = {
      ref: `media/integration/${modality}/${String(index)}`,
      mimeType: part.mediaType,
      modality,
      byteLength: part.data.byteLength,
      metadata: {},
    };
    return [
      { kind: 'media-start', index, modality, mimeType: part.mediaType },
      { kind: 'media-done', index, value },
    ];
  };
  return { mapFilePart, captured };
}

export async function consume(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Assert the stream ended on a `finish` and return its metadata (union narrowing). */
export function finishMetadata(events: readonly InferenceEvent[]): ProviderMetadata {
  const last = events.at(-1);
  if (last?.kind !== 'finish') {
    throw new Error(`expected a terminal finish event, saw ${last?.kind ?? 'nothing'}`);
  }
  return last.metadata;
}
