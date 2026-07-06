import { mediaTag, textTag } from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type {
  MediaTagModality,
  Modality,
  ModelDescriptor,
  NodePortDeclaration,
  TypeTag,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * Derives a model's typed node ports from its declared modalities — the single
 * primitive both the compile-time node registry (a modelCall's declared ports)
 * and the runtime model binding read from. A descriptor carries modalities, not
 * TypeTags, so the mapping and its representability limits live here once.
 *
 * Supported modality shapes (a modelCall has exactly one input and one output
 * port, and TypeTag v1 has no union, so each side must name exactly one
 * representable modality):
 * - `text` on either side → `text`.
 * - a single file-based media modality (`image`, `audio`, `video`) on either
 *   side → `media(modality, <default mime allowlist>)`.
 * Everything else fails closed (a `Result` error excludes the model, never a
 * guessed port): `embedding` (a numeric vector, not a mime-typed file, with no
 * media-tag representation), and any side declaring zero or several modalities
 * (which would need a union). The needed launch shapes — `text → text` and
 * `text → image`/`text → video` — are all supported.
 */

/**
 * Default accepted mime sets per file-based media modality. Descriptors do not
 * carry mimes, so a derived media port declares this default set. `embedding`
 * is deliberately absent — it has no mime-typed representation, so deriving a
 * port for it fails closed.
 */
const MEDIA_MIME_ALLOWLIST: Partial<Record<MediaTagModality, readonly [string, ...string[]]>> = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
  video: ['video/mp4', 'video/webm'],
};

/** The tag for one modality on a single port, or `undefined` when unrepresentable. */
function tagForModality(modality: Modality): TypeTag | undefined {
  if (modality === 'text') return textTag();
  const mimeTypes = MEDIA_MIME_ALLOWLIST[modality];
  return mimeTypes === undefined ? undefined : mediaTag(modality, mimeTypes);
}

/** A single port carries exactly one representable modality's tag; else fail closed. */
function singleModalityTag(
  modalities: readonly Modality[],
  side: string
): Result<TypeTag, DomainError> {
  const [only, ...rest] = modalities;
  if (only === undefined || rest.length > 0) {
    return err(
      validationError(
        `Model ${side} declares ${String(modalities.length)} modalities; a single port needs exactly one (TypeTag v1 has no union)`
      )
    );
  }
  const tag = tagForModality(only);
  if (tag === undefined) {
    return err(validationError(`Model ${side} modality '${only}' has no TypeTag representation`));
  }
  return ok(tag);
}

export function deriveModelPorts(
  descriptor: ModelDescriptor
): Result<NodePortDeclaration, DomainError> {
  return Result.combine([
    singleModalityTag(descriptor.inputs, 'input'),
    singleModalityTag(descriptor.outputs, 'output'),
  ]).map(([input, output]) => ({ in: [input], out: output }));
}
