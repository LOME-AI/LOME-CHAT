import { defineConfig, mergeConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import rootConfig from '@hushbox/config/vitest';

const COVERAGE_GATE = {
  lines: 95,
  branches: 95,
  functions: 95,
  statements: 95,
};

export default mergeConfig(
  rootConfig,
  // defineConfig (not defineProject) because the coverage gate below is a
  // root-level key; the standalone `vitest run --coverage` invocation reads it.
  defineConfig({
    plugins: [react()],
    test: {
      name: 'marketing',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      coverage: {
        // Static inclusion over the real vitest-testable product source: the v8
        // provider only reports files some test imported, so without `include` a
        // never-imported island (e.g. a legal-document component) passes the gate
        // silently. With it, vitest merges unimported matches into the report at
        // 0% and the per-file thresholds below see them. Root-config excludes
        // still apply after `include` (tests, `**/index.ts`, `**/*.config.*`).
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          // Astro SSG surfaces do not execute under vitest — they are build-time
          // templates, not unit-testable here:
          //  - `.astro` files never match the `.ts`/`.tsx` include above.
          //  - The page/endpoint layer (`src/pages/**`) is the route equivalent of
          //    `.astro` pages, run only in the Astro build.
          //  - `blog.ts` / `content.config.ts` import the `astro:content` virtual
          //    module, which only resolves inside the Astro runtime. The pure logic
          //    they wrap lives in `blog-utilities.ts` (covered).
          'src/pages/**',
          'src/lib/blog.ts',
          'src/content.config.ts',
          // Test bootstrap, not product code.
          'src/test-setup.ts',
        ],
        // `perFile` is load-bearing: a glob threshold otherwise compares the
        // AGGREGATE of matching files, where a small 0% island drowns among the
        // covered ones. Per-file plus the static `include` above is what makes a
        // never-imported file actually fail the gate instead of escaping it.
        thresholds: {
          perFile: true,
          'src/**/*.{ts,tsx}': COVERAGE_GATE,
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
  })
);
