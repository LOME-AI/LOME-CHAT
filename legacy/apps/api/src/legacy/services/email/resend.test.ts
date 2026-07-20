import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { createResendEmailClient } from './resend.js';
import type { EmailOptions } from './types.js';

describe('createResendEmailClient', () => {
  const testEmail: EmailOptions = {
    to: 'user@example.com',
    subject: 'Test Subject',
    html: '<p>Test body</p>',
  };

  const originalFetch = globalThis.fetch;
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { id: 'email_123' },
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
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

    expect(body.from).toBe('HushBox <noreply@mail.hushbox.ai>');
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
      Response.json(
        { message: 'Invalid API key' },
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const client = createResendEmailClient('invalid_key');

    await expect(client.sendEmail(testEmail)).rejects.toThrow(
      'Failed to send email: Invalid API key'
    );
  });

  it('throws descriptive error when error response is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const client = createResendEmailClient('re_test_key');

    await expect(client.sendEmail(testEmail)).rejects.toThrow(
      'Resend email: expected JSON but received unparseable body (HTTP 502)'
    );
  });

  it('throws on network error', async () => {
    fetchMock.mockRejectedValue(new Error('Network error'));

    const client = createResendEmailClient('re_test_key');

    await expect(client.sendEmail(testEmail)).rejects.toThrow('Network error');
  });

  it('includes text field when provided', async () => {
    const client = createResendEmailClient('re_test_key');

    await client.sendEmail({
      ...testEmail,
      text: 'Plain text version',
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { text?: string };

    expect(body.text).toBe('Plain text version');
  });

  it('omits text field when not provided', async () => {
    const client = createResendEmailClient('re_test_key');

    await client.sendEmail(testEmail);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { text?: string };

    expect(body.text).toBeUndefined();
  });
});
