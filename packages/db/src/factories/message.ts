import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { messages } from '../schema/messages';

type Message = typeof messages.$inferSelect;

export const messageFactory = Factory.define<Message>(() => ({
  id: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  role: faker.helpers.arrayElement(['user', 'assistant', 'system'] as const),
  content: faker.lorem.paragraphs(),
  model: faker.helpers.arrayElement([null, 'gpt-4', 'claude-3']),
  createdAt: faker.date.recent(),
}));
