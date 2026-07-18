import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, bannerConfig, createDb } from '@hushbox/db';

import { runSettlement } from '../../../lib/idempotency/index.js';
import { createAnnouncementsStores } from './stores.js';

import type { BannerMessage } from '@hushbox/shared';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for announcements store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createAnnouncementsStores(db);

/**
 * Second pool for the lock-contention test: `db`'s pool is sized to one
 * connection, so a rival transaction needs its own session to contend.
 */
const rivalDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Dedicated session for the cross-file advisory lock. It must not come from
 * `db` — that pool is sized to one connection, and a permanently checked-out
 * lock client there would starve every query in the file.
 */
const lockDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

interface LockSession {
  query(text: string): Promise<unknown>;
  release(): void;
}

let lockSession: LockSession | undefined;

// `banner_config` is a global single-row table this file wipes wholesale, so
// every file that commits rows to it holds this lock for its whole duration
// (the routes integration suite is the other holder) — vitest runs files in
// parallel. Generous hook timeout: acquisition legitimately waits for the
// rival file's entire run.
beforeAll(async () => {
  // Checked out (never idle) so the pool cannot cull the session and
  // silently drop the lock mid-file.
  lockSession = await lockDb.$client.connect();
  await lockSession.query("select pg_advisory_lock(hashtext('announcements.banner_config'))");
}, 120_000);

beforeEach(async () => {
  await db.delete(bannerConfig);
});

afterAll(async () => {
  await db.delete(bannerConfig);
  // Ending the lock session is what releases the advisory lock.
  lockSession?.release();
  await lockDb.$client.end();
  await rivalDb.$client.end();
  await db.$client.end();
});

const MESSAGE: BannerMessage = { text: 'maintenance tonight', variant: 'warning' };

async function rowCount(): Promise<number> {
  const rows = await db.select({ id: bannerConfig.id }).from(bannerConfig);
  return rows.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('banner config store: readForUpdateWithinTx', () => {
  it('returns the defined empty state when no row exists', async () => {
    const state = await runSettlement(db, (tx) => stores.config.readForUpdateWithinTx(tx));
    expect(state).toEqual({ enabled: false, messages: [] });
  });

  it('returns the current config as the undo snapshot after a write', async () => {
    await runSettlement(db, (tx) =>
      stores.config.setWithinTx(tx, { enabled: true, messages: [MESSAGE] })
    );
    const state = await runSettlement(db, (tx) => stores.config.readForUpdateWithinTx(tx));
    expect(state).toEqual({ enabled: true, messages: [MESSAGE] });
  });

  it('serializes concurrent transactions: a rival read waits for the holder to commit', async () => {
    await runSettlement(db, (tx) =>
      stores.config.setWithinTx(tx, { enabled: true, messages: [MESSAGE] })
    );
    let holderCommitted = false;
    let holderHasLock = (): void => {};
    const lockHeld = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    const holder = runSettlement(db, async (tx) => {
      await stores.config.readForUpdateWithinTx(tx);
      holderHasLock();
      // Held long enough that a non-blocking rival would observe
      // `holderCommitted === false`; the row lock forces it to wait.
      await sleep(300);
      holderCommitted = true;
    });
    await lockHeld;
    const rival = runSettlement(rivalDb, async (tx) => {
      await stores.config.readForUpdateWithinTx(tx);
      expect(holderCommitted).toBe(true);
    });
    await Promise.all([holder, rival]);
  });
});

describe('banner config store: setWithinTx', () => {
  it('round-trips through the public read', async () => {
    await runSettlement(db, (tx) =>
      stores.config.setWithinTx(tx, { enabled: true, messages: [MESSAGE] })
    );
    const read = await stores.config.readActive();
    expect(read._unsafeUnwrap()).toEqual({ enabled: true, messages: [MESSAGE] });
  });

  it('updates the existing row on a second write instead of duplicating it', async () => {
    const replacement: BannerMessage = { text: 'all clear', variant: 'info' };
    await runSettlement(db, (tx) =>
      stores.config.setWithinTx(tx, { enabled: true, messages: [MESSAGE] })
    );
    await runSettlement(db, (tx) =>
      stores.config.setWithinTx(tx, { enabled: false, messages: [replacement] })
    );
    expect(await rowCount()).toBe(1);
    const read = await stores.config.readActive();
    expect(read._unsafeUnwrap()).toEqual({ enabled: false, messages: [replacement] });
  });

  it('rolls back with the enclosing transaction, leaving no partial write', async () => {
    await expect(
      runSettlement(db, async (tx) => {
        await stores.config.setWithinTx(tx, { enabled: true, messages: [MESSAGE] });
        throw new Error('caller aborts after the write');
      })
    ).rejects.toThrow('caller aborts after the write');
    expect(await rowCount()).toBe(0);
  });
});
