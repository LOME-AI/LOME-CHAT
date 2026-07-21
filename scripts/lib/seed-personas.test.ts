import { describe, expect, it } from 'vitest';

import {
  BASE_TEST_PERSONAS,
  DEV_PERSONAS,
  E2E_PROJECT_NAMES,
  E2E_WORKER_POOL_SIZE,
  MOBILE_TEST_PERSONA,
  POOLED_PERSONA_BASE_NAMES,
  PROJECT_CODE,
  pooledPersonaName,
  seedUUID,
  TEST_2FA_TOTP_SECRET,
  TEST_PERSONAS,
  testPersonaName,
  usdDecimalToNanoUsd,
} from './seed-personas.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_MAX_LENGTH = 20;

describe('seedUUID', () => {
  it('produces a v4-shaped UUID', () => {
    expect(seedUUID('test')).toMatch(UUID_PATTERN);
  });

  it('is deterministic for the same input', () => {
    expect(seedUUID('test')).toBe(seedUUID('test'));
  });

  it('differs for different inputs', () => {
    expect(seedUUID('test1')).not.toBe(seedUUID('test2'));
  });
});

describe('usdDecimalToNanoUsd', () => {
  it('converts a whole-dollar string to nano-USD', () => {
    expect(usdDecimalToNanoUsd('10000.00000000')).toBe(10_000_000_000_000n);
  });

  it('converts a sub-dollar fractional string exactly', () => {
    expect(usdDecimalToNanoUsd('0.20000000')).toBe(200_000_000n);
  });

  it('converts zero', () => {
    expect(usdDecimalToNanoUsd('0.00000000')).toBe(0n);
  });

  it('handles integer strings without a fractional part', () => {
    expect(usdDecimalToNanoUsd('5')).toBe(5_000_000_000n);
  });

  it('rejects a non-decimal string', () => {
    expect(() => usdDecimalToNanoUsd('abc')).toThrow();
  });

  it('rejects more than 9 fractional digits', () => {
    expect(() => usdDecimalToNanoUsd('1.0123456789')).toThrow('more than 9 fractional digits');
  });

  it('negates a signed amount', () => {
    expect(usdDecimalToNanoUsd('-2.5')).toBe(-2_500_000_000n);
  });
});

describe('DEV_PERSONAS', () => {
  it('has the three dev personas with nano-USD balances', () => {
    expect(DEV_PERSONAS.map((p) => p.name)).toEqual(['alice', 'bob', 'charlie']);
    const alice = DEV_PERSONAS.find((p) => p.name === 'alice');
    expect(alice?.balanceNanoUsd).toBe(10_000_000_000_000n);
    expect(DEV_PERSONAS.find((p) => p.name === 'charlie')?.balanceNanoUsd).toBe(0n);
  });
});

describe('BASE_TEST_PERSONAS', () => {
  it('marks test-charlie unverified', () => {
    const charlie = BASE_TEST_PERSONAS.find((p) => p.name === 'test-charlie');
    expect(charlie?.emailVerified).toBe(false);
  });

  it('gives test-2fa the shared TOTP secret', () => {
    const twoFa = BASE_TEST_PERSONAS.find((p) => p.name === 'test-2fa');
    expect(twoFa?.totpSecret).toBe(TEST_2FA_TOTP_SECRET);
  });

  it('marks test-alice as having sample data', () => {
    expect(BASE_TEST_PERSONAS.find((p) => p.name === 'test-alice')?.hasSampleData).toBe(true);
  });
});

describe('pooledPersonaName', () => {
  it('keeps worker slot 0 on the un-suffixed persona name', () => {
    expect(pooledPersonaName('test-alice', 0)).toBe('test-alice');
  });

  it('suffixes slots 1..N-1 with -w<slot>', () => {
    expect(pooledPersonaName('test-alice', 1)).toBe('test-alice-w1');
    expect(pooledPersonaName('test-bob', 3)).toBe('test-bob-w3');
    expect(pooledPersonaName('test-dave', E2E_WORKER_POOL_SIZE - 1)).toBe(
      `test-dave-w${String(E2E_WORKER_POOL_SIZE - 1)}`
    );
  });

  it('leaves non-pooled personas unchanged on every slot', () => {
    expect(pooledPersonaName('test-billing-token', 5)).toBe('test-billing-token');
    expect(pooledPersonaName('test-2fa', 2)).toBe('test-2fa');
  });

  it('wraps a worker index beyond the pool size back into range', () => {
    expect(pooledPersonaName('test-alice', E2E_WORKER_POOL_SIZE)).toBe('test-alice');
    expect(pooledPersonaName('test-alice', E2E_WORKER_POOL_SIZE + 1)).toBe('test-alice-w1');
  });
});

describe('worker-isolation pool', () => {
  it('seeds a distinct copy of every pooled persona for each non-zero slot', () => {
    for (const base of POOLED_PERSONA_BASE_NAMES) {
      for (let slot = 1; slot < E2E_WORKER_POOL_SIZE; slot++) {
        const copy = BASE_TEST_PERSONAS.find((p) => p.name === `${base}-w${String(slot)}`);
        expect(copy, `${base}-w${String(slot)} must be seeded`).toBeDefined();
      }
    }
  });

  it('preserves each pooled persona source balance across its copies', () => {
    for (const base of POOLED_PERSONA_BASE_NAMES) {
      const source = BASE_TEST_PERSONAS.find((p) => p.name === base);
      const copy = BASE_TEST_PERSONAS.find((p) => p.name === `${base}-w1`);
      expect(copy?.balanceNanoUsd).toBe(source?.balanceNanoUsd);
    }
  });

  it('carries no sample data on pool copies', () => {
    expect(BASE_TEST_PERSONAS.find((p) => p.name === 'test-alice-w1')?.hasSampleData).toBe(false);
  });
});

describe('TEST_PERSONAS', () => {
  it('is the persona × project cross-product', () => {
    expect(TEST_PERSONAS).toHaveLength(BASE_TEST_PERSONAS.length * E2E_PROJECT_NAMES.length);
  });

  it('keeps every username within the varchar(20) limit', () => {
    for (const persona of TEST_PERSONAS) {
      expect(persona.username.length).toBeLessThanOrEqual(USERNAME_MAX_LENGTH);
    }
  });

  it('gives every persona a unique username', () => {
    const usernames = TEST_PERSONAS.map((p) => p.username);
    expect(new Set(usernames).size).toBe(usernames.length);
  });

  it('suffixes usernames with the 2-char project code', () => {
    const firstProject = E2E_PROJECT_NAMES[0];
    const aliceFirst = TEST_PERSONAS.find((p) => p.name === `test-alice-${firstProject}`);
    expect(aliceFirst?.username).toBe(`test_alice_${PROJECT_CODE[firstProject]}`);
  });
});

describe('MOBILE_TEST_PERSONA', () => {
  it('uses the shortest legal username to save Maestro input time', () => {
    expect(MOBILE_TEST_PERSONA.username).toBe('tmu');
    expect(MOBILE_TEST_PERSONA.name).toBe('test-mobile');
    expect(MOBILE_TEST_PERSONA.hasSampleData).toBe(true);
  });
});

describe('testPersonaName', () => {
  it('joins a base name and a project name', () => {
    expect(testPersonaName('test-alice', 'chromium')).toBe('test-alice-chromium');
  });
});
