import path from 'node:path';
import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';
import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { getAIClient } from './index.js';
import type { AIClient } from './types.js';

/**
 * Filesystem root for HTTP cassettes. CI restores/saves this directory via
 * `actions/cache@v4`; locally it's `.gitignore`d. See `docs/CI-CASSETTES.md`.
 */
const CASSETTE_ROOT = path.resolve(process.cwd(), '../../.ai-cassettes');

export interface IntegrationClientSetup {
  client: AIClient;
  db: Database | null;
  isMock: boolean;
}

interface IntegrationEnv extends EnvContext {
  AI_GATEWAY_API_KEY?: string;
  PUBLIC_MODELS_URL?: string;
}

function readEnvFromProcess(): IntegrationEnv {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    // Vitest sets VITEST in its process; forwarding it lets `isDevServer` stay
    // false under a local integration run (NODE_ENV stays 'development'), so the
    // dev-server-only mock delays don't slow the suite.
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
    ...(process.env['AI_GATEWAY_API_KEY'] !== undefined && {
      AI_GATEWAY_API_KEY: process.env['AI_GATEWAY_API_KEY'],
    }),
    ...(process.env['PUBLIC_MODELS_URL'] !== undefined && {
      PUBLIC_MODELS_URL: process.env['PUBLIC_MODELS_URL'],
    }),
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      'DATABASE_URL is required for AI integration tests in CI — envConfig (mode `ciVitest`) sets it; verify the env-generation step ran.'
    );
  }
  return databaseUrl;
}

function buildCassetteFetch(): typeof globalThis.fetch {
  const store = createCassetteStore({ rootDir: CASSETTE_ROOT });
  return createCassetteFetch({
    store,
    realFetch: globalThis.fetch.bind(globalThis),
  });
}

/**
 * Delegates to the production `getAIClient` factory so test integration uses
 * the same env-branching as production code — no parallel reimplementation
 * to drift against. envConfig (mode `ciVitest`) guarantees AI_GATEWAY_API_KEY,
 * PUBLIC_MODELS_URL, and DATABASE_URL are present; `verify:env --mode=ciVitest`
 * runs before tests and fails fast on missing vars, so this code trusts the
 * contract rather than re-checking each variable's existence.
 *
 * Local dev returns the mock client. CI vitest returns the real client wired
 * with: (1) evidence recording so `verify:evidence --require=ai-gateway` has
 * something to assert against; (2) an HTTP cassette layer that records real
 * gateway calls on first run and replays them on subsequent runs from the GH
 * Actions cache. The cassette is engaged ONLY in `isCiVitest` (= isCI &&
 * !isE2E); the E2E job uses the mock client via `getAIClient`'s built-in
 * E2E branch and never reaches this code path with isE2E=true.
 */
export function setupIntegrationClient(): IntegrationClientSetup {
  const env = readEnvFromProcess();
  const envUtilities = createEnvUtilities(env);

  if (envUtilities.isLocalDev) {
    return { client: getAIClient(env), db: null, isMock: true };
  }

  const db = createDb({
    connectionString: requireDatabaseUrl(),
    neonDev: LOCAL_NEON_DEV_CONFIG,
  });
  const evidence = { db, isCI: envUtilities.isCI };

  // isCiVitest = isCI && !isE2E. Only the vitest integration job both has
  // AI_GATEWAY_API_KEY set and needs real-call behavior; the e2e job goes
  // through the mock path inside getAIClient and never reaches here in
  // practice. Guard explicitly anyway so a future refactor that exposes this
  // factory to E2E doesn't silently turn on cassette recording there.
  const isCiVitest = envUtilities.isCI && !envUtilities.isE2E;
  const client = isCiVitest
    ? getAIClient(env, { evidence, fetch: buildCassetteFetch() })
    : getAIClient(env, { evidence });
  return { client, db, isMock: false };
}
