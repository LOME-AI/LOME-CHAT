import { describe, expect, it } from 'vitest';
import { httpStatusCode, sanitizeErrorName, stackFrameLines } from './error-scrub.js';

describe('sanitizeErrorName', () => {
  it('passes an identifier-shaped name through', () => {
    expect(sanitizeErrorName('TypeError')).toBe('TypeError');
  });

  it('passes identifier-shaped names with underscore, dollar, and digits', () => {
    expect(sanitizeErrorName('_Custom$Error2')).toBe('_Custom$Error2');
  });

  it('falls back to Error for a content-bearing name', () => {
    expect(sanitizeErrorName('ENOENT: /home/alice/.ssh/id_rsa')).toBe('Error');
  });

  it('falls back to Error for an empty name', () => {
    expect(sanitizeErrorName('')).toBe('Error');
  });
});

describe('stackFrameLines', () => {
  it('keeps only call-site frames, never the message header', () => {
    const error = new Error('PLAINTEXT-MARKER');
    const lines = stackFrameLines(error);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\s+at /);
      expect(line).not.toContain('PLAINTEXT-MARKER');
    }
  });

  it('drops a frame-shaped line embedded in the message while keeping real frames', () => {
    const error = new Error('boom\n    at fake (x.ts:1:1)');
    const lines = stackFrameLines(error);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('fake (x.ts:1:1)');
  });

  it('handles the bare-name header of an empty-message error', () => {
    // Cleared post-construction: V8 derives the stack header lazily at first
    // access, so this exercises the `name`-only header (no `: message` part).
    const error = new Error('placeholder');
    error.message = '';
    const lines = stackFrameLines(error);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\s+at /);
    }
  });

  it('returns no frames when the stack is absent', () => {
    const error = new Error('no trace');
    delete error.stack;
    expect(stackFrameLines(error)).toEqual([]);
  });

  it('returns no frames when the header cannot be derived (fail closed)', () => {
    const error = new Error('m');
    error.stack = 'mangled by a library: secret content\n    at real (file.ts:1:1)';
    expect(stackFrameLines(error)).toEqual([]);
  });
});

describe('httpStatusCode', () => {
  it('reads a numeric statusCode property', () => {
    const error = Object.assign(new Error('provider failed'), { statusCode: 429 });
    expect(httpStatusCode(error)).toBe(429);
  });

  it('reads a numeric status property when statusCode is absent', () => {
    const error = Object.assign(new Error('provider failed'), { status: 503 });
    expect(httpStatusCode(error)).toBe(503);
  });

  it('prefers statusCode over status', () => {
    const error = Object.assign(new Error('provider failed'), { statusCode: 429, status: 503 });
    expect(httpStatusCode(error)).toBe(429);
  });

  it('drops a non-numeric statusCode (a content vector)', () => {
    const error = Object.assign(new Error('x'), { statusCode: 'Internal Server Error' });
    expect(httpStatusCode(error)).toBeUndefined();
  });

  it('drops a non-finite statusCode', () => {
    const error = Object.assign(new Error('x'), { statusCode: Number.NaN });
    expect(httpStatusCode(error)).toBeUndefined();
  });

  it('returns undefined when the error carries no status', () => {
    expect(httpStatusCode(new Error('x'))).toBeUndefined();
  });
});
