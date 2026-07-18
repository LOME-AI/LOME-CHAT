import { describe, expect, it } from 'vitest';
import {
  newsletterConfirmBodySchema,
  newsletterConfirmResponseSchema,
  newsletterSettingsBodySchema,
  newsletterSettingsResponseSchema,
  newsletterSubscribeBodySchema,
  newsletterSubscribeResponseSchema,
  newsletterUnsubscribeBodySchema,
  newsletterUnsubscribeResponseSchema,
} from './newsletter.js';
import { newsletterSubscribeBodySchema as BarrelSchema } from '../../index.js';

describe('newsletterSubscribeBodySchema', () => {
  it('accepts a valid email', () => {
    expect(newsletterSubscribeBodySchema.safeParse({ email: 'a@b.com' }).success).toBe(true);
  });

  it('rejects a malformed email', () => {
    expect(newsletterSubscribeBodySchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a missing email', () => {
    expect(newsletterSubscribeBodySchema.safeParse({}).success).toBe(false);
  });

  it('is re-exported from the package barrel', () => {
    expect(BarrelSchema).toBe(newsletterSubscribeBodySchema);
  });
});

describe('newsletterConfirmBodySchema', () => {
  it('accepts a non-empty token', () => {
    expect(newsletterConfirmBodySchema.safeParse({ token: 'abc' }).success).toBe(true);
  });

  it('rejects an empty token', () => {
    expect(newsletterConfirmBodySchema.safeParse({ token: '' }).success).toBe(false);
  });
});

describe('newsletterUnsubscribeBodySchema', () => {
  it('accepts a non-empty token', () => {
    expect(newsletterUnsubscribeBodySchema.safeParse({ token: 'abc' }).success).toBe(true);
  });

  it('rejects an empty token', () => {
    expect(newsletterUnsubscribeBodySchema.safeParse({ token: '' }).success).toBe(false);
  });
});

describe('newsletterSettingsBodySchema', () => {
  it('accepts a boolean subscribed flag', () => {
    expect(newsletterSettingsBodySchema.safeParse({ subscribed: true }).success).toBe(true);
    expect(newsletterSettingsBodySchema.safeParse({ subscribed: false }).success).toBe(true);
  });

  it('rejects a non-boolean subscribed flag', () => {
    expect(newsletterSettingsBodySchema.safeParse({ subscribed: 'yes' }).success).toBe(false);
  });
});

describe('newsletterSettingsResponseSchema', () => {
  it('accepts the subscribed state', () => {
    expect(newsletterSettingsResponseSchema.safeParse({ subscribed: true }).success).toBe(true);
  });

  it('rejects a missing subscribed field', () => {
    expect(newsletterSettingsResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('enumeration-safe ok responses', () => {
  const schemas = [
    newsletterSubscribeResponseSchema,
    newsletterConfirmResponseSchema,
    newsletterUnsubscribeResponseSchema,
  ];

  it('accept exactly { ok: true }', () => {
    for (const schema of schemas) {
      expect(schema.safeParse({ ok: true }).success).toBe(true);
    }
  });

  it('reject ok: false', () => {
    for (const schema of schemas) {
      expect(schema.safeParse({ ok: false }).success).toBe(false);
    }
  });
});
