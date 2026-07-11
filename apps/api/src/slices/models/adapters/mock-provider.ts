import {
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  SMART_MODEL_ID,
  callShapeFamilyFor,
  mockDirectivesSchema,
} from '@hushbox/shared';
import {
  InferenceError,
  invalidRequestError,
  unsupportedModalityError,
} from './inference-error.js';
import type {
  EnvUtilities,
  InferenceEvent,
  InferenceRequest,
  MockDirectives,
  ModelDescriptor,
} from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

// `MockDirectives` is owned by `@hushbox/shared` (the run-start contract carries
// it); re-exported here so the models barrel and every existing consumer keep a
// stable import site.
export type { MockDirectives } from '@hushbox/shared';

/**
 * The dev/E2E deterministic inference mock behind the ModelProvider port — the
 * new-tree home of the legacy `x-mock-*` e2e determinism seam. It replaces the
 * real OpenRouter provider in local dev and E2E (never production/CI — see
 * `mockProviderEnabled`), producing a deterministic echo for plain turns and
 * honoring four request-driven knobs the smart-model / multi-model specs need:
 *
 *   - `classifierResolution` — the model id the mock classifier "picks";
 *   - `classifierFailure`    — the classifier throws (survivable → fallback);
 *   - `failingModels`        — a listed model's generation fails at the port;
 *   - `classifierDelayMs`    — a first-event delay on the classifier stream.
 *
 * Scope: LANGUAGE call-shape + the smart-model classifier — exactly where all
 * four legacy knobs live. Media (image/video) mocking is out of scope (owned by
 * the media-adapter work); a media-family descriptor is refused with the same
 * typed unsupported-modality error the real dispatch raises, never a crash.
 *
 * Directives arrive PER-REQUEST: the chat route parses `x-mock-*` headers (dev/E2E
 * only) into `MockDirectives`, the run-start body carries them to the DO, and the
 * conversation runtime selects this mock — with those directives — per run.
 */

/** Coarse token estimate; deterministic and never zero (finish usage is > 0). */
const CHARS_PER_TOKEN = 4;
/** A tiny non-zero inline cost so settlement bills authoritative (not estimated). */
const MOCK_GENERATION_COST_USD = 0.000_001;
/** Chunk width so the echo streams in a few deltas (the SSE multi-frame path). */
const MOCK_CHUNK_CHARS = 8;
/** The echo prefix (legacy-compatible: e2e specs substring-match "Echo:"). */
export const MOCK_ECHO_PREFIX = 'Echo:';

/**
 * Parse the four `x-mock-*` request headers into a validated {@link MockDirectives}.
 * A pure header reader (no Hono coupling): the caller supplies a header getter.
 * Malformed values are dropped, never thrown on — a bad header can never break a
 * request. Mirrors the legacy `MockAIClientConfig` construction exactly.
 */
export function parseMockDirectives(get: (name: string) => string | undefined): MockDirectives {
  const resolution = get('x-mock-classifier-resolution');
  const failingModels = readFailingModels(get('x-mock-failing-models'));
  const classifierDelayMs = readPositiveInt(get('x-mock-classifier-delay-ms'));
  const raw = {
    ...(resolution === undefined || resolution === '' ? {} : { classifierResolution: resolution }),
    ...(get('x-mock-classifier-failure') === 'true' ? { classifierFailure: true } : {}),
    ...(failingModels === undefined ? {} : { failingModels }),
    ...(classifierDelayMs === undefined ? {} : { classifierDelayMs }),
  };
  // `raw` is built from validated helpers; the schema is the final defensive gate
  // (malformed → inert). Return the parsed `data` so the result is exactly the
  // inferred `MockDirectives` shape (the literal `classifierFailure: true` the
  // wire type requires), not the widened object-literal type.
  const parsed = mockDirectivesSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** The CSV of failing model ids → a trimmed non-empty list, or undefined. */
function readFailingModels(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const models = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return models.length > 0 ? models : undefined;
}

/** A header value parsed as a strictly-positive integer, or undefined. */
function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * THE env switch for the mock inference path: local dev OR E2E only (mirrors the
 * legacy `getAIClient` gate `isLocalDev || isE2E`). Production and CI-vitest read
 * `false` — production runs real OpenRouter; CI-vitest replays cassettes. This is
 * the single source both the runtime composer (provider selection) and
 * {@link mockDirectivesFor} (header gating) consult. The explicit `!isProduction`
 * term is belt-and-suspenders: the mock can never activate in production even if an
 * `E2E` binding errantly leaked into a production deploy.
 */
export function mockProviderEnabled(
  env: Pick<EnvUtilities, 'isLocalDev' | 'isE2E' | 'isProduction'>
): boolean {
  return (env.isLocalDev || env.isE2E) && !env.isProduction;
}

/**
 * The directives for a request, gated on {@link mockProviderEnabled}: parsed only
 * where the mock is active (dev/E2E), and inert (`{}`) everywhere else — so a
 * production request carrying `x-mock-*` headers is never read and never threaded.
 */
export function mockDirectivesFor(
  env: Pick<EnvUtilities, 'isLocalDev' | 'isE2E' | 'isProduction'>,
  get: (name: string) => string | undefined
): MockDirectives {
  return mockProviderEnabled(env) ? parseMockDirectives(get) : {};
}

/** A deterministic ModelProvider for dev/E2E; every generation is reproducible. */
export function createMockModelProvider(directives: MockDirectives = {}): ModelProvider {
  const failingModels = new Set(directives.failingModels);
  let generationCounter = 0;
  const mintGenerationId = (): string => {
    generationCounter += 1;
    return `mock-gen-${String(generationCounter)}`;
  };
  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      _options: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      return inferMock({ request, descriptor, directives, failingModels, mintGenerationId });
    },
  };
}

interface MockContext {
  readonly request: InferenceRequest;
  readonly descriptor: ModelDescriptor;
  readonly directives: MockDirectives;
  readonly failingModels: ReadonlySet<string>;
  readonly mintGenerationId: () => string;
}

async function* inferMock(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const { request, descriptor } = ctx;
  if (request.model === SMART_MODEL_ID) {
    // Defensive: the virtual sentinel must be resolved to a real candidate before
    // inference; mirror the real gateway's rejection so a forwarding bug fails in
    // tests too, not only in production.
    throw invalidRequestError(`Mock provider received the virtual '${SMART_MODEL_ID}' id`);
  }
  if (callShapeFamilyFor(descriptor.outputs) !== 'language') {
    throw unsupportedModalityError(descriptor.outputs);
  }
  if (isClassifierRequest(request)) {
    yield* classifierStream(ctx);
    return;
  }
  if (ctx.failingModels.has(request.model)) {
    // A directed generation failure — the typed InferenceError the engine treats
    // as an expected inference failure (err), exactly like a real provider outage.
    throw new InferenceError('upstream_error', `Mock: model ${request.model} is unavailable`);
  }
  yield* echoStream(ctx);
}

/** A classifier call is recognized by the marker the shared prompt embeds. */
function isClassifierRequest(request: InferenceRequest): boolean {
  return request.inputs.some(
    (part) => part.modality === 'text' && part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)
  );
}

async function* classifierStream(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const { request, directives } = ctx;
  await firstEventDelay(directives.classifierDelayMs);
  if (directives.classifierFailure === true) {
    throw new InferenceError('upstream_error', 'Mock: classifier unavailable');
  }
  // The classifier's routing choice: the directive, else the classifier's own
  // model id — by construction the cheapest candidate, which the resolver matches
  // exactly, so the default deterministically routes to the cheapest.
  const resolution = directives.classifierResolution ?? request.model;
  yield* textDeltas(resolution);
  yield finishEvent(promptTextOf(request), resolution, ctx.mintGenerationId());
}

function* echoStream(ctx: MockContext): Generator<InferenceEvent> {
  const prompt = promptTextOf(ctx.request);
  const content = `${MOCK_ECHO_PREFIX} ${prompt}`;
  yield* textDeltas(content);
  yield finishEvent(prompt, content, ctx.mintGenerationId());
}

/** The current-turn user text: the last non-marker text input part. */
function promptTextOf(request: InferenceRequest): string {
  for (let index = request.inputs.length - 1; index >= 0; index -= 1) {
    const part = request.inputs[index];
    if (part?.modality === 'text' && !part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)) {
      return part.text;
    }
  }
  return '';
}

function* textDeltas(content: string): Generator<InferenceEvent> {
  // One text stream → slot index 0 for every delta (model-call-execution
  // concatenates by content, not index).
  for (let index = 0; index < content.length; index += MOCK_CHUNK_CHARS) {
    yield { kind: 'text-delta', index: 0, content: content.slice(index, index + MOCK_CHUNK_CHARS) };
  }
}

function finishEvent(input: string, output: string, generationId: string): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: tokensOf(input), outputTokens: tokensOf(output) },
      finishReason: 'stop',
      providerCostUsd: MOCK_GENERATION_COST_USD,
      generationId,
    },
  };
}

function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function firstEventDelay(ms: number | undefined): Promise<void> {
  if (ms === undefined || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
