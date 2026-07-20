import { describe, it, expect } from 'vitest';
import { createMockEmailClient } from './mock.js';
import type { EmailOptions } from './types.js';

describe('createMockEmailClient', () => {
  const testEmail: EmailOptions = {
    to: 'user@example.com',
    subject: 'Test Subject',
    html: '<p>Test body</p>',
  };

  it('returns an EmailClient with getSentEmails method', () => {
    const client = createMockEmailClient();

    expect(typeof client.sendEmail === 'function').toBe(true);
    expect(typeof client.getSentEmails === 'function').toBe(true);
  });

  it('stores sent emails for later retrieval', async () => {
    const client = createMockEmailClient();

    await client.sendEmail(testEmail);

    const sent = client.getSentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(testEmail);
  });

  it('stores multiple emails in order', async () => {
    const client = createMockEmailClient();
    const email1 = { ...testEmail, to: 'first@example.com' };
    const email2 = { ...testEmail, to: 'second@example.com' };

    await client.sendEmail(email1);
    await client.sendEmail(email2);

    const sent = client.getSentEmails();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe('first@example.com');
    expect(sent[1]?.to).toBe('second@example.com');
  });

  it('returns empty array when no emails sent', () => {
    const client = createMockEmailClient();

    expect(client.getSentEmails()).toEqual([]);
  });

  it('allows clearing sent emails', async () => {
    const client = createMockEmailClient();

    await client.sendEmail(testEmail);
    client.clearSentEmails();

    expect(client.getSentEmails()).toEqual([]);
  });
});
