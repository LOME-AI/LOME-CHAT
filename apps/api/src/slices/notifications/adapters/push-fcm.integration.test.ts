import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { eq } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, SERVICE_NAMES, createDb, serviceEvidence } from '@hushbox/db';
import { createFcmPushSender, _resetTokenCache } from './push-fcm.js';
import type { PushMessage } from '../ports/index.js';

/**
 * REAL push-fcm service-evidence integration — the local counterpart to the
 * openrouter `verify:evidence` gate. FCM has no CI sandbox, so the real send
 * path is exercised against a mocked HTTP seam; what this proves is that the
 * adapter's evidence-recording code path runs end-to-end and lands a real
 * `push-fcm` row in Postgres. The row is left in place (afterAll only closes
 * the connection) so `pnpm verify:evidence --require=push-fcm` finds it — the
 * same persistence the openrouter and r2 evidence seams rely on.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required for notifications integration tests — run via pnpm test:api`
    );
  }
  return value;
}

const db = createDb(requireEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

const PROJECT_ID = 'hushbox-test';
const CLIENT_EMAIL = 'test@hushbox-test.iam.gserviceaccount.com';

let serviceAccountJson: string;
let fetchImpl: Mock<typeof fetch>;

const message: PushMessage = {
  recipients: [{ userId: 'user-1', token: 'device-token-abc' }],
  title: 'New Message',
  body: 'Hello from HushBox',
};

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

afterAll(async () => {
  await db.$client.end();
});

async function countPushFcmEvidence(): Promise<number> {
  const rows = await db
    .select()
    .from(serviceEvidence)
    .where(eq(serviceEvidence.service, SERVICE_NAMES.PUSH_FCM));
  return rows.length;
}

describe('createFcmPushSender evidence', () => {
  it('lands a real push-fcm evidence row after a successful CI send', async () => {
    _resetTokenCache();
    fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      Response.json({ access_token: 'ya29.test-token', expires_in: 3600 })
    );
    fetchImpl.mockResolvedValueOnce(Response.json({ name: 'projects/test/messages/0' }));

    const sender = createFcmPushSender({
      projectId: PROJECT_ID,
      serviceAccountJson,
      fetchImpl,
      db,
      isCI: true,
    });

    const before = await countPushFcmEvidence();
    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
    expect(await countPushFcmEvidence()).toBeGreaterThan(before);
  });
});
