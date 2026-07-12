import { readFileSync } from 'node:fs';

/**
 * Duration of a PCM WAV from its RIFF header (fmt byteRate + data size).
 * Header parsing instead of ffprobe so timing validation has zero system
 * dependencies; only uncompressed WAV (ElevenLabs PCM output) is supported.
 */
export function wavDurationSeconds(path: string): number {
  const buf = readFileSync(path);
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let byteRate: number | null = null;
  let dataSize: number | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') byteRate = buf.readUInt32LE(offset + 16);
    if (chunkId === 'data') dataSize = chunkSize;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (byteRate === null || dataSize === null || byteRate === 0) {
    throw new Error(`${path}: missing fmt/data chunk (compressed WAV is unsupported)`);
  }
  return dataSize / byteRate;
}
