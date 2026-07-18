import { bannerConfigSchema } from '@hushbox/shared';

import { hashCanonicalJson } from '../../../lib/idempotency/index.js';
import { okAsync, ResultAsync } from '../../../lib/result/index.js';

import type { BannerResponse } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { BannerConfigStore } from '../ports/index.js';

export interface BannerReadResult {
  readonly response: BannerResponse;
  /** How many messages the salvaging parse dropped — logged for observability. */
  readonly droppedCount: number;
}

/**
 * Read the active banner. The row is salvaged (never throws), the hash is
 * computed server-side over the normalized content so it is authoritative and
 * opaque to clients, and an empty/disabled set yields a null hash.
 */
export function getActiveBanner(
  store: BannerConfigStore
): ResultAsync<BannerReadResult, DomainError> {
  return store.readActive().andThen((row) => {
    const config = bannerConfigSchema.parse(row ?? {});
    const rawCount = row !== null && Array.isArray(row.messages) ? row.messages.length : 0;
    const droppedCount = Math.max(0, rawCount - config.messages.length);
    const active = config.enabled ? config.messages : [];

    if (active.length === 0) {
      return okAsync<BannerReadResult, DomainError>({
        response: { hash: null, messages: [] },
        droppedCount,
      });
    }

    // Variant rides inside each message, so it still feeds the hash — a
    // variant-only change re-shows dismissed banners, which is intended.
    return ResultAsync.fromSafePromise(hashCanonicalJson({ messages: active })).map((hash) => ({
      response: { hash, messages: active },
      droppedCount,
    }));
  });
}
