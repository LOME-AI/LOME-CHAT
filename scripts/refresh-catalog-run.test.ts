import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshSummary } from '@hushbox/api/dev-seed';

// `runRefreshCatalog` drives the real `refreshCatalog` job against a live
// OpenRouter fetch and a local Postgres. Here the DB client, the refresh job,
// and the E2E-model assertion are mocked so the script's orchestration —
// env validation, error propagation, the `--require-e2e-models` gate, and
// connection teardown — is exercised without infrastructure or network.

const endSpy = vi.fn();
const fakeDb = { $client: { end: endSpy } };

const refreshCatalog = vi.fn();
const assertE2eModelsPresent = vi.fn(async () => {});

vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return { ...actual, createDb: vi.fn(() => fakeDb) };
});

vi.mock('@hushbox/api/dev-seed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/api/dev-seed')>();
  return { ...actual, refreshCatalog };
});

vi.mock('./lib/e2e-models.js', () => ({ assertE2eModelsPresent }));

const { runRefreshCatalog } = await import('./refresh-catalog.js');

const SUMMARY: RefreshSummary = {
  discovered: 5,
  written: 5,
  unchanged: 0,
  excluded: 0,
  excludedByReason: {
    'token-priced-image': 0,
    'token-priced-video': 0,
    'megapixel-priced-image': 0,
    'missing-pricing': 0,
    'zero-priced': 0,
    'below-price-floor': 0,
    'too-old': 0,
    deprecated: 0,
    'non-zdr': 0,
    'non-conversational': 0,
    'non-runnable-shape': 0,
    'unclassifiable-modality': 0,
    'missing-release-date': 0,
    'unknown-pricing-unit': 0,
  },
};

let savedDbUrl: string | undefined;

beforeEach(() => {
  savedDbUrl = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = 'postgres://postgres:postgres@localhost:5432/hushbox';
  vi.clearAllMocks();
  // Exercise the `now` callback the real refresh would invoke.
  refreshCatalog.mockImplementation((options: { now: () => Date }) => {
    options.now();
    return Promise.resolve({ isErr: () => false, value: SUMMARY });
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = savedDbUrl;
  vi.restoreAllMocks();
});

describe('runRefreshCatalog', () => {
  it('refreshes the catalog and closes the connection without the E2E gate', async () => {
    await runRefreshCatalog(false);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(assertE2eModelsPresent).not.toHaveBeenCalled();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('asserts every E2E model is present when required', async () => {
    await runRefreshCatalog(true);
    expect(assertE2eModelsPresent).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('throws and still closes the connection when the refresh fails', async () => {
    refreshCatalog.mockResolvedValue({ isErr: () => true, error: { message: 'endpoint down' } });
    await expect(runRefreshCatalog(false)).rejects.toThrow('refresh failed — endpoint down');
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when DATABASE_URL is missing', async () => {
    delete process.env['DATABASE_URL'];
    await expect(runRefreshCatalog(false)).rejects.toThrow('DATABASE_URL is required');
  });
});
