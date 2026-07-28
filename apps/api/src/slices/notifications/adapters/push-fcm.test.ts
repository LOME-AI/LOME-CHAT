import { describe, it, expect, vi, beforeAll, beforeEach, type Mock } from 'vitest';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_COPY } from '@hushbox/shared';
import { createFcmPushSender, _resetTokenCache, collectFcmErrorCodes } from './push-fcm.js';
import type { PushEventPayload } from '@hushbox/shared';
import type { PushMessage } from '../ports/index.js';

let serviceAccountJson: string;
const PROJECT_ID = 'hushbox-test';
const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
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
  recipients: [{ platform: 'ios', userId: 'user-1', token: 'device-token-abc' }],
  payload: { category: 'message', conversationId: CONVERSATION_ID },
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
    const result = await sender().send({ ...message, recipients: [] });

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 0,
      deliveredTokens: [],
      deadTokens: [],
    });
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

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 1,
      failureCount: 0,
      deliveredTokens: [{ userId: 'user-1', token: 'device-token-abc' }],
      deadTokens: [],
    });
    const [sendUrl, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`);
    expect((sendInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer ya29.test-token'
    );
    const body = JSON.parse(sendInit.body as string) as {
      message: { token: string; notification: { title: string; body: string } };
    };
    expect(body.message.token).toBe('device-token-abc');
    expect(body.message.notification).toEqual(NOTIFICATION_COPY.message);
  });

  it('asks FCM to validate without delivering when configured validate-only', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await createFcmPushSender({
      projectId: PROJECT_ID,
      serviceAccountJson,
      fetchImpl,
      validateOnly: true,
    }).send(message);
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as Record<string, unknown>;
    expect(body['validate_only']).toBe(true);
  });

  it('omits the validate-only key entirely from an ordinary send', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send(message);
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as Record<string, unknown>;
    expect('validate_only' in body).toBe(false);
  });

  it('sends the generic payload as the FCM data block', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send(message);
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as {
      message: { data?: Record<string, string> };
    };
    expect(body.message.data).toEqual({
      category: 'message',
      conversationId: CONVERSATION_ID,
    });
  });

  it('sends nothing a payload object smuggles alongside the two generic fields', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    // A structurally typed value satisfies `PushEventPayload` while carrying
    // extra properties: assignment through a variable skips TypeScript's
    // excess-property check, so the compiler cannot be the last line here.
    const smuggling = {
      category: 'message',
      conversationId: CONVERSATION_ID,
      preview: 'the actual message text',
    } satisfies PushEventPayload & { preview: string };

    const result = await sender().send({ ...message, payload: smuggling });
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(sendInit.body as string).not.toContain('the actual message text');
  });

  it('collapses on the derived alias, never the raw conversation id', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send({ ...message, collapseKey: 'alias32chars' });
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as {
      message: {
        android?: { collapse_key?: string };
        apns?: { headers?: Record<string, string> };
      };
    };
    expect(body.message.android?.collapse_key).toBe('alias32chars');
    expect(body.message.apns?.headers?.['apns-collapse-id']).toBe('alias32chars');
  });

  it('tags the shade entry with the same conversation id the data payload carries', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send({ ...message, collapseKey: 'alias32chars' });
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as {
      message: {
        data?: Record<string, string>;
        android?: { collapse_key?: string; notification?: { tag?: string } };
      };
    };
    // The client reads a delivered Android notification's tag and clears the
    // conversation by it, so the tag must be the raw id and not the alias —
    // the alias exists to keep the id out of push-service-visible headers, and
    // this same message's data payload already puts the id in front of FCM.
    expect(body.message.android?.notification?.tag).toBe(body.message.data?.['conversationId']);
    expect(body.message.android?.notification?.tag).toBe(CONVERSATION_ID);
    expect(body.message.android?.notification?.tag).not.toBe('alias32chars');
  });

  it('omits the collapse fields when no alias is set', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();

    const result = await sender().send(message);
    expect(result.isOk()).toBe(true);

    const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(sendInit.body as string) as { message: { android?: unknown } };
    expect(body.message.android).toBeUndefined();
  });

  it('reports an UNREGISTERED token as dead and leaves a delivered one alone', async () => {
    mockOAuthSuccess();
    mockFcmSendSuccess();
    fetchImpl.mockResolvedValueOnce(
      Response.json(
        { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
        { status: 404 }
      )
    );

    const result = await sender().send({
      ...message,
      recipients: [
        { platform: 'ios', userId: 'u-ok', token: 'token-ok' },
        { platform: 'ios', userId: 'u-gone', token: 'token-gone' },
      ],
    });

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 1,
      failureCount: 1,
      deliveredTokens: [{ userId: 'u-ok', token: 'token-ok' }],
      deadTokens: [{ userId: 'u-gone', token: 'token-gone' }],
    });
  });

  it('counts a non-dead failure without marking the token for pruning', async () => {
    mockOAuthSuccess();
    fetchImpl.mockResolvedValueOnce(
      Response.json({ error: { status: 'INTERNAL' } }, { status: 500 })
    );

    const result = await sender().send(message);

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 1,
      deliveredTokens: [],
      deadTokens: [],
    });
  });

  it('does not prune when a failed response body is not JSON', async () => {
    mockOAuthSuccess();
    fetchImpl.mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }));

    const result = await sender().send(message);

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 1,
      deliveredTokens: [],
      deadTokens: [],
    });
  });

  it('counts a send that rejects at the transport layer as a failure', async () => {
    mockOAuthSuccess();
    fetchImpl.mockRejectedValueOnce(new Error('network down'));

    const result = await sender().send(message);

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 1,
      deliveredTokens: [],
      deadTokens: [],
    });
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

  it.each(NOTIFICATION_CATEGORIES)(
    'renders the fixed %s copy from the shared table',
    async (category) => {
      mockOAuthSuccess();
      mockFcmSendSuccess();

      const result = await sender().send({
        recipients: [{ platform: 'android', userId: 'user-1', token: 'device-token-abc' }],
        payload: { category, conversationId: CONVERSATION_ID },
      });
      expect(result.isOk()).toBe(true);

      const [, sendInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(sendInit.body as string) as {
        message: { notification: { title: string; body: string } };
      };
      expect(body.message.notification).toEqual(NOTIFICATION_COPY[category]);
    }
  );

  it('keeps device tokens out of error messages', async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    const result = await sender().send(message);

    expect(result._unsafeUnwrapErr().message).not.toContain('device-token-abc');
  });
});

describe('collectFcmErrorCodes', () => {
  it('returns the string itself for a string error', () => {
    expect(collectFcmErrorCodes('UNREGISTERED')).toEqual(['UNREGISTERED']);
  });

  it('returns no codes for a null error body', () => {
    expect(collectFcmErrorCodes(null)).toEqual([]);
  });

  it('returns no codes for a non-object, non-string error body', () => {
    expect(collectFcmErrorCodes(42)).toEqual([]);
  });

  it('collects the status and detail error codes from an object body', () => {
    expect(
      collectFcmErrorCodes({
        status: 'NOT_FOUND',
        details: [{ errorCode: 'UNREGISTERED' }, { notACode: 'x' }, { errorCode: 7 }],
      })
    ).toEqual(['NOT_FOUND', 'UNREGISTERED']);
  });

  it('returns no codes for an object body with no status or details', () => {
    expect(collectFcmErrorCodes({})).toEqual([]);
  });
});
