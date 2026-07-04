import { err, ok } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { concatBytes } from './concat-bytes.js';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * Removes the metadata segments a JPEG can smuggle identifying data in:
 * APP1 (Exif — GPS, timestamps, device ids — and XMP), APP13 (IPTC/Photoshop
 * captions) and COM comments. Everything the decoder needs (JFIF APP0,
 * Adobe APP14, quantization/huffman tables, frame headers) passes through
 * untouched, and the entropy-coded stream after SOS is copied through its
 * terminating EOI. Bytes after EOI are dropped: motion photos (Samsung,
 * Google) append a video there whose container carries its own identifying
 * metadata, so pass-through would defeat the strip.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const STRIPPED_MARKERS: ReadonlySet<number> = new Set([0xe1, 0xed, 0xfe]);

/** One header-section step: a terminal marker, or a length-bearing segment. */
type SegmentScan =
  | { readonly kind: 'end-of-image' }
  | { readonly kind: 'start-of-scan' }
  | { readonly kind: 'segment'; readonly marker: number; readonly end: number };

function scanSegment(bytes: Uint8Array, offset: number): Result<SegmentScan, DomainError> {
  if (bytes[offset] !== 0xff) {
    return err(validationError('malformed JPEG: expected a marker prefix'));
  }
  const marker = bytes[offset + 1];
  if (marker === undefined) {
    return err(validationError('malformed JPEG: truncated marker'));
  }
  if (marker === EOI) return ok({ kind: 'end-of-image' });
  const high = bytes[offset + 2];
  const low = bytes[offset + 3];
  if (high === undefined || low === undefined) {
    return err(validationError('malformed JPEG: truncated segment length'));
  }
  const end = offset + 2 + ((high << 8) | low);
  if (end > bytes.length) {
    return err(validationError('malformed JPEG: segment overruns the stream'));
  }
  if (marker === SOS) return ok({ kind: 'start-of-scan' });
  return ok({ kind: 'segment', marker, end });
}

/**
 * Index just past the EOI that terminates the scan section starting at
 * `from`, or null when the stream is truncated. Entropy-coded data is
 * byte-stuffed (a literal 0xFF is coded FF 00) and inter-scan markers are
 * restart/table/SOS codes, so FF D9 cannot occur before the terminating EOI
 * in a valid stream — the first match is the image's end.
 */
function findEntropyEnd(bytes: Uint8Array, from: number): number | null {
  for (let index = from; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === EOI) {
      return index + 2;
    }
  }
  return null;
}

/**
 * T.81 B.1.1.2: any marker may be preceded by any number of 0xFF fill bytes.
 * Reading a fill byte as the marker would mis-parse a legal stream; padding
 * is optional, so dropping it from the output stays valid.
 */
function skipFillBytes(bytes: Uint8Array, offset: number): number {
  let index = offset;
  while (bytes[index] === 0xff && bytes[index + 1] === 0xff) {
    index += 1;
  }
  return index;
}

function finishAtTerminal(
  kind: 'end-of-image' | 'start-of-scan',
  bytes: Uint8Array,
  offset: number,
  kept: readonly Uint8Array[]
): Result<Uint8Array<ArrayBuffer>, DomainError> {
  if (kind === 'end-of-image') {
    return ok(concatBytes([...kept, bytes.subarray(offset, offset + 2)]));
  }
  const end = findEntropyEnd(bytes, offset);
  if (end === null) {
    return err(validationError('malformed JPEG: entropy-coded stream ended without EOI'));
  }
  return ok(concatBytes([...kept, bytes.subarray(offset, end)]));
}

export function stripJpegMetadata(bytes: Uint8Array): Result<Uint8Array<ArrayBuffer>, DomainError> {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== SOI) {
    return err(validationError('input is not a JPEG stream'));
  }
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    offset = skipFillBytes(bytes, offset);
    const scanned = scanSegment(bytes, offset);
    if (scanned.isErr()) return err(scanned.error);
    const scan = scanned.value;
    if (scan.kind !== 'segment') {
      return finishAtTerminal(scan.kind, bytes, offset, kept);
    }
    if (!STRIPPED_MARKERS.has(scan.marker)) {
      kept.push(bytes.subarray(offset, scan.end));
    }
    offset = scan.end;
  }
  return err(validationError('malformed JPEG: stream ended without EOI'));
}
