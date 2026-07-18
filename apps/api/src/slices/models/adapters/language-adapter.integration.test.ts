import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SHOULD_RUN,
  consume,
  finishMetadata,
  languageDescriptor,
  languageRequest,
  setupRealProvider,
} from './integration-setup.js';
import type { Database } from '@hushbox/db';
import type { ModelProvider } from '../ports/index.js';

const TEXT_TIMEOUT_MS = 30_000;

/**
 * REAL language inference through the {@link setupRealProvider} factory path.
 * CI-vitest only (skips locally — see `integration-setup.ts`). The factory's
 * evidence wrapper records `openrouter` service-evidence on the first event,
 * so `verify:evidence --require=openrouter` has a row to assert.
 */
describe.skipIf(!SHOULD_RUN)('language adapter — real OpenRouter inference', () => {
  let provider: ModelProvider;
  let db: Database;

  beforeAll(() => {
    const setup = setupRealProvider();
    provider = setup.provider;
    db = setup.db;
  });

  afterAll(async () => {
    await db.$client.end();
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
});
