import { mediaTag } from '@hushbox/shared';
import { err } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { stripJpegMetadata } from './jpeg-metadata.js';
import { stripPngMetadata } from './png-metadata.js';
import type { ContentValue } from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { MediaTransformEntry } from '../../ports/index.js';

/**
 * The privacy transform for user-supplied images: strips embedded metadata
 * (Exif GPS/device data, IPTC, textual chunks) before the plaintext moves
 * further through a flow. One logical transform across the handled formats —
 * the output mime always equals the input mime, so the declared out-tag set
 * mirrors the in-tag set.
 */

const HANDLED_MIME_TYPES = ['image/jpeg', 'image/png'] as const;

function stripFor(
  mimeType: (typeof HANDLED_MIME_TYPES)[number],
  bytes: Uint8Array
): Result<Uint8Array<ArrayBuffer>, DomainError> {
  return mimeType === 'image/jpeg' ? stripJpegMetadata(bytes) : stripPngMetadata(bytes);
}

function isHandledMime(value: string): value is (typeof HANDLED_MIME_TYPES)[number] {
  return (HANDLED_MIME_TYPES as readonly string[]).includes(value);
}

export const stripImageMetadataEntry: MediaTransformEntry = {
  name: 'strip-image-metadata',
  version: 1,
  ports: {
    in: [mediaTag('image', [...HANDLED_MIME_TYPES])],
    out: mediaTag('image', [...HANDLED_MIME_TYPES]),
  },
  run(inputs: readonly ContentValue[]): Result<ContentValue, DomainError> {
    const [input] = inputs;
    if (inputs.length !== 1 || input === undefined) {
      return err(validationError('strip-image-metadata takes exactly one input'));
    }
    if (input.kind !== 'bytes') {
      return err(validationError('strip-image-metadata expects materialized image bytes'));
    }
    if (!isHandledMime(input.mimeType)) {
      return err(validationError('strip-image-metadata handles only JPEG or PNG input'));
    }
    const mimeType = input.mimeType;
    return stripFor(mimeType, input.bytes).map((bytes) => ({
      kind: 'bytes',
      bytes,
      mimeType,
      modality: 'image',
    }));
  },
};
