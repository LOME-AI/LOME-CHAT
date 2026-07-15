import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { sharedLinks } from '../schema/shared-links';

type NewSharedLink = typeof sharedLinks.$inferInsert;

/**
 * Builds insertable `shared_links` rows. `conversationId` defaults to a
 * random uuid — pass a real conversation id when inserting (NOT NULL FK).
 */
export const sharedLinkFactory = Factory.define<NewSharedLink>(() => ({
  conversationId: crypto.randomUUID(),
  linkPublicKey: placeholderBytes(32),
  displayName: faker.person.firstName(),
}));

/** Revoked link — enforced lazily at the read path. */
export const revokedSharedLinkFactory = Factory.define<NewSharedLink>(() => ({
  ...sharedLinkFactory.build(),
  revokedAt: faker.date.recent(),
}));
