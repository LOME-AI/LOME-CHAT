import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import {
  createEnvUtilities,
  planReasoning,
  planReasoningOff,
  reasoningPlanModelFrom,
} from '@hushbox/shared';
import { resolveModelProvider } from './resolve-model-provider.js';
import type { Database } from '@hushbox/db';
import type {
  EnvContext,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
  ProviderMetadata,
} from '@hushbox/shared';
import type { ModelProvider } from '../ports/index.js';

/**
 * Shared harness for the AI-inference adapter integration tests (language,
 * image, video). The suites run EVERYWHERE with no skips — the same
 * provider-agnostic test bodies exercise:
 *
 *   - locally (any non-CI shell): the deterministic mock provider — no key, no
 *     db, no cassette, and structurally NO service-evidence write (the mock
 *     path of {@link resolveModelProvider} records nothing);
 *   - CI-vitest: the real provider under `OPENROUTER_API_KEY_RESTRICTED` with
 *     record-on-miss cassettes (the first uncached call is real, then replays
 *     from the actions/cache); the factory's evidence wrapper records
 *     `openrouter` service-evidence on the first successful event, so
 *     `verify:evidence --require=openrouter` has a row to assert.
 *
 * There is no local cassette system. Which path a run takes is decided by ONE
 * `createEnvUtilities()` derivation ({@link deriveIntegrationEnv}:
 * `useMock: !isCI`) — never by raw `process.env['CI']`/`['E2E']` sniffing — so
 * a CI-shaped local shell cannot reach the real evidence-writing path.
 */

/** The env vars `createEnvUtilities` consumes, read from the ambient process. */
export function processEnvContext(): EnvContext {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
  };
}

export interface IntegrationEnv {
  /** True outside CI — the suites resolve the deterministic mock. */
  readonly useMock: boolean;
  readonly isCI: boolean;
}

/**
 * THE single env→provider derivation for the adapter integration suites:
 * mock everywhere except CI. Pinned by `integration-setup.test.ts`.
 */
export function deriveIntegrationEnv(env: EnvContext): IntegrationEnv {
  const envUtilities = createEnvUtilities(env);
  return { useMock: !envUtilities.isCI, isCI: envUtilities.isCI };
}

/** Mirrors the dev/local `.dev.vars` placeholder — never a recordable real key. */
const DEV_MOCK_OPENROUTER_KEY = 'mock-openrouter-key';

const RAW_KEY = process.env['OPENROUTER_API_KEY'];
const RAW_DATABASE_URL = process.env['DATABASE_URL'];
const HAS_REAL_KEY =
  RAW_KEY !== undefined && RAW_KEY.length > 0 && RAW_KEY !== DEV_MOCK_OPENROUTER_KEY;
const HAS_DATABASE = RAW_DATABASE_URL !== undefined && RAW_DATABASE_URL.length > 0;

/**
 * The CI-vitest real-call gate for suites whose dependency has NO local mock
 * (the gateway-metadata catalog suite): CI and not E2E — classified by the one
 * `createEnvUtilities` derivation, never raw CI/E2E sniffing — with the
 * key/db presence terms because those suites skip (rather than fail) when the
 * shell lacks their inputs. Pinned by `integration-setup.test.ts`.
 */
export function deriveCiVitestGate(
  env: EnvContext,
  inputs: { readonly hasRealKey: boolean; readonly hasDatabase: boolean }
): boolean {
  const envUtilities = createEnvUtilities(env);
  return envUtilities.isCI && !envUtilities.isE2E && inputs.hasRealKey && inputs.hasDatabase;
}

/** The ambient gate value real-only integration suites hang `describe.skipIf` on. */
export const SHOULD_RUN = deriveCiVitestGate(processEnvContext(), {
  hasRealKey: HAS_REAL_KEY,
  hasDatabase: HAS_DATABASE,
});

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

/**
 * Cheap reasoning models for the reasoning cassette tests, one per wire
 * shape. Same ZDR-at-record-time contract as {@link REAL_MODEL_IDS}: a
 * non-ZDR-reachable id fails loudly on the CI record run. The effort-native
 * pick must RETURN reasoning text (OpenAI o-series bills reasoning but
 * streams none, so it cannot pin the delta assertions); gpt-oss models
 * stream their raw reasoning. Gemini 2.5 takes `reasoning.max_tokens` as a
 * thinking budget (budget-native) and streams thought summaries.
 */
export const REASONING_MODEL_IDS = {
  effortNative: 'openai/gpt-oss-20b',
  budgetNative: 'google/gemini-2.5-flash',
} as const;

interface RealProviderSetup {
  readonly provider: ModelProvider;
  readonly db: Database;
}

/**
 * Build the real provider through the factory. Called only inside `beforeAll`
 * (never at module scope) so no db/cassette construction happens at import.
 * Missing inputs fail fast with a clear message — in CI there is no skip.
 */
function setupRealProvider(): RealProviderSetup {
  if (RAW_KEY === undefined || RAW_KEY.length === 0) {
    throw new Error('OPENROUTER_API_KEY is required for real AI integration tests in CI-vitest.');
  }
  if (RAW_DATABASE_URL === undefined || RAW_DATABASE_URL.length === 0) {
    throw new Error(
      'DATABASE_URL is required for real AI integration tests — envConfig (mode `ciVitest`) sets it; verify the env-generation step ran.'
    );
  }
  const { isCI } = deriveIntegrationEnv(processEnvContext());
  const db = createDb(RAW_DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  const provider = resolveModelProvider({ useMock: false, apiKey: RAW_KEY, isCI, db });
  return { provider, db };
}

export interface IntegrationProviderSetup {
  readonly provider: ModelProvider;
  /** Closes the real path's db pool; a no-op on the mock path. */
  readonly teardown: () => Promise<void>;
}

/**
 * The adapter suites' single entry point: resolve the provider from the env —
 * deterministic mock outside CI, real + cassettes + evidence inside CI. The
 * injectable `env` exists for the harness pin test; suites call it bare.
 */
export function setupIntegrationProvider(
  env: EnvContext = processEnvContext()
): IntegrationProviderSetup {
  const { useMock, isCI } = deriveIntegrationEnv(env);
  if (useMock) {
    return {
      provider: resolveModelProvider({ useMock: true, apiKey: '', isCI, db: undefined }),
      teardown: () => Promise.resolve(),
    };
  }
  const { provider, db } = setupRealProvider();
  return {
    provider,
    teardown: async (): Promise<void> => {
      await db.$client.end();
    },
  };
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
    version: '2',
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

/** Effort-native reasoning model: enumerated levels pick the `{effort}` wire. */
export function reasoningEffortDescriptor(): ModelDescriptor {
  return {
    ...descriptorFor(REASONING_MODEL_IDS.effortNative, ['text'], ['streaming']),
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  };
}

/** Budget-native reasoning model: no effort vocabulary → `{max_tokens}` wire. */
export function reasoningBudgetDescriptor(): ModelDescriptor {
  return {
    ...descriptorFor(REASONING_MODEL_IDS.budgetNative, ['text'], ['streaming']),
    reasoning: { mandatory: false },
  };
}

/**
 * Answer headroom (H) for the reasoning requests. Generous relative to the
 * short stable prompt so a low-effort run cannot exhaust its completion cap
 * in thinking (an empty `length` finish would fail the answer assertions).
 */
const REASONING_ANSWER_HEADROOM_TOKENS = 512;

/**
 * The reasoning config comes from the shared plan — no code path sets
 * `reasoning` except via `planReasoning` output — so the wire shape under
 * test is exactly the one production sends. Deterministic inputs keep the
 * request hash (and its cassette) stable.
 */
function reasoningParameters(descriptor: ModelDescriptor): Record<string, unknown> {
  const result = planReasoning(
    reasoningPlanModelFrom(descriptor),
    'low',
    REASONING_ANSWER_HEADROOM_TOKENS
  );
  if (!result.feasible) {
    throw new Error(`reasoning plan infeasible for ${descriptor.id}: ${result.reason}`);
  }
  return { reasoning: result.plan.wire, maxOutputTokens: result.plan.maxTokens };
}

/** Stable prompt: a short question that invites a brief visible thought. */
const REASONING_PROMPT = 'What is 17 + 25? Reply with just the number.';

export function reasoningEffortRequest(): InferenceRequest {
  return {
    model: REASONING_MODEL_IDS.effortNative,
    inputs: [{ modality: 'text', text: REASONING_PROMPT }],
    parameters: reasoningParameters(reasoningEffortDescriptor()),
    outputs: ['text'],
  };
}

export function reasoningBudgetRequest(): InferenceRequest {
  return {
    model: REASONING_MODEL_IDS.budgetNative,
    inputs: [{ modality: 'text', text: REASONING_PROMPT }],
    parameters: reasoningParameters(reasoningBudgetDescriptor()),
    outputs: ['text'],
  };
}

/**
 * The hard-off exchange: an explicit `{ enabled: false }` wire (never
 * parameter omission) on a reasoning-capable, non-mandatory model, built via
 * `planReasoningOff`. Same stable prompt/model as the active reasoning
 * requests so the cassette hash stays deterministic.
 */
export function reasoningOffRequest(): InferenceRequest {
  const result = planReasoningOff(
    reasoningPlanModelFrom(reasoningEffortDescriptor()),
    REASONING_ANSWER_HEADROOM_TOKENS
  );
  if (!result.feasible) {
    throw new Error(`reasoning off-plan infeasible for ${REASONING_MODEL_IDS.effortNative}`);
  }
  return {
    model: REASONING_MODEL_IDS.effortNative,
    inputs: [{ modality: 'text', text: REASONING_PROMPT }],
    parameters: { reasoning: result.plan.wire, maxOutputTokens: result.plan.maxTokens },
    outputs: ['text'],
  };
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
