import { describe, it, expect } from 'vitest';

import { userFactory, lockedUserFactory } from './user';
import { walletFactory, negativeBalanceWalletFactory } from './wallet';
import { jobFactory, deadJobFactory, discardedJobFactory } from './job';
import { sharedLinkFactory, revokedSharedLinkFactory } from './shared-link';

describe('userFactory', () => {
  it('builds a user with unique identity fields across builds', () => {
    const a = userFactory.build();
    const b = userFactory.build();
    expect(a.email).not.toBe(b.email);
    expect(a.username).not.toBe(b.username);
    expect(a.username.length).toBeLessThanOrEqual(20);
    expect(a.publicKey).toBeInstanceOf(Uint8Array);
    expect(a.lockedAt ?? null).toBeNull();
  });

  it('locked trait sets the paired lock columns together', () => {
    const locked = lockedUserFactory.build();
    expect(locked.lockedAt).toBeInstanceOf(Date);
    expect(locked.lockReason).toBe('admin');
  });
});

describe('walletFactory', () => {
  it('builds a zero-balance purchased wallet by default', () => {
    const wallet = walletFactory.build();
    expect(wallet.balanceNanoUsd).toBe(0n);
    expect(wallet.type).toBe('purchased');
  });

  it('negative-balance trait builds a wallet below zero', () => {
    const wallet = negativeBalanceWalletFactory.build();
    expect(wallet.balanceNanoUsd).toBeLessThan(0n);
  });
});

describe('jobFactory', () => {
  it('builds a pending job with the dispatcher counters', () => {
    const job = jobFactory.build();
    expect(job.status).toBe('pending');
    expect(job.maxClaims).toBeGreaterThan(0);
    expect(job.maxFailures).toBeGreaterThan(0);
    expect(job.leaseSeconds).toBeGreaterThan(0);
  });

  it('dead trait builds an exhausted dead row', () => {
    const job = deadJobFactory.build();
    expect(job.status).toBe('dead');
    expect(job.failures).toBe(job.maxFailures);
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(job.discardedAt ?? null).toBeNull();
  });

  it('discarded trait builds a dead row with the restorable marker', () => {
    const job = discardedJobFactory.build();
    expect(job.status).toBe('dead');
    expect(job.discardedAt).toBeInstanceOf(Date);
  });
});

describe('sharedLinkFactory', () => {
  it('builds a live link with unique key material', () => {
    const a = sharedLinkFactory.build();
    const b = sharedLinkFactory.build();
    expect(a.linkPublicKey).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(a.linkPublicKey).equals(Buffer.from(b.linkPublicKey))).toBe(false);
    expect(a.revokedAt ?? null).toBeNull();
  });

  it('revoked trait sets revokedAt', () => {
    const link = revokedSharedLinkFactory.build();
    expect(link.revokedAt).toBeInstanceOf(Date);
  });
});
