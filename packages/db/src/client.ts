import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { PoolClient } from '@neondatabase/serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

/**
 * Runtime-agnostic by construction: this module never imports the node-only
 * `ws` package. The driver falls back to the global WebSocket constructor,
 * which exists in both Node >= 22 and workerd — the same code path therefore
 * runs in node-environment tests, the production Worker, and Durable Objects.
 */

export interface NeonDevConfig {
  wsProxy: (host: string, port: string | number) => string;
  useSecureWebSocket: boolean;
  pipelineTLS: boolean;
  pipelineConnect: false | 'password';
}

/** Settings for the local neon-proxy (wsproxy container). Dev/test only. */
export const LOCAL_NEON_DEV_CONFIG: NeonDevConfig = {
  wsProxy: (host: string, port: string | number) => `${host}:${String(port)}/v1`,
  useSecureWebSocket: false,
  pipelineTLS: false,
  pipelineConnect: false,
};

export interface DbOptions {
  /** Local neon-proxy settings. Omit in production. */
  neonDev?: NeonDevConfig;
  /**
   * Fixed delay (ms) added before every statement. Local-only test/dev knob:
   * the local wsproxy's ~0 ms round trips hide transaction-shape regressions
   * (e.g. settlement lock-hold growth) that production's per-statement latency
   * exposes. Requires neonDev. Deliberately not an env-registry entry — the
   * backend env module lands in a later task; until then this is programmatic
   * only.
   */
  injectLatencyMs?: number;
}

export type Database = NeonDatabase & { $client: Pool };

function validate(connectionString: string, options: DbOptions): void {
  if (connectionString.trim() === '') {
    throw new Error('createDb: connectionString is required');
  }
  let protocol: string;
  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    throw new Error('createDb: connectionString must be a postgres:// or postgresql:// URL');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new Error('createDb: connectionString must be a postgres:// or postgresql:// URL');
  }
  if (options.injectLatencyMs !== undefined) {
    if (!Number.isFinite(options.injectLatencyMs) || options.injectLatencyMs < 0) {
      throw new Error('createDb: injectLatencyMs must be a finite number >= 0');
    }
    if (options.neonDev === undefined) {
      throw new Error(
        'createDb: injectLatencyMs is a local-driver-only option and requires neonDev'
      );
    }
  }
}

/**
 * Wraps a pooled client's query method with a fixed pre-statement delay.
 * Patching at the client level (not the Pool) is what makes the delay
 * per-statement: drizzle runs transactions as begin/.../commit on one
 * checked-out client, so every statement in a transaction pays the delay.
 */
function delayClientStatements(client: PoolClient, latencyMs: number): void {
  // The bound original keeps pg's overload dispatch (promise and callback
  // forms) intact; the wrapper only defers invocation.
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  const delayed = async (...args: unknown[]): Promise<unknown> => {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return original(...args);
  };
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = delayed;
}

export function createDb(connectionString: string, options: DbOptions = {}): Database {
  validate(connectionString, options);

  if (options.neonDev) {
    neonConfig.wsProxy = options.neonDev.wsProxy;
    neonConfig.useSecureWebSocket = options.neonDev.useSecureWebSocket;
    neonConfig.pipelineTLS = options.neonDev.pipelineTLS;
    neonConfig.pipelineConnect = options.neonDev.pipelineConnect;
  }

  const pool = new Pool({ connectionString, max: 1 });

  const latencyMs = options.injectLatencyMs ?? 0;
  if (latencyMs > 0) {
    // 'connect' fires once per physical connection, before it serves queries,
    // so every client this pool ever hands out carries the delay.
    pool.on('connect', (client: PoolClient) => {
      delayClientStatements(client, latencyMs);
    });
  }

  return drizzle(pool);
}
