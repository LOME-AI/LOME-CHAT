import { describe, it, expect } from 'vitest';
import { Pool, neonConfig } from '@neondatabase/serverless';

import { createDb, LOCAL_NEON_DEV_CONFIG } from './client';

const DATABASE_URL = 'postgresql://user:secret@localhost:4444/testdb';

describe('LOCAL_NEON_DEV_CONFIG', () => {
  it('formats the wsProxy address as host:port/v1 for string and number ports', () => {
    expect(LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', '4444')).toBe('localhost:4444/v1');
    expect(LOCAL_NEON_DEV_CONFIG.wsProxy('localhost', 4444)).toBe('localhost:4444/v1');
  });
});

describe('createDb input validation', () => {
  it('throws when connectionString is empty', () => {
    expect(() => createDb('')).toThrow(/connectionString/);
  });

  it('throws when connectionString is not a URL', () => {
    expect(() => createDb('not a url at all')).toThrow(/postgres/);
  });

  it('throws when connectionString is not a postgres URL', () => {
    expect(() => createDb('mysql://user:pw@localhost:3306/db')).toThrow(/postgres/);
  });

  it('throws when injectLatencyMs is negative', () => {
    expect(() =>
      createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG, injectLatencyMs: -1 })
    ).toThrow(/injectLatencyMs/);
  });

  it('throws when injectLatencyMs is not finite', () => {
    expect(() =>
      createDb(DATABASE_URL, {
        neonDev: LOCAL_NEON_DEV_CONFIG,
        injectLatencyMs: Number.POSITIVE_INFINITY,
      })
    ).toThrow(/injectLatencyMs/);
  });

  it('throws when injectLatencyMs is provided without neonDev', () => {
    expect(() => createDb(DATABASE_URL, { injectLatencyMs: 30 })).toThrow(/neonDev/);
  });
});

describe('createDb', () => {
  it('returns a drizzle database handle over a neon Pool', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(db.$client).toBeInstanceOf(Pool);
    expect(typeof db.execute).toBe('function');
    expect(typeof db.transaction).toBe('function');
    await db.$client.end();
  });

  it('applies the neonDev settings to the driver config', async () => {
    const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    expect(neonConfig.useSecureWebSocket).toBe(false);
    expect(neonConfig.pipelineTLS).toBe(false);
    expect(neonConfig.pipelineConnect).toBe(false);
    expect(neonConfig.wsProxy).toBe(LOCAL_NEON_DEV_CONFIG.wsProxy);
    await db.$client.end();
  });

  it('accepts injectLatencyMs of zero alongside neonDev', async () => {
    const db = createDb(DATABASE_URL, {
      neonDev: LOCAL_NEON_DEV_CONFIG,
      injectLatencyMs: 0,
    });
    expect(db.$client).toBeInstanceOf(Pool);
    await db.$client.end();
  });
});
