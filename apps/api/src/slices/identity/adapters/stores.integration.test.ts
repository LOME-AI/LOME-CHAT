import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, accountDeletionEvents, createDb, users } from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createIdentityStores } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for identity store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createIdentityStores(db);

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zi${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

function registrationValues(suffix: string): {
  id: string;
  email: string;
  username: string;
  opaqueRegistration: Uint8Array;
  publicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
} {
  return {
    id: crypto.randomUUID(),
    email: `${PREFIX}${suffix}@identity-stores.test`,
    username: `${PREFIX}${suffix}`,
    opaqueRegistration: BYTES,
    publicKey: BYTES,
    passwordWrappedPrivateKey: BYTES,
    recoveryWrappedPrivateKey: BYTES,
  };
}

async function createUser(): Promise<{ id: string; email: string; username: string }> {
  counter += 1;
  const values = registrationValues(`u${String(counter)}`);
  const inserted = await stores.users.insertRegistered(values);
  const outcome = inserted._unsafeUnwrap();
  if (outcome.kind !== 'created') throw new Error('user seed failed');
  createdUserIds.push(outcome.userId);
  return { id: outcome.userId, email: values.email, username: values.username };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  // Deletion-event rows are anonymous by design; the run-unique userAgent
  // marker is the only handle this suite has on its own rows.
  await db.delete(accountDeletionEvents).where(like(accountDeletionEvents.userAgent, `${PREFIX}%`));
  await db.$client.end();
});

describe('identity stores: insertRegistered', () => {
  it('creates the user row with the caller-chosen id and unverified email', async () => {
    const values = registrationValues('ins');
    const inserted = await stores.users.insertRegistered(values);
    expect(inserted._unsafeUnwrap()).toEqual({ kind: 'created', userId: values.id });
    createdUserIds.push(values.id);
    const lookedUp = await stores.users.findById(values.id);
    const found = lookedUp._unsafeUnwrap();
    expect(found?.username).toBe(values.username);
    expect(found?.totpEnabled).toBe(false);
    expect(found?.lockedAt).toBeNull();
  });

  it('reports a duplicate email as email-taken', async () => {
    const existing = await createUser();
    const values = { ...registrationValues('dupe'), email: existing.email };
    const inserted = await stores.users.insertRegistered(values);
    expect(inserted._unsafeUnwrap()).toEqual({ kind: 'email-taken' });
  });

  it('reports a duplicate username as username-taken', async () => {
    const existing = await createUser();
    const values = { ...registrationValues('dupu'), username: existing.username };
    const inserted = await stores.users.insertRegistered(values);
    expect(inserted._unsafeUnwrap()).toEqual({ kind: 'username-taken' });
  });
});

describe('identity stores: lockForChargebackWithinTx', () => {
  it('locks a fresh account, returns locked + its email, and stamps locked_at + chargeback reason', async () => {
    const user = await createUser();
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, user.id)
    );
    expect(locked).toEqual({ locked: true, email: user.email });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('chargeback');
  });

  it('is a no-op on an already-locked account (no second transition)', async () => {
    const user = await createUser();
    const first = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, user.id)
    );
    expect(first).toEqual({ locked: true, email: user.email });
    const firstRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, user.id));
    const firstAt = firstRows[0]?.lockedAt;

    const second = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, user.id)
    );
    // The conditional UPDATE matched zero rows the second time: not locked, and
    // no email (the notification rides only the fresh transition).
    expect(second).toEqual({ locked: false, email: null });
    const secondRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, user.id));
    const secondAt = secondRows[0]?.lockedAt;
    // The original lock timestamp is untouched — the row was not re-written.
    expect(secondAt?.getTime()).toBe(firstAt?.getTime());
  });

  it('returns not-locked with a null email for an unknown user id', async () => {
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForChargebackWithinTx(tx, '00000000-0000-7000-8000-000000000000')
    );
    expect(locked).toEqual({ locked: false, email: null });
  });
});

describe('identity stores: lockUserWithinTx', () => {
  it('locks a fresh account with the admin reason, stamping both paired columns', async () => {
    const user = await createUser();
    const outcome = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'admin')
    );
    expect(outcome).toEqual({ kind: 'locked' });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('admin');
  });

  it('locks a fresh account with the chargeback reason', async () => {
    const user = await createUser();
    const outcome = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'chargeback')
    );
    expect(outcome).toEqual({ kind: 'locked' });
    const row = await db
      .select({ lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockReason).toBe('chargeback');
  });

  it('is a no-op on an already-locked account, reporting the original reason and timestamp', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'chargeback'));
    const firstRows = await db
      .select({ lockedAt: users.lockedAt })
      .from(users)
      .where(eq(users.id, user.id));
    const firstAt = firstRows[0]?.lockedAt;
    if (!firstAt) throw new Error('lock seed failed');

    const second = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'admin')
    );
    // The original reason and timestamp are never clobbered by a second lock.
    expect(second).toEqual({ kind: 'already-locked', lockedAt: firstAt, lockReason: 'chargeback' });
    const secondRows = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(secondRows[0]?.lockedAt?.getTime()).toBe(firstAt.getTime());
    expect(secondRows[0]?.lockReason).toBe('chargeback');
  });

  it('answers not-found for an unknown user id', async () => {
    const outcome = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, '00000000-0000-7000-8000-000000000000', 'admin')
    );
    expect(outcome).toEqual({ kind: 'not-found' });
  });
});

describe('identity stores: unlockUserWithinTx', () => {
  it('unlocks an admin-locked account and returns the prior reason', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'admin'));
    const outcome = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(outcome).toEqual({ kind: 'unlocked', priorLockReason: 'admin' });
    // Both columns clear together — the paired-null check constraint never
    // admits a half-cleared state.
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]).toEqual({ lockedAt: null, lockReason: null });
  });

  it('unlocks a chargeback-locked account and returns the prior reason', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'chargeback'));
    const outcome = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(outcome).toEqual({ kind: 'unlocked', priorLockReason: 'chargeback' });
  });

  it('is a no-op on an account that is not locked', async () => {
    const user = await createUser();
    const outcome = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(outcome).toEqual({ kind: 'not-locked' });
  });

  it('is a no-op on the second of two unlocks', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'admin'));
    const first = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(first).toEqual({ kind: 'unlocked', priorLockReason: 'admin' });
    const second = await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    expect(second).toEqual({ kind: 'not-locked' });
  });

  it('answers not-found for an unknown user id', async () => {
    const outcome = await runSettlement(db, (tx) =>
      stores.users.unlockUserWithinTx(tx, '00000000-0000-7000-8000-000000000000')
    );
    expect(outcome).toEqual({ kind: 'not-found' });
  });

  it('permits a fresh lock after an unlock (full round trip)', async () => {
    const user = await createUser();
    await runSettlement(db, (tx) => stores.users.lockUserWithinTx(tx, user.id, 'chargeback'));
    await runSettlement(db, (tx) => stores.users.unlockUserWithinTx(tx, user.id));
    const relocked = await runSettlement(db, (tx) =>
      stores.users.lockUserWithinTx(tx, user.id, 'admin')
    );
    expect(relocked).toEqual({ kind: 'locked' });
    const row = await db
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row[0]?.lockedAt).not.toBeNull();
    expect(row[0]?.lockReason).toBe('admin');
  });
});

describe('identity stores: lookups', () => {
  it('finds a user by lowercased email', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findByEmail(user.email);
    expect(lookedUp._unsafeUnwrap()?.id).toBe(user.id);
  });

  it('finds a user by normalized username', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findByUsername(user.username);
    expect(lookedUp._unsafeUnwrap()?.id).toBe(user.id);
  });

  it('returns null for an unknown email', async () => {
    const lookedUp = await stores.users.findByEmail(`${PREFIX}-nobody@x.test`);
    expect(lookedUp._unsafeUnwrap()).toBeNull();
  });

  it('returns null for an unknown user id', async () => {
    const lookedUp = await stores.users.findById('00000000-0000-7000-8000-000000000000');
    expect(lookedUp._unsafeUnwrap()).toBeNull();
  });

  it('round-trips the OPAQUE registration record bytes', async () => {
    const user = await createUser();
    const lookedUp = await stores.users.findById(user.id);
    const found = lookedUp._unsafeUnwrap();
    expect([...(found?.opaqueRegistration ?? [])]).toEqual([...BYTES]);
  });

  it('answers unavailable when the database is unreachable', async () => {
    const deadDb = createDb('postgres://postgres:postgres@127.0.0.1:9/hushbox', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    const result = await createIdentityStores(deadDb).users.findById(
      '00000000-0000-7000-8000-000000000000'
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('answers unavailable for an insert rejection that is no unique violation', async () => {
    const deadDb = createDb('postgres://postgres:postgres@127.0.0.1:9/hushbox', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    const result = await createIdentityStores(deadDb).users.insertRegistered(
      registrationValues('dead')
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('identity stores: account-deletion writes', () => {
  it('locks the users row and captures its email before the cascade', async () => {
    const user = await createUser();
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForDeletionWithinTx(tx, user.id)
    );
    expect(locked).toEqual({ email: user.email });
  });

  it('answers null for a user that no longer exists', async () => {
    const locked = await runSettlement(db, (tx) =>
      stores.users.lockForDeletionWithinTx(tx, '00000000-0000-7000-8000-000000000000')
    );
    expect(locked).toBeNull();
  });

  it('deletes the user and records the anonymous event in one transaction', async () => {
    const user = await createUser();
    const deletedAt = new Date();
    const userAgent = `${PREFIX}-agent`;

    await runSettlement(db, async (tx) => {
      await stores.users.insertDeletionEventWithinTx(tx, {
        deletedAt,
        ipAddress: '203.0.113.9',
        userAgent,
      });
      await stores.users.deleteUserWithinTx(tx, user.id);
    });

    const gone = await stores.users.findById(user.id);
    expect(gone._unsafeUnwrap()).toBeNull();
    const events = await db
      .select({
        deletedAt: accountDeletionEvents.deletedAt,
        ipAddress: accountDeletionEvents.ipAddress,
        userAgent: accountDeletionEvents.userAgent,
      })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, userAgent));
    expect(events).toEqual([{ deletedAt, ipAddress: '203.0.113.9', userAgent }]);
  });
});

describe('identity stores: consumeEmailVerification', () => {
  it('verifies exactly one of N concurrent consumers of the same token', async () => {
    const user = await createUser();
    const token = crypto.randomUUID();
    const issued = await stores.verification.issueEmailVerification(
      user.id,
      token,
      new Date(Date.now() + 60_000)
    );
    issued._unsafeUnwrap();
    // One client per consumer: a shared pool would serialize the transactions
    // and hide the race the DELETE arbiter exists to win.
    const racers = Array.from({ length: 4 }, () =>
      createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG })
    );
    try {
      const results = await Promise.all(
        racers.map((racer) =>
          createIdentityStores(racer).verification.consumeEmailVerification(token, new Date())
        )
      );
      const kinds = results.map((result) => result._unsafeUnwrap().kind);
      expect(kinds.filter((kind) => kind === 'verified')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'invalid')).toHaveLength(3);
    } finally {
      await Promise.all(racers.map((racer) => racer.$client.end()));
    }
  });
});
