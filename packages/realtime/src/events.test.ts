import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MEMBER_PRIVILEGES } from '@hushbox/shared';
import {
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
  realtimeEventSchema,
  createEvent,
  parseEvent,
} from './events.js';
import type {
  MessageNewEvent,
  MessageStreamEvent,
  MessageCompleteEvent,
  MessageDeletedEvent,
  MemberAddedEvent,
  MemberRemovedEvent,
  MemberPrivilegeChangedEvent,
  RotationCompleteEvent,
  TypingStartEvent,
  TypingStopEvent,
  PresenceUpdateEvent,
  RealtimeEvent,
  RealtimeEventType,
} from './events.js';

describe('events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('messageNewEventSchema', () => {
    it('validates a valid message:new event with all fields', () => {
      const event = {
        type: 'message:new' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user' as const,
        senderId: 'user-1',
        modelName: 'test-model',
        sequenceNumber: 5,
      };
      const result = messageNewEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('validates a message:new event with only required fields', () => {
      const event = {
        type: 'message:new' as const,
        timestamp: Date.now(),
        messageId: 'msg-2',
        conversationId: 'conv-2',
        senderType: 'ai' as const,
      };
      const result = messageNewEventSchema.parse(event);
      expect(result.type).toBe('message:new');
      expect(result.senderId).toBeUndefined();
      expect(result.modelName).toBeUndefined();
      expect(result.sequenceNumber).toBeUndefined();
    });

    it('validates a message:new event with optional content field', () => {
      const event = {
        type: 'message:new' as const,
        timestamp: Date.now(),
        messageId: 'msg-3',
        conversationId: 'conv-3',
        senderType: 'user' as const,
        senderId: 'user-1',
        content: 'Hello from Alice',
      };
      const result = messageNewEventSchema.parse(event);
      expect(result.content).toBe('Hello from Alice');
    });

    it('allows message:new without content field', () => {
      const event = {
        type: 'message:new' as const,
        timestamp: Date.now(),
        messageId: 'msg-4',
        conversationId: 'conv-4',
        senderType: 'user' as const,
      };
      const result = messageNewEventSchema.parse(event);
      expect(result.content).toBeUndefined();
    });

    it('rejects a message:new event with wrong type literal', () => {
      const event = {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
      };
      expect(() => messageNewEventSchema.parse(event)).toThrow();
    });

    it('rejects a message:new event with invalid senderType', () => {
      const event = {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'system',
      };
      expect(() => messageNewEventSchema.parse(event)).toThrow();
    });

    it('rejects a message:new event missing required messageId', () => {
      const event = {
        type: 'message:new',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        senderType: 'user',
      };
      expect(() => messageNewEventSchema.parse(event)).toThrow();
    });
  });

  describe('messageStreamEventSchema', () => {
    it('validates a valid message:stream event', () => {
      const event = {
        type: 'message:stream' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'Hello',
      };
      const result = messageStreamEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('accepts modelName for AI message streaming', () => {
      const event = {
        type: 'message:stream' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'Hello',
        modelName: 'GPT-4o',
      };
      const result = messageStreamEventSchema.parse(event);
      expect(result.modelName).toBe('GPT-4o');
    });

    it('accepts message:stream without modelName', () => {
      const event = {
        type: 'message:stream' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'Hello',
      };
      const result = messageStreamEventSchema.parse(event);
      expect(result.modelName).toBeUndefined();
    });

    it('rejects a message:stream event missing token', () => {
      const event = {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'msg-1',
      };
      expect(() => messageStreamEventSchema.parse(event)).toThrow();
    });

    it('accepts senderId so clients can filter own-sender broadcasts', () => {
      const event = {
        type: 'message:stream' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'Hello',
        senderId: 'user-42',
      };
      const result = messageStreamEventSchema.parse(event);
      expect(result.senderId).toBe('user-42');
    });

    it('accepts message:stream without senderId', () => {
      const event = {
        type: 'message:stream' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'Hello',
      };
      const result = messageStreamEventSchema.parse(event);
      expect(result.senderId).toBeUndefined();
    });
  });

  describe('messageCompleteEventSchema', () => {
    it('validates a valid message:complete event', () => {
      const event = {
        type: 'message:complete' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 10,
        epochNumber: 3,
      };
      const result = messageCompleteEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('accepts modelName for AI message completion', () => {
      const event = {
        type: 'message:complete' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 10,
        epochNumber: 3,
        modelName: 'Claude 3.5 Sonnet',
      };
      const result = messageCompleteEventSchema.parse(event);
      expect(result.modelName).toBe('Claude 3.5 Sonnet');
    });

    it('accepts message:complete without modelName', () => {
      const event = {
        type: 'message:complete' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 10,
        epochNumber: 3,
      };
      const result = messageCompleteEventSchema.parse(event);
      expect(result.modelName).toBeUndefined();
    });

    it('rejects a message:complete event missing epochNumber', () => {
      const event = {
        type: 'message:complete',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 10,
      };
      expect(() => messageCompleteEventSchema.parse(event)).toThrow();
    });

    it('rejects a message:complete event with non-number sequenceNumber', () => {
      const event = {
        type: 'message:complete',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 'ten',
        epochNumber: 3,
      };
      expect(() => messageCompleteEventSchema.parse(event)).toThrow();
    });
  });

  describe('messageDeletedEventSchema', () => {
    it('validates a valid message:deleted event', () => {
      const event = {
        type: 'message:deleted' as const,
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
      };
      const result = messageDeletedEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('rejects a message:deleted event missing conversationId', () => {
      const event = {
        type: 'message:deleted',
        timestamp: Date.now(),
        messageId: 'msg-1',
      };
      expect(() => messageDeletedEventSchema.parse(event)).toThrow();
    });
  });

  describe('memberAddedEventSchema', () => {
    it('validates a member:added event with all fields', () => {
      const event = {
        type: 'member:added' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        userId: 'user-1',
        linkId: 'link-1',
        privilege: 'admin' as const,
      };
      const result = memberAddedEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('validates a member:added event with only required fields', () => {
      const event = {
        type: 'member:added' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'read' as const,
      };
      const result = memberAddedEventSchema.parse(event);
      expect(result.userId).toBeUndefined();
      expect(result.linkId).toBeUndefined();
    });

    it('derives its privilege values from the single shared MEMBER_PRIVILEGES source', () => {
      expect(memberAddedEventSchema.shape.privilege.options).toEqual([...MEMBER_PRIVILEGES]);
      expect(memberPrivilegeChangedEventSchema.shape.privilege.options).toEqual([
        ...MEMBER_PRIVILEGES,
      ]);
    });

    it('validates all privilege levels', () => {
      const privileges = MEMBER_PRIVILEGES;
      for (const privilege of privileges) {
        const event = {
          type: 'member:added' as const,
          timestamp: Date.now(),
          conversationId: 'conv-1',
          memberId: 'mem-1',
          privilege,
        };
        const result = memberAddedEventSchema.parse(event);
        expect(result.privilege).toBe(privilege);
      }
    });

    it('rejects an invalid privilege level', () => {
      const event = {
        type: 'member:added',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'superadmin',
      };
      expect(() => memberAddedEventSchema.parse(event)).toThrow();
    });
  });

  describe('memberRemovedEventSchema', () => {
    it('validates a valid member:removed event', () => {
      const event = {
        type: 'member:removed' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        userId: 'user-1',
        linkId: 'link-1',
      };
      const result = memberRemovedEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('validates a member:removed event with only required fields', () => {
      const event = {
        type: 'member:removed' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
      };
      const result = memberRemovedEventSchema.parse(event);
      expect(result.userId).toBeUndefined();
      expect(result.linkId).toBeUndefined();
    });
  });

  describe('memberPrivilegeChangedEventSchema', () => {
    it('validates a member:privilege-changed event with all fields', () => {
      const event = {
        type: 'member:privilege-changed' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'write' as const,
      };
      const result = memberPrivilegeChangedEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('validates all privilege levels', () => {
      const privileges = ['read', 'write', 'admin', 'owner'] as const;
      for (const privilege of privileges) {
        const event = {
          type: 'member:privilege-changed' as const,
          timestamp: Date.now(),
          conversationId: 'conv-1',
          memberId: 'mem-1',
          privilege,
        };
        const result = memberPrivilegeChangedEventSchema.parse(event);
        expect(result.privilege).toBe(privilege);
      }
    });

    it('rejects an invalid privilege level', () => {
      const event = {
        type: 'member:privilege-changed',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'superadmin',
      };
      expect(() => memberPrivilegeChangedEventSchema.parse(event)).toThrow();
    });

    it('rejects a member:privilege-changed event missing memberId', () => {
      const event = {
        type: 'member:privilege-changed',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        privilege: 'write',
      };
      expect(() => memberPrivilegeChangedEventSchema.parse(event)).toThrow();
    });
  });

  describe('rotationCompleteEventSchema', () => {
    it('validates a valid rotation:complete event', () => {
      const event = {
        type: 'rotation:complete' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        newEpochNumber: 4,
      };
      const result = rotationCompleteEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('rejects a rotation:complete event missing newEpochNumber', () => {
      const event = {
        type: 'rotation:complete',
        timestamp: Date.now(),
        conversationId: 'conv-1',
      };
      expect(() => rotationCompleteEventSchema.parse(event)).toThrow();
    });
  });

  describe('typingStartEventSchema', () => {
    it('validates a valid typing:start event', () => {
      const event = {
        type: 'typing:start' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const result = typingStartEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('rejects a typing:start event missing userId', () => {
      const event = {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
      };
      expect(() => typingStartEventSchema.parse(event)).toThrow();
    });
  });

  describe('typingStopEventSchema', () => {
    it('validates a valid typing:stop event', () => {
      const event = {
        type: 'typing:stop' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const result = typingStopEventSchema.parse(event);
      expect(result).toEqual(event);
    });

    it('rejects a typing:stop event missing userId', () => {
      const event = {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
      };
      expect(() => typingStopEventSchema.parse(event)).toThrow();
    });
  });

  describe('presenceUpdateEventSchema', () => {
    it('validates a valid presence:update event with members', () => {
      const event = {
        type: 'presence:update' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [
          {
            userId: 'user-1',
            displayName: 'Alice',
            isGuest: false,
            connectedAt: Date.now(),
          },
          {
            isGuest: true,
            connectedAt: Date.now(),
          },
        ],
      };
      const result = presenceUpdateEventSchema.parse(event);
      expect(result.members).toHaveLength(2);
      expect(result.members[0]?.userId).toBe('user-1');
      expect(result.members[1]?.isGuest).toBe(true);
    });

    it('validates a presence:update event with empty members array', () => {
      const event = {
        type: 'presence:update' as const,
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [],
      };
      const result = presenceUpdateEventSchema.parse(event);
      expect(result.members).toHaveLength(0);
    });

    it('rejects a presence:update event with invalid member shape', () => {
      const event = {
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [{ userId: 'user-1' }],
      };
      expect(() => presenceUpdateEventSchema.parse(event)).toThrow();
    });
  });

  describe('realtimeEventSchema (discriminated union)', () => {
    it('correctly identifies a message:new event', () => {
      const event = {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('message:new');
    });

    it('correctly identifies a message:stream event', () => {
      const event = {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'hi',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('message:stream');
    });

    it('correctly identifies a message:complete event', () => {
      const event = {
        type: 'message:complete',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 1,
        epochNumber: 1,
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('message:complete');
    });

    it('correctly identifies a message:deleted event', () => {
      const event = {
        type: 'message:deleted',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('message:deleted');
    });

    it('correctly identifies a member:added event', () => {
      const event = {
        type: 'member:added',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'write',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('member:added');
    });

    it('correctly identifies a member:removed event', () => {
      const event = {
        type: 'member:removed',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('member:removed');
    });

    it('correctly identifies a member:privilege-changed event', () => {
      const event = {
        type: 'member:privilege-changed',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'admin',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('member:privilege-changed');
    });

    it('correctly identifies a rotation:complete event', () => {
      const event = {
        type: 'rotation:complete',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        newEpochNumber: 2,
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('rotation:complete');
    });

    it('correctly identifies a typing:start event', () => {
      const event = {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('typing:start');
    });

    it('correctly identifies a typing:stop event', () => {
      const event = {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('typing:stop');
    });

    it('correctly identifies a presence:update event', () => {
      const event = {
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [],
      };
      const result = realtimeEventSchema.parse(event);
      expect(result.type).toBe('presence:update');
    });

    it('rejects an event with unknown type', () => {
      const event = {
        type: 'unknown:event',
        timestamp: Date.now(),
      };
      expect(() => realtimeEventSchema.parse(event)).toThrow();
    });

    it('rejects an event missing required fields for its type', () => {
      const event = {
        type: 'message:new',
        timestamp: Date.now(),
      };
      expect(() => realtimeEventSchema.parse(event)).toThrow();
    });
  });

  describe('createEvent', () => {
    it('creates a message:new event with auto-timestamp', () => {
      const event = createEvent('message:new', {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'user-1',
      });
      expect(event.type).toBe('message:new');
      expect(event.timestamp).toBe(Date.now());
      const newMsg = event as Extract<RealtimeEvent, { type: 'message:new' }>;
      expect(newMsg.messageId).toBe('msg-1');
      expect(newMsg.conversationId).toBe('conv-1');
      expect(newMsg.senderType).toBe('user');
      expect(newMsg.senderId).toBe('user-1');
    });

    it('creates a message:new event with content for phantom display', () => {
      const event = createEvent('message:new', {
        messageId: 'msg-phantom',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'user-1',
        content: 'Hello from Alice',
      });
      expect(event.type).toBe('message:new');
      const newMsg = event as Extract<RealtimeEvent, { type: 'message:new' }>;
      expect(newMsg.content).toBe('Hello from Alice');
    });

    it('creates a message:stream event with auto-timestamp', () => {
      const event = createEvent('message:stream', {
        messageId: 'msg-1',
        token: 'Hello world',
      });
      expect(event.type).toBe('message:stream');
      expect(event.timestamp).toBe(Date.now());
      const streamMsg = event as Extract<RealtimeEvent, { type: 'message:stream' }>;
      expect(streamMsg.token).toBe('Hello world');
    });

    it('creates a message:complete event with auto-timestamp', () => {
      const event = createEvent('message:complete', {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 42,
        epochNumber: 3,
      });
      expect(event.type).toBe('message:complete');
      expect(event.timestamp).toBe(Date.now());
      const completeMsg = event as Extract<RealtimeEvent, { type: 'message:complete' }>;
      expect(completeMsg.sequenceNumber).toBe(42);
      expect(completeMsg.epochNumber).toBe(3);
    });

    it('creates a message:deleted event with auto-timestamp', () => {
      const event = createEvent('message:deleted', {
        messageId: 'msg-1',
        conversationId: 'conv-1',
      });
      expect(event.type).toBe('message:deleted');
      expect(event.timestamp).toBe(Date.now());
    });

    it('creates a member:added event with auto-timestamp', () => {
      const event = createEvent('member:added', {
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'owner',
      });
      expect(event.type).toBe('member:added');
      const addedMember = event as Extract<RealtimeEvent, { type: 'member:added' }>;
      expect(addedMember.privilege).toBe('owner');
    });

    it('creates a member:removed event with auto-timestamp', () => {
      const event = createEvent('member:removed', {
        conversationId: 'conv-1',
        memberId: 'mem-1',
      });
      expect(event.type).toBe('member:removed');
      expect(event.timestamp).toBe(Date.now());
    });

    it('creates a member:privilege-changed event with auto-timestamp', () => {
      const event = createEvent('member:privilege-changed', {
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'admin',
      });
      expect(event.type).toBe('member:privilege-changed');
      expect(event.timestamp).toBe(Date.now());
      const changed = event as Extract<RealtimeEvent, { type: 'member:privilege-changed' }>;
      expect(changed.memberId).toBe('mem-1');
      expect(changed.privilege).toBe('admin');
    });

    it('creates a rotation:complete event with auto-timestamp', () => {
      const event = createEvent('rotation:complete', {
        conversationId: 'conv-1',
        newEpochNumber: 5,
      });
      expect(event.type).toBe('rotation:complete');
      const rotationEvent = event as Extract<RealtimeEvent, { type: 'rotation:complete' }>;
      expect(rotationEvent.newEpochNumber).toBe(5);
    });

    it('creates a typing:start event with auto-timestamp', () => {
      const event = createEvent('typing:start', {
        conversationId: 'conv-1',
        userId: 'user-1',
      });
      expect(event.type).toBe('typing:start');
      const typingEvent = event as Extract<RealtimeEvent, { type: 'typing:start' }>;
      expect(typingEvent.userId).toBe('user-1');
    });

    it('creates a typing:stop event with auto-timestamp', () => {
      const event = createEvent('typing:stop', {
        conversationId: 'conv-1',
        userId: 'user-1',
      });
      expect(event.type).toBe('typing:stop');
    });

    it('creates a presence:update event with auto-timestamp', () => {
      const event = createEvent('presence:update', {
        conversationId: 'conv-1',
        members: [
          { isGuest: false, connectedAt: Date.now(), userId: 'user-1', displayName: 'Alice' },
        ],
      });
      expect(event.type).toBe('presence:update');
      const presenceEvent = event as Extract<RealtimeEvent, { type: 'presence:update' }>;
      expect(presenceEvent.members).toHaveLength(1);
    });

    it('uses current time for timestamp', () => {
      const before = Date.now();
      const event = createEvent('typing:start', {
        conversationId: 'conv-1',
        userId: 'user-1',
      });
      expect(event.timestamp).toBe(before);
    });
  });

  describe('parseEvent', () => {
    it('parses a valid JSON string into a message:new event', () => {
      const json = JSON.stringify({
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
      });
      const event = parseEvent(json);
      expect(event.type).toBe('message:new');
    });

    it('parses a message:new event with content field', () => {
      const json = JSON.stringify({
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
        senderId: 'user-1',
        content: 'Hello from Alice',
      });
      const event = parseEvent(json);
      expect(event.type).toBe('message:new');
      const newMsg = event as Extract<RealtimeEvent, { type: 'message:new' }>;
      expect(newMsg.content).toBe('Hello from Alice');
    });

    it('parses a valid JSON string into a typing:start event', () => {
      const json = JSON.stringify({
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
      const event = parseEvent(json);
      expect(event.type).toBe('typing:start');
    });

    it('parses a valid JSON string into a presence:update event', () => {
      const json = JSON.stringify({
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [{ isGuest: true, connectedAt: Date.now() }],
      });
      const event = parseEvent(json);
      expect(event.type).toBe('presence:update');
    });

    it('throws on invalid JSON', () => {
      expect(() => parseEvent('not json')).toThrow();
    });

    it('throws on valid JSON but invalid event data', () => {
      const json = JSON.stringify({ type: 'invalid:event', timestamp: 123 });
      expect(() => parseEvent(json)).toThrow();
    });

    it('throws on valid JSON with missing required fields', () => {
      const json = JSON.stringify({ type: 'message:new', timestamp: 123 });
      expect(() => parseEvent(json)).toThrow();
    });

    it('throws on non-object JSON', () => {
      expect(() => parseEvent('"hello"')).toThrow();
    });

    it('throws on null JSON', () => {
      expect(() => parseEvent('null')).toThrow();
    });
  });

  describe('type inference', () => {
    it('infers correct types from schemas', () => {
      const newEvent: MessageNewEvent = {
        type: 'message:new',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        senderType: 'user',
      };
      expect(newEvent.type).toBe('message:new');

      const streamEvent: MessageStreamEvent = {
        type: 'message:stream',
        timestamp: Date.now(),
        messageId: 'msg-1',
        token: 'hi',
      };
      expect(streamEvent.type).toBe('message:stream');

      const completeEvent: MessageCompleteEvent = {
        type: 'message:complete',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
        sequenceNumber: 1,
        epochNumber: 1,
      };
      expect(completeEvent.type).toBe('message:complete');

      const deletedEvent: MessageDeletedEvent = {
        type: 'message:deleted',
        timestamp: Date.now(),
        messageId: 'msg-1',
        conversationId: 'conv-1',
      };
      expect(deletedEvent.type).toBe('message:deleted');

      const memberAdded: MemberAddedEvent = {
        type: 'member:added',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'write',
      };
      expect(memberAdded.type).toBe('member:added');

      const memberRemoved: MemberRemovedEvent = {
        type: 'member:removed',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
      };
      expect(memberRemoved.type).toBe('member:removed');

      const memberPrivilegeChanged: MemberPrivilegeChangedEvent = {
        type: 'member:privilege-changed',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        memberId: 'mem-1',
        privilege: 'write',
      };
      expect(memberPrivilegeChanged.type).toBe('member:privilege-changed');

      const rotationComplete: RotationCompleteEvent = {
        type: 'rotation:complete',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        newEpochNumber: 1,
      };
      expect(rotationComplete.type).toBe('rotation:complete');

      const typingStart: TypingStartEvent = {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      expect(typingStart.type).toBe('typing:start');

      const typingStop: TypingStopEvent = {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      };
      expect(typingStop.type).toBe('typing:stop');

      const presenceUpdate: PresenceUpdateEvent = {
        type: 'presence:update',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        members: [],
      };
      expect(presenceUpdate.type).toBe('presence:update');
    });

    it('RealtimeEvent is a union of all event types', () => {
      const events: RealtimeEvent[] = [
        {
          type: 'message:new',
          timestamp: Date.now(),
          messageId: 'msg-1',
          conversationId: 'conv-1',
          senderType: 'user',
        },
        {
          type: 'typing:start',
          timestamp: Date.now(),
          conversationId: 'conv-1',
          userId: 'user-1',
        },
      ];
      expect(events).toHaveLength(2);
    });

    it('RealtimeEventType covers all event type strings', () => {
      const types: RealtimeEventType[] = [
        'message:new',
        'message:stream',
        'message:complete',
        'message:deleted',
        'member:added',
        'member:removed',
        'member:privilege-changed',
        'rotation:complete',
        'typing:start',
        'typing:stop',
        'presence:update',
      ];
      expect(types).toHaveLength(11);
    });
  });
});
