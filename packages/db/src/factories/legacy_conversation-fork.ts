import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { conversationForks } from '../schema/conversation-forks';

type ConversationFork = typeof conversationForks.$inferSelect;

export const conversationForkFactory = Factory.define<ConversationFork>(() => ({
  id: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  name: faker.helpers.arrayElement(['Main', 'Fork 1', 'Fork 2']),
  tipMessageId: null,
  createdAt: faker.date.recent(),
}));
