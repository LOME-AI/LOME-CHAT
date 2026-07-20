import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { epochMembers } from '../schema/epoch-members';

type EpochMember = typeof epochMembers.$inferSelect;

export const epochMemberFactory = Factory.define<EpochMember>(() => ({
  id: crypto.randomUUID(),
  epochId: crypto.randomUUID(),
  memberPublicKey: placeholderBytes(32),
  wrap: placeholderBytes(48),
  visibleFromEpoch: 1,
  createdAt: faker.date.recent(),
}));
