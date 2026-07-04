import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { EnvContext } from '@hushbox/shared';
import type { PaymentProvider } from '../ports/index.js';

/**
 * Live-sandbox harness for the Helcim real-integration lane. There is NO
 * cassette here (unlike the AI-gateway lane): in ciVitest the constructed
 * provider and `searchCardTransactionsRaw` make real calls to the Helcim
 * SANDBOX, confirming the orphaned-capture `invoiceNumber` round-trip and the
 * (currently SYNTHETIC) `card-transactions` list-response shape against the
 * real API.
 *
 * Gating is mode-based only — `isCiVitest = isCI && !isE2E`, from
 * `createEnvUtilities` — NEVER on the presence of the API token (CODE-RULES
 * env rule). The API token travels solely in the request header and is never
 * placed in a URL, a log, or an error.
 *
 * Dependencies are injected so the pure logic is fully unit-coverable with
 * fakes; the real adapter/DB/fetch constructors live in the (coverage-excluded)
 * test file and are only invoked when `shouldRun` is true.
 */

/** Helcim v2 API root; the sandbox and production share it (only the token differs). */
const HELCIM_BASE_URL = 'https://api.helcim.com/v2';

const INERT_MESSAGE = 'Helcim live integration helpers run only in ciVitest (isCI && !isE2E)';

export interface HelcimIntegrationEnv extends EnvContext {
  readonly HELCIM_API_TOKEN?: string;
  readonly DATABASE_URL?: string;
  /** Optional: a sandbox card token unlocks the full charge → lookup path. */
  readonly HELCIM_SANDBOX_CARD_TOKEN?: string;
  readonly HELCIM_SANDBOX_CUSTOMER_CODE?: string;
}

export interface HelcimIntegrationDeps {
  createProvider(apiToken: string): PaymentProvider;
  createDatabase(url: string): Database;
  fetchImpl: typeof fetch;
}

export interface CardTransactionsSearchResult {
  readonly status: number;
  readonly body: unknown;
}

export interface HelcimIntegrationSetup {
  /** True only in ciVitest — the live sandbox path runs. */
  readonly shouldRun: boolean;
  /** The real Helcim provider; null outside ciVitest. */
  readonly provider: PaymentProvider | null;
  /** Optional sandbox card token, when configured. */
  readonly cardToken: string | null;
  readonly customerCode: string | null;
  /**
   * Raw `GET /card-transactions?invoiceNumber=` against the live API — the
   * confirmation seam for the SYNTHETIC list-response shape. Rejects outside
   * ciVitest.
   */
  searchCardTransactionsRaw(reference: string): Promise<CardTransactionsSearchResult>;
  /** Records a `helcim` service_evidence row (no-op outside ciVitest). */
  recordEvidence(details?: Record<string, unknown>): Promise<void>;
  /** Closes the db pool (no-op outside ciVitest). */
  cleanup(): Promise<void>;
}

function requireEnv(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required for the Helcim live integration test in ciVitest — envConfig (mode ciVitest) provides it; verify the env-generation step ran.`
    );
  }
  return value;
}

async function searchCardTransactionsRaw(
  fetchImpl: typeof fetch,
  apiToken: string,
  reference: string
): Promise<CardTransactionsSearchResult> {
  const response = await fetchImpl(
    `${HELCIM_BASE_URL}/card-transactions?invoiceNumber=${encodeURIComponent(reference)}`,
    { method: 'GET', headers: { 'api-token': apiToken, accept: 'application/json' } }
  );
  const body = await response.json();
  return { status: response.status, body };
}

export function setupHelcimIntegration(
  env: HelcimIntegrationEnv,
  deps: HelcimIntegrationDeps
): HelcimIntegrationSetup {
  const utilities = createEnvUtilities(env);
  const shouldRun = utilities.isCI && !utilities.isE2E;

  if (!shouldRun) {
    return {
      shouldRun: false,
      provider: null,
      cardToken: null,
      customerCode: null,
      searchCardTransactionsRaw: () => Promise.reject(new Error(INERT_MESSAGE)),
      recordEvidence: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
  }

  const apiToken = requireEnv(env.HELCIM_API_TOKEN, 'HELCIM_API_TOKEN');
  const databaseUrl = requireEnv(env.DATABASE_URL, 'DATABASE_URL');
  const provider = deps.createProvider(apiToken);
  const db = deps.createDatabase(databaseUrl);

  return {
    shouldRun: true,
    provider,
    cardToken: env.HELCIM_SANDBOX_CARD_TOKEN ?? null,
    customerCode: env.HELCIM_SANDBOX_CUSTOMER_CODE ?? null,
    searchCardTransactionsRaw: (reference) =>
      searchCardTransactionsRaw(deps.fetchImpl, apiToken, reference),
    recordEvidence: (details) =>
      recordServiceEvidence(db, utilities.isCI, SERVICE_NAMES.HELCIM, details),
    cleanup: () => db.$client.end(),
  };
}
