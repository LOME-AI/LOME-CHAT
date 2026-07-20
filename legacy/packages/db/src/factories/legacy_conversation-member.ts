import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { conversationMembers } from '../schema/conversation-members';

type ConversationMember = typeof conversationMembers.$inferSelect;

export const conversationMemberFactory = Factory.define<ConversationMember>(() => ({
  id: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  linkId: null,
  privilege: faker.helpers.arrayElement(['read', 'write', 'admin', 'owner']),
  visibleFromEpoch: 1,
  joinedAt: faker.date.recent(),
  leftAt: null,
  acceptedAt: faker.date.recent(),
  muted: false,
  pinned: false,
  invitedByUserId: null,
}));
