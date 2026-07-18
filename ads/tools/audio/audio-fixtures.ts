/**
 * In-memory RIFF/WAVE and FLAC buffer builders shared by the audio tests, so
 * the header-parsing fixtures live in one place rather than being duplicated
 * across test files. Not production code; excluded from the coverage gate.
 */

interface WavParts {
  byteRate?: number;
  dataSize?: number;
  includeFormat?: boolean;
  includeData?: boolean;
  riffTag?: string;
  waveTag?: string;
}

function formatChunk(byteRate: number): Buffer {
  const chunk = Buffer.alloc(24);
  chunk.write('fmt ', 0, 'ascii');
  chunk.writeUInt32LE(16, 4);
  chunk.writeUInt16LE(1, 8);
  chunk.writeUInt16LE(2, 10);
  chunk.writeUInt32LE(48_000, 12);
  chunk.writeUInt32LE(byteRate, 16);
  return chunk;
}

function dataChunk(dataSize: number): Buffer {
  const chunk = Buffer.alloc(8 + dataSize);
  chunk.write('data', 0, 'ascii');
  chunk.writeUInt32LE(dataSize, 4);
  return chunk;
}

/** Filler so a header-incomplete buffer still clears the 44-byte minimum and
 *  reaches the missing-chunk check rather than the too-short check. */
function fillerChunk(): Buffer {
  const chunk = Buffer.alloc(40);
  chunk.write('JUNK', 0, 'ascii');
  chunk.writeUInt32LE(32, 4);
  return chunk;
}

export function buildWav(parts: WavParts = {}): Buffer {
  const { byteRate = 1000, dataSize = 2500, includeFormat = true, includeData = true } = parts;

  const body = [
    includeFormat ? formatChunk(byteRate) : fillerChunk(),
    includeData ? dataChunk(dataSize) : fillerChunk(),
  ];
  const payload = Buffer.concat(body);
  const header = Buffer.alloc(12);
  header.write(parts.riffTag ?? 'RIFF', 0, 'ascii');
  header.writeUInt32LE(payload.length + 4, 4);
  header.write(parts.waveTag ?? 'WAVE', 8, 'ascii');
  return Buffer.concat([header, payload]);
}

interface FlacParts {
  sampleRate?: number;
  totalSamples?: number;
  channels?: number;
  bitsPerSample?: number;
  blockType?: number;
  marker?: string;
}

export function buildFlac(parts: FlacParts = {}): Buffer {
  const {
    sampleRate = 44_100,
    totalSamples = 110_250,
    channels = 1,
    bitsPerSample = 16,
    blockType = 0,
    marker = 'fLaC',
  } = parts;

  const buffer = Buffer.alloc(42);
  buffer.write(marker, 0, 'ascii');
  // Metadata block header: last-block flag set, block type, 24-bit length 34.
  buffer.writeUInt8(0x80 | (blockType & 0x7f), 4);
  buffer.writeUIntBE(34, 5, 3);
  // STREAMINFO body at offset 8; packed field (sampleRate/channels/bps/samples)
  // at body offset 10 = file offset 18.
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitsPerSample - 1) << 36n) |
    BigInt(totalSamples);
  buffer.writeBigUInt64BE(packed, 18);
  return buffer;
}
