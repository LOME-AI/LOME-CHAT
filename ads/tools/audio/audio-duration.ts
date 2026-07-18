/**
 * Header-only audio-duration parsing for VO takes, with no system dependency.
 * WAV duration is always derivable from the RIFF header. FLAC duration is
 * derivable only when the encoder recorded a total-sample count in STREAMINFO;
 * streamed exports (e.g. MiniMax speech) leave it zero, so the FLAC parser
 * returns null and the caller (audio-probe) falls back to a decode.
 */

/** Duration of a PCM WAV from its RIFF header (fmt byteRate + data size). */
export function wavDurationSeconds(buffer: Buffer): number {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE buffer');
  }

  let byteRate: number | null = null;
  let dataSize: number | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
    if (chunkId === 'data') dataSize = chunkSize;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (byteRate === null || dataSize === null || byteRate === 0) {
    throw new Error('missing fmt/data chunk (compressed WAV is unsupported)');
  }
  return dataSize / byteRate;
}

/**
 * Duration of a FLAC file from its STREAMINFO metadata block, or null when the
 * encoder wrote a total-sample count of 0 ("unknown" — common in streamed
 * output). The first metadata block after the `fLaC` marker must be STREAMINFO.
 */
export function flacHeaderDurationSeconds(buffer: Buffer): number | null {
  if (buffer.length < 42 || buffer.toString('ascii', 0, 4) !== 'fLaC') {
    throw new Error('not a FLAC buffer');
  }
  if ((buffer.readUInt8(4) & 0x7f) !== 0) {
    throw new Error('first FLAC metadata block is not STREAMINFO');
  }
  // STREAMINFO body starts at offset 8; the packed sampleRate/channels/
  // bitsPerSample/totalSamples field is 10 bytes into the body (offset 18).
  const o = 18;
  const sampleRate =
    (buffer.readUInt8(o) << 12) | (buffer.readUInt8(o + 1) << 4) | (buffer.readUInt8(o + 2) >> 4);
  const totalSamples = (buffer.readUInt8(o + 3) & 0x0f) * 2 ** 32 + buffer.readUInt32BE(o + 4);
  if (sampleRate === 0) throw new Error('FLAC sample rate is zero');
  return totalSamples === 0 ? null : totalSamples / sampleRate;
}
