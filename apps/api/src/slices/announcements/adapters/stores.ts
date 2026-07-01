import { desc, eq } from 'drizzle-orm';
import { bannerConfig, bannerDismissals } from '@hushbox/db';

import { unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';

import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { AnnouncementsStores, BannerConfigRow } from '../ports/index.js';

/** One mapper for store query rejections: infra failures become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('announcements store query failed', cause);
}

/**
 * Drizzle implementation. Single-writer: the announcements slice owns
 * `banner_dismissals`; `banner_config` is read-only here (operator-edited
 * out-of-band).
 */
export function createAnnouncementsStores(db: Database): AnnouncementsStores {
  return {
    config: {
      readActive: () =>
        fromPromise(
          db
            .select({
              enabled: bannerConfig.enabled,
              variant: bannerConfig.variant,
              messages: bannerConfig.messages,
            })
            .from(bannerConfig)
            .orderBy(desc(bannerConfig.updatedAt))
            .limit(1),
          storeFailure
        ).map((rows): BannerConfigRow | null => rows[0] ?? null),
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
