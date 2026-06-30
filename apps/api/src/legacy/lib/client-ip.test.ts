import { describe, it, expect } from 'vitest';
import { hashIp, getClientIp } from './client-ip.js';

describe('hashIp', () => {
  it('returns consistent SHA256 hash for same IP', () => {
    const hash1 = hashIp('192.168.1.1');
    const hash2 = hashIp('192.168.1.1');

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex is 64 chars
  });

  it('returns different hashes for different IPs', () => {
    const hash1 = hashIp('192.168.1.1');
    const hash2 = hashIp('192.168.1.2');

    expect(hash1).not.toBe(hash2);
  });
});

describe('getClientIp', () => {
  function createMockContext(headers: Record<string, string | undefined>) {
    return {
      req: {
        header: (name: string) => headers[name.toLowerCase()],
      },
    };
  }

  it('returns first IP from x-forwarded-for header', () => {
    const ctx = createMockContext({
      'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178',
    });

    const ip = getClientIp(ctx);

    expect(ip).toBe('203.0.113.195');
  });

  it('trims whitespace from forwarded IP', () => {
    const ctx = createMockContext({
      'x-forwarded-for': '  203.0.113.195  , 70.41.3.18',
    });

    const ip = getClientIp(ctx);

    expect(ip).toBe('203.0.113.195');
  });

  it('falls back to x-real-ip if x-forwarded-for missing', () => {
    const ctx = createMockContext({
      'x-real-ip': '198.51.100.178',
    });

    const ip = getClientIp(ctx);

    expect(ip).toBe('198.51.100.178');
  });

  it('returns unknown if no headers present', () => {
    const ctx = createMockContext({});

    const ip = getClientIp(ctx);

    expect(ip).toBe('unknown');
  });

  it('returns unknown if x-forwarded-for is empty', () => {
    const ctx = createMockContext({
      'x-forwarded-for': '',
    });

    const ip = getClientIp(ctx);

    expect(ip).toBe('unknown');
  });

  it('returns cf-connecting-ip when present', () => {
    const ctx = createMockContext({
      'cf-connecting-ip': '203.0.113.42',
    });

    const ip = getClientIp(ctx);

    expect(ip).toBe('203.0.113.42');
  });

  it('prioritizes cf-connecting-ip over x-forwarded-for', () => {
    const ctx = createMockContext({
      'cf-connecting-ip': '203.0.113.42',
      'x-forwarded-for': '198.51.100.1',
    });

    const ip = getClientIp(ctx);

    expect(ip).toBe('203.0.113.42');
  });

  it('uses custom fallback when no headers present', () => {
    const ctx = createMockContext({});

    const ip = getClientIp(ctx, '0.0.0.0');

    expect(ip).toBe('0.0.0.0');
  });

  it('uses default fallback when no custom fallback provided', () => {
    const ctx = createMockContext({});

    const ip = getClientIp(ctx);

    expect(ip).toBe('unknown');
  });
});
