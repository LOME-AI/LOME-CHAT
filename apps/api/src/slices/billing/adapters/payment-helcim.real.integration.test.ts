import { randomUUID } from 'node:crypto';
import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';
import { nanoUSD } from '@hushbox/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { paymentReference } from '../domain/payments.js';
import { createHelcimPaymentProvider } from './payment-helcim.js';
import {
  setupHelcimIntegration,
  type HelcimIntegrationDeps,
  type HelcimIntegrationEnv,
} from './payment-helcim.integration-setup.js';

/**
 * Live-sandbox integration for the orphaned-capture `invoiceNumber` round-trip.
 * Unlike the AI-gateway lane, there is NO cassette: in ciVitest this file makes
 * real calls to the Helcim SANDBOX to confirm the (currently SYNTHETIC)
 * `card-transactions` list-response shape against the real API and to prove a
 * charge is recoverable by its merchant `reference`.
 *
 * Gating is mode-based (`isCiVitest = isCI && !isE2E`, from `createEnvUtilities`),
 * NEVER on secret presence. Locally the live bodies are skipped; the harness
 * unit tests below run always and drive every branch with injected fakes so the
 * gated `integration-setup.ts` source stays covered without a network.
 */

const LIVE_TIMEOUT_MS = 30_000;
/** $0.10 — a whole-cent amount the charge precondition accepts. */
const LIVE_CHARGE_AMOUNT = nanoUSD(100_000_000n);

// ── Test-file-only wiring (excluded from coverage) ──────────────────────────

/** Builds the harness env from process.env, mirroring the AI-gateway harness. */
function readProcessEnv(): HelcimIntegrationEnv {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
    ...(process.env['HELCIM_API_TOKEN'] !== undefined && {
      HELCIM_API_TOKEN: process.env['HELCIM_API_TOKEN'],
    }),
    ...(process.env['DATABASE_URL'] !== undefined && { DATABASE_URL: process.env['DATABASE_URL'] }),
    ...(process.env['HELCIM_SANDBOX_CARD_TOKEN'] !== undefined && {
      HELCIM_SANDBOX_CARD_TOKEN: process.env['HELCIM_SANDBOX_CARD_TOKEN'],
    }),
    ...(process.env['HELCIM_SANDBOX_CUSTOMER_CODE'] !== undefined && {
      HELCIM_SANDBOX_CUSTOMER_CODE: process.env['HELCIM_SANDBOX_CUSTOMER_CODE'],
    }),
  };
}

/** Real dependencies — only invoked in ciVitest (shouldRun); never local. */
const REAL_DEPS: HelcimIntegrationDeps = {
  createProvider: (apiToken) => createHelcimPaymentProvider({ apiToken }),
  createDatabase: (url) => createDb(url, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  fetchImpl: (...args) => fetch(...args),
};

// ── Harness unit tests (always run; injected fakes, no network / DB) ─────────

const SANDBOX_TOKEN = 'sandbox-token-1234567890';
const TEST_DB_URL = 'postgres://user:pass@localhost:5432/hushbox';
const CI_ENV: HelcimIntegrationEnv = {
  NODE_ENV: 'test',
  CI: 'true',
  HELCIM_API_TOKEN: SANDBOX_TOKEN,
  DATABASE_URL: TEST_DB_URL,
};

interface FakeDb {
  readonly db: Database;
  readonly inserted: { service: string; details: Record<string, unknown> | null }[];
  readonly endCalls: number;
}

function makeFakeDb(): FakeDb {
  const state = {
    inserted: [] as { service: string; details: Record<string, unknown> | null }[],
    endCalls: 0,
  };
  const db = {
    insert: () => ({
      values: (row: { service: string; details: Record<string, unknown> | null }) => {
        state.inserted.push(row);
        return Promise.resolve();
      },
    }),
    $client: {
      end: () => {
        state.endCalls += 1;
        return Promise.resolve();
      },
    },
  } as unknown as Database;
  return {
    db,
    get inserted() {
      return state.inserted;
    },
    get endCalls() {
      return state.endCalls;
    },
  };
}

function fakeDeps(overrides: Partial<HelcimIntegrationDeps> = {}): {
  deps: HelcimIntegrationDeps;
  fakeDb: FakeDb;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fakeDb = makeFakeDb();
  const fetchMock = vi.fn(
    (_url: string, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(
        Response.json([{ transactionId: 4242, status: 'APPROVED', amount: 0.1 }], { status: 200 })
      )
  );
  const deps: HelcimIntegrationDeps = {
    createProvider: (apiToken) => createHelcimPaymentProvider({ apiToken }),
    createDatabase: () => fakeDb.db,
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
  return { deps, fakeDb, fetchMock };
}

describe('setupHelcimIntegration (harness gating)', () => {
  it('does not run outside CI (local dev)', () => {
    const { deps } = fakeDeps();
    const setup = setupHelcimIntegration({ NODE_ENV: 'development' }, deps);
    expect(setup.shouldRun).toBe(false);
    expect(setup.provider).toBeNull();
    expect(setup.cardToken).toBeNull();
    expect(setup.customerCode).toBeNull();
  });

  it('does not run under E2E even when CI is set (excludes ciE2E)', () => {
    const { deps } = fakeDeps();
    const setup = setupHelcimIntegration({ NODE_ENV: 'test', CI: 'true', E2E: 'true' }, deps);
    expect(setup.shouldRun).toBe(false);
    expect(setup.provider).toBeNull();
  });

  it('runs in ciVitest (isCI && !isE2E) and builds the real provider', () => {
    const { deps } = fakeDeps();
    const setup = setupHelcimIntegration(CI_ENV, deps);
    expect(setup.shouldRun).toBe(true);
    expect(setup.provider).not.toBeNull();
    expect(setup.provider?.isMock).toBe(false);
  });

  it('surfaces the optional sandbox card token and customer code when present', () => {
    const { deps } = fakeDeps();
    const setup = setupHelcimIntegration(
      { ...CI_ENV, HELCIM_SANDBOX_CARD_TOKEN: 'card-tok-1', HELCIM_SANDBOX_CUSTOMER_CODE: 'CST1' },
      deps
    );
    expect(setup.cardToken).toBe('card-tok-1');
    expect(setup.customerCode).toBe('CST1');
  });

  it('fails fast when HELCIM_API_TOKEN is missing in ciVitest', () => {
    const { deps } = fakeDeps();
    expect(() =>
      setupHelcimIntegration({ NODE_ENV: 'test', CI: 'true', DATABASE_URL: TEST_DB_URL }, deps)
    ).toThrow('HELCIM_API_TOKEN');
  });

  it('fails fast when DATABASE_URL is missing in ciVitest', () => {
    const { deps } = fakeDeps();
    expect(() =>
      setupHelcimIntegration(
        { NODE_ENV: 'test', CI: 'true', HELCIM_API_TOKEN: SANDBOX_TOKEN },
        deps
      )
    ).toThrow('DATABASE_URL');
  });
});

describe('setupHelcimIntegration (inert helpers outside ciVitest)', () => {
  it('rejects searchCardTransactionsRaw', async () => {
    const { deps } = fakeDeps();
    const setup = setupHelcimIntegration({ NODE_ENV: 'development' }, deps);
    await expect(setup.searchCardTransactionsRaw('ref')).rejects.toThrow(/ciVitest/);
  });

  it('makes recordEvidence and cleanup no-ops', async () => {
    const { deps, fakeDb } = fakeDeps();
    const setup = setupHelcimIntegration({ NODE_ENV: 'development' }, deps);
    await setup.recordEvidence({ any: 'thing' });
    await setup.cleanup();
    expect(fakeDb.inserted).toHaveLength(0);
    expect(fakeDb.endCalls).toBe(0);
  });
});

describe('setupHelcimIntegration (live helpers, driven with fakes)', () => {
  it('searches card-transactions with the api token in the header ONLY, never the URL', async () => {
    const { deps, fetchMock } = fakeDeps();
    const setup = setupHelcimIntegration(CI_ENV, deps);
    const result = await setup.searchCardTransactionsRaw('deadbeef');
    expect(result.status).toBe(200);
    expect(result.body).toEqual([{ transactionId: 4242, status: 'APPROVED', amount: 0.1 }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/card-transactions?invoiceNumber=deadbeef');
    expect(url).not.toContain(SANDBOX_TOKEN);
    const headers = init.headers as Record<string, string>;
    expect(headers['api-token']).toBe(SANDBOX_TOKEN);
  });

  it('records a helcim service_evidence row via the injected db', async () => {
    const { deps, fakeDb } = fakeDeps();
    const setup = setupHelcimIntegration(CI_ENV, deps);
    await setup.recordEvidence({ endpoint: 'card-transactions' });
    expect(fakeDb.inserted).toEqual([
      { service: 'helcim', details: { endpoint: 'card-transactions' } },
    ]);
  });

  it('closes the db pool on cleanup', async () => {
    const { deps, fakeDb } = fakeDeps();
    const setup = setupHelcimIntegration(CI_ENV, deps);
    await setup.cleanup();
    expect(fakeDb.endCalls).toBe(1);
  });
});

// ── Live sandbox tests (ciVitest only; inert everywhere else) ────────────────

describe('payment-helcim real Helcim sandbox integration', () => {
  const live = setupHelcimIntegration(readProcessEnv(), REAL_DEPS);

  afterAll(async () => {
    await live.cleanup();
  });

  it.runIf(live.shouldRun)(
    'confirms the real card-transactions list-response shape and records evidence',
    async () => {
      // A fresh, never-charged reference. The real endpoint must answer with a
      // well-formed list (array); this is the load-bearing confirmation of the
      // SYNTHETIC `cardTransactionListSchema` against the live API.
      const freshReference = paymentReference(randomUUID());
      const { status, body } = await live.searchCardTransactionsRaw(freshReference);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      await live.recordEvidence({ endpoint: 'card-transactions', reference: freshReference });
    },
    LIVE_TIMEOUT_MS
  );

  it.runIf(live.shouldRun && live.cardToken !== null)(
    'charges the sandbox then round-trips the capture via invoiceNumber',
    async () => {
      const provider = live.provider;
      const cardToken = live.cardToken;
      if (provider === null || cardToken === null) throw new Error('live setup incomplete');

      const paymentId = randomUUID();
      const reference = paymentReference(paymentId);
      const chargeResult = await provider
        .charge({
          idempotencyKey: paymentId,
          reference,
          amount: LIVE_CHARGE_AMOUNT,
          cardToken,
          customerCode: live.customerCode ?? 'CST1000',
          ipAddress: '127.0.0.1',
        })
        .match(
          (outcome) => outcome,
          (error) => {
            throw new Error(`live sandbox charge failed: ${error.code}`);
          }
        );
      expect(chargeResult.status).toBe('approved');
      if (chargeResult.status !== 'approved') throw new Error('expected approval');
      const chargedTransactionId = chargeResult.transactionId;

      const lookup = await provider.findCaptureByReference(reference).match(
        (result) => result,
        (error) => {
          throw new Error(`reference lookup failed: ${error.code}`);
        }
      );
      expect(lookup.kind).toBe('found');
      if (lookup.kind !== 'found') throw new Error('expected the capture to be found');
      expect(lookup.capture.transactionId).toBe(chargedTransactionId);
      expect(lookup.capture.status).toBe('approved');

      // Surface the REAL capture-amount shape into the evidence row so the
      // first CI run reveals whether/how the amount is carried — the input the
      // deferred amount-mismatch guard needs (it cannot be built by guessing).
      const { body } = await live.searchCardTransactionsRaw(reference);
      const first = Array.isArray(body)
        ? (body[0] as Record<string, unknown> | undefined)
        : undefined;
      const keys = first === undefined ? [] : Object.keys(first);
      const amountCandidates =
        first === undefined
          ? {}
          : Object.fromEntries(Object.entries(first).filter(([key]) => /amount/i.test(key)));
      await live.recordEvidence({
        endpoint: 'card-transactions',
        transactionId: chargedTransactionId,
        capturedKeys: keys,
        amountCandidates,
      });
    },
    LIVE_TIMEOUT_MS
  );
});
