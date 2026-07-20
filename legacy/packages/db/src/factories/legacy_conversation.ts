import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { conversations } from '../schema/conversations';

type Conversation = typeof conversations.$inferSelect;

export const conversationFactory = Factory.define<Conversation>(() => ({
  id: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  title: placeholderBytes(32),
  projectId: null,
  titleEpochNumber: 1,
  currentEpoch: 1,
  nextSequence: 1,
  conversationBudget: '0.00',
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
