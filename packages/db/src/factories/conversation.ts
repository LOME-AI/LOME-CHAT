import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { conversations } from '../schema/conversations';

type Conversation = typeof conversations.$inferSelect;

export const conversationFactory = Factory.define<Conversation>(() => ({
  id: faker.string.uuid(),
  userId: faker.string.uuid(),
  title: faker.lorem.sentence(),
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
