import { describe, it, expect, beforeAll } from 'vitest';
import {
  applyFees,
  estimateMessageCostDevelopment,
  estimateTokenCount,
  TOTAL_FEE_RATE,
} from '@hushbox/shared';
import { calculateMessageCost } from '../billing/cost-calculator.js';
import {
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
} from './test-utilities.js';
import type { AIClient, TextRequest } from './types.js';

const TEXT_TIMEOUT_MS = 30_000;
const SANITY_TEXT_MAX_USD = 0.01;
const FEE_MATH_PRECISION = 12;

describe('AIClient billing integration', () => {
  let client: AIClient;

  beforeAll(() => {
    clearTestModelCache();
    const setup = setupIntegrationClient();
    client = setup.client;
  });

  describe('text cost retrieval', () => {
    it(
      'getGenerationStats returns a positive USD cost within sanity bounds',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const inputContent = 'Reply with one short word.';
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: inputContent }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.generationId).toBeDefined();
        const stats = await client.getGenerationStats(result.generationId!);
        expect(stats.costUsd).toBeGreaterThan(0);
        expect(stats.costUsd).toBeLessThan(SANITY_TEXT_MAX_USD);

        // Drift guard: the real path returns the gateway's reported cost, not
        // a dev-mode estimate. If someone accidentally swaps the real
        // `getGenerationStats` call for `estimateMessageCostDevelopment`, the
        // returned number would land on the deterministic estimate and this
        // assertion would fire.
        const model = await client.getModel(spec.modelId);
        if (model.pricing.kind !== 'token') throw new Error('expected token pricing');
        const devEstimate = estimateMessageCostDevelopment({
          inputTokens: estimateTokenCount(inputContent),
          outputTokens: estimateTokenCount(result.textContent),
          inputCharacters: inputContent.length,
          outputCharacters: result.textContent.length,
          pricePerInputToken: model.pricing.inputPerToken,
          pricePerOutputToken: model.pricing.outputPerToken,
        });
        expect(stats.costUsd).not.toBe(devEstimate);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'applyFees(costUsd) equals costUsd × (1 + TOTAL_FEE_RATE)',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Say hi.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        const stats = await client.getGenerationStats(result.generationId!);
        const expected = stats.costUsd * (1 + TOTAL_FEE_RATE);
        expect(applyFees(stats.costUsd)).toBeCloseTo(expected, FEE_MATH_PRECISION);
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('calculateMessageCost end-to-end', () => {
    it(
      'returns applyFees(gatewayCost) + storageCost over input and output characters',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const inputContent = 'Reply with the single word OK.';
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: inputContent }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const stream = await consumeStream(client.stream(request));
        const generationId = stream.generationId!;
        const outputContent = stream.textContent;

        const result = await calculateMessageCost({
          aiClient: client,
          generationId,
          modelId: spec.modelId,
          inputContent,
          outputContent,
        });

        expect(result.totalDollars).toBeGreaterThan(0);
        // CI guardrail: the retry layer must cover the gateway eventual-consistency
        // window. A `true` here means production-style estimation fallback fired in
        // CI, which masks billing inaccuracy — fail loudly.
        expect(result.wasEstimated).toBe(false);
        const stats = await client.getGenerationStats(generationId);
        // calculateMessageCost = applyFees(gateway) + (inputChars + outputChars) * storage
        // The storage component is small but positive, so cost > applyFees(gatewayCost).
        expect(result.totalDollars).toBeGreaterThanOrEqual(applyFees(stats.costUsd));
      },
      TEXT_TIMEOUT_MS
    );
  });
});
