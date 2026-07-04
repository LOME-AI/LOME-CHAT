import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { afterAll, describe, expect, it } from 'vitest';
import { BILLING_CONTACT_EMAIL } from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createMockEmailSender } from '../slices/notifications/index.js';
import { errAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import {
  ACCOUNT_LOCKED_EMAIL_SUBJECT,
  createAccountLockedEmailAdapter,
  createAppAccountLockedEmailPort,
} from './account-locked-email.js';
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

describe('createAccountLockedEmailAdapter', () => {
  function harness(sender: EmailSender): {
    port: ReturnType<typeof createAccountLockedEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createAccountLockedEmailAdapter(() => {
      calls += 1;
      return { sender, logger: telemetry };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendAccountLockedEmail({ to: 'victim@example.com' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('victim@example.com');
  });

  it('uses the fixed account-locked subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendAccountLockedEmail({ to: 'victim@example.com' });
    expect(sender.getSentMessages()[0]?.subject).toBe(ACCOUNT_LOCKED_EMAIL_SUBJECT);
  });

  it('carries the lock notice in both bodies', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendAccountLockedEmail({ to: 'victim@example.com' });
    expect(sender.getSentMessages()[0]?.html).toContain('locked');
    expect(sender.getSentMessages()[0]?.text).toContain('locked');
  });

  it('sends the chargeback-lock copy, not the sign-in-lockout copy', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendAccountLockedEmail({ to: 'victim@example.com' });
    const sent = sender.getSentMessages()[0];
    expect(sent?.html).toContain('dispute');
    expect(sent?.html).toContain(BILLING_CONTACT_EMAIL);
    expect(sent?.text).not.toContain('minutes');
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendAccountLockedEmail({ to: 'victim@example.com' });
    expect(warns).toEqual([
      { msg: 'account-locked email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendAccountLockedEmail({ to: 'victim@example.com' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendAccountLockedEmail({ to: 'a@example.com' });
    await port.sendAccountLockedEmail({ to: 'b@example.com' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppAccountLockedEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app account-locked email port tests');
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
      const port = createAppAccountLockedEmailPort();
      const result = await port.sendAccountLockedEmail({ to: 'victim@example.com' });
      return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/send', { method: 'POST' }, env);
    expect(await res.json()).toEqual({ outcome: 'ok' });
  });
});
