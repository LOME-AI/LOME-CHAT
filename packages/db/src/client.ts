import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import * as schema from './schema/index';

neonConfig.webSocketConstructor = ws;

export interface NeonDevConfig {
  wsProxy: (host: string, port: string | number) => string;
  useSecureWebSocket: boolean;
  pipelineTLS: boolean;
  pipelineConnect: false | 'password';
}

export interface DbConfig {
  connectionString: string;
  /** Development-only neon proxy settings. Omit in production. */
  neonDev?: NeonDevConfig;
}

/** Standard dev config for local neon-proxy */
export const LOCAL_NEON_DEV_CONFIG: NeonDevConfig = {
  wsProxy: (host: string, port: string | number) => `${host}:${String(port)}/v1`,
  useSecureWebSocket: false,
  pipelineTLS: false,
  pipelineConnect: false,
};

export function createDb(config: DbConfig) {
  // Apply neon dev config if provided (must happen before Pool creation)
  if (config.neonDev) {
    neonConfig.wsProxy = config.neonDev.wsProxy;
    neonConfig.useSecureWebSocket = config.neonDev.useSecureWebSocket;
    neonConfig.pipelineTLS = config.neonDev.pipelineTLS;
    neonConfig.pipelineConnect = config.neonDev.pipelineConnect;
  }

  const pool = new Pool({ connectionString: config.connectionString });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
