import { describe, it, expect } from 'vitest';
import { createEvidenceConfig } from './evidence-config.js';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';

interface ContextStub {
  db: unknown;
  envUtils: { isCI: boolean };
}

function buildContext(stub: ContextStub): Context<AppEnv> {
  const map = new Map<string, unknown>([
    ['db', stub.db],
    ['envUtils', stub.envUtils],
  ]);
  return { get: (key: string) => map.get(key) } as unknown as Context<AppEnv>;
}

describe('createEvidenceConfig', () => {
  it('bundles db and isCI=true from context', () => {
    const dbSentinel = { sentinel: 'db' };
    const c = buildContext({ db: dbSentinel, envUtils: { isCI: true } });
    const result = createEvidenceConfig(c);
    expect(result.db).toBe(dbSentinel);
    expect(result.isCI).toBe(true);
  });

  it('bundles db and isCI=false from context', () => {
    const dbSentinel = { sentinel: 'db' };
    const c = buildContext({ db: dbSentinel, envUtils: { isCI: false } });
    const result = createEvidenceConfig(c);
    expect(result.db).toBe(dbSentinel);
    expect(result.isCI).toBe(false);
  });

  it('throws when envUtils is missing (test harness must call createEnvUtilities directly)', () => {
    const dbSentinel = { sentinel: 'db' };
    const map = new Map<string, unknown>([['db', dbSentinel]]);
    const c = { get: (key: string) => map.get(key) } as unknown as Context<AppEnv>;
    expect(() => createEvidenceConfig(c)).toThrow(/envUtils/);
  });
});
