import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { users } from '../schema/users';

type NewUser = typeof users.$inferInsert;

/**
 * Builds insertable `users` rows against the current schema. The sequence
 * keeps email/username unique across builds (both columns are UNIQUE).
 */
export const userFactory = Factory.define<NewUser>(({ sequence }) => ({
  email: `user-${String(sequence)}-${faker.string.alphanumeric(8)}@example.com`,
  // varchar(20) unique
  username: `u${String(sequence)}_${faker.string.alphanumeric(6)}`.toLowerCase().slice(0, 20),
  opaqueRegistration: placeholderBytes(64),
  publicKey: placeholderBytes(32),
  passwordWrappedPrivateKey: placeholderBytes(48),
  recoveryWrappedPrivateKey: placeholderBytes(48),
}));

/** Locked account: sets the paired lock columns together (check constraint). */
export const lockedUserFactory = Factory.define<NewUser>(() => ({
  ...userFactory.build(),
  lockedAt: faker.date.recent(),
  lockReason: 'admin',
}));
