// Programmatic ESLint tests for the frontend client-side error/analytics SDK
// ban (reactConfig, no-restricted-imports).
//
// Doctrine "No client-side error/analytics SDKs" was previously enforced only
// by dependency-absence. reactConfig now carries a no-restricted-imports block
// that fails an accidental `@sentry/*` / `posthog-js` / analytics-SDK import at
// its import site. reactConfig composes only into the three frontend surfaces
// (apps/web, apps/marketing, packages/ui), so this never reaches apps/api's
// telemetry adapter, which legitimately imports `@sentry/*`.
//
// The real, exported reactConfig is applied to fixture code, so a pattern that
// stops firing (or the animation ban being silently dropped by the shared
// rule-key replacement) fails here instead of silently shipping. Assertions
// count messages by `ruleId` only; they pin firing behavior, not wording.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { reactConfig } from '../eslint.config.js';

const cwd = path.dirname(fileURLToPath(import.meta.url));

const linter = new ESLint({
  cwd,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    },
    ...reactConfig,
  ],
});

async function restrictedImportCount(code, relativePath = path.join('src', 'fixture.tsx')) {
  const [result] = await linter.lintText(code, { filePath: path.join(cwd, relativePath) });
  return result.messages.filter((message) => message.ruleId === 'no-restricted-imports').length;
}

describe('frontend client-SDK ban', () => {
  it('flags a @sentry/browser import', async () => {
    expect(
      await restrictedImportCount("import * as Sentry from '@sentry/browser';\n")
    ).toBeGreaterThan(0);
  });

  it('flags a @sentry/react import', async () => {
    expect(await restrictedImportCount("import { init } from '@sentry/react';\n")).toBeGreaterThan(
      0
    );
  });

  it('flags a posthog-js import', async () => {
    expect(await restrictedImportCount("import posthog from 'posthog-js';\n")).toBeGreaterThan(0);
  });

  it('flags a mixpanel-browser import', async () => {
    expect(
      await restrictedImportCount("import mixpanel from 'mixpanel-browser';\n")
    ).toBeGreaterThan(0);
  });

  it('flags a @datadog/browser-rum import', async () => {
    expect(
      await restrictedImportCount("import { datadogRum } from '@datadog/browser-rum';\n")
    ).toBeGreaterThan(0);
  });

  it('flags a banned SDK import from a plain .ts module', async () => {
    expect(
      await restrictedImportCount(
        "import posthog from 'posthog-js';\n",
        path.join('src', 'fixture.ts')
      )
    ).toBeGreaterThan(0);
  });

  it('passes a legitimate frontend import', async () => {
    expect(await restrictedImportCount("import { useState } from 'react';\n")).toBe(0);
  });

  it('still bans animation libraries (shared rule key not dropped)', async () => {
    expect(await restrictedImportCount("import gsap from 'gsap';\n")).toBeGreaterThan(0);
  });
});
