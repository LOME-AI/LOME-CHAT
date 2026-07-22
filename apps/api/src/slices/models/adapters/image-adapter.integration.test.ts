import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  finishMetadata,
  imageDescriptor,
  imageRequest,
  makeMediaCapture,
  setupIntegrationProvider,
} from './integration-setup.js';
import { assertValidMediaBytes } from './media-assertions.js';
import type { ModelProvider } from '../ports/index.js';

const IMAGE_TIMEOUT_MS = 60_000;

/**
 * Image inference through the {@link setupIntegrationProvider} env derivation:
 * the deterministic mock locally (a real decodable PNG), real OpenRouter with
 * record-on-miss cassettes in CI-vitest (evidence recorded via the factory
 * wrapper). Image emits no inline cost — settlement uses the deterministic
 * estimate — so only structural media invariants are asserted; the same
 * provider-agnostic bodies run everywhere, no skips.
 */
describe('image adapter — provider inference', () => {
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
      const bytes = capture.captured[0];
      if (bytes === undefined) throw new Error('expected captured image bytes');
      // Magic-byte + size-bound validation (bounds ported from the legacy
      // image integration suite): the provider must return decodable
      // PNG/JPEG/WebP bytes, not merely a non-empty buffer.
      assertValidMediaBytes(bytes, ['image/png', 'image/jpeg', 'image/webp'], {
        min: 32,
        max: 10_000_000,
      });
    }
  );
});
