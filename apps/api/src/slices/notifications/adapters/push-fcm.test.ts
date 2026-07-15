import { describe, it, expect, vi, beforeAll, beforeEach, type Mock } from 'vitest';
import { createFcmPushSender, _resetTokenCache } from './push-fcm.js';
import type { Database } from '@hushbox/db';
import type { PushMessage } from '../ports/index.js';

let serviceAccountJson: string;
const PROJECT_ID = 'hushbox-test';
const CLIENT_EMAIL = 'test@hushbox-test.iam.gserviceaccount.com';

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`; // gitleaks:allow

  serviceAccountJson = JSON.stringify({
    type: 'service_account',
    project_id: PROJECT_ID,
    private_key: pem,
    client_email: CLIENT_EMAIL,
  });
});

const message: PushMessage = {
  tokens: ['device-token-abc'],
  title: 'New Message',
  body: 'Hello from HushBox',
};

let fetchImpl: Mock<typeof fetch>;

beforeEach(() => {
  fetchImpl = vi.fn();
  _resetTokenCache();
});

function mockOAuthSuccess(): void {
  fetchImpl.mockResolvedValueOnce(
    Response.json({ access_token: 'ya29.test-token', expires_in: 3600 })
  );
}

function mockFcmSendSuccess(count = 1): void {
  for (let index = 0; index < count; index++) {
    fetchImpl.mockResolvedValueOnce(
      Response.json({ name: `projects/test/messages/${String(index)}` })
    );
  }
}

function sender(): ReturnType<typeof createFcmPushSender> {
  return createFcmPushSender({ projectId: PROJECT_ID, serviceAccountJson, fetchImpl });
}

describe('createFcmPushSender', () => {
  it('throws on invalid service-account JSON', () => {
    expect(() =>
      createFcmPushSender({ projectId: PROJECT_ID, serviceAccountJson: 'not-json', fetchImpl })
    ).toThrow();
  });

  it('throws when client_email is missing', () => {
    const json = JSON.stringify({ private_key: 'key' });

    expect(() =>
      createFcmPushSender({ projectId: PROJECT_ID, serviceAccountJson: json, fetchImpl })
    ).toThrow(/client_email/);
  });

  it('throws when private_key is missing', () => {
    const json = JSON.stringify({ client_email: CLIENT_EMAIL });

    expect(() =>
      createFcmPushSender({ projectId: PROJECT_ID, serviceAccountJson: json, fetchImpl })
    ).toThrow(/private_key/);
  });

  it('resolves zero counts without fetching when there are no tokens', async () => {
    const result = await sender().send({ ...message, tokens: [] });

    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exchanges a signed JWT for an access token before sending', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send(message);
    expect(result.isOk()).toBe(true);

    const [oauthUrl, oauthInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(oauthUrl).toBe('https://oauth2.googleapis.com/token');
    expect(oauthInit.body as string).toContain('jwt-bearer');
  });

  it('posts each token to the project send endpoint with the bearer token', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send(message);

    expect(result._unsafeUnwrap()).toEqual({ successCount: 1, failureCount: 0 });
    const [sendUrl, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`);
    expect((sendInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer ya29.test-token'
    );
    const body = JSON.parse(sendInit.body as string) as {
      message: { token: string; notification: { title: string; body: string } };
    };
    expect(body.message.token).toBe('device-token-abc');
    expect(body.message.notification).toEqual({ title: 'New Message', body: 'Hello from HushBox' });
  });

  it('includes the data payload when provided', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send({ ...message, data: { conversationId: 'conv-1' } });
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as {
      message: { data?: Record<string, string> };
    };
    expect(body.message.data).toEqual({ conversationId: 'conv-1' });
  });

  it('counts per-token failures without failing the delivery', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();
    fetchImpl.mockResolvedValueOnce(Response.json({ error: 'UNREGISTERED' }, { status: 404 }));

    const result = await sender().send({ ...message, tokens: ['token-ok', 'token-gone'] });

    expect(result._unsafeUnwrap()).toEqual({ successCount: 1, failureCount: 1 });
  });

  it('reuses the cached access token across sends', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess(2);
    const fcm = sender();

    const first = await fcm.send(message);
    const second = await fcm.send(message);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);

    const oauthCalls = fetchImpl.mock.calls.filter(
      ([url]) => url === 'https://oauth2.googleapis.com/token'
    );
    expect(oauthCalls).toHaveLength(1);
  });

  it('maps an OAuth exchange failure to an unavailable error', async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    const result = await sender().send(message);

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('keeps device tokens out of error messages', async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    const result = await sender().send(message);

    expect(result._unsafeUnwrapErr().message).not.toContain('device-token-abc');
  });

  it('records one push-fcm service-evidence row after a successful CI send', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();
    const values = vi.fn(() => Promise.resolve());
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as unknown as Database;

    const fcm = createFcmPushSender({
      projectId: PROJECT_ID,
      serviceAccountJson,
      fetchImpl,
      db,
      isCI: true,
    });
    const result = await fcm.send(message);

    expect(result.isOk()).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ service: 'push-fcm' }));
  });

  it('skips the evidence write outside CI', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();
    const insert = vi.fn();
    const db = { insert } as unknown as Database;

    const fcm = createFcmPushSender({
      projectId: PROJECT_ID,
      serviceAccountJson,
      fetchImpl,
      db,
      isCI: false,
    });
    const result = await fcm.send(message);

    expect(result.isOk()).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });
});
