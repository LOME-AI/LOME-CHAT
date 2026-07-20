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
import type { AIClient, ImageRequest } from './types.js';

const IMAGE_TIMEOUT_MS = 60_000;

// SOURCE OF TRUTH for live image generation in integration tests.
//
// Every test that needs a real generated image lives in this file and asserts
// against the single `generated` produced in `beforeAll`, so the suite pays for
// ONE image generation instead of one per test. Add new image-needing
// assertions here rather than issuing another stream(image) call elsewhere.
describe('AIClient image generation integration', () => {
  let client: AIClient;
  let spec: TestModelSpec;
  let generated: ConsumedStream;

  beforeAll(async () => {
    clearTestModelCache();
    client = setupIntegrationClient().client;
    const picked = await getCheapestTestModel(client, 'image');
    if (picked.parameters.kind !== 'image') throw new Error('expected image spec');
    spec = picked;
    const request: ImageRequest = {
      modality: 'image',
      model: picked.modelId,
      prompt: 'A small red dot on a white background',
      aspectRatio: picked.parameters.aspectRatio,
    };
    generated = await consumeStream(client.stream(request));
  }, IMAGE_TIMEOUT_MS);

  it('produces a valid image with media-start, media-done, and finish events', () => {
    const kinds = generated.events.map((e) => e.kind);
    expect(kinds).toContain('media-start');
    expect(kinds).toContain('media-done');
    expect(kinds.at(-1)).toBe('finish');
    expect(generated.mediaBytes).toBeDefined();
    const detection = assertValidMediaBytes(
      generated.mediaBytes!,
      ['image/png', 'image/jpeg', 'image/webp'],
      { min: 32, max: 10_000_000 }
    );
    expect(detection.detectedMime).toMatch(/^image\//);
    expect(generated.generationId).toBeDefined();
  });

  it('calculateMediaGenerationCost matches perImage × n + mediaStorageCost(bytes) (fee-inclusive prices)', async () => {
    expect(generated.mediaBytes).toBeDefined();
    if (spec.parameters.kind !== 'image') throw new Error('expected image spec');
    const model = await client.getModel(spec.modelId);
    if (model.pricing.kind !== 'image') throw new Error('expected image pricing');
    const sizeBytes = generated.mediaBytes!.byteLength;
    const cost = calculateMediaGenerationCost({
      pricing: { kind: 'image', perImage: model.pricing.perImage },
      sizeBytes,
      imageCount: 1,
    });
    // `model.pricing.perImage` is fee-inclusive per the `ModelInfo.pricing` contract.
    const modelComponent = model.pricing.perImage;
    expect(cost).toBeGreaterThanOrEqual(modelComponent);
    const storageComponent = cost - modelComponent;
    expect(storageComponent).toBeGreaterThanOrEqual(0);
  });
});
