import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, type Mock } from 'vitest';
import { createFcmPushClient, _resetTokenCache } from './fcm.js';
import type { PushNotification } from './types.js';

let testServiceAccountJson: string;
const TEST_PROJECT_ID = 'hushbox-test';
const TEST_CLIENT_EMAIL = 'test@hushbox-test.iam.gserviceaccount.com';

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

  const { privateKey } = keyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`; // gitleaks:allow

  testServiceAccountJson = JSON.stringify({
    type: 'service_account',
    project_id: TEST_PROJECT_ID,
    private_key: pem,
    client_email: TEST_CLIENT_EMAIL,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
});

describe('createFcmPushClient', () => {
  const testNotification: PushNotification = {
    tokens: ['token-abc'],
    title: 'New Message',
    body: 'Hello from HushBox',
  };

  const originalFetch = globalThis.fetch;
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    _resetTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function mockOAuthSuccess(): void {
    fetchMock.mockResolvedValueOnce(
      Response.json({ access_token: 'ya29.test-token', expires_in: 3600 })
    );
  }

  function mockFcmSendSuccess(): void {
    fetchMock.mockResolvedValueOnce(Response.json({ name: 'projects/test/messages/123' }));
  }

  function mockOAuthAndFcm(): void {
    mockOAuthSuccess();
    mockFcmSendSuccess();
  }

  function mockOAuthAndFcmMultiple(tokenCount: number): void {
    mockOAuthSuccess();
    for (let index = 0; index < tokenCount; index++) {
      fetchMock.mockResolvedValueOnce(
        Response.json({ name: `projects/test/messages/${String(index)}` })
      );
    }
  }

  describe('service account validation', () => {
    it('throws on invalid JSON', () => {
      expect(() => createFcmPushClient(TEST_PROJECT_ID, 'not-json')).toThrow();
    });

    it('throws when client_email is missing', () => {
      const json = JSON.stringify({
        private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      });
      expect(() => createFcmPushClient(TEST_PROJECT_ID, json)).toThrow('client_email');
    });

    it('throws when private_key is missing', () => {
      const json = JSON.stringify({ client_email: 'test@example.com' });
      expect(() => createFcmPushClient(TEST_PROJECT_ID, json)).toThrow('private_key');
    });

    it('returns a PushClient for valid service account', () => {
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);
      expect(typeof client.send).toBe('function');
    });
  });

  describe('OAuth token exchange', () => {
    it('requests access token from Google OAuth endpoint', async () => {
      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);

      const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe('https://oauth2.googleapis.com/token');
    });

    it('sends a valid JWT assertion', async () => {
      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);

      const [, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
      const body = new URLSearchParams(options.body as string);
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

      const jwt = body.get('assertion')!;
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);

      const header = JSON.parse(
        atob(parts[0]!.replaceAll('-', '+').replaceAll('_', '/'))
      ) as Record<string, unknown>;
      expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

      const payload = JSON.parse(
        atob(parts[1]!.replaceAll('-', '+').replaceAll('_', '/'))
      ) as Record<string, unknown>;
      expect(payload['iss']).toBe(TEST_CLIENT_EMAIL);
      expect(payload['scope']).toBe('https://www.googleapis.com/auth/firebase.messaging');
      expect(payload['aud']).toBe('https://oauth2.googleapis.com/token');
      expect(typeof payload['iat']).toBe('number');
      expect(typeof payload['exp']).toBe('number');
      expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(3600);
    });

    it('caches access token for subsequent sends', async () => {
      mockOAuthAndFcmMultiple(1);
      mockFcmSendSuccess();

      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);
      await client.send(testNotification);

      // 1 OAuth + 2 FCM = 3 (not 2 OAuth + 2 FCM = 4)
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('reuses cached token within TTL', async () => {
      vi.useFakeTimers();
      const start = Date.now();

      mockOAuthAndFcmMultiple(1);
      mockFcmSendSuccess();

      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);

      // Advance to 54 minutes (within 55-min TTL)
      vi.setSystemTime(start + 54 * 60 * 1000);

      await client.send(testNotification);

      // 1 OAuth + 2 FCM = 3 (token still cached)
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('re-mints token when expired', async () => {
      vi.useFakeTimers();
      const start = Date.now();

      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Advance past 55-minute cache TTL
      vi.setSystemTime(start + 56 * 60 * 1000);

      mockOAuthAndFcm();

      await client.send(testNotification);

      // 2 OAuth + 2 FCM = 4
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('throws when OAuth endpoint returns error', async () => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 401 }));

      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await expect(client.send(testNotification)).rejects.toThrow('OAuth');
    });
  });

  describe('FCM message sending', () => {
    it('calls correct FCM endpoint URL', async () => {
      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);

      const [url] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect(url).toBe(`https://fcm.googleapis.com/v1/projects/${TEST_PROJECT_ID}/messages:send`);
    });

    it('includes Bearer token from OAuth response', async () => {
      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);

      const [, options] = fetchMock.mock.calls[1]! as [string, RequestInit];
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer ya29.test-token'
      );
    });

    it('sends correct message payload', async () => {
      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send(testNotification);

      const [, options] = fetchMock.mock.calls[1]! as [string, RequestInit];
      const body = JSON.parse(options.body as string) as {
        message: { token: string; notification: { title: string; body: string } };
      };

      expect(body.message.token).toBe('token-abc');
      expect(body.message.notification.title).toBe('New Message');
      expect(body.message.notification.body).toBe('Hello from HushBox');
    });

    it('includes data payload when provided', async () => {
      mockOAuthAndFcm();
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send({
        ...testNotification,
        data: { conversationId: 'conv-123' },
      });

      const [, options] = fetchMock.mock.calls[1]! as [string, RequestInit];
      const body = JSON.parse(options.body as string) as {
        message: { data?: Record<string, string> };
      };

      expect(body.message.data).toEqual({ conversationId: 'conv-123' });
    });

    it('sends one FCM request per token', async () => {
      mockOAuthAndFcmMultiple(3);
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      await client.send({
        tokens: ['token-1', 'token-2', 'token-3'],
        title: 'T',
        body: 'B',
      });

      // 1 OAuth + 3 FCM = 4
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('returns correct success and failure counts', async () => {
      mockOAuthSuccess();
      fetchMock.mockResolvedValueOnce(Response.json({ name: 'projects/test/messages/1' }));
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: { code: 404, message: 'Token not registered' } }, { status: 404 })
      );

      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      const result = await client.send({
        tokens: ['good-token', 'bad-token'],
        title: 'T',
        body: 'B',
      });

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
    });

    it('does not throw on individual token failure', async () => {
      mockOAuthSuccess();
      fetchMock.mockResolvedValueOnce(
        Response.json({ error: { code: 400, message: 'Invalid token' } }, { status: 400 })
      );

      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      const result = await client.send(testNotification);

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(1);
    });

    it('handles empty tokens array', async () => {
      const client = createFcmPushClient(TEST_PROJECT_ID, testServiceAccountJson);

      const result = await client.send({
        tokens: [],
        title: 'T',
        body: 'B',
      });

      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
