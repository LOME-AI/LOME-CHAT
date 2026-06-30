import type { LegacyModality } from '@hushbox/shared';

/**
 * Per-modality prompt placeholder. Text modality uses the caller-supplied
 * default so different surfaces (chat-layout vs chat-welcome) keep their
 * wording.
 */
export function getPromptPlaceholder(
  modality: LegacyModality | undefined,
  fallback: string
): string {
  if (modality === 'image') return 'Describe the image you want...';
  if (modality === 'video') return 'Describe the video you want...';
  if (modality === 'audio') return 'Describe the audio you want...';
  return fallback;
}

export function getSendAriaLabel(modality: LegacyModality | undefined): string {
  if (modality === 'image') return 'Generate image';
  if (modality === 'video') return 'Generate video';
  if (modality === 'audio') return 'Generate audio';
  return 'Send message';
}

export function getMediaLoadingLabel(modality: LegacyModality | undefined): string {
  if (modality === 'image') return 'Generating image...';
  if (modality === 'video') return 'Generating video...';
  if (modality === 'audio') return 'Generating audio...';
  return 'Loading...';
}

export function getInspirationLabel(_modality: LegacyModality | undefined): string {
  return 'Need inspiration? Try these:';
}

export function getCostUnit(modality: LegacyModality | undefined): string {
  if (modality === 'image') return '$/image';
  if (modality === 'video') return '$/second';
  if (modality === 'audio') return '$/second';
  return '$/1M tokens';
}

/**
 * Builds a group-chat activity label for one or more typing/generating users.
 * `subject` is the pre-formatted user(s) string (e.g., "Alice", "Alice and Bob",
 * "3 people"). `plural` controls verb agreement and noun pluralization for
 * media modalities ("is generating an image" vs "are generating images").
 */
export function getTypingActivityLabel(
  modality: LegacyModality | undefined,
  subject: string,
  plural: boolean
): string {
  const verb = plural ? 'are' : 'is';
  if (modality === 'image') {
    const noun = plural ? 'images' : 'an image';
    return `${subject} ${verb} generating ${noun}...`;
  }
  if (modality === 'video') {
    const noun = plural ? 'videos' : 'a video';
    return `${subject} ${verb} generating ${noun}...`;
  }
  if (modality === 'audio') {
    return `${subject} ${verb} generating audio...`;
  }
  return `${subject} ${verb} typing...`;
}
