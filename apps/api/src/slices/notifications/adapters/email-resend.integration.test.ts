import { describe, it, expect, afterAll, vi, type Mock } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, serviceEvidence } from '@hushbox/db';
import { createResendEmailSender } from './email-resend.js';
import type { EmailMessage } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for notifications integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

// The dev database is shared with concurrent runs: every evidence row this
// suite writes carries a run-unique messageId, and cleanup deletes only those.
const runId = `resend-test-${crypto.randomUUID()}`;
const runPattern = `${runId}%`;

const message: EmailMessage = {
  to: 'user@example.com',
  subject: 'Test Subject',
  html: '<p>Test body</p>',
};

function okFetch(messageId: string): Mock<typeof fetch> {
  return vi.fn(() => Promise.resolve(Response.json({ id: messageId }, { status: 200 })));
}

async function evidenceRowsForRun(): Promise<{ details: unknown }[]> {
  return db
    .select({ details: serviceEvidence.details })
    .from(serviceEvidence)
    .where(
      sql`${serviceEvidence.service} = 'resend' and ${serviceEvidence.details}->>'messageId' like ${runPattern}`
    );
}

afterAll(async () => {
  await db
    .delete(serviceEvidence)
    .where(
      sql`${serviceEvidence.service} = 'resend' and ${serviceEvidence.details}->>'messageId' like ${runPattern}`
    );
  await db.$client.end();
});

describe('createResendEmailSender', () => {
  it('fails fast on a blank api key', () => {
    expect(() => createResendEmailSender({ apiKey: ' ', db, isCI: false })).toThrow(/api key/i);
  });

  it('posts to the Resend emails endpoint with the bearer key', async () => {
    const fetchImpl = okFetch(`${runId}-endpoint`);
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer re_test_key');
  });

  it('sends the message fields with the default from address', async () => {
    const fetchImpl = okFetch(`${runId}-body`);
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

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
    const fetchImpl = okFetch(`${runId}-from`);
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

    const result = await sender.send({ ...message, from: 'Custom <custom@example.com>' });
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body['from']).toBe('Custom <custom@example.com>');
  });

  it('includes the text field when provided', async () => {
    const fetchImpl = okFetch(`${runId}-text`);
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

    const result = await sender.send({ ...message, text: 'Plain text version' });
    expect(result.isOk()).toBe(true);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body['text']).toBe('Plain text version');
  });

  it('writes a service-evidence row when isCI is true', async () => {
    const messageId = `${runId}-evidence`;
    const sender = createResendEmailSender({
      apiKey: 're_test_key',
      db,
      isCI: true,
      fetchImpl: okFetch(messageId),
    });

    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
    const rows = await evidenceRowsForRun();
    expect(rows).toContainEqual({ details: { messageId } });
  });

  it('writes no service-evidence row when isCI is false', async () => {
    const sender = createResendEmailSender({
      apiKey: 're_test_key',
      db,
      isCI: false,
      fetchImpl: okFetch(`${runId}-no-ci`),
    });

    const result = await sender.send(message);
    expect(result.isOk()).toBe(true);

    const rows = await evidenceRowsForRun();
    expect(
      rows.filter((row) => (row.details as { messageId?: string }).messageId?.endsWith('-no-ci'))
    ).toEqual([]);
  });

  it('maps a rejected send to an unavailable error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ message: 'Invalid API key' }, { status: 401 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_bad_key', db, isCI: true, fetchImpl });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('writes no service-evidence row for a rejected send', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ message: 'Invalid API key' }, { status: 401 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_bad_key', db, isCI: true, fetchImpl });

    const before = await evidenceRowsForRun();
    const result = await sender.send(message);
    expect(result.isErr()).toBe(true);

    const after = await evidenceRowsForRun();
    expect(after.length).toBe(before.length);
  });

  it('maps a non-JSON success response to an unavailable error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('<html>ok</html>', { status: 200 }))
    ) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('tolerates a success response without a message id', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({}, { status: 200 }))) as Mock<
      typeof fetch
    >;
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
  });

  it('fails the send when the evidence write fails', async () => {
    const brokenDb = {} as typeof db;
    const sender = createResendEmailSender({
      apiKey: 're_test_key',
      db: brokenDb,
      isCI: true,
      fetchImpl: okFetch(`${runId}-broken-db`),
    });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a network failure to an unavailable error', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('Network error'))) as Mock<typeof fetch>;
    const sender = createResendEmailSender({ apiKey: 're_test_key', db, isCI: false, fetchImpl });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('maps a hung send to a timeout error', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as Mock<typeof fetch>;
    const sender = createResendEmailSender({
      apiKey: 're_test_key',
      db,
      isCI: false,
      fetchImpl,
      timeoutMs: 20,
    });

    const result = await sender.send(message);

    expect(result._unsafeUnwrapErr().code).toBe('timeout');
  });
});
