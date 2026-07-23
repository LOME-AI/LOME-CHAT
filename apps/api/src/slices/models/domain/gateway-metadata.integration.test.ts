import path from 'node:path';
import { LOCAL_NEON_DEV_CONFIG, SERVICE_NAMES, createDb, recordServiceEvidence } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCassetteFetch } from '../adapters/cassette/recording-fetch.js';
import { createCassetteStore } from '../adapters/cassette/cassette-store.js';
import { cassetteModeFor } from '../adapters/cassette/mode.js';
import { OPENROUTER_BASE_URL } from '../adapters/openrouter-provider.js';
import { SHOULD_RUN, processEnvContext } from '../adapters/integration-setup.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import type { Database } from '@hushbox/db';
import type { EnvUtilities } from '@hushbox/shared';

/**
 * REAL catalog-metadata integration — legacy parity for the catalog / pricing /
 * ZDR coverage the legacy `real.integration.test.ts` carried. It fetches
 * OpenRouter's live catalog through the record-on-miss HTTP cassette and records
 * `openrouter` service-evidence for `verify:evidence`.
 *
 * CI-vitest only — the live catalog has no local mock, so this suite keeps its
 * skip. The gate is the harness's shared `SHOULD_RUN` (one `createEnvUtilities`
 * derivation, `deriveCiVitestGate` — never raw CI/E2E sniffing), so a CI-shaped
 * local shell cannot reach the real fetch. Db / cassette construction happens
 * inside `beforeAll`, so a skipped run never touches either. In CI-vitest the
 * real fetch + evidence run against `OPENROUTER_API_KEY_RESTRICTED`.
 */

/** Same cassette root as the adapters' real provider path, so recordings are
 * shared across the CI cache (`../../.ai-cassettes` from the api cwd). */
const CASSETTE_ROOT = path.resolve(process.cwd(), '../../.ai-cassettes');

const RAW_DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!SHOULD_RUN)('fetchGatewayCatalog live integration', () => {
  let db: Database;
  let envUtilities: EnvUtilities;
  let cassetteFetch: typeof globalThis.fetch;

  beforeAll(() => {
    // SHOULD_RUN guarantees these; assert for the non-null narrowing.
    if (RAW_DATABASE_URL === undefined) throw new Error('DATABASE_URL is required in CI-vitest');
    envUtilities = createEnvUtilities(processEnvContext());
    db = createDb(RAW_DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    cassetteFetch = createCassetteFetch({
      store: createCassetteStore({ rootDir: CASSETTE_ROOT }),
      mode: cassetteModeFor(),
      realFetch: globalThis.fetch.bind(globalThis),
    });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('discovers the live catalog with loose structural invariants and records evidence', async () => {
    const result = await fetchGatewayCatalog({
      baseUrl: OPENROUTER_BASE_URL,
      fetch: cassetteFetch,
    });
    expect(result.isOk()).toBe(true);
    const catalog = result._unsafeUnwrap();

    // Loose invariants only — exact catalog contents drift constantly.
    expect(catalog.models.length).toBeGreaterThan(0);
    for (const model of catalog.models) {
      expect(['language', 'image', 'video']).toContain(model.source);
    }
    expect(catalog.zdrModelIds.size).toBeGreaterThan(0);
    expect(catalog.models.some((model) => model.source === 'language')).toBe(true);
    expect(
      catalog.models.some((model) => model.source === 'image' || model.source === 'video')
    ).toBe(true);

    // Last, only after every assertion passed: the real fetch succeeded.
    await recordServiceEvidence(db, envUtilities.isCI, SERVICE_NAMES.OPENROUTER);
  });
});
