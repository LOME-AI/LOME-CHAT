import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_GATEWAY_BASE_URL, catalogFetch } from '../slices/models/domain/gateway-fixtures.js';
import {
  CATALOG_REFRESH_JITTER_MAX_MS,
  createCatalogRefreshEntry,
  productionRefreshJitter,
} from './poller-entries.js';
import type { Telemetry } from '../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for poller entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

afterAll(async () => {
  await db.$client.end();
});

describe('createCatalogRefreshEntry', () => {
  it('runs the catalog refresh against the configured gateway', async () => {
    const sleeps: number[] = [];
    const entry = createCatalogRefreshEntry({
      db,
      telemetry: silentTelemetry,
      now: () => new Date(),
      fetch: catalogFetch({ models: [], zdrModelIds: [] }),
      gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
      jitter: {
        maxMs: CATALOG_REFRESH_JITTER_MAX_MS,
        random: () => 0.5,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    });
    expect(entry.name).toBe('model-catalog-refresh');
    await entry.run();
    // The jitter spreads a fleet of triggers; half of the 60s ceiling here.
    expect(sleeps).toEqual([CATALOG_REFRESH_JITTER_MAX_MS / 2]);
  });

  it('propagates a refresh failure to the entry runner', async () => {
    const entry = createCatalogRefreshEntry({
      db,
      telemetry: silentTelemetry,
      now: () => new Date(),
      fetch: () => Promise.reject(new Error('gateway unreachable')),
      gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
      jitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
    });
    await expect(entry.run()).rejects.toThrow();
  });
});

describe('productionRefreshJitter', () => {
  it('spreads starts across the sixty-second ceiling', async () => {
    const jitter = productionRefreshJitter();
    expect(jitter.maxMs).toBe(60_000);
    const sample = jitter.random();
    expect(sample).toBeGreaterThanOrEqual(0);
    expect(sample).toBeLessThan(1);
    await expect(jitter.sleep(1)).resolves.toBeUndefined();
  });
});
