import { describe, it, expect } from 'vitest';
import { Redis } from '@upstash/redis';
import { createRequestDb, createRequestRedis } from './factories.js';
import type { RequiredBindings } from './app-env.js';

const bindings: RequiredBindings = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
};

describe('createRequestDb', () => {
  it('returns a database client', () => {
    const db = createRequestDb(bindings, { isDev: true });
    expect(db.select).toBeTypeOf('function');
  });

  it('returns a fresh client per call (no module-level singleton)', () => {
    expect(createRequestDb(bindings, { isDev: true })).not.toBe(
      createRequestDb(bindings, { isDev: true })
    );
  });

  it('returns a database client outside dev mode', () => {
    const db = createRequestDb(bindings, { isDev: false });
    expect(db.select).toBeTypeOf('function');
  });
});

describe('createRequestRedis', () => {
  it('returns a Redis client', () => {
    expect(createRequestRedis(bindings)).toBeInstanceOf(Redis);
  });

  it('returns a fresh client per call (no module-level singleton)', () => {
    expect(createRequestRedis(bindings)).not.toBe(createRequestRedis(bindings));
  });
});
