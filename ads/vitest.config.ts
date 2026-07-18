import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

// The `test` script deliberately omits `--passWithNoTests` (unlike scripts/ and
// ops/, which may legitimately be empty): the ads toolkit is a tested package by
// contract, so a run collecting zero tests is a regression that must fail loudly.
//
// defineConfig (not defineProject): the coverage gate below is a root-level key
// a standalone `vitest run --coverage` reads.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      name: 'ads',
      environment: 'node',
      coverage: {
        // Only the PURE, unit-testable production logic is gated. The Playwright
        // capture driver (phone-capture.ts and each campaign's capture.ts), the
        // ffmpeg encode, and the Remotion compositions (*.tsx) are verified by
        // live run / render, not units, so they are deliberately outside this
        // include set. Static inclusion (like scripts/) forces a never-imported
        // pure module into the report at 0% instead of passing silently. Grow
        // this list as pure helpers (cursor path, coordinate map, timing) land
        // with their tests.
        include: [
          'tools/capture/action-logger.ts',
          'tools/audio/audio-duration.ts',
          'tools/audio/timing-map.ts',
          'tools/media/download.ts',
          'tools/remotion/zoom-transform.ts',
          'tools/remotion/cursor-position.ts',
          'tools/remotion/fade.ts',
          'tools/remotion/caption-emphasis.ts',
          'tools/remotion/music-volume.ts',
          'tools/remotion/ad-spec.ts',
          'tools/remotion/screen-track.ts',
          'tools/capture/mouse-path.ts',
          'tools/capture/encode.ts',
        ],
        thresholds: {
          // perFile so one small under-tested file fails on its own instead of
          // being averaged away across the include set.
          perFile: true,
          'tools/capture/action-logger.ts': COVERAGE_GATE,
          'tools/capture/mouse-path.ts': COVERAGE_GATE,
          'tools/capture/encode.ts': COVERAGE_GATE,
          'tools/audio/audio-duration.ts': COVERAGE_GATE,
          'tools/audio/timing-map.ts': COVERAGE_GATE,
          'tools/media/download.ts': COVERAGE_GATE,
          'tools/remotion/zoom-transform.ts': COVERAGE_GATE,
          'tools/remotion/cursor-position.ts': COVERAGE_GATE,
          'tools/remotion/fade.ts': COVERAGE_GATE,
          'tools/remotion/caption-emphasis.ts': COVERAGE_GATE,
          'tools/remotion/music-volume.ts': COVERAGE_GATE,
          'tools/remotion/ad-spec.ts': COVERAGE_GATE,
          'tools/remotion/screen-track.ts': COVERAGE_GATE,
        },
      },
    },
  })
);
