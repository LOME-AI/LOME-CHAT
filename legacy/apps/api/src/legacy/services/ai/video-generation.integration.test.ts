import { describe, it, expect, beforeAll } from 'vitest';
import { calculateMediaGenerationCost } from '@hushbox/shared';
import {
  assertValidMediaBytes,
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
  type ConsumedStream,
  type TestModelSpec,
} from './test-utilities.js';
import type { AIClient, VideoRequest } from './types.js';

const VIDEO_TIMEOUT_MS = 300_000;

// SOURCE OF TRUTH for live video generation in integration tests.
//
// The AI Gateway caps video at one request per minute for balances below $100,
// so the whole suite must generate video AT MOST ONCE. Every test that needs a
// real generated video lives in this file and asserts against the single
// `generated` produced in `beforeAll`. Do NOT add another stream(video) /
// experimental_generateVideo call anywhere else — two live video requests race
// for the single per-minute slot and one fails with a 429.
describe('AIClient video generation integration', () => {
  let client: AIClient;
  let spec: TestModelSpec;
  let generated: ConsumedStream;

  beforeAll(async () => {
    clearTestModelCache();
    client = setupIntegrationClient().client;
    const picked = await getCheapestTestModel(client, 'video');
    if (picked.parameters.kind !== 'video') throw new Error('expected video spec');
    spec = picked;
    const request: VideoRequest = {
      modality: 'video',
      model: picked.modelId,
      prompt: 'A short panning shot of a calm landscape',
      durationSeconds: picked.parameters.duration,
      resolution: picked.parameters.resolution,
      ...(picked.parameters.aspectRatio !== undefined && {
        aspectRatio: picked.parameters.aspectRatio,
      }),
    };
    generated = await consumeStream(client.stream(request));
  }, VIDEO_TIMEOUT_MS);

  it('produces a valid short video with media-start, media-done, and finish events', () => {
    const kinds = generated.events.map((e) => e.kind);
    expect(kinds).toContain('media-start');
    expect(kinds).toContain('media-done');
    expect(kinds.at(-1)).toBe('finish');
    expect(generated.mediaBytes).toBeDefined();
    assertValidMediaBytes(generated.mediaBytes!, ['video/mp4', 'video/webm'], {
      min: 16,
      max: 50_000_000,
    });
    expect(generated.generationId).toBeDefined();
  });

  it('calculateMediaGenerationCost matches perSecond × duration + storage(actualBytes) (fee-inclusive prices)', async () => {
    expect(generated.mediaBytes).toBeDefined();
    if (spec.parameters.kind !== 'video') throw new Error('expected video spec');
    const model = await client.getModel(spec.modelId);
    if (model.pricing.kind !== 'video') throw new Error('expected video pricing');
    const perSecond = model.pricing.perSecondByResolution[spec.parameters.resolution];
    if (perSecond === undefined) {
      throw new Error(`Model ${spec.modelId} missing pricing for ${spec.parameters.resolution}`);
    }
    const sizeBytes = generated.mediaBytes!.byteLength;
    const duration = spec.parameters.duration;

    const cost = calculateMediaGenerationCost({
      pricing: { kind: 'video', perSecond },
      sizeBytes,
      durationSeconds: duration,
    });

    // `perSecond` from `ModelInfo.pricing.perSecondByResolution` is fee-inclusive.
    const expectedModelCost = perSecond * duration;
    expect(cost).toBeGreaterThanOrEqual(expectedModelCost);
  });
});
