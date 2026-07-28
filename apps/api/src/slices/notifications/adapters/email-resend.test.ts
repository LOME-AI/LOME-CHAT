import { describe, it, expect, vi, type Mock } from 'vitest';
import { createResendEmailSender } from './email-resend.js';
import type { EmailMessage } from '../ports/index.js';

const message: EmailMessage = {
  to: 'user@example.com',
  subject: 'Test Subject',
  html: '<p>Test body</p>',
};

function okFetch(messageId: string): Mock<typeof fetch> {
  return vi.fn(() => Promise.resolve(Response.json({ id: messageId }, { status: 200 })));
}

describe('createResendEmailSender', () => {
  it('fails fast on a blank api key', () => {
    expect(() => createResendEmailSender({ apiKey: ' ' })).toThrow(/api key/i);
  });

  it('posts to the Resend emails endpoint with the bearer key', async () => {
    const fetchImpl = okFetch('endpoint');
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer re_test_key');
  });

  it('sends the message fields with the default from address', async () => {
    const fetchImpl = okFetch('body');
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send(message);
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body['to']).toBe('user@example.com');
    expect(body['subject']).toBe('Test Subject');
    expect(body['html']).toBe('<p>Test body</p>');
    expect(body['from']).toBe('HushBox <noreply@mail.hushbox.ai>');
    expect(body['text']).toBeUndefined();
  });

  it('honors a custom from address', async () => {
    const fetchImpl = okFetch('from');
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send({ ...message, from: 'Custom <custom@example.com>' });
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body['from']).toBe('Custom <custom@example.com>');
  });

  it('includes the text field when provided', async () => {
    const fetchImpl = okFetch('text');
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send({ ...message, text: 'Plain text version' });
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body['text']).toBe('Plain text version');
  });

  it('forwards custom headers into the request body', async () => {
    const fetchImpl = okFetch('headers');
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send({ ...message, headers: { 'X-Entity-Ref-ID': 'issue-1' } });
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['headers']).toEqual({ 'X-Entity-Ref-ID': 'issue-1' });
  });

  it('sends no headers field when the message declares none', async () => {
    const fetchImpl = okFetch('no-headers');
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send(message);
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect('headers' in body).toBe(false);
  });

  it('maps a rejected send to an unavailable error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ message: 'Invalid API key' }, { status: 401 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_bad_key', fetchImpl });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a non-JSON success response to an unavailable error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('<html>ok</html>', { status: 200 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('tolerates a success response without a message id', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({}, { status: 200 }))) as Mock<
      typeof fetch
    >;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
  });

  it('maps a network failure to an unavailable error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('Network error'))) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('posts a batch to the Resend batch endpoint with the idempotency key header', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ data: [{ id: 'b-1' }, { id: 'b-2' }] }, { status: 200 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.sendBatch([message, { ...message, to: 'b@example.com' }], {
      idempotencyKey: 'newsletter:issue:0',
    });

    expect(result._unsafeUnwrap().ids).toEqual(['b-1', 'b-2']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails/batch');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_key');
    expect(headers['Idempotency-Key']).toBe('newsletter:issue:0');
  });

  it('serializes each batched message with defaults and per-message headers', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ data: [{ id: 'b-3' }] }, { status: 200 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.sendBatch(
      [{ ...message, text: 'plain', headers: { 'List-Unsubscribe': '<https://x>' } }],
      { idempotencyKey: 'k' }
    );
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]?.['from']).toBe('HushBox <noreply@mail.hushbox.ai>');
    expect(body[0]?.['text']).toBe('plain');
    expect(body[0]?.['headers']).toEqual({ 'List-Unsubscribe': '<https://x>' });
  });

  it('rejects a batch over the 100-message provider cap without calling the provider', async () => {
    const fetchImpl = vi.fn();
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.sendBatch(
      Array.from({ length: 101 }, () => message),
      { idempotencyKey: 'k' }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a batch whose response ids do not match its length to an unavailable error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ data: [{ id: 'only-one' }] }, { status: 200 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.sendBatch([message, message], { idempotencyKey: 'k' });

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a rejected batch send to an unavailable error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ message: 'nope' }, { status: 422 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', fetchImpl });

    const result = await sender.sendBatch([message], { idempotencyKey: 'k' });

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a hung send to a timeout error', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as Mock<typeof fetch>;
    const sender = createResendEmailSender({
      apiKey: 're_test_key',
      fetchImpl,
      timeoutMs: 20,
    });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('timeout');
  });
});
