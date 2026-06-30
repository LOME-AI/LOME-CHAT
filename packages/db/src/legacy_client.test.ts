import { describe, it, expect, afterEach, vi } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { createDb, LOCAL_NEON_DEV_CONFIG } from './legacy_client';

const { MockPool } = vi.hoisted(() => ({
  MockPool: vi.fn(function (this: Record<string, unknown>) {
    this['query'] = vi.fn();
  }),
}));

vi.mock('@neondatabase/serverless', () => ({
  Pool: MockPool,
  neonConfig: {
    webSocketConstructor: null,
    wsProxy: undefined,
    useSecureWebSocket: true,
    pipelineTLS: true,
    pipelineConnect: 'password' as const,
  },
}));

vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: vi.fn(() => ({
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  })),
}));

const DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

afterEach(() => {
  vi.clearAllMocks();
});

describe('LOCAL_NEON_DEV_CONFIG', () => {
  it('has correct wsProxy function with string port', () => {
    const result = LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', '4444');
    expect(result).toBe('localhost:4444/v1');
  });

  it('has correct wsProxy function with number port', () => {
    const result = LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', 4444);
    expect(result).toBe('localhost:4444/v1');
  });

  it('has useSecureWebSocket set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.useSecureWebSocket).toBe(false);
  });

  it('has pipelineTLS set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.pipelineTLS).toBe(false);
  });

  it('has pipelineConnect set to false', () => {
    expect(LOCAL_NEON_DEV_CONFIG.pipelineConnect).toBe(false);
  });
});

describe('createDb', () => {
  it('creates a database instance with expected methods', () => {
    const db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
    expect(typeof db.insert).toBe('function');
    expect(typeof db.update).toBe('function');
    expect(typeof db.delete).toBe('function');
  });

  it('creates Pool with max: 1 per request', () => {
    createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(Pool).toHaveBeenCalledWith({
      connectionString: DATABASE_URL,
      max: 1,
    });
  });

  it('creates a new Pool on every call (no caching)', () => {
    createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    createDb({ connectionString: DATABASE_URL, neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(Pool).toHaveBeenCalledTimes(3);
  });
});
