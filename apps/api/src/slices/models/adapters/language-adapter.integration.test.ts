import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  finishMetadata,
  languageDescriptor,
  languageRequest,
  reasoningBudgetDescriptor,
  reasoningBudgetRequest,
  reasoningEffortDescriptor,
  reasoningEffortRequest,
  reasoningOffRequest,
  setupIntegrationProvider,
} from './integration-setup.js';
import type { InferenceEvent } from '@hushbox/shared';
import type { ModelProvider } from '../ports/index.js';

const TEXT_TIMEOUT_MS = 30_000;
/** Reasoning turns generate thinking tokens ahead of the answer — slower. */
const REASONING_TIMEOUT_MS = 60_000;

function reasoningTextOf(events: readonly InferenceEvent[]): string {
  return events
    .filter((event) => event.kind === 'reasoning-delta')
    .map((event) => event.content)
    .join('');
}

function answerTextOf(events: readonly InferenceEvent[]): string {
  return events
    .filter((event) => event.kind === 'text-delta')
    .map((event) => event.content)
    .join('');
}

/**
 * Language inference through the {@link setupIntegrationProvider} env
 * derivation: the deterministic mock locally, real OpenRouter with
 * record-on-miss cassettes in CI-vitest (where the factory's evidence wrapper
 * records `openrouter` service-evidence on the first event, so
 * `verify:evidence --require=openrouter` has a row to assert). The assertions
 * are provider-agnostic — the same bodies run everywhere, no skips.
 */
describe('language adapter — provider inference', () => {
  let provider: ModelProvider;
  let teardown: () => Promise<void>;

  beforeAll(() => {
    const setup = setupIntegrationProvider();
    provider = setup.provider;
    teardown = setup.teardown;
  });

  afterAll(async () => {
    await teardown();
  });

  it(
    'streams text content and a terminal finish carrying a generation id',
    { timeout: TEXT_TIMEOUT_MS },
    async () => {
      const events = await consume(provider.infer(languageRequest(), languageDescriptor()));

      const text = events
        .filter((event) => event.kind === 'text-delta')
        .map((event) => event.content)
        .join('');
      expect(text.length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.generationId).toBeDefined();
      expect(metadata.generationId?.length ?? 0).toBeGreaterThan(0);
      expect(metadata.usage.outputTokens).toBeGreaterThan(0);
    }
  );

  it(
    'streams reasoning deltas and bills reasoning tokens for an effort-native reasoning config',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider.infer(reasoningEffortRequest(), reasoningEffortDescriptor())
      );

      expect(reasoningTextOf(events).length).toBeGreaterThan(0);
      expect(answerTextOf(events).length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
      expect(metadata.providerCostUsd ?? 0).toBeGreaterThan(0);
    }
  );

  it(
    'streams reasoning deltas and bills reasoning tokens for a budget-native reasoning config',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider.infer(reasoningBudgetRequest(), reasoningBudgetDescriptor())
      );

      expect(reasoningTextOf(events).length).toBeGreaterThan(0);
      expect(answerTextOf(events).length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
      expect(metadata.providerCostUsd ?? 0).toBeGreaterThan(0);
    }
  );

  it(
    'suppresses reasoning under the explicit hard-off wire on a reasoning-capable model',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider.infer(reasoningOffRequest(), reasoningEffortDescriptor())
      );

      expect(reasoningTextOf(events)).toBe('');
      expect(answerTextOf(events).length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.usage.reasoningTokens ?? 0).toBe(0);
    }
  );
});
