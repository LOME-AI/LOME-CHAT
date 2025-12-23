import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { EmailOptions } from '../types.js';
import { createMockEmailClient } from '../mock.js';
import { createConsoleEmailClient } from '../console.js';
import { createResendEmailClient } from '../resend.js';

describe('EmailClient interface', () => {
  const testEmail: EmailOptions = {
    to: 'user@example.com',
    subject: 'Test Subject',
    html: '<p>Test body</p>',
  };

  describe('createMockEmailClient', () => {
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

  describe('createConsoleEmailClient', () => {
    let consoleSpy: Mock<(message?: unknown, ...optionalParams: unknown[]) => void>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined) as Mock<
        (message?: unknown, ...optionalParams: unknown[]) => void
      >;
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('returns an EmailClient', () => {
      const client = createConsoleEmailClient();

      expect(typeof client.sendEmail === 'function').toBe(true);
    });

    it('logs email details to console', async () => {
      const client = createConsoleEmailClient();

      await client.sendEmail(testEmail);

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
      expect(logOutput).toContain('user@example.com');
      expect(logOutput).toContain('Test Subject');
    });

    it('logs the HTML content', async () => {
      const client = createConsoleEmailClient();

      await client.sendEmail(testEmail);

      const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
      expect(logOutput).toContain('<p>Test body</p>');
    });
  });

  describe('createResendEmailClient', () => {
    const originalFetch = globalThis.fetch;
    let fetchMock: Mock<typeof fetch>;

    beforeEach(() => {
      fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: 'email_123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      ) as Mock<typeof fetch>;
      globalThis.fetch = fetchMock;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns an EmailClient', () => {
      const client = createResendEmailClient('re_test_key');

      expect(typeof client.sendEmail === 'function').toBe(true);
    });

    it('calls Resend API with correct endpoint', async () => {
      const client = createResendEmailClient('re_test_key');

      await client.sendEmail(testEmail);

      expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.any(Object));
    });

    it('includes Authorization header with API key', async () => {
      const client = createResendEmailClient('re_my_api_key');

      await client.sendEmail(testEmail);

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer re_my_api_key'
      );
    });

    it('sends email data in request body', async () => {
      const client = createResendEmailClient('re_test_key');

      await client.sendEmail(testEmail);

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as {
        from: string;
        to: string;
        subject: string;
        html: string;
      };

      expect(body.to).toBe('user@example.com');
      expect(body.subject).toBe('Test Subject');
      expect(body.html).toBe('<p>Test body</p>');
    });

    it('uses default from address', async () => {
      const client = createResendEmailClient('re_test_key');

      await client.sendEmail(testEmail);

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as { from: string };

      expect(body.from).toBe('LOME-CHAT <noreply@lome-chat.com>');
    });

    it('allows custom from address', async () => {
      const client = createResendEmailClient('re_test_key');

      await client.sendEmail({
        ...testEmail,
        from: 'Custom <custom@example.com>',
      });

      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as { from: string };

      expect(body.from).toBe('Custom <custom@example.com>');
    });

    it('throws on API error response', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invalid API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = createResendEmailClient('invalid_key');

      await expect(client.sendEmail(testEmail)).rejects.toThrow(
        'Failed to send email: Invalid API key'
      );
    });

    it('throws on network error', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const client = createResendEmailClient('re_test_key');

      await expect(client.sendEmail(testEmail)).rejects.toThrow('Network error');
    });
  });
});

describe('EmailOptions type', () => {
  it('requires to, subject, and html fields', () => {
    const validEmail: EmailOptions = {
      to: 'test@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
    };

    expect(validEmail.to).toBeDefined();
    expect(validEmail.subject).toBeDefined();
    expect(validEmail.html).toBeDefined();
  });

  it('allows optional from field', () => {
    const emailWithFrom: EmailOptions = {
      to: 'test@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
      from: 'sender@example.com',
    };

    expect(emailWithFrom.from).toBe('sender@example.com');
  });
});
