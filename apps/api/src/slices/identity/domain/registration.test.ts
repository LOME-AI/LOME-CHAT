import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { createRegisterFinishFlow } from './registration.js';
import type { Database } from '@hushbox/db';
import type { BillingStores, WelcomeEmailPort } from '../../billing/index.js';
import type {
  IdentityUsersStore,
  IdentityVerificationStore,
  VerificationEmailPort,
} from '../ports/index.js';

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
  requestDeletion: () => {
    throw new Error('store must not be touched');
  },
};

const untouchableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

// The provisioning/email deps are never reached: execute throws its
// pending-state defect and onDuplicate short-circuits before any settlement.
const untouchable: unknown = new Proxy(
  {},
  {
    get() {
      throw new Error('provisioning deps must not be touched');
    },
  }
);

function flowUnderTest(): ReturnType<typeof createRegisterFinishFlow> {
  return createRegisterFinishFlow({
    store: untouchableStore,
    redis: untouchableRedis,
    db: untouchable as Database,
    billingStores: untouchable as BillingStores,
    verificationStore: untouchable as IdentityVerificationStore,
    welcomeEmail: untouchable as WelcomeEmailPort,
    verificationEmail: untouchable as VerificationEmailPort,
    email: 'someone@example.test',
    registerSessionId: crypto.randomUUID(),
    registrationRecord: [1, 2, 3],
    accountPublicKey: 'AQID',
    passwordWrappedPrivateKey: 'AQID',
    recoveryWrappedPrivateKey: 'AQID',
    now: Date.now(),
  });
}

describe('createRegisterFinishFlow', () => {
  it('treats execute without a won claim as a defect', () => {
    // byEventId runs execute only after claim resolved true; calling it
    // while the consume still reads no-pending is an illegal state.
    expect(() => flowUnderTest().execute()).toThrow(/without a claimed pending state/);
  });

  it('answers the duplicate path with the no-pending outcome', async () => {
    const outcome = await flowUnderTest().onDuplicate();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'no-pending' });
  });
});
