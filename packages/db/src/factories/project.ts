import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { projects } from '../schema/projects';

type Project = typeof projects.$inferSelect;

export const projectFactory = Factory.define<Project>(() => ({
  id: faker.string.uuid(),
  userId: faker.string.uuid(),
  name: faker.commerce.productName(),
  description: faker.helpers.arrayElement([null, faker.lorem.sentence()]),
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
