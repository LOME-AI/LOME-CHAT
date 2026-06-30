import { describe, it, expect } from 'vitest';
import { createEmailSenderFromEnv } from './email-sender-factory.js';
import type { Database } from '@hushbox/db';

// The factory only threads `db` into the resend adapter's evidence writes;
// selection itself never touches it.
const db = {} as Database;

describe('createEmailSenderFromEnv', () => {
  it('fails fast when NODE_ENV is unset', () => {
    expect(() => createEmailSenderFromEnv({}, db)).toThrow(/NODE_ENV/);
  });

  it('selects the mock sender in local dev', () => {
    const sender = createEmailSenderFromEnv({ NODE_ENV: 'development' }, db);

    expect('getSentMessages' in sender).toBe(true);
  });

  it('selects the mock sender in CI', () => {
    const sender = createEmailSenderFromEnv({ NODE_ENV: 'development', CI: 'true' }, db);

    expect('getSentMessages' in sender).toBe(true);
  });

  it('fails fast in production without a Resend key', () => {
    expect(() => createEmailSenderFromEnv({ NODE_ENV: 'production' }, db)).toThrow(
      /RESEND_API_KEY/
    );
  });

  it('selects the real Resend sender in production', () => {
    const sender = createEmailSenderFromEnv(
      { NODE_ENV: 'production', RESEND_API_KEY: 're_live_key' },
      db
    );

    expect('getSentMessages' in sender).toBe(false);
  });
});
