import { describe, it, expect } from 'vitest';
import { ChatRequestError } from '@/lib/chat-request-error';

describe('ChatRequestError', () => {
  it('is an Error whose message mirrors the wire code for older consumers', () => {
    const error = new ChatRequestError('CONCURRENT_RUN');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ChatRequestError');
    expect(error.code).toBe('CONCURRENT_RUN');
    expect(error.message).toBe('CONCURRENT_RUN');
  });

  it('leaves details and status undefined when the refusal carried none', () => {
    const error = new ChatRequestError('VALIDATION');

    expect(error.details).toBeUndefined();
    expect(error.status).toBeUndefined();
  });

  it('carries the wire details and HTTP status when provided', () => {
    const error = new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 12 }, 429);

    expect(error.details).toEqual({ retryAfterSeconds: 12 });
    expect(error.status).toBe(429);
  });
});
