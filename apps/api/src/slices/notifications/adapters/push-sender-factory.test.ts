import { describe, it, expect, beforeAll } from 'vitest';
import { createPushSenderFromEnv } from './push-sender-factory.js';
import type { Database } from '@hushbox/db';

const stubDb = {} as unknown as Database;

let serviceAccountJson: string;

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
  serviceAccountJson = JSON.stringify({ client_email: 'svc@test.iam', private_key: pem });
});

describe('createPushSenderFromEnv', () => {
  it('fails fast when NODE_ENV is unset', () => {
    expect(() => createPushSenderFromEnv({}, stubDb)).toThrow(/NODE_ENV/);
  });

  it('selects the mock sender in local dev', () => {
    const sender = createPushSenderFromEnv({ NODE_ENV: 'development' }, stubDb);

    expect('getSentMessages' in sender).toBe(true);
  });

  it('selects the mock sender in CI', () => {
    const sender = createPushSenderFromEnv({ NODE_ENV: 'development', CI: 'true' }, stubDb);

    expect('getSentMessages' in sender).toBe(true);
  });

  it('fails fast in production without FCM credentials', () => {
    expect(() => createPushSenderFromEnv({ NODE_ENV: 'production' }, stubDb)).toThrow(
      /FCM_PROJECT_ID/
    );
  });

  it('selects the real FCM sender in production', () => {
    const sender = createPushSenderFromEnv(
      {
        NODE_ENV: 'production',
        FCM_PROJECT_ID: 'hushbox-prod',
        FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson,
      },
      stubDb
    );

    expect('getSentMessages' in sender).toBe(false);
  });
});
