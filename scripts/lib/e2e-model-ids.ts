/**
 * The plain model-id data behind `E2E_MODELS` — deliberately import-free so
 * db-banned consumers (e2e specs/helpers may not import `@hushbox/db`) can
 * share the one id list with `scripts/lib/e2e-models.ts`'s catalog assertion.
 * Both sides import from here; there is no hand-copied mirror to drift.
 */

export interface E2eModelSet {
  readonly text: readonly string[];
  readonly image: readonly string[];
  readonly video: readonly string[];
}

/**
 * Both referenced by the E2E specs / seed AND exposed strict-family models in
 * the live OpenRouter catalog (validated by `assertE2eModelsPresent` at refresh
 * time). Image has a single exposed strict-`["image"]` model; the video ids are
 * exposed strict-`["video"]` models.
 */
export const E2E_MODELS = {
  text: ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6'],
  image: ['bytedance-seed/seedream-4.5'],
  video: ['google/veo-3.1-lite', 'kwaivgi/kling-video-o1'],
} as const satisfies E2eModelSet;

/** Every E2E model id, flattened across modalities. */
export function e2eModelIds(): readonly string[] {
  return [...E2E_MODELS.text, ...E2E_MODELS.image, ...E2E_MODELS.video];
}
