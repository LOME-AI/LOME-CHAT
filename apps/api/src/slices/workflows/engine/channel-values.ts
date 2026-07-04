import { match } from 'ts-pattern';
import { ContentValue, MediaValue, mediaTag, textTag } from '@hushbox/shared';
import type { TypeTag } from '@hushbox/shared';

/**
 * The engine's ingress/egress adapters between the wire shape
 * (`ContentValue`) and the plain channel values `zodFor`-derived node
 * schemas validate: text rides as string, media as `MediaValue`, byte
 * payloads keep their envelope (no v1 tag accepts inline bytes — a consumer
 * tag mismatch fails runtime validation, never coerces silently).
 */

export function channelValueOf(input: ContentValue): unknown {
  return match(input)
    .with({ kind: 'text' }, (text) => text.text)
    .with({ kind: 'media' }, (media) => media.value)
    .with({ kind: 'bytes' }, (bytes) => bytes)
    .exhaustive();
}

/**
 * Derives the workflow-input tag a supplied value proves — the runtime leg
 * of "checked at build, save, and runtime". Undefined = unrepresentable
 * input (a byte payload claiming the text modality), rejected at ingress.
 */
export function inputTagOf(input: ContentValue): TypeTag | undefined {
  return match(input)
    .with({ kind: 'text' }, () => textTag())
    .with({ kind: 'media' }, (media) =>
      media.value.modality === 'text'
        ? undefined
        : mediaTag(media.value.modality, [media.value.mimeType])
    )
    .with({ kind: 'bytes' }, (bytes) =>
      bytes.modality === 'text' ? undefined : mediaTag(bytes.modality, [bytes.mimeType])
    )
    .exhaustive();
}

function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString(10) : value;
}

/**
 * Egress projection for settlement outputs: channel value → ContentValue.
 * Structured json serializes to inline text; the settlement policy owns any
 * richer persistence shape.
 */
export function contentValueOf(value: unknown): ContentValue {
  if (typeof value === 'string') {
    return { kind: 'text', text: value };
  }
  const asContent = ContentValue.safeParse(value);
  if (asContent.success) {
    return asContent.data;
  }
  const asMedia = MediaValue.safeParse(value);
  if (asMedia.success) {
    return { kind: 'media', value: asMedia.data };
  }
  return { kind: 'text', text: JSON.stringify(value, jsonSafe) };
}
