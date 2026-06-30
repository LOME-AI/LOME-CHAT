import { testClient } from 'hono/testing';
import { createApp } from '../app.js';
import type { AppType } from '../app.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/**
 * Per-slice API smoke convention: when a slice manifest is mounted in
 * `createApp()`, that change ships with one `<slice>.smoke.test.ts` in this
 * directory. Each spec calls `createSmokeHarness()` and exercises the slice's
 * live routes through `client` — the typed `hc`-style client inferred from
 * `AppType` — so every request traverses the complete default-deny pipeline
 * (env → bindings → session → authorize → idempotency) against the real local
 * dev stack (`pnpm db:up`). Use `app.request(path, init, env)` only for probes
 * the typed client cannot express by design (unknown paths, malformed input).
 *
 * This directory is test tooling: it is deliberately absent from the coverage
 * include globs and must never export production code.
 */
export interface SmokeHarness {
  readonly app: AppType;
  readonly client: ReturnType<typeof testClient<AppType>>;
  readonly env: Bindings & TelemetryEnv;
}

type RequiredHarnessBinding =
  | 'NODE_ENV'
  | 'DATABASE_URL'
  | 'UPSTASH_REDIS_REST_URL'
  | 'UPSTASH_REDIS_REST_TOKEN'
  | 'IRON_SESSION_SECRET'
  | 'TELEMETRY_SINKS';

function readRequiredEnv(name: RequiredHarnessBinding): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `smoke harness: missing ${name}. Run via the package test script ` +
        '(with-env loads apps/api/.dev.vars) with the local dev stack up (pnpm db:up).'
    );
  }
  return value;
}

/** Builds the fully-assembled app with real local bindings + its typed client. */
export function createSmokeHarness(): SmokeHarness {
  const env: Bindings & TelemetryEnv = {
    NODE_ENV: readRequiredEnv('NODE_ENV'),
    DATABASE_URL: readRequiredEnv('DATABASE_URL'),
    UPSTASH_REDIS_REST_URL: readRequiredEnv('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: readRequiredEnv('UPSTASH_REDIS_REST_TOKEN'),
    IRON_SESSION_SECRET: readRequiredEnv('IRON_SESSION_SECRET'),
    TELEMETRY_SINKS: readRequiredEnv('TELEMETRY_SINKS'),
    // Optional EnvContext signals pass through so envUtils classification in
    // the pipeline matches the invoking process (CI vs local vitest).
    ...(process.env['CI'] === undefined ? {} : { CI: process.env['CI'] }),
    ...(process.env['E2E'] === undefined ? {} : { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] === undefined ? {} : { VITEST: process.env['VITEST'] }),
  };
  const app = createApp();
  const client = testClient(app, env);
  return { app, client, env };
}
