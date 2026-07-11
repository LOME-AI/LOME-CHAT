import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { createLoginFinishFlow } from './login.js';
import type { IdentityUsersStore } from '../ports/index.js';

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
