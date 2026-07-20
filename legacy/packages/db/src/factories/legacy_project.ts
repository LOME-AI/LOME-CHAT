import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { projects } from '../schema/legacy_projects';

type Project = typeof projects.$inferSelect;

export const projectFactory = Factory.define<Project>(() => ({
  id: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  encryptedName: placeholderBytes(32),
  encryptedDescription: faker.helpers.arrayElement([null, placeholderBytes(64)]),
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
