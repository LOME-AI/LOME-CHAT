import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { describe, expect, it } from 'vitest';
import { unavailableError } from '../lib/errors/index.js';
import { errAsync, okAsync } from '../lib/result/index.js';
import { createMockEmailSender } from '../slices/notifications/index.js';
import {
  createAdminOpNotifierAdapter,
  createAppAdminOpNotifier,
  parseAdminNotificationRecipients,
} from './admin-op-notification-email.js';
import type { AdminOpExecutedNotice } from '../slices/admin/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');

function createLogger(): { logger: Telemetry; warnCodes: string[] } {
  const warnCodes: string[] = [];
  const noop = (): void => undefined;
  return {
    warnCodes,
    logger: {
      debug: noop,
      info: noop,
      warn: (_message, fields) => {
        if (typeof fields?.errorCode === 'string') warnCodes.push(fields.errorCode);
      },
      error: noop,
      emitMetric: noop,
      captureError: noop,
    },
  };
}

function notice(overrides: Partial<AdminOpExecutedNotice> = {}): AdminOpExecutedNotice {
  return {
    opName: 'wallet.credit',
    actor: 'admin@hushbox.test',
    reason: 'refund escalation',
    target: { type: 'wallet', id: '0198a7e2-1111-7000-8000-000000000001' },
    auditId: '0198a7e2-2222-7000-8000-000000000002',
    isUndo: false,
    ...overrides,
  };
}

describe('parseAdminNotificationRecipients', () => {
  it('splits, trims, and lowercases the comma-separated allowlist', () => {
    expect(parseAdminNotificationRecipients(' Admin@hushbox.test , ops@hushbox.test,, ')).toEqual([
      'admin@hushbox.test',
      'ops@hushbox.test',
    ]);
  });

  it('fails fast on a missing or empty allowlist', () => {
    expect(() => parseAdminNotificationRecipients()).toThrow('ADMIN_ACTOR_ALLOWLIST');
    expect(() => parseAdminNotificationRecipients(' , ')).toThrow('ADMIN_ACTOR_ALLOWLIST');
  });
});

describe('createAdminOpNotifierAdapter', () => {
  it('sends one op-notification email to every admin recipient', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.test', 'ops@hushbox.test'],
      now: () => NOW,
    }));
    await notify(notice());
    const sent = sender.getSentMessages();
    expect(sent.map((message) => message.to)).toEqual(['admin@hushbox.test', 'ops@hushbox.test']);
    expect(sent[0]?.subject).toContain('wallet.credit');
    expect(sent[0]?.html).toContain('refund escalation');
    expect(sent[0]?.html).toContain('0198a7e2-2222-7000-8000-000000000002');
    expect(sent[0]?.html).toContain(NOW.toISOString());
  });

  it('renders an undo notice with the undo subject', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.test'],
      now: () => NOW,
    }));
    await notify(notice({ isUndo: true }));
    expect(sender.getSentMessages()[0]?.subject).toContain('Undo executed');
  });

  it('renders a targetless notice without failing template validation', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.test'],
      now: () => NOW,
    }));
    const withoutTarget: AdminOpExecutedNotice = {
      opName: 'jobs.redriveAll',
      actor: 'admin@hushbox.test',
      reason: 'queue recovery',
      auditId: '0198a7e2-3333-7000-8000-000000000003',
      isUndo: false,
    };
    await notify(withoutTarget);
    expect(sender.getSentMessages()).toHaveLength(1);
  });

  it('binds the production notifier from the request context (dev mock sender)', async () => {
    const app = new Hono<AppEnv>();
    app.use(contextStorage());
    app.use(async (c, next) => {
      c.set('logger', createLogger().logger);
      await next();
    });
    app.get('/notify', async (c) => {
      await createAppAdminOpNotifier()(notice());
      return c.text('ok');
    });
    const response = await app.request(
      '/notify',
      {},
      { NODE_ENV: 'development', ADMIN_ACTOR_ALLOWLIST: 'admin@hushbox.test' }
    );
    expect(response.status).toBe(200);
  });

  it('logs a failed send per recipient and keeps sending to the rest', async () => {
    const { logger, warnCodes } = createLogger();
    const delivered: string[] = [];
    const notify = createAdminOpNotifierAdapter(() => ({
      sender: {
        send: (message) => {
          if (message.to === 'admin@hushbox.test') {
            return errAsync(unavailableError('send failed'));
          }
          delivered.push(message.to);
          return okAsync();
        },
      },
      logger,
      adminEmails: ['admin@hushbox.test', 'ops@hushbox.test'],
      now: () => NOW,
    }));
    await notify(notice());
    expect(delivered).toEqual(['ops@hushbox.test']);
    expect(warnCodes).toHaveLength(1);
  });
});
