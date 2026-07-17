import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `runSeed` orchestrates the audited `@hushbox/api/dev-seed` producers against a
// real local Postgres/Redis. Here the true external seams (DB client, Redis, the
// dev-seed producers, the OPAQUE crypto pool) are mocked so the orchestration
// logic — persona mapping, wallet-balance formatting, the screenshot/group-chat
// fan-out — is exercised deterministically without touching infrastructure.

const endSpy = vi.fn();
let walletRows: { id: string }[] = [{ id: 'wallet-1' }];
let cryptoResult: Uint8Array | undefined = new Uint8Array([1, 2, 3]);

const fakeDb = {
  select: () => ({ from: () => ({ where: () => Promise.resolve(walletRows) }) }),
  $client: { end: endSpy },
};

vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return { ...actual, createDb: vi.fn(() => fakeDb) };
});

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }));

const mintSeedUser = vi.fn(
  async (
    deps: { personaCrypto: (r: { credentialIdentifier: string }) => Promise<Uint8Array> },
    persona: { userId: string }
  ) => {
    // Exercise the warmed-crypto provider closure the real mint would call.
    await deps.personaCrypto({ credentialIdentifier: persona.userId });
    return { created: true };
  }
);

vi.mock('@hushbox/api/dev-seed', () => ({
  createBillingStores: vi.fn(() => ({})),
  createIdentityStores: vi.fn(() => ({})),
  createNoopSeedEmailPorts: vi.fn(() => ({ emailSender: {}, pushSender: {} })),
  createDevConversation: vi.fn(async () => {}),
  createDevGroupChat: vi.fn(async () => {}),
  mintSeedUser,
  seedAdminOpTargets: vi.fn(async () => {}),
  seedPaymentsHistory: vi.fn(async () => {}),
  seedUsageHistory: vi.fn(async () => {}),
  setWalletBalance: vi.fn(async () => {}),
}));

vi.mock('./lib/seed-crypto-pool.js', () => ({
  ensurePersonaCrypto: vi.fn(() => Promise.resolve({ get: () => cryptoResult })),
}));

vi.mock('./lib/seed-crypto-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/seed-crypto-cache.js')>();
  return { ...actual, computeCryptoFingerprint: vi.fn(() => Promise.resolve('fp')) };
});

const devSeed = await import('@hushbox/api/dev-seed');
const { runSeed } = await import('./seed.js');

const ENV_KEYS = [
  'DATABASE_URL',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'OPAQUE_MASTER_SECRET',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env['DATABASE_URL'] = 'postgres://postgres:postgres@localhost:5432/hushbox';
  process.env['UPSTASH_REDIS_REST_URL'] = 'http://localhost:8079';
  process.env['UPSTASH_REDIS_REST_TOKEN'] = 'token';
  process.env['OPAQUE_MASTER_SECRET'] = 'x'.repeat(64);
  walletRows = [{ id: 'wallet-1' }];
  cryptoResult = new Uint8Array([1, 2, 3]);
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('runSeed', () => {
  it('seeds everything in one pass: personas, balances, conversations, history, admin targets', async () => {
    await runSeed();

    // Both rosters minted personas and got authoritative balances.
    expect(mintSeedUser).toHaveBeenCalled();
    expect(devSeed.setWalletBalance).toHaveBeenCalled();
    // The screenshot fan-out hit both the solo and group factories.
    expect(devSeed.createDevConversation).toHaveBeenCalled();
    expect(devSeed.createDevGroupChat).toHaveBeenCalled();
    // Alice's billing history and admin op-targets were seeded.
    expect(devSeed.seedPaymentsHistory).toHaveBeenCalledTimes(1);
    expect(devSeed.seedUsageHistory).toHaveBeenCalledTimes(1);
    expect(devSeed.seedAdminOpTargets).toHaveBeenCalledTimes(1);
    // The connection is always closed.
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('sets authoritative balances for both the test and dev rosters', async () => {
    await runSeed();
    const emails = (devSeed.setWalletBalance as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[2] as { email: string }).email
    );
    expect(emails.some((email) => email.endsWith('@test.hushbox.ai'))).toBe(true);
    expect(emails.some((email) => email.endsWith('@dev.hushbox.ai'))).toBe(true);
  });

  it('formats a whole-dollar balance without a fraction and a negative balance with a sign', async () => {
    await runSeed();
    const balances = (
      devSeed.setWalletBalance as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => (call[2] as { balance: string }).balance);
    // The roster carries at least one whole-dollar balance and mallory's negative
    // (chargeback) balance — both formatting branches of nanoUsdToDecimalString.
    expect(balances.some((b) => !b.includes('.') && !b.startsWith('-'))).toBe(true);
    expect(balances.some((b) => b.startsWith('-'))).toBe(true);
  });

  it('falls back to the development-mode config secret when OPAQUE_MASTER_SECRET is unset', async () => {
    delete process.env['OPAQUE_MASTER_SECRET'];
    await expect(runSeed()).resolves.toBeUndefined();
    expect(mintSeedUser).toHaveBeenCalled();
  });

  it('closes the connection even when seeding throws', async () => {
    walletRows = [];
    await expect(runSeed()).rejects.toThrow('purchased wallet not found');
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when a required env var is missing', async () => {
    delete process.env['DATABASE_URL'];
    await expect(runSeed()).rejects.toThrow('DATABASE_URL is required');
  });

  it('rejects when the warmed crypto cache is missing a persona', async () => {
    cryptoResult = undefined;
    await expect(runSeed()).rejects.toThrow('no cached crypto');
  });
});
