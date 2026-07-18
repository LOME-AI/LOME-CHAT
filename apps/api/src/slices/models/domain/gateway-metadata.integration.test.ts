import path from 'node:path';
import { LOCAL_NEON_DEV_CONFIG, SERVICE_NAMES, createDb, recordServiceEvidence } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCassetteFetch } from '../adapters/cassette/recording-fetch.js';
import { createCassetteStore } from '../adapters/cassette/cassette-store.js';
import { cassetteModeFor } from '../adapters/cassette/mode.js';
import { OPENROUTER_BASE_URL } from '../adapters/openrouter-provider.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import type { Database } from '@hushbox/db';
import type { EnvUtilities } from '@hushbox/shared';

/**
 * REAL catalog-metadata integration — legacy parity for the catalog / pricing /
 * ZDR coverage the legacy `real.integration.test.ts` carried. It fetches
 * OpenRouter's live catalog through the record-on-miss HTTP cassette and records
 * `openrouter` service-evidence for `verify:evidence`.
 *
 * CI-vitest only. The gate keys off raw env (`process.env`) because the skip
 * decision is made at collection time, before any `createEnvUtilities` / db /
 * cassette construction — those happen inside `beforeAll` so a local run never
 * makes a real call and never crashes on import. Locally (no CI, dev mock key)
 * the whole suite skips cleanly and stays green; the real fetch + evidence run
 * only in CI-vitest against `OPENROUTER_API_KEY_RESTRICTED`.
 */

/** Mirrors the dev/local `.dev.vars` placeholder — never a recordable real key. */
const DEV_MOCK_OPENROUTER_KEY = 'mock-openrouter-key';

/** Same cassette root as the adapters' real provider path, so recordings are
 * shared across the CI cache (`../../.ai-cassettes` from the api cwd). */
const CASSETTE_ROOT = path.resolve(process.cwd(), '../../.ai-cassettes');

const RAW_KEY = process.env['OPENROUTER_API_KEY'];
const RAW_DATABASE_URL = process.env['DATABASE_URL'];
const IS_CI = Boolean(process.env['CI']);
const IS_E2E = Boolean(process.env['E2E']);
const HAS_REAL_KEY =
  RAW_KEY !== undefined && RAW_KEY.length > 0 && RAW_KEY !== DEV_MOCK_OPENROUTER_KEY;
const HAS_DATABASE = RAW_DATABASE_URL !== undefined && RAW_DATABASE_URL.length > 0;

// CI-vitest = CI && !E2E, with a real (non-mock) key and a db for evidence.
const SHOULD_RUN = IS_CI && !IS_E2E && HAS_REAL_KEY && HAS_DATABASE;

describe.skipIf(!SHOULD_RUN)('fetchGatewayCatalog live integration', () => {
  let db: Database;
  let envUtilities: EnvUtilities;
  let cassetteFetch: typeof globalThis.fetch;

  beforeAll(() => {
    // SHOULD_RUN guarantees these; assert for the non-null narrowing.
    if (RAW_DATABASE_URL === undefined) throw new Error('DATABASE_URL is required in CI-vitest');
    envUtilities = createEnvUtilities({
      ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
      ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
      ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
      ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
    });
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
