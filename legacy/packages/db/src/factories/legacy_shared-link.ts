import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { sharedLinks } from '../schema/shared-links';

type SharedLink = typeof sharedLinks.$inferSelect;

export const sharedLinkFactory = Factory.define<SharedLink>(() => ({
  id: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  linkPublicKey: placeholderBytes(32),
  displayName: null,
  revokedAt: null,
  createdAt: faker.date.recent(),
}));
