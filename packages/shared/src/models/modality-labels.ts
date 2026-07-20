import type { ChatModality } from './types.js';

/**
 * Single source of truth for the composer modality-switch buttons' aria-labels.
 *
 * The prompt-input renders one button per modality with these labels; the demo
 * director clicks them by exact label and the demo composer-cues dim them by
 * the same selector. Keeping the strings here prevents the three call sites
 * from drifting apart (a renamed label would otherwise silently break the
 * demo's modality switching while production kept working).
 */
export const MODALITY_ARIA_LABELS: Record<ChatModality, string> = {
  text: 'Switch to text',
  image: 'Switch to image generation',
  video: 'Switch to video generation',
  audio: 'Switch to audio generation',
};
