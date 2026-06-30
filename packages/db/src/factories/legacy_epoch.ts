import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { epochs } from '../schema/epochs';

type Epoch = typeof epochs.$inferSelect;

export const epochFactory = Factory.define<Epoch>(({ params }) => {
  const epochNumber = params.epochNumber ?? 1;

  return {
    id: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    epochNumber,
    epochPublicKey: placeholderBytes(32),
    confirmationHash: placeholderBytes(32),
    chainLink: epochNumber > 1 ? placeholderBytes(64) : null,
    createdAt: faker.date.recent(),
  };
});
