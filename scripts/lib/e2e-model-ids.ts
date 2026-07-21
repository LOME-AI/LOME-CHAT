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

/**
 * A synthetic, seed-only strict-`["image"]` model id injected into
 * `model_catalog` AFTER the live `catalog:refresh` (see `scripts/seed.ts` +
 * `e2e-seeded-image-model.ts`). The live OpenRouter catalog exposes exactly one
 * ZDR strict-image model (`E2E_MODELS.image`) — the other live ZDR strict-image
 * model is token-priced and excluded at settlement — so a genuine
 * two-distinct-model image fan-out (`multi-model-media.spec.ts`) needs this
 * second exposed id. It is deliberately NOT in `E2E_MODELS`: that set is
 * validated against the LIVE catalog BEFORE the seed injects this row
 * (`assertE2eModelsPresent`), which a synthetic id would fail. The mock
 * send-provider renders a canned PNG for any image id, so nothing else is needed
 * to drive it. Lives here, import-free, so the db-banned E2E spec can share it.
 */
export const E2E_SEEDED_IMAGE_MODEL_ID = 'hushbox-e2e/mock-image-2';

/** Every E2E model id, flattened across modalities. */
export function e2eModelIds(): readonly string[] {
  return [...E2E_MODELS.text, ...E2E_MODELS.image, ...E2E_MODELS.video];
}
