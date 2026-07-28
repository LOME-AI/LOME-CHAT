import {
  CLASSIFIER_EFFORT_DIMENSION_MARKER,
  CLASSIFIER_MODEL_DIMENSION_MARKER,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  REASONING_EFFORT_LABELS,
  ReasoningWire,
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

/**
 * This fake provider's own synthetic tokenization: deterministic and never zero
 * (finish usage is > 0). It is NOT the money layer's tier estimation ratio and
 * carries no obligation to track it — the tier ratio sizes a reservation against
 * a real tokenizer, while this invents a plausible count for a provider that
 * does not tokenize at all. Equal values today are a coincidence, not a
 * contract. This mock prices itself through the inline cost below, never
 * through this count.
 */
const CHARS_PER_TOKEN = 4;
/** A tiny non-zero inline cost so settlement bills authoritative (not estimated). */
const MOCK_GENERATION_COST_USD = 0.000_001;
/**
 * Echo chunk width in *graphemes* (never code units): the echo is segmented by
 * grapheme cluster so a chunk boundary never splits a multi-code-point emoji or
 * combining sequence mid-token. 24 keeps the frame count low under CI
 * saturation while still streaming the echo in multiple `text-delta` frames.
 */
const MOCK_CHUNK_GRAPHEMES = 24;
/** The echo prefix (legacy-compatible: e2e specs substring-match "Echo:"). */
export const MOCK_ECHO_PREFIX = 'Echo:';
/**
 * Trailing fenced JSON block appended to every echo. It exercises two paths that
 * broke production and must stay covered by the dev/E2E mock: the streamdown
 * incomplete-markdown parser (a fenced block whose `{`/`}` arrive across frames)
 * and the SSE multi-line `data:` path (embedded newlines mid-stream).
 */
export const MOCK_ECHO_JSON_FENCE = '\n\n```json\n{\n  "ok": true\n}\n```';
/**
 * Deterministic thoughts streamed (ahead of the echo) whenever a language
 * request carries a reasoning config. Long enough to span several
 * grapheme-chunked reasoning deltas so multi-frame streaming assertions hold.
 */
export const MOCK_REASONING_TEXT =
  'Reading the request. Planning a faithful echo of the prompt. Ready to answer now.';

/**
 * The human-facing dev-server streaming affordances (visible typewriter echo,
 * the "Generating…" media placeholder, the "Choosing a model…" classifier
 * indicator). They fire ONLY on a real interactive dev server (`isDevServer` —
 * excludes E2E, vitest, CI, production), matching the legacy `buildMockConfig`
 * gate; a per-request directive overrides either way. Values match legacy
 * (`services/ai/index.ts`).
 */
const LOCAL_DEV_TEXT_DELAY_MS = 60;
const LOCAL_DEV_MEDIA_DELAY_MS = 3000;
const LOCAL_DEV_CLASSIFIER_DELAY_MS = 1000;

/**
 * Deterministic canned media the mock synthesizes for image/video generate
 * calls in dev/E2E — a valid PNG (400×300 fixture, or `aspectRatio`-scaled) and
 * a minimal MP4 (`ftyp` box). Fixed bytes, never random, so a media e2e replay
 * is reproducible.
 */
const MOCK_IMAGE_MIME = 'image/png';
const MOCK_VIDEO_MIME = 'video/mp4';

const MOCK_IMAGE_WIDTH = 400;
const MOCK_IMAGE_HEIGHT = 300;
const MOCK_IMAGE_GRAY = 128;
/** Long side (px) of an `aspectRatio`-scaled mock image — a plausible resolution. */
const MOCK_MEDIA_LONG_SIDE = 1024;
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
 * A programmatically-built valid `width`×`height` 8-bit grayscale PNG (signature
 * + IHDR + IDAT + IEND, correct chunk CRCs, a spec-valid stored-block zlib
 * stream), solid mid-gray. Never a hand-authored byte literal — a transcribed
 * literal is exactly what corrupted the previous mock (its IDAT body failed CRC
 * and could not inflate). The encoded dimensions are load-bearing:
 * `image-generation.spec.ts` decodes the rendered <img> and asserts its
 * naturalWidth/Height, which requires bytes a real browser decoder can genuinely
 * decode. The default fixture is 400×300; an `aspectRatio` request scales the
 * long side to {@link MOCK_MEDIA_LONG_SIDE}.
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

/**
 * Pixel dimensions the mock image reports for a requested aspect ratio
 * ("16:9"), scaled so the longer side is {@link MOCK_MEDIA_LONG_SIDE}, so the
 * dev UI reserves a media box matching the requested shape. Falls back to the
 * 400×300 fixture when no (or a malformed) ratio is present — keeping the
 * common no-`aspectRatio` unit path deterministic. Video carries no dimensional
 * payload in the new media contract (its bytes are a fixed `ftyp` box and media
 * events carry no width/height), so only image is scaled.
 */
function mockImageDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  const fallback = { width: MOCK_IMAGE_WIDTH, height: MOCK_IMAGE_HEIGHT };
  if (aspectRatio === undefined) return fallback;
  const [rawW, rawH] = aspectRatio.split(':');
  const ratioW = Number(rawW);
  const ratioH = Number(rawH);
  if (Number.isNaN(ratioW) || Number.isNaN(ratioH) || ratioW <= 0 || ratioH <= 0) {
    return fallback;
  }
  if (ratioW >= ratioH) {
    return {
      width: MOCK_MEDIA_LONG_SIDE,
      height: Math.round((MOCK_MEDIA_LONG_SIDE * ratioH) / ratioW),
    };
  }
  return {
    width: Math.round((MOCK_MEDIA_LONG_SIDE * ratioW) / ratioH),
    height: MOCK_MEDIA_LONG_SIDE,
  };
}

/**
 * The canned PNG for an image request: the 400×300 fixture when no aspect ratio
 * is requested (reuses the module-load fixture), else a freshly-encoded PNG at
 * the `aspectRatio`-scaled dimensions.
 */
function mockImageBytes(request: InferenceRequest): Uint8Array {
  const aspectRatio = request.parameters['aspectRatio'];
  const { width, height } = mockImageDimensions(
    typeof aspectRatio === 'string' ? aspectRatio : undefined
  );
  if (width === MOCK_IMAGE_WIDTH && height === MOCK_IMAGE_HEIGHT) return MOCK_IMAGE_BYTES;
  return buildGrayscalePng(width, height, MOCK_IMAGE_GRAY);
}

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
/** A header value as a non-empty string, or undefined. */
function readNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function parseMockDirectives(get: (name: string) => string | undefined): MockDirectives {
  const resolution = readNonEmpty(get('x-mock-classifier-resolution'));
  const classifierEffort = readNonEmpty(get('x-mock-classifier-effort'));
  const failingModels = readFailingModels(get('x-mock-failing-models'));
  const classifierDelayMs = readPositiveInt(get('x-mock-classifier-delay-ms'));
  const textDelayMs = readPositiveInt(get('x-mock-text-delay-ms'));
  const mediaDelayMs = readPositiveInt(get('x-mock-media-delay-ms'));
  const raw = {
    ...(resolution === undefined ? {} : { classifierResolution: resolution }),
    ...(classifierEffort === undefined ? {} : { classifierEffort }),
    ...(get('x-mock-classifier-failure') === 'true' ? { classifierFailure: true } : {}),
    ...(failingModels === undefined ? {} : { failingModels }),
    ...(classifierDelayMs === undefined ? {} : { classifierDelayMs }),
    ...(textDelayMs === undefined ? {} : { textDelayMs }),
    ...(mediaDelayMs === undefined ? {} : { mediaDelayMs }),
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

/** The resolved streaming delays a run uses (ms); 0 means no delay. */
export interface MockDelays {
  readonly textDelayMs: number;
  readonly mediaDelayMs: number;
  readonly classifierDelayMs: number;
}

/**
 * Resolve the per-run streaming delays, mirroring legacy `buildMockConfig`: a
 * per-request directive value always wins (`??`), otherwise the human-facing
 * dev-server default applies ONLY when `isDevServer` — the strict-subset env
 * flag (excludes E2E, vitest, CI, production), so automated test runs never
 * inherit artificial delay unless a test explicitly asks for one. The caller
 * derives `isDevServer` from `envUtils` (`createEnvUtilities().isDevServer`),
 * never from a raw `NODE_ENV`/`CI`/`E2E` check.
 */
export function resolveMockDelays(directives: MockDirectives, isDevServer: boolean): MockDelays {
  const devDefault = (value: number): number => (isDevServer ? value : 0);
  return {
    textDelayMs: directives.textDelayMs ?? devDefault(LOCAL_DEV_TEXT_DELAY_MS),
    mediaDelayMs: directives.mediaDelayMs ?? devDefault(LOCAL_DEV_MEDIA_DELAY_MS),
    classifierDelayMs: directives.classifierDelayMs ?? devDefault(LOCAL_DEV_CLASSIFIER_DELAY_MS),
  };
}

/**
 * A deterministic ModelProvider for dev/E2E; every generation is reproducible.
 * `awaitStreamRelease` is the dev/E2E stream-pause barrier the ConversationRoom
 * DO threads per-run (never on the wire): when `holdPrimaryStream` is set the
 * primary echo emits its first chunk, awaits this, then completes. Absent on the
 * real path and on every unheld run, so behavior is unchanged without it.
 *
 * `isDevServer` gates the visible streaming/media/classifier delay defaults (see
 * {@link resolveMockDelays}); it defaults `false` so any caller that does not
 * thread the env flag — and therefore every automated (E2E/vitest/CI) run —
 * streams instantly. A per-request delay directive still applies regardless.
 */
export function createMockModelProvider(
  directives: MockDirectives = {},
  awaitStreamRelease?: () => Promise<void>,
  isDevServer = false
): ModelProvider {
  const failingModels = new Set(directives.failingModels);
  const delays = resolveMockDelays(directives, isDevServer);
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
        delays,
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
  readonly delays: MockDelays;
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
    yield* mediaStream(ctx, 'image', MOCK_IMAGE_MIME, mockImageBytes(request));
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
  // The classifier delay is a first-event gate (the "Choosing a model…"
  // indicator), never a per-chunk typewriter — its short output emits at once.
  await delay(ctx.delays.classifierDelayMs);
  if (directives.classifierFailure === true) {
    throw new InferenceError('upstream_error', 'Mock: classifier unavailable');
  }
  // The requested dimensions ride the prompt's marker line (the same
  // no-prompt-coupling contract as the base marker). A legacy prompt carrying
  // neither dimension marker is model routing.
  const { model, effort } = classifierDimensionsOf(request);
  // One labelled line per dimension, exactly as the shared prompt instructs:
  // the answer parser reads by label, never by position.
  const lines: string[] = [];
  if (model) {
    // The routing choice: the directive, else the classifier's own model id —
    // by construction the cheapest candidate, which the resolver matches
    // exactly, so the default deterministically routes to the cheapest.
    lines.push(`model: ${directives.classifierResolution ?? request.model}`);
  }
  if (effort) {
    // The effort choice: the directive, else the canonical middle rung. It is
    // the MOCK's own deterministic answer, deliberately not the product's
    // fallback — a mock that answered what the reducer falls back to could not
    // tell "the classifier chose" from "nothing was chosen". Emitted as the
    // user-facing LABEL, because the classifier is presented labels and the
    // answer parser matches on them.
    const option = directives.classifierEffort ?? 'medium';
    lines.push(`effort: ${REASONING_EFFORT_LABELS[option]}`);
  }
  const answer = lines.join('\n');
  yield* textDeltas(answer, 0);
  yield finishEvent(promptTextOf(request), answer, ctx.mintGenerationId());
}

/** The dimension markers on the classifier prompt's marker line. */
function classifierDimensionsOf(request: InferenceRequest): {
  readonly model: boolean;
  readonly effort: boolean;
} {
  let markerLine = '';
  for (const part of request.inputs) {
    if (part.modality === 'text' && part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)) {
      markerLine = part.text.split('\n')[0] ?? '';
      break;
    }
  }
  const effort = markerLine.includes(CLASSIFIER_EFFORT_DIMENSION_MARKER);
  const model = markerLine.includes(CLASSIFIER_MODEL_DIMENSION_MARKER) || !effort;
  return { model, effort };
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
async function* mediaStream(
  ctx: MockContext,
  modality: 'image' | 'video',
  mimeType: string,
  bytes: Uint8Array
): AsyncGenerator<InferenceEvent> {
  const file: GeneratedMediaFile = { mediaType: mimeType, uint8Array: bytes };
  const events = mediaOutputEvents([file], ctx.options.mapFilePart);
  // Emit media-start immediately so the placeholder paints, hold for the media
  // delay (visible "Generating…" on a dev server; 0 elsewhere), then media-done
  // — mirroring legacy's `buildMediaStream` sequencing.
  for (const [index, event] of events.entries()) {
    if (index > 0) await delay(ctx.delays.mediaDelayMs);
    yield event;
  }
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

/**
 * The mock's thoughts for a request's `reasoning` param: only an ACTIVE wire
 * (effort or token budget) thinks — absence, a malformed value, and the
 * hard-off `{ enabled: false }` wire all produce none.
 */
function mockReasoningTextFor(reasoning: unknown): string | undefined {
  const wire = ReasoningWire.safeParse(reasoning);
  if (!wire.success || 'enabled' in wire.data) return undefined;
  return MOCK_REASONING_TEXT;
}

async function* echoStream(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const prompt = promptTextOf(ctx.request);
  // Newline-separated, never same-line: a same-line prefix would put any
  // column-0-sensitive markdown the prompt starts with (code fences, headings,
  // lists) mid-line and corrupt the shape prod would produce (mock fidelity).
  // The trailing JSON fence exercises the streamdown incomplete-markdown + SSE
  // multi-line `data:` paths.
  const content = `${MOCK_ECHO_PREFIX}\n${prompt}${MOCK_ECHO_JSON_FENCE}`;
  const delayMs = ctx.delays.textDelayMs;
  // Deterministic reasoning emission: a request carrying an ACTIVE reasoning
  // config streams a few reasoning deltas ahead of the echo text (mirroring
  // the real provider's reasoning-before-answer ordering) and bills
  // reasoningTokens on the finish — so reasoning assertions stay
  // provider-agnostic under the local mock run and E2E gets deterministic
  // thoughts. Reasoning-free requests and the hard-off `{ enabled: false }`
  // wire are byte-for-byte unchanged: off must behave exactly like no
  // reasoning (no deltas, no reasoningTokens).
  const reasoningText = mockReasoningTextFor(ctx.request.parameters['reasoning']);
  if (reasoningText !== undefined) {
    yield* reasoningDeltas(reasoningText, delayMs);
  }
  // The dev/E2E stream-pause path: emit the first delta so the client
  // deterministically observes an active stream, park at the DO-owned release
  // barrier, then drain the remainder + finish. Unset (or no barrier wired) is
  // the unchanged instant echo.
  if (ctx.directives.holdPrimaryStream === true && ctx.awaitStreamRelease !== undefined) {
    const iterator = textDeltas(content, delayMs)[Symbol.asyncIterator]();
    const first = await iterator.next();
    /* v8 ignore next -- the echo content carries the non-empty prefix, so a first delta always exists */
    if (first.done === true) return;
    yield first.value;
    await ctx.awaitStreamRelease();
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      yield next.value;
    }
    yield finishEvent(prompt, content, ctx.mintGenerationId(), reasoningText);
    return;
  }
  yield* textDeltas(content, delayMs);
  yield finishEvent(prompt, content, ctx.mintGenerationId(), reasoningText);
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

async function* textDeltas(content: string, delayMs: number): AsyncGenerator<InferenceEvent> {
  // One text stream → slot index 0 for every delta (model-call-execution
  // concatenates by content, not index). Grapheme-segmented so a chunk boundary
  // never splits a multi-code-point cluster. The first chunk emits immediately;
  // each subsequent chunk waits `delayMs` (the typewriter cadence; 0 = instant).
  const chunks = chunkByGrapheme(content, MOCK_CHUNK_GRAPHEMES);
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await delay(delayMs);
    yield { kind: 'text-delta', index: 0, content: chunk };
  }
}

/**
 * Reasoning counterpart of {@link textDeltas}: one reasoning stream at slot
 * index 0, grapheme-chunked, same typewriter cadence rules.
 */
async function* reasoningDeltas(content: string, delayMs: number): AsyncGenerator<InferenceEvent> {
  const chunks = chunkByGrapheme(content, MOCK_CHUNK_GRAPHEMES);
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await delay(delayMs);
    yield { kind: 'reasoning-delta', index: 0, content: chunk };
  }
}

/** Split `content` into chunks of at most `size` grapheme clusters (never mid-cluster). */
function chunkByGrapheme(content: string, size: number): string[] {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(content),
    (entry) => entry.segment
  );
  const chunks: string[] = [];
  for (let index = 0; index < graphemes.length; index += size) {
    chunks.push(graphemes.slice(index, index + size).join(''));
  }
  return chunks;
}

function finishEvent(
  input: string,
  output: string,
  generationId: string,
  reasoningText?: string
): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: {
        inputTokens: tokensOf(input),
        outputTokens: tokensOf(output),
        ...(reasoningText === undefined ? {} : { reasoningTokens: tokensOf(reasoningText) }),
      },
      finishReason: 'stop',
      providerCostUsd: MOCK_GENERATION_COST_USD,
      generationId,
    },
  };
}

function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Resolve after `ms` (a positive delay), or immediately when `ms <= 0`. */
function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
