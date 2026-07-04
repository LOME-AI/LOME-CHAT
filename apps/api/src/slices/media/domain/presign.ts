import { z } from 'zod';
import { authorizePresign } from './presign-authz.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { PresignAuthzDeps, PresignPrincipal } from './presign-authz.js';
import type { PresignReaders, Storage } from '../ports/index.js';

// Ids are uuids by construction; rejecting other shapes at the boundary
// keeps malformed probes off the readers (fail fast, no oracle lost — a
// well-formed unknown id still answers the same blind not-found).
export const contentItemParameterSchema = z.object({
  contentItemId: z.uuid(),
});

export const sharedPresignParameterSchema = z.object({
  shareId: z.uuid(),
  contentItemId: z.uuid(),
});

export interface MintDownloadUrlDeps {
  readonly readers: PresignReaders;
  readonly storage: Storage;
  readonly now: () => Date;
}

export interface DownloadUrlGrant {
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

/**
 * The one presign path: authorize (member or share carve-out), then mint a
 * short-lived GET URL so the ciphertext flows R2 → client without touching
 * the Worker. Read-only — nothing here mutates, so retrying is free.
 */
export function mintDownloadUrl(
  deps: MintDownloadUrlDeps,
  principal: PresignPrincipal,
  contentItemId: string
): ResultAsync<DownloadUrlGrant, DomainError> {
  const authzDeps: PresignAuthzDeps = { ...deps.readers, now: deps.now };
  return authorizePresign(principal, contentItemId, authzDeps).andThen(({ storageKey }) =>
    deps.storage.presignGet(storageKey).map(({ url, expiresAt }) => ({
      downloadUrl: url,
      expiresAt: expiresAt.toISOString(),
    }))
  );
}
