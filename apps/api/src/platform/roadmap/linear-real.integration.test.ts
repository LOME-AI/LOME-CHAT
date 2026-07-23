import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  recordServiceEvidence,
  SERVICE_NAMES,
  type Database,
} from '@hushbox/db';
import { createEnvUtilities, type EnvContext, type EnvUtilities } from '@hushbox/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRealLinearClient } from './linear-real.js';

/**
 * Real Linear GraphQL integration test. CI-vitest only — Linear has no local
 * mock client to run these bodies against, so the suite keeps its skip and
 * derives it from `createEnvUtilities` (never raw env sniffing, never key
 * presence alone: a local shell holding the key no longer makes a real call).
 * CI Vitest injects `LINEAR_API_KEY_READ` from the GitHub Secret. The fully
 * fetch-mocked unit test lives in `linear-real.test.ts`; this file is the
 * real-path test that both catches Linear schema drift against the live API
 * and records `SERVICE_NAMES.LINEAR` evidence so
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

/** CI-vitest (CI, not E2E) with the key — the only shell that runs the real call. */
function deriveLinearGate(envUtilities: EnvUtilities, hasKey: boolean): boolean {
  return envUtilities.isCI && !envUtilities.isE2E && hasKey;
}

const apiKey = process.env['LINEAR_API_KEY_READ'];
const HAS_KEY = apiKey !== undefined && apiKey.length > 0;

/** THE one `createEnvUtilities` derivation for this harness (vitest sets NODE_ENV). */
const AMBIENT_ENV = createEnvUtilities(readEnv());

const shouldRun = deriveLinearGate(AMBIENT_ENV, HAS_KEY);

/**
 * Pin for the gate derivation: the real Linear call is reachable only from a
 * CI-vitest shell that also has the key — never from a local shell, however
 * CI-shaped its other vars look (a local key no longer runs the real call).
 */
describe('deriveLinearGate', () => {
  it('refuses a local vitest shell even with the key present', () => {
    expect(
      deriveLinearGate(createEnvUtilities({ NODE_ENV: 'development', VITEST: 'true' }), true)
    ).toBe(false);
  });

  it('refuses a CI-E2E shell', () => {
    expect(
      deriveLinearGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(false);
  });

  it('refuses CI-vitest without the key (skip — verify:evidence is the loud guard)', () => {
    expect(
      deriveLinearGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        false
      )
    ).toBe(false);
  });

  it('admits only CI-vitest with the key', () => {
    expect(
      deriveLinearGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(true);
  });
});

describe.skipIf(!shouldRun)('createRealLinearClient — real Linear', () => {
  let db: Database;

  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error(
        'DATABASE_URL is required for Linear integration tests — envConfig sets it in CI Vitest; verify the env-generation step ran.'
      );
    }
    db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
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
      await recordServiceEvidence(db, AMBIENT_ENV.isCI, SERVICE_NAMES.LINEAR, {
        projectCount: data.projects.length,
        issueCount: data.issues.length,
      });
    }
  );
});
