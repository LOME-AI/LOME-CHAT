import { describe, it, expect } from 'vitest';
import type { PushNotification, PushClient, PushResult } from './types.js';

describe('PushNotification type', () => {
  it('requires tokens, title, and body fields', () => {
    const notification: PushNotification = {
      tokens: ['token-1', 'token-2'],
      title: 'New Message',
      body: 'Hello world',
    };

    expect(notification.tokens).toHaveLength(2);
    expect(notification.title).toBeDefined();
    expect(notification.body).toBeDefined();
  });

  it('allows optional data field', () => {
    const notification: PushNotification = {
      tokens: ['token-1'],
      title: 'New Message',
      body: 'Hello world',
      data: { conversationId: 'conv-123' },
    };

    expect(notification.data).toEqual({ conversationId: 'conv-123' });
  });
});

describe('PushResult type', () => {
  it('contains successCount and failureCount', () => {
    const result: PushResult = {
      successCount: 3,
      failureCount: 1,
    };

    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(1);
  });
});

describe('PushClient interface', () => {
  it('has a send method', () => {
    const mockClient: PushClient = {
      send: () => Promise.resolve({ successCount: 1, failureCount: 0 }),
    };

    expect(typeof mockClient.send).toBe('function');
  });
});
