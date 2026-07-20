/**
 * Magic-byte media validators for integration test assertions.
 *
 * Hand-rolled magic-byte checks for the formats AI providers actually emit
 * (PNG, JPEG, WebP, MP4, WebM) — no new dependency. Adding a new format means
 * appending a signature constant and a case in `detectMimeFromBytes`.
 */

export interface MediaSizeBounds {
  min: number;
  max: number;
}

export function assertValidMediaBytes(
  bytes: Uint8Array,
  allowedMimeTypes: readonly string[],
  sizeBoundsBytes: MediaSizeBounds
): { detectedMime: string } {
  if (bytes.byteLength < sizeBoundsBytes.min) {
    throw new Error(
      `Media bytes too small: ${String(bytes.byteLength)} < ${String(sizeBoundsBytes.min)}`
    );
  }
  if (bytes.byteLength > sizeBoundsBytes.max) {
    throw new Error(
      `Media bytes too large: ${String(bytes.byteLength)} > ${String(sizeBoundsBytes.max)}`
    );
  }
  const detectedMime = detectMimeFromBytes(bytes);
  if (detectedMime === undefined) {
    throw new Error('Unable to detect media format from byte signature.');
  }
  if (!allowedMimeTypes.includes(detectedMime)) {
    throw new Error(
      `Detected MIME ${detectedMime} not in allowed list [${allowedMimeTypes.join(', ')}]`
    );
  }
  return { detectedMime };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (const [index, expected] of prefix.entries()) {
    if (bytes[offset + index] !== expected) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70] as const;
const EBML_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3] as const;

function detectMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
    return 'image/webp';
  }
  if (startsWith(bytes, FTYP_SIGNATURE, 4)) return 'video/mp4';
  if (startsWith(bytes, EBML_SIGNATURE)) return 'video/webm';
  return undefined;
}
