/**
 * Capability-driven test model picker.
 *
 * Selects the cheapest paid non-premium model per modality and surfaces the
 * lowest-supported call parameters (durations / resolutions / aspect ratios
 * from `packages/shared/src/models/capabilities.ts`). Single SoT: consults
 * `client.listModelsForModality(...)` so the picker can never select a
 * (model, resolution, duration, aspectRatio) combination the gateway would
 * reject. Cached per modality within a test run.
 */

import { assertNever } from '@hushbox/shared';
import type { ImageAspectRatio, VideoAspectRatio, VideoResolution } from '@hushbox/shared/models';
import type { ImageModelView, TextModelView, VideoModelView } from './model-view.js';
import type { AIClient, Modality } from './types.js';

// Test-budget ceilings compared against fee-inclusive `ModelView` prices
// (see `model-view.ts`'s fee contract). Choose generous enough thresholds that
// the ~15% fee bump from raw → fee-inclusive doesn't shift which model the
// picker selects in practice.
const MAX_TEST_TOKEN_PRICE_FEE_INCLUSIVE = 0.000_01;
const MAX_TEST_IMAGE_PRICE_FEE_INCLUSIVE = 0.05;
const MAX_TEST_VIDEO_PRICE_PER_SECOND_FEE_INCLUSIVE = 0.2;

export interface TextTestParameters {
  kind: 'text';
  maxOutputTokens: number;
}
export interface ImageTestParameters {
  kind: 'image';
  aspectRatio: ImageAspectRatio;
}
export interface VideoTestParameters {
  kind: 'video';
  duration: number;
  resolution: VideoResolution;
  /** Populated by the capability-aware picker in a follow-up step. */
  aspectRatio?: VideoAspectRatio;
}
export type TestParameters = TextTestParameters | ImageTestParameters | VideoTestParameters;

export interface TestModelSpec {
  modelId: string;
  parameters: TestParameters;
}

const cachedSpecs = new Map<Modality, TestModelSpec>();

export function clearTestModelCache(): void {
  cachedSpecs.clear();
}

/**
 * Returns the cheapest paid model for the modality, plus the lowest supported
 * parameters drawn from our capability tables. Throws for `audio` (no audio
 * models in scope) and for `image`/`video` when no model satisfies the price
 * ceiling — silent fallbacks would mask pricing data or capability regressions.
 */
export async function getCheapestTestModel(
  client: AIClient,
  modality: Modality
): Promise<TestModelSpec> {
  const cached = cachedSpecs.get(modality);
  if (cached !== undefined) return cached;

  let spec: TestModelSpec;
  switch (modality) {
    case 'text': {
      spec = pickCheapestTextModel(await client.listModelsForModality('text'));
      break;
    }
    case 'image': {
      spec = pickCheapestImageModel(await client.listModelsForModality('image'));
      break;
    }
    case 'video': {
      spec = pickCheapestVideoModel(await client.listModelsForModality('video'));
      break;
    }
    case 'audio': {
      throw new Error('Audio integration tests are not in scope.');
    }
    default: {
      return assertNever(modality);
    }
  }

  cachedSpecs.set(modality, spec);
  return spec;
}

function pickCheapestTextModel(candidates: readonly TextModelView[]): TestModelSpec {
  // Exclude premium models — tests should run against a value model so a
  // single misconfiguration can't burn through credit on Opus or Sonnet.
  const paidNonPremium = candidates.filter(
    (m) => !m.isPremium && m.inputPerToken > 0 && m.outputPerToken > 0
  );
  const sortedAll = paidNonPremium.toSorted(
    (a, b) => a.inputPerToken + a.outputPerToken - (b.inputPerToken + b.outputPerToken)
  );
  const withinThreshold = sortedAll.find(
    (m) =>
      m.inputPerToken <= MAX_TEST_TOKEN_PRICE_FEE_INCLUSIVE &&
      m.outputPerToken <= MAX_TEST_TOKEN_PRICE_FEE_INCLUSIVE
  );
  const cheapest = withinThreshold ?? sortedAll[0];
  if (cheapest === undefined) {
    throw new Error('No paid non-premium text model available.');
  }
  return { modelId: cheapest.id, parameters: { kind: 'text', maxOutputTokens: 2048 } };
}

function pickCheapestImageModel(candidates: readonly ImageModelView[]): TestModelSpec {
  // Require capability data — otherwise we don't know which aspect ratio the
  // model accepts and a silent default risks a gateway 400.
  const withCapability = candidates.filter(
    (m) =>
      m.supportedAspectRatios !== undefined &&
      m.supportedAspectRatios.length > 0 &&
      m.perImage > 0 &&
      m.perImage <= MAX_TEST_IMAGE_PRICE_FEE_INCLUSIVE
  );
  const sorted = withCapability.toSorted((a, b) => a.perImage - b.perImage);
  const cheapest = sorted[0];
  const firstAspectRatio = cheapest?.supportedAspectRatios?.[0];
  if (cheapest === undefined || firstAspectRatio === undefined) {
    throw new Error(
      'No image model with capability data found within MAX_TEST_IMAGE_PRICE_FEE_INCLUSIVE.'
    );
  }
  return {
    modelId: cheapest.id,
    parameters: { kind: 'image', aspectRatio: firstAspectRatio },
  };
}

interface VideoCandidate {
  model: VideoModelView;
  resolution: VideoResolution;
  duration: number;
  aspectRatio: VideoAspectRatio;
  totalCost: number;
}

function videoCandidatesFrom(model: VideoModelView): VideoCandidate[] {
  if (
    model.supportedResolutions === undefined ||
    model.supportedDurationsSeconds === undefined ||
    model.supportedAspectRatios === undefined ||
    model.supportedAspectRatios.length === 0
  ) {
    return [];
  }
  const minDuration = Math.min(...model.supportedDurationsSeconds);
  const aspectRatio = model.supportedAspectRatios[0];
  // The guard above already rejected `length === 0`, so `aspectRatio` is
  // defined at this point — but TypeScript's array-index narrowing doesn't
  // see through the prior `.length === 0` check. Re-check explicitly so a
  // future capability table edit that violates the invariant fails loudly.
  if (aspectRatio === undefined) return [];
  const candidates: VideoCandidate[] = [];
  for (const resolution of model.supportedResolutions) {
    const pricePerSecond = model.perSecondByResolution[resolution];
    if (pricePerSecond === undefined || pricePerSecond <= 0) continue;
    if (pricePerSecond > MAX_TEST_VIDEO_PRICE_PER_SECOND_FEE_INCLUSIVE) continue;
    candidates.push({
      model,
      resolution,
      duration: minDuration,
      aspectRatio,
      totalCost: pricePerSecond * minDuration,
    });
  }
  return candidates;
}

function pickCheapestVideoModel(candidates: readonly VideoModelView[]): TestModelSpec {
  // Score by total call cost (pricePerSecond × min-duration) — a marginally
  // pricier-per-second model with a shorter min-duration can be cheaper per
  // call. Veo 3.1's 4s minimum beats Veo 3.0's 5s minimum at parity pricing.
  const allEntries = candidates.flatMap((m) => videoCandidatesFrom(m));
  const sorted = allEntries.toSorted((a, b) => a.totalCost - b.totalCost);
  const cheapest = sorted[0];
  if (cheapest === undefined) {
    throw new Error(
      'No video model with capability data found within MAX_TEST_VIDEO_PRICE_PER_SECOND_FEE_INCLUSIVE.'
    );
  }
  return {
    modelId: cheapest.model.id,
    parameters: {
      kind: 'video',
      duration: cheapest.duration,
      resolution: cheapest.resolution,
      aspectRatio: cheapest.aspectRatio,
    },
  };
}
