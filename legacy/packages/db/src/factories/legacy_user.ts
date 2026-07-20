import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';

import { placeholderBytes } from './helpers.js';
import type { users } from '../schema/users';

type User = typeof users.$inferSelect;

export const userFactory = Factory.define<User>(() => ({
  id: crypto.randomUUID(),
  email: faker.internet.email(),
  username: faker.internet
    .username()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, '_')
    .replaceAll(/^[^a-z]/g, 'u')
    .slice(0, 20)
    .padEnd(3, '_'),
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),

  emailVerified: false,
  emailVerifyToken: null,
  emailVerifyExpires: null,

  opaqueRegistration: placeholderBytes(64),

  totpSecretEncrypted: null,
  totpEnabled: false,

  hasAcknowledgedPhrase: false,
  customInstructionsEncrypted: null,

  publicKey: placeholderBytes(32),
  passwordWrappedPrivateKey: placeholderBytes(48),
  recoveryWrappedPrivateKey: placeholderBytes(48),

  accessibilityPreferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
  accessibilityPreferencesUpdatedAt: faker.date.recent(),
}));
