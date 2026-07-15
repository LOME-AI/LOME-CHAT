import { describe, expect, it } from 'vitest';
import { createCloudflareAccessLogReader } from './access-log-cloudflare.js';

const WINDOW = {
  since: new Date('2026-07-14T05:00:00.000Z'),
  until: new Date('2026-07-14T12:00:00.000Z'),
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function readerWith(
  body: unknown,
  status = 200
): { reader: ReturnType<typeof createCloudflareAccessLogReader>; requests: Request[] } {
  const requests: Request[] = [];
  const reader = createCloudflareAccessLogReader({
    accountId: 'test-account-id',
    apiToken: 'test-token',
    fetch: (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(jsonResponse(body, status));
    },
  });
  return { reader, requests };
}

const okBody = {
  success: true,
  result: [
    {
      user_email: 'admin@hushbox.test',
      action: 'login',
      allowed: true,
      created_at: '2026-07-14T11:00:00.000Z',
    },
    {
      user_email: 'admin@hushbox.test',
      action: 'registration',
      allowed: true,
      created_at: '2026-07-14T11:30:00.000Z',
    },
  ],
};

describe('createCloudflareAccessLogReader', () => {
  it('requests the Access access_requests log with the bearer token and window', async () => {
    const { reader, requests } = readerWith(okBody);
    await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toContain(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/access/logs/access_requests'
    );
    expect(request?.url).toContain(`since=${encodeURIComponent(WINDOW.since.toISOString())}`);
    expect(request?.url).toContain(`until=${encodeURIComponent(WINDOW.until.toISOString())}`);
    expect(request?.headers.get('authorization')).toBe('Bearer test-token');
  });

  it('maps login actions to authentication and everything else to enrollment (fail-closed)', async () => {
    const { reader } = readerWith(okBody);
    const events = await reader.listEvents(WINDOW);
    expect(events).toEqual([
      {
        email: 'admin@hushbox.test',
        kind: 'authentication',
        occurredAt: '2026-07-14T11:00:00.000Z',
      },
      {
        email: 'admin@hushbox.test',
        kind: 'enrollment',
        occurredAt: '2026-07-14T11:30:00.000Z',
      },
    ]);
  });

  it('throws on a non-2xx response, carrying the status code only', async () => {
    const { reader } = readerWith({ success: false }, 403);
    await expect(reader.listEvents(WINDOW)).rejects.toThrow('403');
  });

  it('throws when the API reports success=false on a 2xx response', async () => {
    const { reader } = readerWith({ success: false, result: [] });
    await expect(reader.listEvents(WINDOW)).rejects.toThrow('success=false');
  });

  it('throws on an unparseable response body', async () => {
    const { reader } = readerWith({ success: true, result: [{ bogus: true }] });
    await expect(reader.listEvents(WINDOW)).rejects.toThrow();
  });
});
