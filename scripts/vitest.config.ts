import { defineProject, mergeConfig } from 'vitest/config';
import rootConfig from '@hushbox/config/vitest';

export default mergeConfig(
  rootConfig,
  defineProject({
    test: {
      name: 'scripts',
      environment: 'node',
      // legacy_* files are the non-running reference corpus, excluded from
      // every gate until their deletion.
      exclude: ['**/dist/**', '**/node_modules/**', '**/legacy_*'],
    },
  })
);
