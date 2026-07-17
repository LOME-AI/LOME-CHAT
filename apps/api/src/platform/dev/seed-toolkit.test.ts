import { describe, expect, it } from 'vitest';
import {
  createNoopSeedEmailPorts,
  createNoopSeedEmailPorts as reexportedFactory,
  mintSeedUser,
  refreshCatalog,
  seedPaymentsHistory,
  seedUsageHistory,
  setWalletBalance,
  usdToNanoUsd,
} from './seed-toolkit.js';

describe('createNoopSeedEmailPorts', () => {
  it('returns best-effort no-op welcome and verification email ports', () => {
    const ports = createNoopSeedEmailPorts();
    expect(ports.welcomeEmail.sendWelcomeEmail).toBeTypeOf('function');
    expect(ports.verificationEmail.sendVerificationEmail).toBeTypeOf('function');
  });

  it('resolves the welcome-email port to a success result', async () => {
    const ports = createNoopSeedEmailPorts();
    const result = await ports.welcomeEmail.sendWelcomeEmail();
    expect(result.isOk()).toBe(true);
  });

  it('resolves the verification-email port to a success result', async () => {
    const ports = createNoopSeedEmailPorts();
    const result = await ports.verificationEmail.sendVerificationEmail();
    expect(result.isOk()).toBe(true);
  });

  it('mints an independent port pair on each call', () => {
    expect(createNoopSeedEmailPorts()).not.toBe(reexportedFactory());
  });
});

describe('seed-toolkit barrel', () => {
  it('re-exports the DI-shaped seed and catalog surface consumed by scripts/seed.ts', () => {
    for (const value of [
      mintSeedUser,
      refreshCatalog,
      seedPaymentsHistory,
      seedUsageHistory,
      setWalletBalance,
      usdToNanoUsd,
    ]) {
      expect(value).toBeTypeOf('function');
    }
  });
});
