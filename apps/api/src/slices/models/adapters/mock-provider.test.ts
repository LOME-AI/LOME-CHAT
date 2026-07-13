import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_SYSTEM_PROMPT_MARKER, SMART_MODEL_ID } from '@hushbox/shared';
import {
  MOCK_ECHO_PREFIX,
  createMockModelProvider,
  mockDirectivesFor,
  mockProviderEnabled,
  parseMockDirectives,
} from './mock-provider.js';
import { AdapterDefect } from './language-adapter.js';
import type {
  FilePart,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
} from '@hushbox/shared';

/** A minimal language-family descriptor for the given model id. */
function languageDescriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function textRequest(model: string, text: string): InferenceRequest {
  return { model, inputs: [{ modality: 'text', text }], parameters: {}, outputs: ['text'] };
}

/** A classifier request: the system prompt (marker-prefixed) rides as the first input part. */
function classifierRequest(model: string): InferenceRequest {
  return {
    model,
    inputs: [
      { modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose a model` },
      { modality: 'text', text: 'the latest exchange' },
    ],
    parameters: { maxOutputTokens: 32 },
    outputs: ['text'],
  };
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: readonly InferenceEvent[]): string {
  return events
    .filter(
      (event): event is Extract<InferenceEvent, { kind: 'text-delta' }> =>
        event.kind === 'text-delta'
    )
    .map((event) => event.content)
    .join('');
}

function finishOf(events: readonly InferenceEvent[]): Extract<InferenceEvent, { kind: 'finish' }> {
  const finish = events.find(
    (event): event is Extract<InferenceEvent, { kind: 'finish' }> => event.kind === 'finish'
  );
  if (finish === undefined) throw new Error('expected a finish event');
  return finish;
}

/** An image-family descriptor for the given model id. */
function imageDescriptor(id: string): ModelDescriptor {
  return { ...languageDescriptor(id), outputs: ['image'] };
}

/** A video-family descriptor for the given model id. */
function videoDescriptor(id: string): ModelDescriptor {
  return { ...languageDescriptor(id), outputs: ['video'] };
}

function imageRequest(model: string): InferenceRequest {
  return {
    model,
    inputs: [{ modality: 'text', text: 'a cat' }],
    parameters: {},
    outputs: ['image'],
  };
}

function videoRequest(model: string, parameters: Record<string, unknown> = {}): InferenceRequest {
  return { model, inputs: [{ modality: 'text', text: 'a cat' }], parameters, outputs: ['video'] };
}

/**
 * A mapFilePart that records each FilePart the provider hands it (so tests can
 * assert the canned bytes/mime the mock produced) and maps it to the media
 * event pair exactly as the engine's real mapper would.
 */
function capturingMapper(modality: 'image' | 'video'): {
  readonly mapFilePart: FilePartMapper;
  readonly parts: FilePart[];
} {
  const parts: FilePart[] = [];
  const mapFilePart: FilePartMapper = (part, index) => {
    parts.push(part);
    return [
      { kind: 'media-start', index, modality, mimeType: part.mediaType },
      {
        kind: 'media-done',
        index,
        value: {
          ref: `mock-ref-${modality}-${String(index)}`,
          mimeType: part.mediaType,
          modality,
          byteLength: part.data.byteLength,
          metadata: {},
        },
      },
    ];
  };
  return { mapFilePart, parts };
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** The `ftyp` box tag at bytes 4..8 of a minimal MP4. */
const MP4_FTYP_TAG = new Uint8Array([102, 116, 121, 112]);

/** Read a big-endian uint32 from `bytes` at `offset` (PNG IHDR width/height). */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

// A grayscale (type-0) 400×300 PNG raster is 300 rows of [filterByte, ...400 px].
const PNG_WIDTH = 400;
const PNG_HEIGHT = 300;
const EXPECTED_RASTER_LENGTH = PNG_HEIGHT * (1 + PNG_WIDTH); // 120300

/** A single decoded PNG chunk with its stored CRC and the byte range it covers. */
interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly storedCrc: number;
  /** type + data — the exact span the chunk CRC is computed over. */
  readonly crcInput: Uint8Array;
}

/** CRC32 (standard PNG polynomial 0xEDB88320), computed independently of the encoder. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * Split a PNG byte stream into its chunks (past the 8-byte signature). Bounds
 * every declared chunk length against the remaining bytes: a corrupt stream
 * whose length field overruns the buffer stops here rather than reading a
 * garbage multi-gigabyte "chunk" — the test must fail on a clean assertion,
 * never on an out-of-bounds allocation.
 */
function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8; // skip the signature
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset) >>> 0;
    if (offset + 12 + length > bytes.length) break; // declared length overruns the buffer
    const crcInput = bytes.subarray(offset + 4, offset + 8 + length); // type + data
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = readUint32BE(bytes, offset + 8 + length) >>> 0;
    const type = String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data, storedCrc, crcInput });
    offset += 12 + length;
  }
  return chunks;
}

describe('parseMockDirectives', () => {
  function getterFor(headers: Record<string, string>): (name: string) => string | undefined {
    return (name) => headers[name];
  }

  it('reads x-mock-classifier-resolution into classifierResolution', () => {
    const directives = parseMockDirectives(
      getterFor({ 'x-mock-classifier-resolution': 'a/model' })
    );
    expect(directives).toEqual({ classifierResolution: 'a/model' });
  });

  it('reads x-mock-classifier-failure=true into classifierFailure', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-failure': 'true' }));
    expect(directives).toEqual({ classifierFailure: true });
  });

  it('ignores x-mock-classifier-failure when not exactly "true"', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-failure': '1' }));
    expect(directives).toEqual({});
  });

  it('splits x-mock-failing-models CSV into a trimmed non-empty list', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-failing-models': ' a/x , , b/y ' }));
    expect(directives).toEqual({ failingModels: ['a/x', 'b/y'] });
  });

  it('drops x-mock-failing-models when the CSV yields no ids', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-failing-models': ' , ' }));
    expect(directives).toEqual({});
  });

  it('reads a positive x-mock-classifier-delay-ms into classifierDelayMs', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': '250' }));
    expect(directives).toEqual({ classifierDelayMs: 250 });
  });

  it('ignores a non-positive or non-numeric classifier delay', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': '0' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': 'nope' }))).toEqual({});
  });

  it('combines all four knobs from one request', () => {
    const directives = parseMockDirectives(
      getterFor({
        'x-mock-classifier-resolution': 'a/model',
        'x-mock-classifier-failure': 'true',
        'x-mock-failing-models': 'c/z',
        'x-mock-classifier-delay-ms': '10',
      })
    );
    expect(directives).toEqual({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['c/z'],
      classifierDelayMs: 10,
    });
  });

  it('returns an empty directive set when no headers are present', () => {
    expect(parseMockDirectives(getterFor({}))).toEqual({});
  });
});

describe('mockProviderEnabled / mockDirectivesFor', () => {
  const headers = { 'x-mock-classifier-resolution': 'a/model' };
  const get = (name: string): string | undefined => (headers as Record<string, string>)[name];

  it('is enabled in local dev and E2E, disabled otherwise', () => {
    expect(mockProviderEnabled({ isLocalDev: true, isE2E: false, isProduction: false })).toBe(true);
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: true, isProduction: false })).toBe(true);
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: false, isProduction: false })).toBe(
      false
    );
  });

  it('stays false in production even if a spurious E2E flag leaks in', () => {
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: true, isProduction: true })).toBe(false);
    expect(mockProviderEnabled({ isLocalDev: true, isE2E: false, isProduction: true })).toBe(false);
  });

  it('parses directives when the mock is enabled (dev/E2E)', () => {
    expect(mockDirectivesFor({ isLocalDev: true, isE2E: false, isProduction: false }, get)).toEqual(
      {
        classifierResolution: 'a/model',
      }
    );
  });

  it('is inert when the mock is disabled — headers are never read (production/CI)', () => {
    expect(
      mockDirectivesFor({ isLocalDev: false, isE2E: false, isProduction: false }, get)
    ).toEqual({});
  });
});

describe('createMockModelProvider — language echo', () => {
  it('echoes the prompt as streamed text with a billable finish', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(`${MOCK_ECHO_PREFIX} hello`);
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // The inline provider cost makes settlement bill authoritative (not estimated).
    expect(finish.metadata.providerCostUsd).toBeGreaterThan(0);
    expect(finish.metadata.generationId).toBeDefined();
  });

  it('mints a distinct generation id per call', async () => {
    const provider = createMockModelProvider();
    const first = finishOf(
      await collect(provider.infer(textRequest('a/model', 'one'), languageDescriptor('a/model')))
    );
    const second = finishOf(
      await collect(provider.infer(textRequest('a/model', 'two'), languageDescriptor('a/model')))
    );
    expect(first.metadata.generationId).not.toBe(second.metadata.generationId);
  });
});

describe('createMockModelProvider — failing-models knob', () => {
  it('throws a typed InferenceError for a listed failing model', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('lets an unlisted model succeed while a listed one fails', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    const ok = await collect(
      provider.infer(textRequest('good/model', 'hi'), languageDescriptor('good/model'))
    );
    expect(textOf(ok)).toBe(`${MOCK_ECHO_PREFIX} hi`);
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });
});

describe('createMockModelProvider — classifier knobs', () => {
  it('emits the directed resolution as the classifier output', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('picked/model');
    expect(finishOf(events).metadata.providerCostUsd).toBeGreaterThan(0);
  });

  it('defaults the resolution to the classifier model id (cheapest candidate)', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('cheap/model');
  });

  it('throws a typed InferenceError when classifier-failure is set', async () => {
    const provider = createMockModelProvider({ classifierFailure: true });
    await expect(
      collect(provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('does not treat a plain (non-marker) request as a classifier call', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    // A plain turn echoes; the classifier resolution never leaks into it.
    expect(textOf(events)).toBe(`${MOCK_ECHO_PREFIX} hello`);
  });

  it('resolves a classifier request whose only input is the marker system prompt', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const markerOnly: InferenceRequest = {
      model: 'cheap/model',
      inputs: [{ modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose` }],
      parameters: {},
      outputs: ['text'],
    };
    const events = await collect(provider.infer(markerOnly, languageDescriptor('cheap/model')));
    expect(textOf(events)).toBe('picked/model');
  });
});

describe('createMockModelProvider — classifier delay knob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gates the classifier stream by classifier-delay-ms', async () => {
    vi.useFakeTimers();
    const provider = createMockModelProvider({
      classifierResolution: 'picked/model',
      classifierDelayMs: 1000,
    });
    let settled = false;
    const pending = (async (): Promise<InferenceEvent[]> => {
      const events = await collect(
        provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
      );
      settled = true;
      return events;
    })();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const events = await pending;
    expect(settled).toBe(true);
    expect(textOf(events)).toBe('picked/model');
  });

  it('does not delay a plain (non-classifier) turn', async () => {
    const provider = createMockModelProvider({ classifierDelayMs: 100_000 });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hi'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(`${MOCK_ECHO_PREFIX} hi`);
  });
});

describe('createMockModelProvider — refusals', () => {
  it('refuses an audio-family descriptor with a typed unsupported-modality error', async () => {
    const provider = createMockModelProvider();
    const audioDescriptor: ModelDescriptor = {
      ...languageDescriptor('audio/model'),
      outputs: ['audio'],
    };
    await expect(
      collect(provider.infer(textRequest('audio/model', 'hi'), audioDescriptor))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'unsupported_modality' });
  });

  it('refuses the virtual smart-model sentinel (it must be resolved before inference)', async () => {
    const provider = createMockModelProvider();
    await expect(
      collect(provider.infer(textRequest(SMART_MODEL_ID, 'hi'), languageDescriptor(SMART_MODEL_ID)))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });
});

describe('createMockModelProvider — image synthesis', () => {
  it('yields a media-start→media-done→finish stream carrying the canned PNG bytes', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const events = await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);

    const start = events[0];
    if (start?.kind !== 'media-start') {
      throw new Error('expected a media-start event');
    }
    expect(start.modality).toBe('image');
    expect(start.mimeType).toBe('image/png');

    expect(parts).toHaveLength(1);
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(file.mediaType).toBe('image/png');
    expect(file.data.slice(0, 8)).toEqual(PNG_SIGNATURE);
    // The IHDR width/height (bytes 16..24) are load-bearing: the image e2e spec
    // decodes the rendered <img> and asserts naturalWidth/Height === 400/300.
    expect(readUint32BE(file.data, 16)).toBe(400);
    expect(readUint32BE(file.data, 20)).toBe(300);
  });

  it('produces a genuinely decodable PNG — a valid IDAT zlib stream and correct chunk CRCs', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');

    const chunks = parsePngChunks(file.data);
    // Every chunk's stored CRC must match a fresh recomputation — a corrupt
    // chunk body (as the old hand-authored bytes had) fails here.
    for (const chunk of chunks) {
      expect(crc32(chunk.crcInput)).toBe(chunk.storedCrc);
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    // The IDAT payload must inflate as a valid zlib stream to the exact raster
    // size. A malformed zlib stream throws; a wrong body yields a wrong length.
    const idat = chunks.find((chunk) => chunk.type === 'IDAT');
    if (idat === undefined) throw new Error('expected an IDAT chunk');
    const raster = inflateSync(Buffer.from(idat.data));
    expect(raster.byteLength).toBe(EXPECTED_RASTER_LENGTH);
  });

  it('finishes an image with no inline cost so settlement falls back to the estimate', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('image');
    const events = await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // OpenRouter's images API returns no inline cost — the mock mirrors that so
    // settlement bills the deterministic catalog estimate (isEstimated=true).
    expect(finish.metadata.providerCostUsd).toBeUndefined();
  });

  it('raises an AdapterDefect when a media call arrives without a mapFilePart contract', async () => {
    const provider = createMockModelProvider();
    await expect(
      collect(provider.infer(imageRequest('img/model'), imageDescriptor('img/model')))
    ).rejects.toBeInstanceOf(AdapterDefect);
  });
});

describe('createMockModelProvider — video synthesis', () => {
  it('yields a media-start→media-done→finish stream carrying the canned MP4 bytes', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('video');
    const events = await collect(
      provider.infer(videoRequest('vid/model'), videoDescriptor('vid/model'), { mapFilePart })
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);

    const start = events[0];
    if (start?.kind !== 'media-start') {
      throw new Error('expected a media-start event');
    }
    expect(start.modality).toBe('video');
    expect(start.mimeType).toBe('video/mp4');

    expect(parts).toHaveLength(1);
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(file.mediaType).toBe('video/mp4');
    expect(file.data.slice(4, 8)).toEqual(MP4_FTYP_TAG);
  });

  it('finishes a video with the authoritative inline cost and a generation id', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(videoRequest('vid/model'), videoDescriptor('vid/model'), { mapFilePart })
    );
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // Video carries OpenRouter's inline cost — the mock mirrors that so settlement
    // bills authoritative (isEstimated=false), matching the real video adapter.
    expect(finish.metadata.providerCostUsd).toBeGreaterThan(0);
    expect(finish.metadata.generationId).toBeDefined();
  });

  it('rejects an unsupported requested duration for a constrained model', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    // google/veo-3.0-generate-001 supports [4, 6, 8]s; 5s is unsupported.
    await expect(
      collect(
        provider.infer(
          videoRequest('google/veo-3.0-generate-001', { durationSeconds: 5 }),
          videoDescriptor('google/veo-3.0-generate-001'),
          { mapFilePart }
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('accepts a supported requested duration for a constrained model', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(
        videoRequest('google/veo-3.0-generate-001', { durationSeconds: 8 }),
        videoDescriptor('google/veo-3.0-generate-001'),
        { mapFilePart }
      )
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });

  it('accepts any duration for a model with no duration constraint', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(
        videoRequest('vid/model', { durationSeconds: 999 }),
        videoDescriptor('vid/model'),
        { mapFilePart }
      )
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });
});
