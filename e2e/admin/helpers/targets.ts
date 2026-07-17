import { requireEnv } from '../../helpers/env.js';
import type { APIRequestContext } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * Fresh-id admin-op target minting via `POST /dev/admin-targets`: every call
 * creates its own mutable rows (unique uuids/emails), so parallel specs
 * mutate private targets instead of racing over the fixed seeded set. Minted
 * users go through the real registration settlement (two wallets + welcome
 * credit + verified email) but are deliberately NOT OPAQUE-loginable.
 *
 * Dev routes need no admin JWT — any request context works; pass one of the
 * harness's retry-wrapped contexts (the base `request` fixture or an
 * `adminApi` context) so transient saturation drops are retried.
 */

export type AdminTargetKind = 'lockedUser' | 'deadJob' | 'discardedJob' | 'revokedShare';

export interface MintedLockedUser {
  readonly userId: string;
  readonly email: string;
}

export interface MintedJob {
  readonly jobId: string;
}

export interface MintedRevokedShare {
  readonly linkId: string;
  readonly conversationId: string;
}

export interface MintedAdminTargets {
  readonly lockedUser?: MintedLockedUser;
  readonly deadJob?: MintedJob;
  readonly discardedJob?: MintedJob;
  readonly revokedShare?: MintedRevokedShare;
}

/** Mint the requested target kinds; throws on any non-201 so a broken seed
 * fails at setup, never mid-assertion. */
export async function mintAdminTargets(
  request: APIRequestContext,
  kinds: readonly AdminTargetKind[]
): Promise<MintedAdminTargets> {
  const response = await request.post(`${API_BASE}/dev/admin-targets`, {
    data: { kinds },
  });
  if (response.status() !== 201) {
    throw new Error(`mintAdminTargets(${kinds.join(',')}) failed: ${String(response.status())}`);
  }
  return (await response.json()) as MintedAdminTargets;
}

/** A disposable locked user with two freshly-settled wallets nobody else
 * touches — the standard mutable target for wallet-op specs. */
export async function mintLockedUser(request: APIRequestContext): Promise<MintedLockedUser> {
  const minted = await mintAdminTargets(request, ['lockedUser']);
  if (minted.lockedUser === undefined) {
    throw new Error('mintAdminTargets returned 201 without a lockedUser');
  }
  return minted.lockedUser;
}
