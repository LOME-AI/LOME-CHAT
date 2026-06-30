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
  const outcome = (await stores.users.insertRegistered(values))._unsafeUnwrap();
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
    const outcome = (await stores.users.insertRegistered(values))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'created', userId: values.id });
    createdUserIds.push(values.id);
    const found = (await stores.users.findById(values.id))._unsafeUnwrap();
    expect(found?.username).toBe(values.username);
    expect(found?.totpEnabled).toBe(false);
    expect(found?.lockedAt).toBeNull();
  });

  it('reports a duplicate email as email-taken', async () => {
    const existing = await createUser();
    const values = { ...registrationValues('dupe'), email: existing.email };
    const outcome = (await stores.users.insertRegistered(values))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'email-taken' });
  });

  it('reports a duplicate username as username-taken', async () => {
    const existing = await createUser();
    const values = { ...registrationValues('dupu'), username: existing.username };
    const outcome = (await stores.users.insertRegistered(values))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'username-taken' });
  });
});

describe('identity stores: lookups', () => {
  it('finds a user by lowercased email', async () => {
    const user = await createUser();
    const found = (await stores.users.findByEmail(user.email))._unsafeUnwrap();
    expect(found?.id).toBe(user.id);
  });

  it('finds a user by normalized username', async () => {
    const user = await createUser();
    const found = (await stores.users.findByUsername(user.username))._unsafeUnwrap();
    expect(found?.id).toBe(user.id);
  });

  it('returns null for an unknown email', async () => {
    const found = (await stores.users.findByEmail(`${PREFIX}-nobody@x.test`))._unsafeUnwrap();
    expect(found).toBeNull();
  });

  it('returns null for an unknown user id', async () => {
    const found = (
      await stores.users.findById('00000000-0000-7000-8000-000000000000')
    )._unsafeUnwrap();
    expect(found).toBeNull();
  });

  it('round-trips the OPAQUE registration record bytes', async () => {
    const user = await createUser();
    const found = (await stores.users.findById(user.id))._unsafeUnwrap();
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
});
