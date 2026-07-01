import { z } from 'zod';

import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BannerDismissalStore } from '../ports/index.js';

// The hash is the server-issued message-set hash; bound the length defensively.
export const bannerHashQuerySchema = z.object({ hash: z.string().min(1).max(128) });
export const putBannerDismissalBodySchema = z.object({ hash: z.string().min(1).max(128) });

export interface BannerDismissalState {
  readonly dismissed: boolean;
}

export function getBannerDismissal(
  store: BannerDismissalStore,
  userId: string,
  hash: string
): ResultAsync<BannerDismissalState, DomainError> {
  return store.isDismissed(userId, hash).map((dismissed) => ({ dismissed }));
}

export function saveBannerDismissal(
  store: BannerDismissalStore,
  userId: string,
  hash: string
): ResultAsync<BannerDismissalState, DomainError> {
  return store.upsertDismissal(userId, hash).map(() => ({ dismissed: true }));
}
