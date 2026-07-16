import { deriveTotpEncryptionKey, encryptTotpSecret } from '@hushbox/crypto';
import { normalizeUsername, textEncoder } from '@hushbox/shared';
// The account INSERT + wallet/welcome-credit provisioning is the real
// registration settlement (§8 single-settlement), published on the identity
// barrel so this dev-only tool composes it through the slice's public surface.
import { completeRegistration } from '../../slices/identity/index.js';
import type { BillingStores, WelcomeEmailPort } from '../../slices/billing/index.js';
import type { IdentityStores, VerificationEmailPort } from '../../slices/identity/index.js';
import type { Result } from '../../lib/result/index.js';
import type { Database } from '@hushbox/db';

/**
 * Real per-persona OPAQUE + account crypto, shaped exactly like the cached
 * `scripts/lib/seed-crypto-pool.ts` output. The seed orchestrator wires this to
 * the cached pool (`ensurePersonaCrypto`) for speed; `mintSeedUser` never
 * computes crypto itself, so apps/api stays free of the scripts/ dependency the
 * cache lives behind.
 */
export interface SeedPersonaCrypto {
  readonly opaqueRegistration: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly recoveryWrappedPrivateKey: Uint8Array;
}

export type SeedCryptoProvider = (request: {
  readonly credentialIdentifier: string;
  readonly password: string;
}) => Promise<SeedPersonaCrypto>;

export interface SeedUserPersona {
  /** Deterministic, caller-supplied — becomes the users PK and OPAQUE credential id. */
  readonly userId: string;
  readonly email: string;
  readonly username: string;
  readonly password: string;
  readonly emailVerified: boolean;
  /** Present only for 2FA personas; the exact secret to enroll (not regenerated). */
  readonly totpSecret?: string;
}

export interface MintSeedUserDeps {
  readonly db: Database;
  readonly stores: IdentityStores;
  readonly billingStores: BillingStores;
  /**
   * The OPAQUE master secret. MUST be the runtime value backing `personaCrypto`
   * (the OPAQUE record) — it also derives the TOTP encryption key here, so a
   * mismatch makes real login or stored-secret decryption fail.
   */
  readonly masterSecret: string;
  readonly personaCrypto: SeedCryptoProvider;
  /** Best-effort ports (no-op/console in dev) — registration fires them outside the tx. */
  readonly welcomeEmail: WelcomeEmailPort;
  readonly verificationEmail: VerificationEmailPort;
  /** Injectable clock for token expiry / verification timestamps (default Date.now). */
  readonly now?: () => number;
}

export interface MintSeedUserResult {
  readonly userId: string;
  readonly created: boolean;
}

function value<T, E>(result: Result<T, E>, step: string): T {
  if (result.isErr()) throw new Error(`seed-user: ${step} failed`);
  return result.value;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Registers a persona as a production-faithful, OPAQUE-authenticatable user
 * (wallets + welcome credit via the real registration settlement), then, per
 * persona, marks the email verified and enrolls TOTP through the same store
 * paths the identity slice uses. Idempotent: an already-minted persona
 * (deterministic userId, or a duplicate email/username) resolves to
 * `created:false` and touches nothing.
 */
export async function mintSeedUser(
  deps: MintSeedUserDeps,
  persona: SeedUserPersona
): Promise<MintSeedUserResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const email = persona.email.toLowerCase();
  const username = normalizeUsername(persona.username);

  // Fast-path skip so a re-mint avoids the expensive crypto compute; the
  // settlement INSERT below stays the authoritative duplicate arbiter.
  const existing = value(await deps.stores.users.findById(persona.userId), 'lookup existing user');
  if (existing !== null) return { userId: persona.userId, created: false };

  const cryptoBytes = await deps.personaCrypto({
    credentialIdentifier: persona.userId,
    password: persona.password,
  });

  const outcome = value(
    await completeRegistration({
      db: deps.db,
      store: deps.stores.users,
      billingStores: deps.billingStores,
      verificationStore: deps.stores.verification,
      welcomeEmail: deps.welcomeEmail,
      verificationEmail: deps.verificationEmail,
      pending: { userId: persona.userId, email, username },
      registrationRecord: [...cryptoBytes.opaqueRegistration],
      accountPublicKey: toBase64(cryptoBytes.publicKey),
      passwordWrappedPrivateKey: toBase64(cryptoBytes.passwordWrappedPrivateKey),
      recoveryWrappedPrivateKey: toBase64(cryptoBytes.recoveryWrappedPrivateKey),
      now: nowMs,
    }),
    'register user'
  );

  // A racing duplicate resolves to email-/username-taken with nothing written.
  if (outcome.kind !== 'created') return { userId: persona.userId, created: false };

  if (persona.emailVerified) {
    await markEmailVerified(deps, email, new Date(nowMs));
  }

  if (persona.totpSecret !== undefined) {
    await enrollTotp(deps, persona.userId, persona.totpSecret);
  }

  return { userId: persona.userId, created: true };
}

/**
 * The dev verify-email path: consume the single-use token registration issued
 * as a best-effort side effect. Fail-fast if it is absent or does not verify —
 * a seeded persona flagged verified must actually be verified.
 */
async function markEmailVerified(deps: MintSeedUserDeps, email: string, now: Date): Promise<void> {
  const token = value(
    await deps.stores.verification.findLatestVerificationToken(email, now),
    'find verification token'
  );
  if (token === null) throw new Error('seed-user: registration issued no verification token');
  const outcome = value(
    await deps.stores.verification.consumeEmailVerification(token, now),
    'consume verification token'
  );
  if (outcome.kind !== 'verified') throw new Error('seed-user: email verification did not verify');
}

/**
 * The server's TOTP confirm step, minus the interactive pending-state round
 * trip: derive the key from the master secret, encrypt the persona's known
 * secret, and flip the account on via the atomic conditional enable.
 */
async function enrollTotp(deps: MintSeedUserDeps, userId: string, secret: string): Promise<void> {
  const key = deriveTotpEncryptionKey(textEncoder.encode(deps.masterSecret));
  const encryptedSecret = encryptTotpSecret(secret, key);
  const outcome = value(
    await deps.stores.users.enableTotp(userId, new Uint8Array(encryptedSecret)),
    'enable totp'
  );
  if (outcome !== 'enabled') throw new Error('seed-user: totp was already enabled');
}
