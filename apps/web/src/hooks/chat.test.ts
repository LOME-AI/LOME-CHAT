import { describe, expect, it } from 'vitest';
import { chatKeys } from './chat';

describe('chatKeys', () => {
  describe('all', () => {
    it('returns base chat key', () => {
      expect(chatKeys.all).toEqual(['chat']);
    });
  });

  describe('conversations', () => {
    it('returns conversations key array', () => {
      expect(chatKeys.conversations()).toEqual(['chat', 'conversations']);
    });
  });

  describe('conversation', () => {
    it('returns conversation key with id', () => {
      expect(chatKeys.conversation('conv-123')).toEqual(['chat', 'conversations', 'conv-123']);
    });
  });

  describe('messages', () => {
    it('returns messages key with conversation id', () => {
      expect(chatKeys.messages('conv-123')).toEqual([
        'chat',
        'conversations',
        'conv-123',
        'messages',
      ]);
    });
  });
});
