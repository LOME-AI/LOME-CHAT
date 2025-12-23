import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { users } from '../schema/users';

type User = typeof users.$inferSelect;

export const userFactory = Factory.define<User>(() => ({
  id: crypto.randomUUID(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  emailVerified: false,
  image: null,
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
