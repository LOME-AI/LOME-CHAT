import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { wallets } from '../schema/wallets';

type Wallet = typeof wallets.$inferSelect;

export const walletFactory = Factory.define<Wallet>(() => ({
  id: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  type: faker.helpers.arrayElement(['purchased', 'free_tier']),
  balance: faker.number.float({ min: 0, max: 500, fractionDigits: 8 }).toFixed(8),
  priority: faker.helpers.arrayElement([0, 1]),
  createdAt: faker.date.recent(),
}));
