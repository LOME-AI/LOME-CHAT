import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, ledgerEntries, users, wallets } from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  createAccount,
  createOpaqueClient,
  createOpaqueServer,
  decryptAndVerifyTotp,
  finishRegistration,
  generateTotpCodeSync,
  generateTotpSecret,
  startRegistration,
} from '@hushbox/crypto';
import { DEV_PASSWORD, normalizeUsername, textEncoder } from '@hushbox/shared';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createBillingStores } from '../../slices/billing/index.js';
import { createIdentityStores } from '../../slices/identity/index.js';
import { mintSeedUser } from './seed-user.js';
import type { WelcomeEmailPort } from '../../slices/billing/index.js';
import type { VerificationEmailPort } from '../../slices/identity/index.js';
import type { MintSeedUserDeps, SeedCryptoProvider, SeedUserPersona } from './seed-user.js';

// Real infra: the OPAQUE handshake + Argon2 account derivation is genuinely
// slow, so every mint takes a couple of seconds.
const SLOW = 60_000;

// A fixed dev master secret backs BOTH the OPAQUE record (via the crypto
// provider's server) and the TOTP encryption key (via deps.masterSecret) —
// they MUST be the same value or a real login / stored-secret decrypt fails.
const MASTER_SECRET = 'seed-user-test-master-secret-0123456789abcdef';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for seed-user integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

const welcomeEmail: WelcomeEmailPort = { sendWelcomeEmail: () => okAsync() };
const verificationEmail: VerificationEmailPort = { sendVerificationEmail: () => okAsync() };

const createdUserIds: string[] = [];

function suffix(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 10);
}

function makePersona(
  overrides: Partial<SeedUserPersona> & { readonly tag: string }
): SeedUserPersona {
  const s = suffix();
  const persona: SeedUserPersona = {
    userId: crypto.randomUUID(),
    email: `seed-${overrides.tag}-${s}@seed-user.test`,
    username: `s${overrides.tag}${s}`,
    password: DEV_PASSWORD,
    emailVerified: true,
    ...overrides,
  };
  createdUserIds.push(persona.userId);
  return persona;
}

let deps: MintSeedUserDeps;

beforeAll(async () => {
  const opaqueServer = await createOpaqueServer(
    textEncoder.encode(MASTER_SECRET),
    OPAQUE_SERVER_IDENTIFIER
  );
  // Mirrors scripts/lib/seed-crypto-pool.ts generateOne — the same real
  // primitives the cached pool the seed orchestrator wires uses. apps/api
  // cannot import scripts/, so the test composes the crypto directly.
  const personaCrypto: SeedCryptoProvider = async ({ credentialIdentifier, password }) => {
    const client = createOpaqueClient();
    const { serialized } = await startRegistration(client, password);
    const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
    const serverResult = await opaqueServer.registerInit(request, credentialIdentifier);
    if (serverResult instanceof Error) throw serverResult;
    const { record, exportKey } = await finishRegistration(
      client,
      serverResult.serialize(),
      OPAQUE_SERVER_IDENTIFIER
    );
    const account = await createAccount(new Uint8Array(exportKey));
    return {
      opaqueRegistration: new Uint8Array(record),
      publicKey: account.publicKey,
      passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey: account.recoveryWrappedPrivateKey,
    };
  };

  deps = {
    db,
    stores: createIdentityStores(db),
    billingStores: createBillingStores(),
    masterSecret: MASTER_SECRET,
    personaCrypto,
    welcomeEmail,
    verificationEmail,
  };
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Delete BOTH welcome-credit legs (user + house) together so each
    // transaction stays zero-sum — the ledger balance trigger fires on DELETE.
    const welcomeKeys = createdUserIds.flatMap((id) => [
      `welcome:${id}:user`,
      `welcome:${id}:house`,
    ]);
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.idempotencyKey, welcomeKeys));
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    // verification_tokens cascade on the users delete.
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('mintSeedUser', () => {
  it(
    'registers a persona as a real user with the persona identity, verified flag, and two wallets',
    async () => {
      const persona = makePersona({ tag: 'v', emailVerified: true });

      const result = await mintSeedUser(deps, persona);

      expect(result).toEqual({ userId: persona.userId, created: true });

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.email).toBe(persona.email.toLowerCase());
      expect(row?.username).toBe(normalizeUsername(persona.username));
      expect(row?.emailVerified).toBe(true);

      const walletRows = await db.select().from(wallets).where(eq(wallets.userId, persona.userId));
      expect(walletRows).toHaveLength(2);
    },
    SLOW
  );

  it(
    'is idempotent — re-minting the same persona returns created:false and never duplicates',
    async () => {
      const persona = makePersona({ tag: 'i', emailVerified: true });

      const first = await mintSeedUser(deps, persona);
      expect(first.created).toBe(true);

      const second = await mintSeedUser(deps, persona);
      expect(second).toEqual({ userId: persona.userId, created: false });

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      expect(rows).toHaveLength(1);
    },
    SLOW
  );

  it(
    'enrolls TOTP so a code from the persona secret validates via the real verify path',
    async () => {
      const totpSecret = generateTotpSecret();
      const persona = makePersona({ tag: 't', emailVerified: false, totpSecret });

      const result = await mintSeedUser(deps, persona);
      expect(result.created).toBe(true);

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      const row = rows[0];
      expect(row?.totpEnabled).toBe(true);
      expect(row?.totpSecretEncrypted).not.toBeNull();

      const verdict = await decryptAndVerifyTotp({
        masterSecret: textEncoder.encode(MASTER_SECRET),
        encryptedSecret: new Uint8Array(row?.totpSecretEncrypted ?? new Uint8Array()),
        code: generateTotpCodeSync(totpSecret),
        now: new Date(),
      });
      expect(verdict.ok).toBe(true);
    },
    SLOW
  );

  it('throws when the existing-user lookup fails', async () => {
    const persona = makePersona({ tag: 'lookuperr', emailVerified: true });
    const failing: MintSeedUserDeps = {
      ...deps,
      stores: {
        ...deps.stores,
        users: { ...deps.stores.users, findById: () => errAsync(unavailableError('db down')) },
      },
    };
    await expect(mintSeedUser(failing, persona)).rejects.toThrow(/lookup existing user/);
  });

  it(
    'resolves created:false when registration finds the email already taken',
    async () => {
      const first = makePersona({ tag: 'race1', emailVerified: true });
      expect((await mintSeedUser(deps, first)).created).toBe(true);

      // A distinct userId (so the fast-path lookup misses) but the same email:
      // the registration settlement is the authoritative duplicate arbiter.
      const rival = makePersona({ tag: 'race2', emailVerified: true, email: first.email });
      const result = await mintSeedUser(deps, rival);
      expect(result).toEqual({ userId: rival.userId, created: false });
    },
    SLOW
  );

  it(
    'throws when a verified persona has no issued verification token',
    async () => {
      const persona = makePersona({ tag: 'notoken', emailVerified: true });
      const noToken: MintSeedUserDeps = {
        ...deps,
        stores: {
          ...deps.stores,
          verification: {
            ...deps.stores.verification,
            findLatestVerificationToken: () => okAsync(null),
          },
        },
      };
      await expect(mintSeedUser(noToken, persona)).rejects.toThrow(/no verification token/);
    },
    SLOW
  );

  it(
    'throws when the verification token does not verify',
    async () => {
      const persona = makePersona({ tag: 'badverify', emailVerified: true });
      const unverifiable: MintSeedUserDeps = {
        ...deps,
        stores: {
          ...deps.stores,
          verification: {
            ...deps.stores.verification,
            consumeEmailVerification: () => okAsync({ kind: 'invalid' as const }),
          },
        },
      };
      await expect(mintSeedUser(unverifiable, persona)).rejects.toThrow(/did not verify/);
    },
    SLOW
  );

  it(
    'throws when TOTP is already enabled for the persona',
    async () => {
      const persona = makePersona({
        tag: 'totpdup',
        emailVerified: false,
        totpSecret: generateTotpSecret(),
      });
      const alreadyEnabled: MintSeedUserDeps = {
        ...deps,
        stores: {
          ...deps.stores,
          users: { ...deps.stores.users, enableTotp: () => okAsync('already-enabled' as const) },
        },
      };
      await expect(mintSeedUser(alreadyEnabled, persona)).rejects.toThrow(/totp was already enabled/);
    },
    SLOW
  );
});
