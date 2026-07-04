import { err, ok } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { concatBytes } from './concat-bytes.js';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * Removes the PNG chunks that carry identifying metadata: textual chunks
 * (tEXt/zTXt/iTXt — authoring tools write software, author, and location
 * strings here), eXIf, and tIME. Chunks are self-contained (length + type +
 * data + CRC), so dropping whole ancillary chunks never invalidates the
 * rest of the stream; kept chunks are copied byte-for-byte, CRCs included.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const STRIPPED_CHUNKS: ReadonlySet<string> = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripPngMetadata(bytes: Uint8Array): Result<Uint8Array<ArrayBuffer>, DomainError> {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return err(validationError('input is not a PNG stream'));
  }
  const kept: Uint8Array[] = [bytes.subarray(0, SIGNATURE.length)];
  let offset: number = SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return err(validationError('malformed PNG: truncated chunk header'));
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const dataLength = view.getUint32(0);
    const type = String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8));
    const chunkEnd = offset + 8 + dataLength + 4;
    if (chunkEnd > bytes.length) {
      return err(validationError('malformed PNG: chunk overruns the stream'));
    }
    if (!STRIPPED_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, chunkEnd));
    }
    if (type === 'IEND') {
      return ok(concatBytes(kept));
    }
    offset = chunkEnd;
  }
  return err(validationError('malformed PNG: stream ended without IEND'));
}
