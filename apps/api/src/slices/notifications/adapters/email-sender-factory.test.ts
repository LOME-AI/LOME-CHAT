import { describe, it, expect } from 'vitest';
import {
  createEmailSenderFromEnv,
  findCapturedEmail,
  listCapturedEmails,
} from './email-sender-factory.js';
import type { Database } from '@hushbox/db';
import type { EmailMessage } from '../ports/index.js';

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

  it('returns a batch-capable sender in every mode', () => {
    const devSender = createEmailSenderFromEnv({ NODE_ENV: 'development' }, db);
    const productionSender = createEmailSenderFromEnv(
      { NODE_ENV: 'production', RESEND_API_KEY: 're_live_key' },
      db
    );

    expect(typeof devSender.sendBatch).toBe('function');
    expect(typeof productionSender.sendBatch).toBe('function');
  });
});

describe('dev mailbox capture', () => {
  const message: EmailMessage = {
    to: 'mailbox@example.com',
    subject: 'Mailbox subject',
    html: '<p>Mailbox body</p>',
  };

  it('captures sends from separately constructed factory mocks in one mailbox', async () => {
    const before = listCapturedEmails().length;
    const first = createEmailSenderFromEnv({ NODE_ENV: 'development' }, db);
    const second = createEmailSenderFromEnv({ NODE_ENV: 'development' }, db);

    const firstSend = await first.send(message);
    expect(firstSend.isOk()).toBe(true);
    const secondSend = await second.sendBatch([{ ...message, to: 'batched@example.com' }], {
      idempotencyKey: 'k',
    });
    expect(secondSend.isOk()).toBe(true);

    const captured = listCapturedEmails().slice(before);
    expect(captured.map((entry) => entry.message.to)).toEqual([
      'mailbox@example.com',
      'batched@example.com',
    ]);
    expect(new Set(captured.map((entry) => entry.id)).size).toBe(2);
  });

  it('finds a captured email by id', async () => {
    const sender = createEmailSenderFromEnv({ NODE_ENV: 'development' }, db);
    const sent = await sender.send(message);
    expect(sent.isOk()).toBe(true);

    const latest = listCapturedEmails().at(-1);
    expect(latest).toBeDefined();
    expect(findCapturedEmail(latest?.id ?? '')?.message.html).toBe('<p>Mailbox body</p>');
  });

  it('returns undefined for an unknown mailbox id', () => {
    expect(findCapturedEmail('no-such-id')).toBeUndefined();
  });
});
