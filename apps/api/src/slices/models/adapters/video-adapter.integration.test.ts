import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SHOULD_RUN,
  consume,
  finishMetadata,
  makeMediaCapture,
  setupRealProvider,
  videoDescriptor,
  videoRequest,
} from './integration-setup.js';
import type { Database } from '@hushbox/db';
import type { ModelProvider } from '../ports/index.js';

const VIDEO_TIMEOUT_MS = 300_000;

/**
 * REAL video inference through the {@link setupRealProvider} factory path
 * (submit → poll → download inside the video adapter). CI-vitest only (skips
 * locally). Records `openrouter` evidence via the factory wrapper. Video carries
 * an inline cost and a generation id on the completed poll, so both are asserted.
 */
describe.skipIf(!SHOULD_RUN)('video adapter — real OpenRouter inference', () => {
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
      expect(capture.captured[0]?.byteLength ?? 0).toBeGreaterThan(0);
    }
  );
});
