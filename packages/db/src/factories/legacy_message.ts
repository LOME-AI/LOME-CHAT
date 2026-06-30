import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { messages } from '../schema/messages';

type Message = typeof messages.$inferSelect;

// Approximate ECIES-wrapped content key size (1 version + 32 ephemeral pub + 32 content key + 16 tag).
const WRAPPED_CONTENT_KEY_BYTES = 81;

export const messageFactory = Factory.define<Message>(({ params }) => {
  const senderType = params.senderType ?? faker.helpers.arrayElement(['user', 'ai'] as const);
  return {
    id: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    senderType,
    senderId: crypto.randomUUID(),
    wrappedContentKey: placeholderBytes(WRAPPED_CONTENT_KEY_BYTES),
    epochNumber: 1,
    sequenceNumber: faker.number.int({ min: 1, max: 1000 }),
    parentMessageId: null,
    batchId: crypto.randomUUID(),
    createdAt: faker.date.recent(),
  };
});
