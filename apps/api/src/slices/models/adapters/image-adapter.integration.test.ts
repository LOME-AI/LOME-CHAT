import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SHOULD_RUN,
  consume,
  finishMetadata,
  imageDescriptor,
  imageRequest,
  makeMediaCapture,
  setupRealProvider,
} from './integration-setup.js';
import type { Database } from '@hushbox/db';
import type { ModelProvider } from '../ports/index.js';

const IMAGE_TIMEOUT_MS = 60_000;

/**
 * REAL image inference through the {@link setupRealProvider} factory path.
 * CI-vitest only (skips locally). Records `openrouter` evidence via the factory
 * wrapper. Image emits no inline cost — settlement uses the deterministic
 * estimate — so only structural media invariants are asserted.
 */
describe.skipIf(!SHOULD_RUN)('image adapter — real OpenRouter inference', () => {
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
    'generates an image emitting media-start, media-done, and a terminal finish',
    { timeout: IMAGE_TIMEOUT_MS },
    async () => {
      const capture = makeMediaCapture('image');
      const events = await consume(
        provider.infer(imageRequest(), imageDescriptor(), { mapFilePart: capture.mapFilePart })
      );

      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('media-start');
      expect(kinds).toContain('media-done');

      const metadata = finishMetadata(events);
      expect(metadata.finishReason).toBe('stop');

      expect(capture.captured.length).toBeGreaterThan(0);
      expect(capture.captured[0]?.byteLength ?? 0).toBeGreaterThan(0);
    }
  );
});
