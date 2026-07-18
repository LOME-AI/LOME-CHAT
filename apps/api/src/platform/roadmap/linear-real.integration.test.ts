import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  recordServiceEvidence,
  SERVICE_NAMES,
  type Database,
} from '@hushbox/db';
import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRealLinearClient } from './linear-real.js';

/**
 * Real Linear GraphQL integration test. Runs only when `LINEAR_API_KEY_READ`
 * is present — CI Vitest injects it from the GitHub Secret; local dev never
 * has the key (the mock client is used everywhere), so this skips locally.
 * The fully fetch-mocked unit test lives in `linear-real.test.ts`; this file
 * is the real-path test that both catches Linear schema drift against the live
 * API and records `SERVICE_NAMES.LINEAR` evidence so
 * `pnpm verify:evidence --require=linear` passes in the CI vitest job.
 *
 * A missing key in CI does not fail here — it skips — but CI's `verify:evidence`
 * step then fails loudly on the absent evidence row, which is the real guard.
 */

function readEnv(): EnvContext {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
  };
}

const apiKey = process.env['LINEAR_API_KEY_READ'];
const shouldRun = apiKey !== undefined && apiKey.length > 0;

describe.skipIf(!shouldRun)('createRealLinearClient — real Linear', () => {
  let db: Database;
  let isCI: boolean;

  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error(
        'DATABASE_URL is required for Linear integration tests — envConfig sets it in CI Vitest; verify the env-generation step ran.'
      );
    }
    db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
    isCI = createEnvUtilities(readEnv()).isCI;
  });

  it(
    'fetches the HushBox team roadmap and returns a parsable response',
    { timeout: 30_000 },
    async () => {
      if (apiKey === undefined) throw new Error('unreachable');
      const client = createRealLinearClient(apiKey);
      const data = await client.fetchRoadmap('HUS');

      // The workspace evolves, so assert the response shape and at least one
      // piece of meaningful data rather than exact counts.
      expect(data).toHaveProperty('projects');
      expect(data).toHaveProperty('issues');
      expect(Array.isArray(data.projects)).toBe(true);
      expect(Array.isArray(data.issues)).toBe(true);

      // In the HushBox workspace there should be at least one tagged issue. If
      // this trips, either the workspace is empty (highly unlikely) or the
      // GraphQL query/filter broke.
      expect(data.issues.length).toBeGreaterThan(0);

      const sample = data.issues[0];
      expect(sample).toBeDefined();
      if (sample) {
        expect(typeof sample.id).toBe('string');
        expect(sample.id.length).toBeGreaterThan(0);
        expect(typeof sample.title).toBe('string');
        expect(['unstarted', 'started', 'completed', 'backlog']).toContain(sample.stateType);
        expect(Array.isArray(sample.labelNames)).toBe(true);
      }

      // Record evidence (only after the real call succeeded) so
      // verify:evidence --require=linear succeeds in CI. No-op when isCI=false.
      await recordServiceEvidence(db, isCI, SERVICE_NAMES.LINEAR, {
        projectCount: data.projects.length,
        issueCount: data.issues.length,
      });
    }
  );
});
