import { describe, it, expect, beforeAll } from 'vitest';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  recordServiceEvidence,
  SERVICE_NAMES,
  type Database,
} from '@hushbox/db';
import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createRealLinearClient } from './real.js';

/**
 * Real Linear GraphQL integration test. Runs in CI Vitest mode only — env
 * config (`Mode.CiVitest`) injects `LINEAR_API_KEY_READ` from the
 * `LINEAR_API_KEY_READ` GitHub Secret. Local dev never has the key (the
 * mock client is used everywhere), so the test silently skips there.
 *
 * Catches schema drift in Linear's GraphQL API before it reaches
 * production: the marketing roadmap page would silently break the next
 * time someone visits it. This test fails loudly instead.
 */

function readEnv(): EnvContext {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
  };
}

const apiKey = process.env['LINEAR_API_KEY_READ'];
const env = readEnv();
const { isLocalDev, isCI, isE2E } = createEnvUtilities(env);

// In CI Vitest mode the secret must be present. If it isn't, that's an env-
// generation bug — fail loudly instead of silently skipping.
if (isCI && !isE2E && (apiKey === undefined || apiKey.length === 0)) {
  throw new Error(
    'LINEAR_API_KEY_READ is required in CI Vitest mode. Check envConfig + GitHub Secrets.'
  );
}

const shouldRun = apiKey !== undefined && apiKey.length > 0 && !isLocalDev && !isE2E;

describe.skipIf(!shouldRun)('createRealLinearClient — real Linear', () => {
  let db: Database;

  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error(
        'DATABASE_URL is required for Linear integration tests — envConfig sets it in CI Vitest; verify the env-generation step ran.'
      );
    }
    db = createDb({ connectionString: databaseUrl, neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  it(
    'fetches the HushBox team roadmap and returns a parsable response',
    { timeout: 30_000 },
    async () => {
      if (apiKey === undefined) throw new Error('unreachable');
      const client = createRealLinearClient(apiKey);
      const data = await client.fetchRoadmap('HUS');

      // We can't assert exact counts because the workspace evolves. Assert
      // the response shape and at least one piece of meaningful data.
      expect(data).toHaveProperty('projects');
      expect(data).toHaveProperty('issues');
      expect(Array.isArray(data.projects)).toBe(true);
      expect(Array.isArray(data.issues)).toBe(true);

      // Sanity check: in our HushBox workspace there should be at least one
      // tagged issue. If this trips, either the workspace is empty (highly
      // unlikely) or the GraphQL query/filter broke.
      expect(data.issues.length).toBeGreaterThan(0);

      // Validate issue fields conform to our internal contract.
      const sample = data.issues[0];
      expect(sample).toBeDefined();
      if (sample) {
        expect(typeof sample.id).toBe('string');
        expect(sample.id.length).toBeGreaterThan(0);
        expect(typeof sample.title).toBe('string');
        expect(['unstarted', 'started', 'completed', 'backlog']).toContain(sample.stateType);
        expect(Array.isArray(sample.labelNames)).toBe(true);
      }

      // Record evidence so verify:evidence --require=linear succeeds in CI.
      await recordServiceEvidence(db, isCI, SERVICE_NAMES.LINEAR, {
        projectCount: data.projects.length,
        issueCount: data.issues.length,
      });
    }
  );
});
