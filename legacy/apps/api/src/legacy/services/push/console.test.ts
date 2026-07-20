import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { createConsolePushClient } from './console.js';
import type { PushNotification } from './types.js';

describe('createConsolePushClient', () => {
  const testNotification: PushNotification = {
    tokens: ['token-abc', 'token-def'],
    title: 'New Message',
    body: 'Hello from HushBox',
  };

  let consoleSpy: Mock<(message?: unknown, ...optionalParams: unknown[]) => void>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {}) as Mock<
      (message?: unknown, ...optionalParams: unknown[]) => void
    >;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('returns a PushClient', () => {
    const client = createConsolePushClient();

    expect(typeof client.send).toBe('function');
  });

  it('logs notification details to console', async () => {
    const client = createConsolePushClient();

    await client.send(testNotification);

    const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
    expect(logOutput).toContain('New Message');
    expect(logOutput).toContain('Hello from HushBox');
  });

  it('logs token count', async () => {
    const client = createConsolePushClient();

    await client.send(testNotification);

    const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
    expect(logOutput).toContain('2');
  });

  it('returns success count matching token count', async () => {
    const client = createConsolePushClient();

    const result = await client.send(testNotification);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
  });

  it('logs data payload when provided', async () => {
    const client = createConsolePushClient();

    await client.send({
      ...testNotification,
      data: { conversationId: 'conv-123' },
    });

    const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
    expect(logOutput).toContain('conv-123');
  });
});
