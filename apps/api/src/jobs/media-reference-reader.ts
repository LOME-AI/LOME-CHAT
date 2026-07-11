import { inArray } from 'drizzle-orm';
import { contentItems } from '@hushbox/db';
import { fromPromise, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import type { DbWriter } from '../lib/idempotency/transaction.js';
import type { MediaReferenceReader } from '../slices/media/index.js';

/**
 * The production `MediaReferenceReader` for the GC cron: a direct read of
 * `content_items.storage_key` (chat owns the table; this composition-root
 * module binds media's reader port to it, the same seam `PresignReaders`
 * uses at request wiring). Read-your-writes fresh by construction — a plain
 * SELECT, never a cache — because a stale miss here deletes a billed
 * message's media. The partial unique index on `storage_key` makes the
 * IN-list probe cheap.
 */
export function createContentItemReferenceReader(db: DbWriter): MediaReferenceReader {
  return {
    referencedStorageKeys(keys) {
      if (keys.length === 0) {
        return okAsync<ReadonlySet<string>>(new Set());
      }
      // The async wrapper turns a synchronous driver throw into a rejection,
      // so every failure rides the typed error channel.
      const read = async (): Promise<{ storageKey: string | null }[]> =>
        db
          .select({ storageKey: contentItems.storageKey })
          .from(contentItems)
          .where(inArray(contentItems.storageKey, [...keys]));
      return fromPromise(read(), (cause) =>
        unavailableError('media GC reference read failed', cause)
      ).map(
        (rows): ReadonlySet<string> =>
          new Set(
            rows
              .map((row) => row.storageKey)
              .filter((storageKey): storageKey is string => storageKey !== null)
          )
      );
    },
  };
}
