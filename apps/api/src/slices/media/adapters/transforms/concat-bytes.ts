/**
 * Assembles byte regions into one buffer with a single allocation. Never
 * argument-spread a byte region (`push(...subarray)`): V8 caps argument
 * counts near 125 KB and throws RangeError, while image regions here run to
 * megabytes; a number[] accumulator also amplifies memory ~8-16x inside the
 * shared ~128 MB isolate.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
