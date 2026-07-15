import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb } from '@hushbox/db';
import { afterAll, describe, expect, it } from 'vitest';
import { unavailableError } from '../lib/errors/index.js';
import { errAsync } from '../lib/result/index.js';
import { createMockEmailSender } from '../slices/notifications/index.js';
import {
  DIGEST_MAX_ACTIONS,
  createAdminDigestEntry,
  digestWindowFor,
} from './admin-digest-entry.js';
import type { Telemetry } from '../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin digest entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  // admin_audit is append-only by trigger; rows stay, isolated by unique actor.
  await db.$client.end();
});

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

describe('digestWindowFor', () => {
  it('covers the previous full UTC day', () => {
    const { day, since, until } = digestWindowFor(new Date('2026-07-14T03:00:00.000Z'));
    expect(day).toBe('2026-07-13');
    expect(since.toISOString()).toBe('2026-07-13T00:00:00.000Z');
    expect(until.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });
});

describe('createAdminDigestEntry', () => {
  it('composes the previous UTC day of audit actions into one digest per admin recipient', async () => {
    const actor = `digest-test-${crypto.randomUUID()}@hushbox.ai`;
    const targetId = crypto.randomUUID();
    // "Now" is the day after the seeded rows, so today's inserts land inside
    // the previous-day window the digest summarizes.
    const now = new Date();
    const cronNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await db.insert(adminAudit).values([
      {
        actor,
        action: 'user.lock',
        targetType: 'user',
        targetId,
        details: { effects: [], inverseInput: null },
      },
      {
        actor,
        action: 'wallet.credit',
        targetType: 'wallet',
        targetId,
        details: { effects: [], inverseInput: null },
      },
    ]);
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const entry = createAdminDigestEntry({
      db,
      telemetry: logger,
      now: () => cronNow,
      resolveSend: () => ({ sender, adminEmails: ['admin@hushbox.test', 'ops@hushbox.test'] }),
    });
    expect(entry.name).toBe('admin-daily-digest');
    await entry.run();
    const sent = sender.getSentMessages();
    expect(sent.map((message) => message.to)).toEqual(['admin@hushbox.test', 'ops@hushbox.test']);
    expect(sent[0]?.subject).toContain(digestWindowFor(cronNow).day);
    expect(sent[0]?.text).toContain('user.lock');
    expect(sent[0]?.text).toContain('wallet.credit');
    expect(sent[0]?.text).toContain(actor);
  });

  it('excludes rows outside the digest window', async () => {
    const actor = `digest-window-test-${crypto.randomUUID()}@hushbox.ai`;
    await db.insert(adminAudit).values({
      actor,
      action: 'model.disable',
      details: { effects: [], inverseInput: null },
    });
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    // "Now" is two days ahead: the row above falls after the summarized day.
    const cronNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const entry = createAdminDigestEntry({
      db,
      telemetry: logger,
      now: () => cronNow,
      resolveSend: () => ({ sender, adminEmails: ['admin@hushbox.test'] }),
    });
    await entry.run();
    expect(sender.getSentMessages()[0]?.text).not.toContain(actor);
  });

  it('keeps the newest actions and drops the oldest on an over-cap day', async () => {
    const runId = crypto.randomUUID().slice(0, 8);
    const actor = `digest-cap-test-${runId}@hushbox.ai`;
    // A random historic UTC day isolates the window: admin_audit is
    // append-only, so rows from other suites (and earlier runs) written
    // "now" would otherwise crowd the newest-first cap. Distinct in-window
    // timestamps (one second apart) make the ordering deterministic.
    const dayStart =
      Date.UTC(1990, 0, 2) + Math.floor(Math.random() * 10_000) * 24 * 60 * 60 * 1000;
    const overCap = DIGEST_MAX_ACTIONS + 5;
    await db.insert(adminAudit).values(
      Array.from({ length: overCap }, (_, index) => ({
        actor,
        action: 'user.lock',
        targetType: 'user',
        targetId: `digest-cap-${runId}-${String(index)}`,
        details: { effects: [], inverseInput: null },
        createdAt: new Date(dayStart + index * 1000),
      }))
    );
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const cronNow = new Date(dayStart + 24 * 60 * 60 * 1000);
    const entry = createAdminDigestEntry({
      db,
      telemetry: logger,
      now: () => cronNow,
      resolveSend: () => ({ sender, adminEmails: ['admin@hushbox.test'] }),
    });
    await entry.run();
    const text = sender.getSentMessages()[0]?.text ?? '';
    // Newest under the cap survives; the oldest overflow rows are dropped.
    expect(text).toContain(`digest-cap-${runId}-${String(overCap - 1)}`);
    // No other index starts with 0, so the bare `-0` suffix is unambiguous.
    expect(text).not.toContain(`digest-cap-${runId}-0`);
  });

  it('logs a failed send per recipient and completes best-effort', async () => {
    const { logger, warnCodes } = createLogger();
    const entry = createAdminDigestEntry({
      db,
      telemetry: logger,
      now: () => new Date(),
      resolveSend: () => ({
        sender: { send: () => errAsync(unavailableError('send failed')) },
        adminEmails: ['admin@hushbox.test', 'ops@hushbox.test'],
      }),
    });
    await entry.run();
    expect(warnCodes).toEqual(['unavailable', 'unavailable']);
  });
});
