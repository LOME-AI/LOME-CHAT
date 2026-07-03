import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createMockEmailSender } from '../slices/notifications/index.js';
import { errAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import {
  VERIFICATION_EMAIL_SUBJECT,
  createAppVerificationEmailPort,
  createVerificationEmailAdapter,
} from './verification-email.js';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { SafeLogFields } from '../lib/telemetry/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { EmailSender } from '../slices/notifications/index.js';

interface RecordedWarn {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

function recordingTelemetry(): { telemetry: Telemetry; warns: RecordedWarn[] } {
  const warns: RecordedWarn[] = [];
  const noop = (): void => undefined;
  const telemetry: Telemetry = {
    debug: noop,
    info: noop,
    warn: (msg, fields) => {
      warns.push({ msg, fields });
    },
    error: noop,
    emitMetric: noop,
    captureError: noop,
  };
  return { telemetry, warns };
}

function failingSender(): EmailSender {
  return {
    send: () => errAsync(unavailableError('sender down')),
  };
}

describe('createVerificationEmailAdapter', () => {
  function harness(sender: EmailSender): {
    port: ReturnType<typeof createVerificationEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createVerificationEmailAdapter(() => {
      calls += 1;
      return { sender, frontendUrl: 'http://localhost:5173', logger: telemetry };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-1' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('user@example.com');
  });

  it('builds the verification link from the frontend URL and token', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-abc' });
    expect(sender.getSentMessages()[0]?.html).toContain(
      'http://localhost:5173/verify?token=tok-abc'
    );
  });

  it('carries the link in the plain-text body', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-abc' });
    expect(sender.getSentMessages()[0]?.text).toContain(
      'http://localhost:5173/verify?token=tok-abc'
    );
  });

  it('uses the fixed verification subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-1' });
    expect(sender.getSentMessages()[0]?.subject).toBe(VERIFICATION_EMAIL_SUBJECT);
  });

  it('greets by user name when one is provided', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-1', userName: 'Sam' });
    expect(sender.getSentMessages()[0]?.html).toContain('Hi Sam,');
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-1' });
    expect(warns).toEqual([
      { msg: 'verification email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-1' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-1' });
    await port.sendVerificationEmail({ to: 'user@example.com', token: 'tok-2' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppVerificationEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app verification-email port tests');
  }
  const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

  afterAll(async () => {
    await db.$client.end();
  });

  /**
   * Runs one send through a context-storage-wrapped app, the same shape the
   * real composition root provides (the adapter reads env/db/logger from the
   * current request context).
   */
  async function sendWithin(env: Bindings & { FRONTEND_URL?: string }): Promise<{
    outcome: 'ok' | 'err' | `threw: ${string}`;
  }> {
    const { telemetry } = recordingTelemetry();
    const app = new Hono<AppEnv>();
    app.use(contextStorage());
    app.post('/send', async (c) => {
      c.set('db', db);
      c.set('logger', telemetry);
      const port = createAppVerificationEmailPort();
      try {
        const result = await port.sendVerificationEmail({
          to: 'user@example.com',
          token: 'tok-app',
        });
        return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
      } catch (error) {
        return c.json({ outcome: `threw: ${error instanceof Error ? error.message : '?'}` });
      }
    });
    const res = await app.request('/send', { method: 'POST' }, env);
    return await res.json();
  }

  it('sends through the env-selected sender inside a request context', async () => {
    const { outcome } = await sendWithin({
      NODE_ENV: 'development',
      FRONTEND_URL: 'http://localhost:5173',
    });
    expect(outcome).toBe('ok');
  });

  it('fails fast when FRONTEND_URL is missing', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development' });
    expect(outcome).toMatch(/^threw: .*FRONTEND_URL/);
  });

  it('fails fast when FRONTEND_URL is blank', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development', FRONTEND_URL: '' });
    expect(outcome).toMatch(/^threw: .*FRONTEND_URL/);
  });
});
