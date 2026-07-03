import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
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
