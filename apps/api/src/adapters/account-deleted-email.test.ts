import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createMockEmailSender } from '../slices/notifications/index.js';
import { errAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import {
  ACCOUNT_DELETED_EMAIL_SUBJECT,
  createAccountDeletedEmailAdapter,
  createAppAccountDeletedEmailPort,
} from './account-deleted-email.js';
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

describe('createAccountDeletedEmailAdapter', () => {
  function harness(sender: EmailSender): {
    port: ReturnType<typeof createAccountDeletedEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createAccountDeletedEmailAdapter(() => {
      calls += 1;
      return { sender, logger: telemetry };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends the fixed subject to the pre-capture address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendAccountDeletedEmail({ to: 'gone@example.com' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('gone@example.com');
    expect(sender.getSentMessages()[0]?.subject).toBe(ACCOUNT_DELETED_EMAIL_SUBJECT);
  });

  it('carries the compromise warning in the plain-text body', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendAccountDeletedEmail({ to: 'gone@example.com' });
    expect(sender.getSentMessages()[0]?.text).toContain('security@hushbox.ai');
  });

  it('logs the failure error code through the typed logger and errs', async () => {
    const { port, warns } = harness({ send: () => errAsync(unavailableError('sender down')) });
    const result = await port.sendAccountDeletedEmail({ to: 'gone@example.com' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
    expect(warns).toEqual([
      { msg: 'account-deleted email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendAccountDeletedEmail({ to: 'a@example.com' });
    await port.sendAccountDeletedEmail({ to: 'b@example.com' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppAccountDeletedEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app account-deleted email port tests');
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
      const port = createAppAccountDeletedEmailPort();
      const result = await port.sendAccountDeletedEmail({ to: 'gone@example.com' });
      return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/send', { method: 'POST' }, env);
    expect(await res.json()).toEqual({ outcome: 'ok' });
  });
});
