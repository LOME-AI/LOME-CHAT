import { describe, it, expect } from 'vitest';
import {
  bannerHrefSchema,
  bannerMessageSchema,
  bannerConfigSchema,
  bannerResponseSchema,
  BANNER_VARIANTS,
  MAX_BANNER_MESSAGES,
  MAX_BANNER_TEXT_LENGTH,
} from './announcements.js';

describe('bannerHrefSchema', () => {
  it('accepts a relative path', () => {
    expect(bannerHrefSchema.parse('/pricing')).toBe('/pricing');
  });

  it('accepts http(s) absolute urls', () => {
    expect(bannerHrefSchema.safeParse('https://hushbox.ai/status').success).toBe(true);
    expect(bannerHrefSchema.safeParse('http://example.com').success).toBe(true);
  });

  it('rejects javascript: urls', () => {
    expect(bannerHrefSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });

  it('rejects data: urls', () => {
    expect(bannerHrefSchema.safeParse('data:text/html,<script>').success).toBe(false);
  });

  it('rejects protocol-relative urls', () => {
    expect(bannerHrefSchema.safeParse('//evil.example.com').success).toBe(false);
  });

  it('rejects non-urls', () => {
    expect(bannerHrefSchema.safeParse('not a url').success).toBe(false);
  });
});

describe('bannerMessageSchema', () => {
  it('parses a minimal message (text only)', () => {
    expect(bannerMessageSchema.parse({ text: 'Switch models mid-conversation.' })).toEqual({
      text: 'Switch models mid-conversation.',
    });
  });

  it('parses a full message', () => {
    const msg = { id: 'm1', text: 'Status update', href: '/status', linkText: 'See status' };
    expect(bannerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('trims surrounding whitespace in text', () => {
    expect(bannerMessageSchema.parse({ text: '  hello  ' }).text).toBe('hello');
  });

  it('rejects empty text', () => {
    expect(bannerMessageSchema.safeParse({ text: '' }).success).toBe(false);
  });

  it('rejects whitespace-only text', () => {
    expect(bannerMessageSchema.safeParse({ text: '   ' }).success).toBe(false);
  });

  it('rejects text over the max length', () => {
    expect(
      bannerMessageSchema.safeParse({ text: 'x'.repeat(MAX_BANNER_TEXT_LENGTH + 1) }).success
    ).toBe(false);
  });

  it('drops unknown fields', () => {
    const parsed = bannerMessageSchema.parse({ text: 'hi', secret: 'leak' });
    expect(parsed).not.toHaveProperty('secret');
  });

  it('keeps the message but strips an unsafe href to undefined', () => {
    const parsed = bannerMessageSchema.parse({ text: 'hi', href: 'javascript:alert(1)' });
    expect(parsed.text).toBe('hi');
    expect(parsed.href).toBeUndefined();
  });
});

describe('bannerConfigSchema (salvaging parse of an operator-edited row)', () => {
  it('parses a valid enabled config', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      variant: 'warning',
      messages: [{ text: 'one' }, { text: 'two' }],
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.variant).toBe('warning');
    expect(cfg.messages.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('falls back to info on an unknown variant', () => {
    expect(
      bannerConfigSchema.parse({ enabled: true, variant: 'explode', messages: [] }).variant
    ).toBe('info');
  });

  it('coerces a non-boolean enabled to false (fail closed)', () => {
    expect(
      bannerConfigSchema.parse({ enabled: 'true', variant: 'info', messages: [] }).enabled
    ).toBe(false);
  });

  it('drops invalid messages but keeps the valid ones', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      variant: 'info',
      messages: [{ text: 'good one' }, { text: '' }, { nope: true }, { text: 'good two' }],
    });
    expect(cfg.messages.map((m) => m.text)).toEqual(['good one', 'good two']);
  });

  it('degrades messages that are not an array to an empty list', () => {
    expect(
      bannerConfigSchema.parse({ enabled: true, variant: 'info', messages: 'oops' }).messages
    ).toEqual([]);
  });

  it('degrades a non-object row to disabled', () => {
    expect(bannerConfigSchema.parse(null)).toEqual({
      enabled: false,
      variant: 'info',
      messages: [],
    });
    expect(bannerConfigSchema.parse('garbage')).toEqual({
      enabled: false,
      variant: 'info',
      messages: [],
    });
  });

  it('clamps to the maximum message count', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 5 }, (_, index) => ({
      text: `m${index.toString()}`,
    }));
    expect(
      bannerConfigSchema.parse({ enabled: true, variant: 'info', messages }).messages
    ).toHaveLength(MAX_BANNER_MESSAGES);
  });
});

describe('bannerResponseSchema (clean wire contract)', () => {
  it('parses a clean response', () => {
    const res = { hash: 'abc123', variant: 'info' as const, messages: [{ text: 'hi' }] };
    expect(bannerResponseSchema.parse(res)).toEqual(res);
  });

  it('accepts a null hash (disabled)', () => {
    expect(
      bannerResponseSchema.parse({ hash: null, variant: 'info', messages: [] }).hash
    ).toBeNull();
  });

  it('rejects more than the maximum messages', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 1 }, () => ({ text: 'x' }));
    expect(bannerResponseSchema.safeParse({ hash: 'h', variant: 'info', messages }).success).toBe(
      false
    );
  });
});

describe('BANNER_VARIANTS', () => {
  it('is the closed severity set', () => {
    expect([...BANNER_VARIANTS]).toEqual(['info', 'warning', 'critical']);
  });
});
