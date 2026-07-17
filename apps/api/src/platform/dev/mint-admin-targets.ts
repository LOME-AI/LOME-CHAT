import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  createOpaqueClient,
  createOpaqueServer,
  finishRegistration,
  generateKeyPair,
  startRegistration,
} from '@hushbox/crypto';
import { DEV_PASSWORD, textEncoder } from '@hushbox/shared';
import { okAsync } from '../../lib/result/index.js';
import { createBillingStores } from '../../slices/billing/index.js';
import { createIdentityStores } from '../../slices/identity/index.js';
import { DevSeedError, createDevConversation } from './factories.js';
import {
  applyChargebackLock,
  insertAdminTargetJob,
  insertAdminTargetRevokedShare,
  verifyAdminTargetJob,
  verifyAdminTargetRevokedShare,
  verifyChargebackLock,
} from './seed-admin-targets.js';
import { mintSeedUser } from './seed-user.js';
import type { SeedCryptoProvider } from './seed-user.js';
import type { Database } from '@hushbox/db';

/**
 * Fresh-id admin-op target minting behind `POST /dev/admin-targets`: every
 * call creates its own mutable rows (unique uuids/emails), so parallel E2E
 * specs mutate their private targets instead of racing over the fixed set
 * `seedAdminOpTargets` seeds. States and verification are shared with the
 * fixed seeder (`seed-admin-targets.ts`).
 */

export const ADMIN_TARGET_KINDS = [
  'lockedUser',
  'deadJob',
  'discardedJob',
  'revokedShare',
] as const;

export type AdminTargetKind = (typeof ADMIN_TARGET_KINDS)[number];

export interface MintedAdminTargets {
  readonly lockedUser?: { readonly userId: string; readonly email: string };
  readonly deadJob?: { readonly jobId: string };
  readonly discardedJob?: { readonly jobId: string };
  readonly revokedShare?: { readonly linkId: string; readonly conversationId: string };
}

/**
 * A throwaway secret, never the runtime OPAQUE binding: it backs the record
 * shape only, so a minted user is deliberately not OPAQUE-loginable against
 * the real server (the seeded fixed personas cover login flows).
 */
const DISPOSABLE_MASTER_SECRET = 'disposable-admin-target-master-secret';

/**
 * Disposable admin-target account crypto: a real (well-formed) OPAQUE record
 * minted against a throwaway server — registration validates the record
 * bytes, and P-256 OPAQUE is EC-only, so this stays fast — plus a REAL
 * X25519 keypair (epoch wraps on the share conversation need a valid public
 * key). The wrapped private keys are placeholders: skipping `createAccount`
 * avoids the Argon2 derivation, the one genuinely slow/memory-heavy step,
 * and no spec ever unwraps a disposable target's account key.
 */
const disposableCrypto: SeedCryptoProvider = async ({ credentialIdentifier, password }) => {
  const server = await createOpaqueServer(
    textEncoder.encode(DISPOSABLE_MASTER_SECRET),
    OPAQUE_SERVER_IDENTIFIER
  );
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, password);
  const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
  const response = await server.registerInit(request, credentialIdentifier);
  /* v8 ignore next -- type narrowing on the OPAQUE lib's union; registerInit
     with a well-formed request and fresh credential id cannot fail */
  if (response instanceof Error) throw response;
  const { record } = await finishRegistration(
    client,
    response.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );
  const keys = generateKeyPair();
  return {
    opaqueRegistration: new Uint8Array(record),
    publicKey: keys.publicKey,
    passwordWrappedPrivateKey: new Uint8Array([1]),
    recoveryWrappedPrivateKey: new Uint8Array([1]),
  };
};

/**
 * Mints a clearly-disposable user through the real registration settlement
 * (wallets + welcome credit + verified email) under a fresh random identity.
 */
async function mintDisposableUser(db: Database): Promise<{ userId: string; email: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const persona = {
    userId: crypto.randomUUID(),
    email: `admin-target-${suffix}@admin-targets.test`,
    username: `at${suffix}`,
    password: DEV_PASSWORD,
    emailVerified: true,
  };
  const minted = await mintSeedUser(
    {
      db,
      stores: createIdentityStores(db),
      billingStores: createBillingStores(),
      masterSecret: DISPOSABLE_MASTER_SECRET,
      personaCrypto: disposableCrypto,
      welcomeEmail: { sendWelcomeEmail: () => okAsync() },
      verificationEmail: { sendVerificationEmail: () => okAsync() },
    },
    persona
  );
  /* v8 ignore next 3 -- defensive: created:false needs a fresh random
     uuid/email/username collision, an unreachable state */
  if (!minted.created) {
    throw new DevSeedError(`mint admin targets: disposable user ${persona.email} not created`);
  }
  return { userId: persona.userId, email: persona.email };
}

async function mintLockedUser(db: Database): Promise<{ userId: string; email: string }> {
  const user = await mintDisposableUser(db);
  await applyChargebackLock(db, user.userId);
  await verifyChargebackLock(db, user.userId);
  return user;
}

async function mintJob(db: Database, discarded: boolean): Promise<{ jobId: string }> {
  const jobId = crypto.randomUUID();
  // The payload user id is schema-legal opacity, never dereferenced: a
  // redrive of media.reclaimUser with an empty key list is the idempotent
  // no-op regardless of the user existing.
  await insertAdminTargetJob(db, { id: jobId, payloadUserId: crypto.randomUUID(), discarded });
  await verifyAdminTargetJob(db, jobId, discarded);
  return { jobId };
}

async function mintRevokedShare(db: Database): Promise<{ linkId: string; conversationId: string }> {
  const owner = await mintDisposableUser(db);
  const { conversationId } = await createDevConversation(db, {
    ownerEmail: owner.email,
    // Unused: no messages are seeded, so no AI model row is ever written.
    seedAiModel: 'dev/unused-admin-target',
  });
  const linkId = crypto.randomUUID();
  await insertAdminTargetRevokedShare(db, {
    id: linkId,
    conversationId,
    linkPublicKey: generateKeyPair().publicKey,
  });
  await verifyAdminTargetRevokedShare(db, linkId);
  return { linkId, conversationId };
}

export async function mintAdminTargets(
  db: Database,
  kinds: readonly AdminTargetKind[]
): Promise<MintedAdminTargets> {
  const requested = new Set(kinds);
  return {
    ...(requested.has('lockedUser') ? { lockedUser: await mintLockedUser(db) } : {}),
    ...(requested.has('deadJob') ? { deadJob: await mintJob(db, false) } : {}),
    ...(requested.has('discardedJob') ? { discardedJob: await mintJob(db, true) } : {}),
    ...(requested.has('revokedShare') ? { revokedShare: await mintRevokedShare(db) } : {}),
  };
}
