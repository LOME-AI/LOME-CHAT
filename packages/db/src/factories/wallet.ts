import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { wallets } from '../schema/wallets';

type NewWallet = typeof wallets.$inferInsert;

/**
 * Builds insertable `wallets` rows. `userId` defaults to null (the column is
 * nullable — SET NULL pseudonymization); pass a real user id to satisfy the
 * UNIQUE(userId, type) pairing in integration tests.
 */
export const walletFactory = Factory.define<NewWallet>(() => ({
  userId: null,
  type: 'purchased',
  balanceNanoUsd: 0n,
}));

/** Negative balance — a legal state (settlement is never balance-guarded). */
export const negativeBalanceWalletFactory = Factory.define<NewWallet>(() => ({
  ...walletFactory.build(),
  balanceNanoUsd: BigInt(faker.number.int({ min: 1, max: 5_000_000 })) * -1000n,
}));
