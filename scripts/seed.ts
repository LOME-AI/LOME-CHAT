/**
 * `pnpm db:seed` — the unified seed orchestrator.
 *
 * The composition root: it builds the real infra clients (Neon via the dev
 * driver, Upstash Redis), resolves the runtime OPAQUE master secret, warms the
 * fingerprint-keyed OPAQUE crypto cache, and drives the audited in-process
 * producers from `@hushbox/api/dev-seed`.
 *
 * It also re-exports the persona roster + derivations the E2E/mobile harnesses
 * import from `scripts/seed.js`, so the whole seed surface has one entry point.
 *
 * There is exactly ONE seed path (matching the legacy seed): every run seeds
 * everything, idempotently — every `TEST_PERSONAS` row + the mobile persona
 * (with correct verified flags and 2FA enrollment), the dev personas with
 * alice's rich billing history, the screenshot conversations, charlie's
 * conversation, the admin op-target states, authoritative wallet balances
 * for every persona, and the anonymous public-/stats usage spread with its
 * snapshot (written through the real cron entry). No flags, no profiles, no
 * branching.
 *
 * Model catalog: `model_catalog` is populated out-of-band by `catalog:refresh`
 * (the real, live OpenRouter refresh — the same job the hourly cron runs),
 * which the pipeline runs BEFORE `db:seed` (see `e2e:prepare` / `pnpm dev`).
 * Seeding therefore assumes the catalog is already populated: the dev
 * group-chat factory (`pickSeedTextModels`) and the app's model picker read
 * those exposed descriptors. There are no pinned, hand-authored descriptors —
 * the catalog is always real/live.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb, wallets, type Database } from '@hushbox/db';
import {
  DEV_EMAIL_DOMAIN,
  DEV_PASSWORD,
  Mode,
  TEST_EMAIL_DOMAIN,
  envConfig,
  resolveRaw,
} from '@hushbox/shared';
import {
  createBillingStores,
  createCatalogModelMetaResolver,
  createConsoleTelemetry,
  createDevConversation,
  createDevGroupChat,
  createIdentityStores,
  createNoopSeedEmailPorts,
  createPublicStatsSnapshotEntry,
  createPublicStatsStores,
  mintSeedUser,
  seedAdminOpTargets,
  seedPaymentsHistory,
  seedPublicUsageRecords,
  seedUsageHistory,
  setWalletBalance,
  upsertCatalog,
} from '@hushbox/api/dev-seed';
import {
  ALICE_PAYMENT_SPECS,
  ALICE_USAGE_SPECS,
  PUBLIC_USAGE_SPECS,
  SCREENSHOT_CONVERSATIONS,
} from './lib/seed-fixtures.js';
import { DEV_PERSONAS, MOBILE_TEST_PERSONA, TEST_PERSONAS, seedUUID } from './lib/seed-personas.js';
import { assertSeededImageModelPresent } from './lib/e2e-models.js';
import { seededImageModelUpsert } from './lib/e2e-seeded-image-model.js';
import { CACHE_VERSION, computeCryptoFingerprint } from './lib/seed-crypto-cache.js';
import { ensurePersonaCrypto } from './lib/seed-crypto-pool.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import type { FixtureMessageSpec } from './lib/seed-fixtures.js';
import type { DevPersona, SeededTestPersona } from './lib/seed-personas.js';
import type { MintSeedUserDeps, SeedCryptoProvider, SeedUserPersona } from '@hushbox/api/dev-seed';

// Re-export the persona roster + derivations for the harnesses that import them
// from `scripts/seed.js` (e2e/auth.setup, e2e/helpers/personas, auth-2fa spec,
// mobile flows). Kept as local re-exports so the single import above is their
// one source.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const CACHE_DIR = path.join(REPO_ROOT, 'scripts', '.cache', 'seed-crypto');
const CRYPTO_SRC_DIR = path.join(REPO_ROOT, 'packages', 'crypto', 'src');

/**
 * A known model id stamped on seeded AI messages. `model_id` is a plain text
 * column with no FK to `model_catalog`, but this id is one the live catalog
 * (populated by `catalog:refresh`) exposes, so a seeded turn references a model
 * the picker renders.
 */
const SEED_MODEL_ID = 'anthropic/claude-opus-4.6';

/**
 * Dedicated admin-plane op-target persona for the dev profile: minted like
 * any dev persona, then placed in the states the admin ops act on —
 * chargeback-locked (`user.unlock`) with a negative purchased balance
 * (`wallet.credit`). Kept out of `DEV_PERSONAS` so demo flows never log in
 * as a locked user.
 */
export const ADMIN_TARGET_PERSONA: DevPersona = {
  name: 'mallory',
  displayName: 'Mallory Quinn',
  emailVerified: true,
  hasSampleData: false,
  balanceNanoUsd: -2_500_000_000n,
};

/** Charlie's small standalone conversation (legacy parity: a non-empty convo). */
const CHARLIE_CONV_MESSAGES: readonly { content: string; senderType: 'user' | 'ai' }[] = [
  { content: 'What is the difference between TCP and UDP?', senderType: 'user' },
  {
    content:
      'TCP is connection-oriented and reliable (ordered, retransmitted delivery); UDP is connectionless and best-effort (lower latency, no delivery guarantees).',
    senderType: 'ai',
  },
];

// `new URL('postgres://[::1]:5432/db').hostname` returns the bracketed form
// `[::1]`, so the bracketed literal — not the bare `::1` — is what the allowlist
// check sees for an IPv6-loopback dev DB.
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export const SEED_REMOTE_REFUSAL_MESSAGE =
  'Refusing to seed: DATABASE_URL does not point at a local database. ' +
  'The seed is local-development only and must never run against a remote (production) database.';

/**
 * The seed is local-development only. An unparseable URL is not provably local,
 * so it fails closed (treated as remote).
 */
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }
  return LOCAL_DATABASE_HOSTS.has(host);
}

/** Fail-closed guard: a remote (non-local) DATABASE_URL aborts before any write. */
export function assertLocalDatabaseUrl(databaseUrl: string): void {
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new Error(SEED_REMOTE_REFUSAL_MESSAGE);
  }
}

/**
 * The seed takes no arguments — every run seeds everything. Fail fast on any
 * argument (especially the removed `--profile` flag) instead of silently
 * ignoring it and seeding something the caller did not expect.
 */
export function assertNoSeedArgs(argv: readonly string[]): void {
  const first = argv[0];
  if (first === undefined) return;
  if (first === '--profile') {
    throw new Error(
      'seed: profiles were removed — `pnpm db:seed` seeds everything; drop the --profile flag'
    );
  }
  throw new Error(`seed: unexpected argument "${first}" (the seed takes no arguments)`);
}

/** Upstash Redis client for the authoritative-balance writes (`setWalletBalance`). */
function createSeedRedis(): Redis {
  return new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`seed: ${name} is required (run pnpm generate:env)`);
  }
  return value;
}

/**
 * The runtime OPAQUE master secret. Prefer the process env `with-env` injects;
 * fall back to the development-mode config value. It MUST be the value backing
 * both the cached persona crypto and `mintSeedUser`'s TOTP key derivation — one
 * source feeds both, so they can never diverge.
 */
function resolveMasterSecret(): string {
  const fromEnv = process.env['OPAQUE_MASTER_SECRET'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const resolved = resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development);
  /* v8 ignore next 3 -- defensive: the development-mode config always resolves OPAQUE_MASTER_SECRET to a non-empty string */
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error('seed: OPAQUE_MASTER_SECRET could not be resolved');
  }
  return resolved;
}

function devEmail(name: string): string {
  return `${name}@${DEV_EMAIL_DOMAIN}`;
}

function testEmail(name: string): string {
  return `${name}@${TEST_EMAIL_DOMAIN}`;
}

/** Nano-USD `bigint` → decimal USD string (up to 9 places), for `setWalletBalance`. */
function nanoUsdToDecimalString(nanoUsd: bigint): string {
  const negative = nanoUsd < 0n;
  const magnitude = negative ? -nanoUsd : nanoUsd;
  const whole = magnitude / 1_000_000_000n;
  const fraction = (magnitude % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  const value = fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
  return negative ? `-${value}` : value;
}

function daysAgoDate(now: Date, daysAgo: number, hour = 0, minute = 0): Date {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function toTestSeedPersona(persona: SeededTestPersona): SeedUserPersona {
  const email = testEmail(persona.name);
  return {
    userId: seedUUID(email),
    email,
    username: persona.username,
    password: DEV_PASSWORD,
    emailVerified: persona.emailVerified,
    ...(persona.totpSecret === null ? {} : { totpSecret: persona.totpSecret }),
  };
}

function toDevSeedPersona(persona: DevPersona): SeedUserPersona {
  const email = devEmail(persona.name);
  return {
    userId: seedUUID(email),
    email,
    // `mintSeedUser` normalizes the username; the dev roster carries a display
    // name, mirroring the legacy seed's `normalizeUsername(displayName)`.
    username: persona.displayName,
    password: DEV_PASSWORD,
    emailVerified: persona.emailVerified,
  };
}

function devPersonaByName(name: string): DevPersona {
  const persona = DEV_PERSONAS.find((candidate) => candidate.name === name);
  /* v8 ignore next -- defensive: only ever called with a name known to be in DEV_PERSONAS */
  if (persona === undefined) throw new Error(`seed: dev persona "${name}" is not defined`);
  return persona;
}

function baseMintDeps(
  db: Database,
  masterSecret: string,
  personaCrypto: SeedCryptoProvider
): MintSeedUserDeps {
  return {
    db,
    stores: createIdentityStores(db),
    billingStores: createBillingStores(),
    masterSecret,
    personaCrypto,
    ...createNoopSeedEmailPorts(),
  };
}

/**
 * Warms the parallel, fingerprint-keyed OPAQUE cache for a persona set and
 * returns the provider `mintSeedUser` calls. The provider is keyed by
 * `credentialIdentifier`, which is the persona's deterministic `userId`.
 */
async function warmPersonaCrypto(
  masterSecret: string,
  personas: readonly SeedUserPersona[]
): Promise<SeedCryptoProvider> {
  const requests = personas.map((persona) => ({
    credentialIdentifier: persona.userId,
    password: persona.password,
  }));
  const cryptoFingerprint = await computeCryptoFingerprint(CRYPTO_SRC_DIR);
  const cryptoByCredentialId = await ensurePersonaCrypto(requests, {
    cacheDir: CACHE_DIR,
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint,
    masterSecret,
  });
  return ({ credentialIdentifier }) => {
    const bytes = cryptoByCredentialId.get(credentialIdentifier);
    if (bytes === undefined) {
      throw new Error(`seed: no cached crypto for "${credentialIdentifier}"`);
    }
    return Promise.resolve(bytes);
  };
}

async function mintAll(
  deps: MintSeedUserDeps,
  personas: readonly SeedUserPersona[]
): Promise<{ processed: number; created: number }> {
  let created = 0;
  for (const persona of personas) {
    const result = await mintSeedUser(deps, persona);
    if (result.created) created += 1;
  }
  return { processed: personas.length, created };
}

function toFactoryMessage(message: FixtureMessageSpec): {
  content: string;
  senderType: 'user' | 'ai';
} {
  return { content: message.text, senderType: message.sender === 'ai' ? 'ai' : 'user' };
}

/** Seeds the five curated screenshot conversations; returns their ids in order. */
async function seedScreenshotConversations(db: Database): Promise<string[]> {
  const conversationIds: string[] = [];
  for (const spec of SCREENSHOT_CONVERSATIONS) {
    const id = seedUUID(spec.seedKey);
    if (spec.members === undefined) {
      await createDevConversation(db, {
        ownerEmail: devEmail(spec.ownerPersona),
        seedAiModel: SEED_MODEL_ID,
        id,
        messages: spec.messages.map((message) => toFactoryMessage(message)),
      });
    } else {
      await createDevGroupChat(db, {
        ownerEmail: devEmail(spec.ownerPersona),
        memberEmails: spec.members
          .filter((name) => name !== spec.ownerPersona)
          .map((name) => devEmail(name)),
        seedAiModel: SEED_MODEL_ID,
        id,
        messages: spec.messages.map((message) => ({
          content: message.text,
          senderType: message.sender === 'ai' ? ('ai' as const) : ('user' as const),
          senderEmail: message.sender === 'ai' ? undefined : devEmail(message.sender),
        })),
      });
    }
    conversationIds.push(id);
  }
  return conversationIds;
}

async function purchasedWalletId(db: Database, userId: string): Promise<string> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.type, 'purchased')));
  if (row === undefined) throw new Error(`seed: purchased wallet not found for user ${userId}`);
  return row.id;
}

/**
 * Alice's rich billing history — 14 backdated payments and 200 backdated usage
 * records — attributed to her first seeded conversation. Runs before the
 * authoritative balance set so the final displayed balance is clean.
 */
async function seedAliceBillingHistory(
  db: Database,
  aliceUserId: string,
  conversationId: string,
  now: Date
): Promise<void> {
  const walletId = await purchasedWalletId(db, aliceUserId);
  await seedPaymentsHistory(
    { db },
    {
      userId: aliceUserId,
      purchasedWalletId: walletId,
      payments: ALICE_PAYMENT_SPECS.map((spec, index) => ({
        stableKey: `alice-payment-${index.toString()}`,
        amountNanoUsd: spec.amountNanoUsd,
        cardType: spec.cardType,
        cardLastFour: spec.cardLastFour,
        helcimTransactionId: `hlcm-alice-${(index + 1).toString()}`,
        createdAt: daysAgoDate(now, spec.daysAgo),
      })),
    }
  );
  await seedUsageHistory(
    { db },
    {
      userId: aliceUserId,
      walletId,
      conversationId,
      records: ALICE_USAGE_SPECS.map((spec) => ({
        stableKey: `alice-usage-${spec.index.toString()}`,
        modelId: spec.model,
        providerName: spec.provider,
        modality: 'text' as const,
        baseCostNanoUsd: spec.costNanoUsd,
        tokens: {
          inputTokens: spec.inputTokens,
          outputTokens: spec.outputTokens,
          cachedInputTokens: spec.cachedTokens,
        },
        createdAt: daysAgoDate(now, spec.daysAgo, spec.hour, spec.minute),
      })),
    }
  );
}

/** Mints the E2E roster (all Playwright-project variants + mobile) with authoritative balances. */
async function seedTestPersonas(db: Database, redis: Redis, masterSecret: string): Promise<void> {
  const testPersonas: SeededTestPersona[] = [...TEST_PERSONAS, MOBILE_TEST_PERSONA];
  const personas = testPersonas.map((persona) => toTestSeedPersona(persona));
  const personaCrypto = await warmPersonaCrypto(masterSecret, personas);
  const deps = baseMintDeps(db, masterSecret, personaCrypto);
  const { processed, created } = await mintAll(deps, personas);

  // Authoritative purchased-wallet balances, set last (same mechanism as the dev
  // roster). This overrides the mint's $0.20 welcome credit so a live AI send —
  // the composer defaults to Smart Model, whose admission hold exceeds the
  // welcome credit — doesn't 402. A `0n` balance (test-bob) is set explicitly to
  // zero the welcome credit; the group-billing suite requires him broke.
  for (const persona of testPersonas) {
    await setWalletBalance(db, redis, {
      email: testEmail(persona.name),
      walletType: 'purchased',
      balance: nanoUsdToDecimalString(persona.balanceNanoUsd),
    });
  }
  console.log(
    `seed[test personas]: ${processed.toString()} personas processed, ${created.toString()} newly created; ${testPersonas.length.toString()} wallet balances set.`
  );
}

/**
 * Mints the dev roster (+ mallory) and seeds its data: screenshot conversations,
 * charlie's conversation, alice's billing history, admin op-target states, and
 * authoritative balances.
 */
async function seedDevData(db: Database, redis: Redis, masterSecret: string): Promise<void> {
  const now = new Date();
  const devRoster = [...DEV_PERSONAS, ADMIN_TARGET_PERSONA];
  const personas = devRoster.map((persona) => toDevSeedPersona(persona));
  const personaCrypto = await warmPersonaCrypto(masterSecret, personas);
  const deps = baseMintDeps(db, masterSecret, personaCrypto);
  const { processed, created } = await mintAll(deps, personas);

  const conversationIds = await seedScreenshotConversations(db);
  await createDevConversation(db, {
    ownerEmail: devEmail('charlie'),
    seedAiModel: SEED_MODEL_ID,
    id: seedUUID('charlie-conv-1'),
    messages: [...CHARLIE_CONV_MESSAGES],
  });

  const alice = devPersonaByName('alice');
  const aliceConversationId = conversationIds[0];
  /* v8 ignore next 3 -- defensive: SCREENSHOT_CONVERSATIONS is a non-empty constant, so index 0 is always present */
  if (aliceConversationId === undefined) {
    throw new Error('seed: no screenshot conversation available for alice usage history');
  }
  await seedAliceBillingHistory(db, seedUUID(devEmail(alice.name)), aliceConversationId, now);

  // Admin-plane op-target states (verified by query inside the seeder):
  // chargeback-locked mallory, a dead job, a discarded job, and a revoked
  // share on charlie's conversation; mallory's negative balance lands in the
  // authoritative-balance loop below.
  await seedAdminOpTargets(db, {
    lockedUserEmail: devEmail(ADMIN_TARGET_PERSONA.name),
    conversationId: seedUUID('charlie-conv-1'),
  });

  // Authoritative final balances, set last so the payment/usage history does not
  // drift the displayed balance.
  for (const persona of devRoster) {
    await setWalletBalance(db, redis, {
      email: devEmail(persona.name),
      walletType: 'purchased',
      balance: nanoUsdToDecimalString(persona.balanceNanoUsd),
    });
  }
  console.log(
    `seed[dev]: ${processed.toString()} personas processed, ${created.toString()} newly created; ${conversationIds.length.toString()} screenshot + 1 charlie conversation; alice billing history; admin op-target states.`
  );
}

/**
 * Anonymous public-/stats data: backdated user-less `usage_records` from the
 * deterministic fixture spread, then a snapshot produced through the REAL
 * path — the same `public-stats-snapshot` cron entry the Worker runs daily,
 * composed from the real billing stores and the live-catalog meta resolver
 * (never hand-crafted snapshot jsonb). Image records carry the
 * deterministic-estimate flag, matching production image-charge semantics.
 */
async function seedPublicStats(db: Database): Promise<void> {
  const now = new Date();
  const { usageRecordsCreated } = await seedPublicUsageRecords(
    { db },
    {
      records: PUBLIC_USAGE_SPECS.map((spec) => ({
        stableKey: `public-usage-${spec.index.toString()}`,
        modelId: spec.model,
        providerName: spec.provider,
        modality: spec.modality,
        costNanoUsd: spec.costNanoUsd,
        isEstimated: spec.modality === 'image',
        createdAt: daysAgoDate(now, spec.daysAgo, spec.hour, spec.minute),
      })),
    }
  );
  const entry = createPublicStatsSnapshotEntry({
    db,
    stores: createPublicStatsStores(),
    now: () => new Date(),
    resolveModelMeta: createCatalogModelMetaResolver({ db, telemetry: createConsoleTelemetry() }),
  });
  await entry.run();
  console.log(
    `seed[public stats]: ${usageRecordsCreated.toString()} usage records created; snapshot written via the ${entry.name} cron entry.`
  );
}

/**
 * Injects the one synthetic strict-image catalog row through the models slice's
 * published `upsertCatalog` (single-writer boundary — never a raw insert). The
 * live `catalog:refresh` exposes only one ZDR strict-image model, so this second
 * exposed id is what lets the multi-model image fan-out select two distinct
 * models. Asserted present afterward so a broken descriptor fails the seed loud,
 * not mid-test. The seed's local-DB guard keeps this row out of production.
 */
async function seedSyntheticImageModel(db: Database): Promise<void> {
  const result = await upsertCatalog(db, seededImageModelUpsert(new Date()));
  if (result.isErr()) {
    throw new Error(`seed: synthetic image model upsert failed — ${result.error.message}`);
  }
  await assertSeededImageModelPresent(db);
  console.log('seed[catalog]: synthetic strict-image model upserted.');
}

/** The one seed path: seeds everything, idempotently (legacy-parity single pass). */
export async function runSeed(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  assertLocalDatabaseUrl(databaseUrl);
  const masterSecret = resolveMasterSecret();
  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
  try {
    // `model_catalog` is populated out-of-band by `catalog:refresh` before this
    // runs (see `e2e:prepare` / `pnpm dev`): the dev conversation factories and
    // the app's model picker read those exposed descriptors, and the E2E
    // per-test dev routes depend on them. Test personas first, dev data second
    // (the order the combined seed has always used); balances are set after
    // each roster's mint so the authoritative values land last.
    const redis = createSeedRedis();
    await seedSyntheticImageModel(db);
    await seedTestPersonas(db, redis, masterSecret);
    await seedDevData(db, redis, masterSecret);
    await seedPublicStats(db);
  } finally {
    await db.$client.end();
  }
}

/* v8 ignore start -- CLI wiring; the pure helpers are unit-tested, seeding proven by the E2E run */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    assertNoSeedArgs(process.argv.slice(2));
    await runSeed();
  });
}
/* v8 ignore stop */

export {
  BASE_TEST_PERSONAS,
  E2E_PROJECT_NAMES,
  TEST_2FA_TOTP_SECRET,
  testPersonaName,
  type E2EProjectName,
  TEST_PERSONAS,
  DEV_PERSONAS,
  MOBILE_TEST_PERSONA,
  seedUUID,
  pooledPersonaName,
  POOLED_PERSONA_BASE_NAMES,
  E2E_WORKER_POOL_SIZE,
} from './lib/seed-personas.js';
