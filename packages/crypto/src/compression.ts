import { deflateSync } from 'fflate';
import { boundedInflate } from './bounded-inflate.js';

/**
 * Absolute output cap for decompressing one text-message payload. A hostile
 * conversation member can ship a deflate bomb that decrypts legitimately, so
 * inflation must abort mid-stream — on every member's client — the moment
 * output exceeds this bound. No per-message plaintext limit exists elsewhere
 * to derive from; 4 MiB is roughly an order of magnitude above the largest
 * plausible legitimate text message (a ~128K-token model output is ~0.5 MB
 * of UTF-8) while the per-flow media cap (20 MiB) is sized for media blobs,
 * not text.
 */
export const MAX_DECOMPRESSED_MESSAGE_BYTES = 4 * 1024 * 1024;

export function compress(data: Uint8Array): Uint8Array {
  return deflateSync(data);
}

export function decompress(data: Uint8Array): Uint8Array {
  return boundedInflate(data, MAX_DECOMPRESSED_MESSAGE_BYTES);
}

export function compressIfSmaller(data: Uint8Array): { result: Uint8Array; compressed: boolean } {
  const compressed = compress(data);
  if (compressed.length < data.length) {
    return { result: compressed, compressed: true };
  }
  return { result: data, compressed: false };
}
