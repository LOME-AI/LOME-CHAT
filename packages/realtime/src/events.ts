import { z } from 'zod';
import { MEMBER_PRIVILEGES } from '@hushbox/shared';

export const messageNewEventSchema = z.object({
  type: z.literal('message:new'),
  timestamp: z.number(),
  messageId: z.string(),
  conversationId: z.string(),
  senderType: z.enum(['user', 'ai']),
  senderId: z.string().optional(),
  modelName: z.string().optional(),
  sequenceNumber: z.number().optional(),
  content: z.string().optional(),
});

export const messageStreamEventSchema = z.object({
  type: z.literal('message:stream'),
  timestamp: z.number(),
  messageId: z.string(),
  token: z.string(),
  modelName: z.string().optional(),
  senderId: z.string().optional(),
});

export const messageCompleteEventSchema = z.object({
  type: z.literal('message:complete'),
  timestamp: z.number(),
  messageId: z.string(),
  conversationId: z.string(),
  sequenceNumber: z.number(),
  epochNumber: z.number(),
  modelName: z.string().optional(),
});

export const messageDeletedEventSchema = z.object({
  type: z.literal('message:deleted'),
  timestamp: z.number(),
  messageId: z.string(),
  conversationId: z.string(),
});

export const memberAddedEventSchema = z.object({
  type: z.literal('member:added'),
  timestamp: z.number(),
  conversationId: z.string(),
  memberId: z.string(),
  userId: z.string().optional(),
  linkId: z.string().optional(),
  privilege: z.enum(MEMBER_PRIVILEGES),
});

export const memberRemovedEventSchema = z.object({
  type: z.literal('member:removed'),
  timestamp: z.number(),
  conversationId: z.string(),
  memberId: z.string(),
  userId: z.string().optional(),
  linkId: z.string().optional(),
});

export const memberPrivilegeChangedEventSchema = z.object({
  type: z.literal('member:privilege-changed'),
  timestamp: z.number(),
  conversationId: z.string(),
  memberId: z.string(),
  privilege: z.enum(MEMBER_PRIVILEGES),
});

export const rotationCompleteEventSchema = z.object({
  type: z.literal('rotation:complete'),
  timestamp: z.number(),
  conversationId: z.string(),
  newEpochNumber: z.number(),
});

export const typingStartEventSchema = z.object({
  type: z.literal('typing:start'),
  timestamp: z.number(),
  conversationId: z.string(),
  userId: z.string(),
});

export const typingStopEventSchema = z.object({
  type: z.literal('typing:stop'),
  timestamp: z.number(),
  conversationId: z.string(),
  userId: z.string(),
});

export const presenceUpdateEventSchema = z.object({
  type: z.literal('presence:update'),
  timestamp: z.number(),
  conversationId: z.string(),
  members: z.array(
    z.object({
      userId: z.string().optional(),
      displayName: z.string().optional(),
      isGuest: z.boolean(),
      connectedAt: z.number(),
    })
  ),
});

export const forkCreatedEventSchema = z.object({
  type: z.literal('fork:created'),
  timestamp: z.number(),
  forkId: z.string(),
  conversationId: z.string(),
  name: z.string(),
  tipMessageId: z.string().nullable(),
});

export const forkDeletedEventSchema = z.object({
  type: z.literal('fork:deleted'),
  timestamp: z.number(),
  forkId: z.string(),
  conversationId: z.string(),
});

export const forkRenamedEventSchema = z.object({
  type: z.literal('fork:renamed'),
  timestamp: z.number(),
  forkId: z.string(),
  conversationId: z.string(),
  name: z.string(),
});

export const messagesDeletedEventSchema = z.object({
  type: z.literal('messages:deleted'),
  timestamp: z.number(),
  conversationId: z.string(),
  deletedMessageIds: z.array(z.string()),
});

export const realtimeEventSchema = z.discriminatedUnion('type', [
  messageNewEventSchema,
  messageStreamEventSchema,
  messageCompleteEventSchema,
  messageDeletedEventSchema,
  memberAddedEventSchema,
  memberRemovedEventSchema,
  memberPrivilegeChangedEventSchema,
  rotationCompleteEventSchema,
  typingStartEventSchema,
  typingStopEventSchema,
  presenceUpdateEventSchema,
  forkCreatedEventSchema,
  forkDeletedEventSchema,
  forkRenamedEventSchema,
  messagesDeletedEventSchema,
]);

export type MessageNewEvent = z.infer<typeof messageNewEventSchema>;
export type MessageStreamEvent = z.infer<typeof messageStreamEventSchema>;
export type MessageCompleteEvent = z.infer<typeof messageCompleteEventSchema>;
export type MessageDeletedEvent = z.infer<typeof messageDeletedEventSchema>;
export type MemberAddedEvent = z.infer<typeof memberAddedEventSchema>;
export type MemberRemovedEvent = z.infer<typeof memberRemovedEventSchema>;
export type MemberPrivilegeChangedEvent = z.infer<typeof memberPrivilegeChangedEventSchema>;
export type RotationCompleteEvent = z.infer<typeof rotationCompleteEventSchema>;
export type TypingStartEvent = z.infer<typeof typingStartEventSchema>;
export type TypingStopEvent = z.infer<typeof typingStopEventSchema>;
export type PresenceUpdateEvent = z.infer<typeof presenceUpdateEventSchema>;
export type ForkCreatedEvent = z.infer<typeof forkCreatedEventSchema>;
export type ForkDeletedEvent = z.infer<typeof forkDeletedEventSchema>;
export type ForkRenamedEvent = z.infer<typeof forkRenamedEventSchema>;
export type MessagesDeletedEvent = z.infer<typeof messagesDeletedEventSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export type RealtimeEventType = RealtimeEvent['type'];

export function createEvent<T extends RealtimeEventType>(
  type: T,
  data: Omit<Extract<RealtimeEvent, { type: T }>, 'type' | 'timestamp'>
): RealtimeEvent {
  return { type, timestamp: Date.now(), ...data } as unknown as RealtimeEvent;
}

export function parseEvent(data: string): RealtimeEvent {
  const parsed: unknown = JSON.parse(data);
  return realtimeEventSchema.parse(parsed);
}
