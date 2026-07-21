import {
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  SMART_MODEL_ID,
  callShapeFamilyFor,
  getSupportedVideoDurations,
  mockDirectivesSchema,
} from '@hushbox/shared';
import {
  InferenceError,
  invalidRequestError,
  unsupportedModalityError,
} from './inference-error.js';
import { mediaFinishEvent, mediaOutputEvents } from './media-generate.js';
import type { GeneratedMediaFile } from './media-generate.js';
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
 * Scope: the LANGUAGE call-shape + the smart-model classifier (where all four
 * legacy knobs live), plus IMAGE and VIDEO generate calls — each returns a
 * single deterministic canned artifact through the same media-start/media-done/
 * finish contract the real adapters emit, so media e2e specs run without
 * cassettes. Audio/embedding families are refused with the same typed
 * unsupported-modality error the real dispatch raises, never a crash.
 *
 * Directives arrive PER-REQUEST: the chat route parses `x-mock-*` headers (dev/E2E
 * only) into `MockDirectives`, the run-start body carries them to the DO, and the
 * conversation runtime selects this mock — with those directives — per run.
 */

/** Coarse token estimate; deterministic and never zero (finish usage is > 0).
 * The shared standard constant is the single source (equals 4). */
const CHARS_PER_TOKEN = CHARS_PER_TOKEN_STANDARD;
/** A tiny non-zero inline cost so settlement bills authoritative (not estimated). */
const MOCK_GENERATION_COST_USD = 0.000_001;
/** Chunk width so the echo streams in a few deltas (the SSE multi-frame path). */
const MOCK_CHUNK_CHARS = 8;
/** The echo prefix (legacy-compatible: e2e specs substring-match "Echo:"). */
export const MOCK_ECHO_PREFIX = 'Echo:';

/**
 * Deterministic canned media the mock synthesizes for image/video generate
 * calls in dev/E2E — a valid 400×300 PNG and a minimal MP4 (`ftyp` box).
 * Fixed bytes, never random, so a media e2e replay is reproducible.
 */
const MOCK_IMAGE_MIME = 'image/png';
const MOCK_VIDEO_MIME = 'video/mp4';

const MOCK_IMAGE_WIDTH = 400;
const MOCK_IMAGE_HEIGHT = 300;
const MOCK_IMAGE_GRAY = 128;
const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];

/** CRC32 over `bytes` (standard PNG polynomial 0xEDB88320) for chunk checks. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xed_b8_83_20;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** Adler-32 over `bytes` — the trailing checksum of a zlib stream. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Big-endian 4-byte encoding of an unsigned 32-bit value. */
function uint32BE(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Wrap `data` as a PNG chunk: length + type + data + CRC32(type + data). */
function pngChunk(type: string, data: readonly number[]): number[] {
  const body = [...new TextEncoder().encode(type), ...data];
  return [...uint32BE(data.length), ...body, ...uint32BE(crc32(Uint8Array.from(body)))];
}

/**
 * Encode `raster` as a zlib stream using uncompressed (stored) deflate blocks —
 * a fully spec-valid stream every PNG decoder inflates, produced without a
 * compression dependency. Blocks cap at 65535 bytes; the last is marked final.
 */
function zlibStored(raster: Uint8Array): number[] {
  const out: number[] = [0x78, 0x01]; // zlib header (CM=8, 32K window, no preset; 0x7801 % 31 === 0)
  const maxBlock = 0xff_ff;
  for (let offset = 0; offset < raster.length; offset += maxBlock) {
    const end = Math.min(offset + maxBlock, raster.length);
    const blockLength = end - offset;
    const complement = ~blockLength & 0xff_ff;
    out.push(
      end === raster.length ? 1 : 0,
      blockLength & 0xff,
      (blockLength >>> 8) & 0xff,
      complement & 0xff,
      complement >>> 8
    );
    for (const byte of raster.subarray(offset, end)) out.push(byte);
  }
  out.push(...uint32BE(adler32(raster)));
  return out;
}

/**
 * A programmatically-built valid 400×300 8-bit grayscale PNG (signature + IHDR +
 * IDAT + IEND, correct chunk CRCs, a spec-valid stored-block zlib stream), solid
 * mid-gray. Built at module load, never a hand-authored byte literal — a
 * transcribed literal is exactly what corrupted the previous mock (its IDAT body
 * failed CRC and could not inflate). The 400×300 dimensions are load-bearing:
 * `image-generation.spec.ts` decodes the rendered <img> and asserts
 * naturalWidth/Height === 400/300, which requires bytes a real browser decoder
 * can genuinely decode.
 */
function buildGrayscalePng(width: number, height: number, gray: number): Uint8Array {
  const raster = new Uint8Array(height * (1 + width));
  raster.fill(gray);
  for (let y = 0; y < height; y += 1) raster[y * (1 + width)] = 0; // per-row filter byte: none
  const ihdr = pngChunk('IHDR', [...uint32BE(width), ...uint32BE(height), 8, 0, 0, 0, 0]);
  const idat = pngChunk('IDAT', zlibStored(raster));
  const iend = pngChunk('IEND', []);
  return Uint8Array.from([...PNG_SIGNATURE_BYTES, ...ihdr, ...idat, ...iend]);
}

const MOCK_IMAGE_BYTES = buildGrayscalePng(MOCK_IMAGE_WIDTH, MOCK_IMAGE_HEIGHT, MOCK_IMAGE_GRAY);

// A minimal MP4 `ftyp` box (major brand isom, compatible isom/mp42).
const MOCK_VIDEO_BYTES = new Uint8Array([
  0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52,
  50,
]);

/**
 * Parse the `x-mock-*` request headers into a validated {@link MockDirectives}.
 * A pure header reader (no Hono coupling): the caller supplies a header getter.
 * Malformed values are dropped, never thrown on — a bad header can never break a
 * request. `x-mock-hold-primary-stream` is the E2E stream-pause knob (dev/E2E
 * only, like every directive here); the mock holds the primary echo open until
 * an explicit release.
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
    ...(get('x-mock-hold-primary-stream') === 'true' ? { holdPrimaryStream: true } : {}),
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

/**
 * A deterministic ModelProvider for dev/E2E; every generation is reproducible.
 * `awaitStreamRelease` is the dev/E2E stream-pause barrier the ConversationRoom
 * DO threads per-run (never on the wire): when `holdPrimaryStream` is set the
 * primary echo emits its first chunk, awaits this, then completes. Absent on the
 * real path and on every unheld run, so behavior is unchanged without it.
 */
export function createMockModelProvider(
  directives: MockDirectives = {},
  awaitStreamRelease?: () => Promise<void>
): ModelProvider {
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
      options: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      return inferMock({
        request,
        descriptor,
        directives,
        failingModels,
        mintGenerationId,
        options,
        ...(awaitStreamRelease === undefined ? {} : { awaitStreamRelease }),
      });
    },
  };
}

interface MockContext {
  readonly request: InferenceRequest;
  readonly descriptor: ModelDescriptor;
  readonly directives: MockDirectives;
  readonly failingModels: ReadonlySet<string>;
  readonly mintGenerationId: () => string;
  readonly options: InferOptions;
  /** The dev/E2E stream-release barrier the echo awaits under `holdPrimaryStream`. */
  readonly awaitStreamRelease?: () => Promise<void>;
}

async function* inferMock(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const { request, descriptor } = ctx;
  if (request.model === SMART_MODEL_ID) {
    // Defensive: the virtual sentinel must be resolved to a real candidate before
    // inference; mirror the real gateway's rejection so a forwarding bug fails in
    // tests too, not only in production.
    throw invalidRequestError(`Mock provider received the virtual '${SMART_MODEL_ID}' id`);
  }
  const family = callShapeFamilyFor(descriptor.outputs);
  if (family === 'image') {
    yield* mediaStream(ctx, 'image', MOCK_IMAGE_MIME, MOCK_IMAGE_BYTES);
    return;
  }
  if (family === 'video') {
    assertSupportedVideoDuration(request);
    yield* mediaStream(ctx, 'video', MOCK_VIDEO_MIME, MOCK_VIDEO_BYTES);
    return;
  }
  if (family !== 'language') {
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

/**
 * Synthesize one deterministic media artifact, mirroring the real image/video
 * adapters' event shape: the canned bytes flow through the caller's
 * `mapFilePart` (a missing mapper is an AdapterDefect, exactly as in the real
 * path) into a media-start/media-done pair, then a terminal finish. Video
 * carries OpenRouter's inline cost + a generation id so settlement bills
 * authoritative; image carries neither (its API returns no inline cost, so
 * settlement falls back to the deterministic estimate).
 */
function* mediaStream(
  ctx: MockContext,
  modality: 'image' | 'video',
  mimeType: string,
  bytes: Uint8Array
): Generator<InferenceEvent> {
  const file: GeneratedMediaFile = { mediaType: mimeType, uint8Array: bytes };
  yield* mediaOutputEvents([file], ctx.options.mapFilePart);
  if (modality === 'video') {
    const metadata = {
      openrouter: { generationId: ctx.mintGenerationId(), cost: MOCK_GENERATION_COST_USD },
    };
    yield mediaFinishEvent(metadata, { inputTokens: 0, outputTokens: 0 }, MOCK_GENERATION_COST_USD);
    return;
  }
  yield mediaFinishEvent(undefined, { inputTokens: 0, outputTokens: 0 });
}

/**
 * Parity with the real video path: an unsupported requested duration is refused
 * before synthesis. `getSupportedVideoDurations` is the same capability source
 * request-shaping validation reads; a model with no constraint (undefined)
 * accepts any duration, and a non-integer/absent value imposes no check.
 */
function assertSupportedVideoDuration(request: InferenceRequest): void {
  const requested = request.parameters['durationSeconds'];
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) return;
  const supported = getSupportedVideoDurations(request.model);
  if (supported !== undefined && !supported.includes(requested)) {
    throw invalidRequestError(
      `Unsupported video duration (${String(requested)}s) for model ${request.model}`
    );
  }
}

async function* echoStream(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const prompt = promptTextOf(ctx.request);
  // Newline-separated, never same-line: a same-line prefix would put any
  // column-0-sensitive markdown the prompt starts with (code fences, headings,
  // lists) mid-line and corrupt the shape prod would produce (mock fidelity).
  const content = `${MOCK_ECHO_PREFIX}\n${prompt}`;
  // The dev/E2E stream-pause path: emit the first delta so the client
  // deterministically observes an active stream, park at the DO-owned release
  // barrier, then drain the remainder + finish. Unset (or no barrier wired) is
  // the unchanged instant echo.
  if (ctx.directives.holdPrimaryStream === true && ctx.awaitStreamRelease !== undefined) {
    const deltas = [...textDeltas(content)];
    const [first] = deltas;
    /* v8 ignore next -- the echo content carries the non-empty prefix, so a first delta always exists */
    if (first === undefined) return;
    yield first;
    await ctx.awaitStreamRelease();
    yield* deltas.slice(1);
    yield finishEvent(prompt, content, ctx.mintGenerationId());
    return;
  }
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
