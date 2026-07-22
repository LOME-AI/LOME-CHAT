import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { createLoginFinishFlow, loginFinishBodySchema, loginInitBodySchema } from './login.js';
import type { IdentityUsersStore } from '../ports/index.js';

const keArray = (length: number): number[] => Array.from({ length }, () => 0);

/** Neither the store nor Redis may be touched on the defect path. */
const untouchableStore: IdentityUsersStore = {
  findByEmail: () => {
    throw new Error('store must not be touched');
  },
  findByUsername: () => {
    throw new Error('store must not be touched');
  },
  findById: () => {
    throw new Error('store must not be touched');
  },
  insertRegistered: () => {
    throw new Error('store must not be touched');
  },
  insertRegisteredWithinTx: () => {
    throw new Error('store must not be touched');
  },
  enableTotp: () => {
    throw new Error('store must not be touched');
  },
  disableTotp: () => {
    throw new Error('store must not be touched');
  },
  rotatePassword: () => {
    throw new Error('store must not be touched');
  },
  lockForDeletionWithinTx: () => {
    throw new Error('store must not be touched');
  },
  insertDeletionEventWithinTx: () => {
    throw new Error('store must not be touched');
  },
  deleteUserWithinTx: () => {
    throw new Error('store must not be touched');
  },
  saveRecoveryKey: () => {
    throw new Error('store must not be touched');
  },
  lockForChargebackWithinTx: () => {
    throw new Error('store must not be touched');
  },
  lockUserWithinTx: () => {
    throw new Error('store must not be touched');
  },
  unlockUserWithinTx: () => {
    throw new Error('store must not be touched');
  },
};

const untouchableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

function flowUnderTest(): ReturnType<typeof createLoginFinishFlow> {
  return createLoginFinishFlow({
    store: untouchableStore,
    redis: untouchableRedis,
    masterSecret: 'secret-at-least-32-characters-long!!',
    identifier: 'someone@example.test',
    ke3: [1, 2, 3],
    loginSessionId: crypto.randomUUID(),
    request: new Request('http://localhost/auth/login/finish'),
    response: new Response(),
    secret: 'secret-at-least-32-characters-long!!',
    isProduction: false,
    now: Date.now(),
  });
}

describe('createLoginFinishFlow', () => {
  it('treats execute without a won claim as a defect', () => {
    // byEventId runs execute only after claim resolved true; calling it
    // while the consume still reads null is an illegal state.
    expect(() => flowUnderTest().execute()).toThrow(/without a claimed pending state/);
  });

  it('answers the duplicate path with the no-pending outcome', async () => {
    const outcome = await flowUnderTest().onDuplicate();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'no-pending' });
  });
});

/**
 * The 1024-element cap on the OPAQUE KE arrays bounds parse cost. Legacy left
 * login uncapped; this cap is consistent DoS-hardening (fail-fast doctrine),
 * matching the delete-account parity value, not a legacy-parity restoration.
 */
describe('login KE-array cap', () => {
  it('accepts a ke1 array of exactly 1024 elements', () => {
    const body = { identifier: 'someone@example.test', ke1: keArray(1024) };
    expect(loginInitBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a ke1 array of 1025 elements', () => {
    const body = { identifier: 'someone@example.test', ke1: keArray(1025) };
    expect(loginInitBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts a ke3 array of exactly 1024 elements', () => {
    const body = {
      identifier: 'someone@example.test',
      ke3: keArray(1024),
      loginSessionId: crypto.randomUUID(),
    };
    expect(loginFinishBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a ke3 array of 1025 elements', () => {
    const body = {
      identifier: 'someone@example.test',
      ke3: keArray(1025),
      loginSessionId: crypto.randomUUID(),
    };
    expect(loginFinishBodySchema.safeParse(body).success).toBe(false);
  });
});
