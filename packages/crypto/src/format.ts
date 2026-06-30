import { InvalidParameterError, MalformedBlobError, UnknownBlobVersionError } from './errors.js';

/**
 * Format version shared by every blob (envelope, wrap, media chunk).
 * 0x01 is taken by the legacy ECIES blob format; these decrypt paths reject it
 * as unknown rather than silently falling back.
 */
export const BLOB_FORMAT_VERSION = 0x02;

export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;

const encoder = new TextEncoder();

export function assertKnownVersion(blob: Uint8Array): void {
  const version = blob.at(0);
  if (version === undefined) {
    throw new MalformedBlobError('Empty blob: missing format version byte');
  }
  if (version !== BLOB_FORMAT_VERSION) {
    throw new UnknownBlobVersionError(version);
  }
}

/**
 * Length-prefixed (u32 big-endian) field encoding. Prefixing makes AAD
 * concatenation injective — without it, ('ab','c') and ('a','bc') would
 * produce identical AAD bytes and the location binding would be ambiguous.
 */
export function bytesField(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  new DataView(out.buffer).setUint32(0, value.length, false);
  out.set(value, 4);
  return out;
}

export function utf8Field(value: string): Uint8Array {
  return bytesField(encoder.encode(value));
}

export function u64Field(value: number, fieldName: string): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidParameterError(
      `Field ${fieldName} must be a non-negative safe integer, got ${String(value)}`
    );
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}
