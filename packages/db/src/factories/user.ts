import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { users } from '../schema/users';

type User = typeof users.$inferSelect;

export const userFactory = Factory.define<User>(() => ({
  id: faker.string.uuid(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
