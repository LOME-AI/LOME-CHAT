import { createBaseConfig, reactConfig, testConfig, prettierConfig } from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'src/routeTree.gen.ts',
      'dist-ota/**',
      'android/**',
      '!android/**/*.test.ts',
      'ios/**',
      '!ios/**/*.test.ts',
    ],
  },
  ...createBaseConfig(import.meta.dirname),
  {
    files: ['ios/**/*.test.ts', 'android/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'ios/App/App.xcodeproj/project.pbxproj.test.ts',
            'ios/App/App/PrivacyInfo.test.ts',
            'ios/App/App/App.entitlements.test.ts',
            'ios/fastlane/Fastfile.test.ts',
            'android/app/src/main/AndroidManifest.test.ts',
            'android/fastlane/Fastfile.test.ts',
          ],
        },
      },
    },
  },
  ...reactConfig,
  ...testConfig,
  {
    // Server state must flow through TanStack Query hooks wrapping the typed
    // api-client. Raw fetch() is invisible to useIsMutating, which makes the
    // settled-aware E2E harness fire its grace timer mid-mutation and throw
    // false negatives (see auth-mutations.ts for the migration template).
    //
    // The allowlist covers files that legitimately can't use TanStack:
    //   - api-client.ts / sse-client.ts: the wrappers themselves
    //   - use-chat-stream.ts: SSE streaming, has its own activity store
    //   - use-decrypt-blob.ts: direct R2 download URL, not an API endpoint
    //   - auth-client.ts: legacy OPAQUE flow, migrate via the auth-mutations.ts pattern
    //   - recovery-phrase-modal.tsx: same legacy migration path
    //   - dev.personas.tsx: dev-only feature
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/lib/api-client.ts',
      'src/lib/sse-client.ts',
      'src/lib/auth-client.ts',
      'src/hooks/chat/use-chat-stream.ts',
      'src/hooks/crypto/use-decrypt-blob.ts',
      'src/components/auth/recovery-phrase-modal.tsx',
      'src/routes/dev.personas.tsx',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      // Both restrictions in one rule body — ESLint's no-restricted-globals
      // doesn't merge across config blocks, so listing only `fetch` here
      // would silently disable the requestAnimationFrame check from the base
      // config (see packages/config/eslint.config.js).
      'no-restricted-globals': [
        'error',
        {
          name: 'requestAnimationFrame',
          message:
            'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
        },
        {
          name: 'fetch',
          message:
            'Use TanStack Query hooks wrapping the typed api-client (see hooks/auth-mutations.ts). Raw fetch() is invisible to useIsMutating and breaks the settled-aware E2E harness.',
        },
      ],
    },
  },
  prettierConfig,
];
