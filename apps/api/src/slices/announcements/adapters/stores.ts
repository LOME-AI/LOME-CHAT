import { desc, eq, sql } from 'drizzle-orm';
import { bannerConfig, bannerDismissals } from '@hushbox/db';

import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';

import type { Database } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { AnnouncementsStores, BannerConfigRow } from '../ports/index.js';

/** One mapper for store query rejections: infra failures become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('announcements store query failed', cause);
}

/**
 * Locks and returns the newest `banner_config` row on the caller's
 * transaction. `FOR UPDATE` serializes concurrent admin executes on the row;
 * when no row exists there is nothing to lock, so concurrent first-ever
 * inserts may duplicate — the newest-row-wins read keeps that deterministic.
 */
async function lockNewestConfigRow(
  tx: SettlementTx
): Promise<{ id: string; enabled: boolean; messages: unknown } | undefined> {
  const rows = await tx
    .select({
      id: bannerConfig.id,
      enabled: bannerConfig.enabled,
      messages: bannerConfig.messages,
    })
    .from(bannerConfig)
    .orderBy(desc(bannerConfig.updatedAt))
    .limit(1)
    .for('update');
  return rows[0];
}

/**
 * Drizzle implementation. Single-writer: the announcements slice owns
 * `banner_config` and `banner_dismissals`; the admin plane writes the config
 * only through this slice's `*WithinTx` surface.
 */
export function createAnnouncementsStores(db: Database): AnnouncementsStores {
  return {
    config: {
      readActive: () =>
        fromPromise(
          db
            .select({
              enabled: bannerConfig.enabled,
              messages: bannerConfig.messages,
            })
            .from(bannerConfig)
            .orderBy(desc(bannerConfig.updatedAt))
            .limit(1),
          storeFailure
        ).map((rows): BannerConfigRow | null => rows[0] ?? null),
      readForUpdateWithinTx: async (tx): Promise<BannerConfigRow> => {
        const row = await lockNewestConfigRow(tx);
        return row === undefined
          ? { enabled: false, messages: [] }
          : { enabled: row.enabled, messages: row.messages };
      },
      setWithinTx: async (tx, config): Promise<void> => {
        const row = await lockNewestConfigRow(tx);
        if (row === undefined) {
          await tx
            .insert(bannerConfig)
            .values({ enabled: config.enabled, messages: config.messages });
          return;
        }
        // `updatedAt` is DB-side so newest-row-wins ordering is authoritative
        // regardless of the caller's clock.
        await tx
          .update(bannerConfig)
          .set({ enabled: config.enabled, messages: config.messages, updatedAt: sql`now()` })
          .where(eq(bannerConfig.id, row.id));
      },
    },
    dismissals: {
      isDismissed: (userId, hash) =>
        fromPromise(
          db
            .select({ messageSetHash: bannerDismissals.messageSetHash })
            .from(bannerDismissals)
            .where(eq(bannerDismissals.userId, userId))
            .limit(1),
          storeFailure
        ).map((rows) => rows[0]?.messageSetHash === hash),
      upsertDismissal: (userId, hash) => {
        const now = new Date();
        return fromPromise(
          db
            .insert(bannerDismissals)
            .values({ userId, messageSetHash: hash, dismissedAt: now, updatedAt: now })
            .onConflictDoUpdate({
              target: bannerDismissals.userId,
              set: { messageSetHash: hash, dismissedAt: now, updatedAt: now },
            })
            .returning({ id: bannerDismissals.id }),
          storeFailure
        );
      },
    },
  };
}
