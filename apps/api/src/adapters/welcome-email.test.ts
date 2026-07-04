import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createMockEmailSender } from '../slices/notifications/index.js';
import { errAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import {
  WELCOME_EMAIL_SUBJECT,
  createAppWelcomeEmailPort,
  createWelcomeEmailAdapter,
} from './welcome-email.js';
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

describe('createWelcomeEmailAdapter', () => {
  function harness(sender: EmailSender): {
    port: ReturnType<typeof createWelcomeEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createWelcomeEmailAdapter(() => {
      calls += 1;
      return { sender, logger: telemetry };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address with the fixed welcome subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('new@example.com');
    expect(sender.getSentMessages()[0]?.subject).toBe(WELCOME_EMAIL_SUBJECT);
  });

  it('greets by user name when one is provided', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendWelcomeEmail({ to: 'new@example.com', userName: 'Sam' });
    expect(sender.getSentMessages()[0]?.html).toContain('Hi Sam,');
  });

  it('carries the billing explainer in the plain-text body', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(sender.getSentMessages()[0]?.text).toContain('How Billing Works');
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(warns).toEqual([
      { msg: 'welcome email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendWelcomeEmail({ to: 'a@example.com' });
    await port.sendWelcomeEmail({ to: 'b@example.com' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppWelcomeEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app welcome email port tests');
  }
  const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

  afterAll(async () => {
    await db.$client.end();
  });

  it('sends through the env-selected sender inside a request context', async () => {
    const { telemetry } = recordingTelemetry();
    const app = new Hono<AppEnv>();
    app.use(contextStorage());
    app.post('/send', async (c) => {
      c.set('db', db);
      c.set('logger', telemetry);
      const port = createAppWelcomeEmailPort();
      const result = await port.sendWelcomeEmail({ to: 'new@example.com' });
      return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/send', { method: 'POST' }, env);
    expect(await res.json()).toEqual({ outcome: 'ok' });
  });
});
