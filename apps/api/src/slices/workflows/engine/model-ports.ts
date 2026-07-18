import { isRunnableModelShape, mediaTag, textTag } from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import type {
  MediaTagModality,
  Modality,
  ModelDescriptor,
  NodePortDeclaration,
  TypeTag,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';

/**
 * Derives a model's typed node ports from its declared modalities — the single
 * primitive both the compile-time node registry (a modelCall's declared ports)
 * and the runtime model binding read from. A descriptor carries modalities, not
 * TypeTags, so the mapping and its representability limits live here once.
 *
 * Gated on the shared `isRunnableModelShape` predicate so catalog admission and
 * port derivation never diverge: a model runs iff it accepts text input (extra
 * declared input modalities are allowed but unused) and produces exactly one
 * routable output modality (`text` | `image` | `video`; not audio, not
 * embedding, not multi-output).
 *
 * - Input port is always `text` — a chat turn only ever sends text to the model,
 *   and the predicate guarantees `text` is among the declared inputs. A
 *   multimodal-input model (e.g. text+image vision) is therefore runnable with a
 *   text input port.
 * - Output port is the single declared output's tag: `text` → `text`, or a
 *   file-based media modality (`image`, `video`) → `media(modality, <default
 *   mime allowlist>)`.
 *
 * Everything else fails closed (a `Result` error excludes the model, never a
 * guessed port): a no-text input, an audio/embedding output (no runnable
 * call-shape family), and any multi-output.
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
  /* v8 ignore next -- unreachable via deriveModelPorts: the runnable-shape gate admits only text/image/video outputs, all present in the mime allowlist; kept fail-closed for direct callers */
  if (mimeTypes === undefined) return undefined;
  return mediaTag(modality, mimeTypes);
}

/** A single port carries exactly one representable modality's tag; else fail closed. */
function singleModalityTag(
  modalities: readonly Modality[],
  side: string
): Result<TypeTag, DomainError> {
  const [only, ...rest] = modalities;
  /* v8 ignore next 7 -- unreachable: deriveModelPorts is the only caller and gates on isRunnableModelShape, which guarantees exactly one output modality; kept fail-closed */
  if (only === undefined || rest.length > 0) {
    return err(
      validationError(
        `Model ${side} declares ${String(modalities.length)} modalities; a single port needs exactly one (TypeTag v1 has no union)`
      )
    );
  }
  const tag = tagForModality(only);
  /* v8 ignore next 3 -- unreachable: the runnable-shape gate admits only text/image/video outputs, each of which has a TypeTag; kept fail-closed */
  if (tag === undefined) {
    return err(validationError(`Model ${side} modality '${only}' has no TypeTag representation`));
  }
  return ok(tag);
}

export function deriveModelPorts(
  descriptor: ModelDescriptor
): Result<NodePortDeclaration, DomainError> {
  if (!isRunnableModelShape(descriptor)) {
    return err(
      validationError(
        `Model shape (inputs [${descriptor.inputs.join(', ')}], outputs [${descriptor.outputs.join(', ')}]) is not runnable: needs a text input and exactly one routable output (text | image | video)`
      )
    );
  }
  // Input is always text — a chat turn only ever sends text; the predicate above
  // guarantees the model declares a text input. The single routable output keeps
  // its modality's tag.
  return singleModalityTag(descriptor.outputs, 'output').map((output) => ({
    in: [textTag()],
    out: output,
  }));
}
