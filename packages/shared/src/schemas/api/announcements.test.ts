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
      variant: 'info',
    });
  });

  it('parses a full message', () => {
    const msg = {
      id: 'm1',
      text: 'Status update',
      variant: 'warning' as const,
      href: '/status',
      linkText: 'See status',
    };
    expect(bannerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('preserves each declared variant', () => {
    for (const variant of BANNER_VARIANTS) {
      expect(bannerMessageSchema.parse({ text: 'hi', variant }).variant).toBe(variant);
    }
  });

  it('salvages an unknown variant to info', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', variant: 'explode' }).variant).toBe('info');
  });

  it('salvages a non-string variant to info', () => {
    expect(bannerMessageSchema.parse({ text: 'hi', variant: 7 }).variant).toBe('info');
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
  it('parses a valid enabled config with per-message variants', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [
        { text: 'one', variant: 'warning' },
        { text: 'two', variant: 'critical' },
      ],
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.messages).toEqual([
      { text: 'one', variant: 'warning' },
      { text: 'two', variant: 'critical' },
    ]);
  });

  it('has no top-level variant', () => {
    expect(
      bannerConfigSchema.parse({ enabled: true, variant: 'warning', messages: [] })
    ).not.toHaveProperty('variant');
  });

  it('salvages an unknown message variant to info', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [{ text: 'one', variant: 'explode' }],
    });
    expect(cfg.messages[0]?.variant).toBe('info');
  });

  it('defaults a missing message variant to info', () => {
    const cfg = bannerConfigSchema.parse({ enabled: true, messages: [{ text: 'one' }] });
    expect(cfg.messages[0]?.variant).toBe('info');
  });

  it('coerces a non-boolean enabled to false (fail closed)', () => {
    expect(bannerConfigSchema.parse({ enabled: 'true', messages: [] }).enabled).toBe(false);
  });

  it('drops invalid messages but keeps the valid ones', () => {
    const cfg = bannerConfigSchema.parse({
      enabled: true,
      messages: [{ text: 'good one' }, { text: '' }, { nope: true }, { text: 'good two' }],
    });
    expect(cfg.messages.map((m) => m.text)).toEqual(['good one', 'good two']);
  });

  it('degrades messages that are not an array to an empty list', () => {
    expect(bannerConfigSchema.parse({ enabled: true, messages: 'oops' }).messages).toEqual([]);
  });

  it('degrades a non-object row to disabled', () => {
    expect(bannerConfigSchema.parse(null)).toEqual({ enabled: false, messages: [] });
    expect(bannerConfigSchema.parse('garbage')).toEqual({ enabled: false, messages: [] });
  });

  it('clamps to the maximum message count', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 5 }, (_, index) => ({
      text: `m${index.toString()}`,
    }));
    expect(bannerConfigSchema.parse({ enabled: true, messages }).messages).toHaveLength(
      MAX_BANNER_MESSAGES
    );
  });
});

describe('bannerResponseSchema (clean wire contract)', () => {
  it('parses a clean response with per-message variants', () => {
    const res = { hash: 'abc123', messages: [{ text: 'hi', variant: 'critical' as const }] };
    expect(bannerResponseSchema.parse(res)).toEqual(res);
  });

  it('has no top-level variant', () => {
    expect(
      bannerResponseSchema.parse({ hash: 'h', variant: 'warning', messages: [] })
    ).not.toHaveProperty('variant');
  });

  it('accepts a null hash (disabled)', () => {
    expect(bannerResponseSchema.parse({ hash: null, messages: [] }).hash).toBeNull();
  });

  it('rejects more than the maximum messages', () => {
    const messages = Array.from({ length: MAX_BANNER_MESSAGES + 1 }, () => ({ text: 'x' }));
    expect(bannerResponseSchema.safeParse({ hash: 'h', messages }).success).toBe(false);
  });
});

describe('BANNER_VARIANTS', () => {
  it('is the closed severity set', () => {
    expect([...BANNER_VARIANTS]).toEqual(['info', 'warning', 'critical']);
  });
});
