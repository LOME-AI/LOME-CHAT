/**
 * `pnpm catalog:refresh` — populate `model_catalog` from OpenRouter's live,
 * public metadata endpoints.
 *
 * This runs the SAME real `refreshCatalog` job the hourly production cron runs
 * (a live `globalThis.fetch` against OpenRouter's unauthenticated `/models`,
 * `/endpoints/zdr`, `/images/models`, `/videos/models`) — there are no pinned
 * or hand-authored descriptors. The cron does not fire under `wrangler dev`, so
 * local dev and E2E would otherwise start with an empty catalog; this script is
 * the dedicated dev-startup / `e2e:prepare` step that fills it with real data.
 *
 * Fail-loud by design: an unreachable endpoint or a failed refresh exits
 * non-zero. With `--require-e2e-models`, it additionally asserts every
 * `E2E_MODELS` id is present in the freshly-refreshed catalog (E2E passes the
 * flag; plain `pnpm dev` / `pnpm catalog:refresh` does not, so local dev just
 * gets a live catalog without the E2E-specific gate).
 */
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { OPENROUTER_BASE_URL, createConsoleTelemetry, refreshCatalog } from '@hushbox/api/dev-seed';
import { assertE2eModelsPresent } from './lib/e2e-models.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { assertLocalDatabaseUrl } from './seed.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`catalog:refresh: ${name} is required (run pnpm generate:env)`);
  }
  return value;
}

export async function runRefreshCatalog(requireE2eModels: boolean): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  assertLocalDatabaseUrl(databaseUrl);
  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  try {
    const result = await refreshCatalog({
      db,
      fetch: globalThis.fetch.bind(globalThis),
      gatewayBaseUrl: OPENROUTER_BASE_URL,
      telemetry: createConsoleTelemetry(),
      now: () => new Date(),
    });
    if (result.isErr()) {
      throw new Error(`catalog:refresh: refresh failed — ${result.error.message}`);
    }
    const summary = result.value;
    console.log(
      `catalog:refresh: ${summary.discovered.toString()} discovered, ` +
        `${summary.written.toString()} written, ${summary.unchanged.toString()} unchanged, ` +
        `${summary.excluded.toString()} excluded.`
    );
    if (requireE2eModels) {
      await assertE2eModelsPresent(db);
      console.log('catalog:refresh: all E2E_MODELS present in the live catalog.');
    }
  } finally {
    await db.$client.end();
  }
}

/* v8 ignore start -- CLI wiring; the guard + refresh are tested/proven elsewhere */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    await runRefreshCatalog(process.argv.slice(2).includes('--require-e2e-models'));
  });
}
/* v8 ignore stop */
