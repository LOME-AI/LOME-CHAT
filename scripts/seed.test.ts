import { describe, expect, it } from 'vitest';
import {
  ADMIN_TARGET_PERSONA,
  BASE_TEST_PERSONAS,
  DEV_PERSONAS,
  E2E_PROJECT_NAMES,
  MOBILE_TEST_PERSONA,
  SEED_REMOTE_REFUSAL_MESSAGE,
  TEST_2FA_TOTP_SECRET,
  TEST_PERSONAS,
  assertLocalDatabaseUrl,
  assertNoSeedArgs,
  isLocalDatabaseUrl,
  seedUUID,
  testPersonaName,
} from './seed.js';

describe('assertLocalDatabaseUrl remote-DB guard', () => {
  it('refuses a remote (non-local) DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://user:pass@db.prod.neon.tech/hushbox');
    }).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('refuses an unparseable DATABASE_URL (fails closed)', () => {
    expect(() => {
      assertLocalDatabaseUrl('not a valid url');
    }).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('accepts a 127.0.0.1 DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@127.0.0.1:4444/hushbox');
    }).not.toThrow();
  });

  it('accepts a bracketed IPv6 loopback DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@[::1]:5432/hushbox');
    }).not.toThrow();
  });

  it('accepts a localhost DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/hushbox');
    }).not.toThrow();
  });
});

describe('isLocalDatabaseUrl', () => {
  it('is true for a loopback host', () => {
    expect(isLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/hushbox')).toBe(true);
  });

  it('is false for a remote host', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.prod.neon.tech/hushbox')).toBe(false);
  });

  it('is false (fail-closed) for an unparseable URL', () => {
    expect(isLocalDatabaseUrl('::::')).toBe(false);
  });
});

describe('assertNoSeedArgs', () => {
  it('accepts an empty argv', () => {
    expect(() => {
      assertNoSeedArgs([]);
    }).not.toThrow();
  });

  it('rejects the removed --profile flag with a clear error', () => {
    expect(() => {
      assertNoSeedArgs(['--profile', 'e2e']);
    }).toThrow(/profiles were removed.*seeds everything/);
  });

  it('rejects any unexpected argument (fail-fast, never silently ignored)', () => {
    expect(() => {
      assertNoSeedArgs(['--anything']);
    }).toThrow(/unexpected argument "--anything"/);
  });
});

describe('e2e re-exports (imported from scripts/seed.js)', () => {
  it('exposes the base and cross-product persona rosters', () => {
    expect(BASE_TEST_PERSONAS).toHaveLength(11);
    expect(TEST_PERSONAS).toHaveLength(BASE_TEST_PERSONAS.length * E2E_PROJECT_NAMES.length);
  });

  it('exposes the mobile and dev personas', () => {
    expect(MOBILE_TEST_PERSONA.name).toBe('test-mobile');
    expect(DEV_PERSONAS.map((persona) => persona.name)).toStrictEqual(['alice', 'bob', 'charlie']);
  });

  it('exposes the project names and the 2FA secret constant', () => {
    expect([...E2E_PROJECT_NAMES]).toContain('chromium');
    expect(TEST_2FA_TOTP_SECRET).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('exposes the deterministic derivations', () => {
    expect(testPersonaName('test-alice', 'chromium')).toBe('test-alice-chromium');
    expect(seedUUID('anything')).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
  });
});

describe('admin op-target persona', () => {
  it('carries a negative purchased balance and stays out of the demo roster', () => {
    expect(ADMIN_TARGET_PERSONA.balanceNanoUsd < 0n).toBe(true);
    expect(DEV_PERSONAS.map((persona) => persona.name)).not.toContain(ADMIN_TARGET_PERSONA.name);
  });
});
