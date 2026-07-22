import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  finishMetadata,
  makeMediaCapture,
  setupIntegrationProvider,
  videoDescriptor,
  videoRequest,
} from './integration-setup.js';
import { assertValidMediaBytes } from './media-assertions.js';
import type { ModelProvider } from '../ports/index.js';

const VIDEO_TIMEOUT_MS = 300_000;

/**
 * Video inference through the {@link setupIntegrationProvider} env derivation:
 * the deterministic mock locally (a minimal valid MP4), real OpenRouter with
 * record-on-miss cassettes in CI-vitest (submit → poll → download inside the
 * video adapter; evidence recorded via the factory wrapper). Video carries an
 * inline cost and a generation id on its finish, so both are asserted; the
 * same provider-agnostic bodies run everywhere, no skips.
 */
describe('video adapter — provider inference', () => {
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
    'generates a video emitting media-start, media-done, and a finish with cost and generation id',
    { timeout: VIDEO_TIMEOUT_MS },
    async () => {
      const capture = makeMediaCapture('video');
      const events = await consume(
        provider.infer(videoRequest(), videoDescriptor(), { mapFilePart: capture.mapFilePart })
      );

      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('media-start');
      expect(kinds).toContain('media-done');

      const metadata = finishMetadata(events);
      expect(metadata.generationId).toBeDefined();
      expect(metadata.generationId?.length ?? 0).toBeGreaterThan(0);
      expect(metadata.providerCostUsd).toBeDefined();

      expect(capture.captured.length).toBeGreaterThan(0);
      const bytes = capture.captured[0];
      if (bytes === undefined) throw new Error('expected captured video bytes');
      // Magic-byte + size-bound validation (bounds ported from the legacy
      // video integration suite): the provider must return decodable
      // MP4/WebM bytes, not merely a non-empty buffer.
      assertValidMediaBytes(bytes, ['video/mp4', 'video/webm'], {
        min: 16,
        max: 50_000_000,
      });
    }
  );
});
