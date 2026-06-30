import { z } from 'zod';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ByTransitionParams } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { InstructionsStore } from '../ports/index.js';

/**
 * Ciphertext byte cap for the account-level encrypted instructions blob. The
 * legacy route stored it uncapped; 32 KiB comfortably covers the 5000-char
 * plaintext cap used elsewhere plus ECIES/compression overhead while bounding
 * row size. The encoded cap is the exact unpadded URL-safe base64 length of
 * that many bytes.
 */
export const MAX_ENCRYPTED_INSTRUCTIONS_BYTES = 32_768;
const MAX_ENCODED_INSTRUCTIONS_LENGTH = 43_691;

export const putInstructionsBodySchema = z.object({
  instructions: z.string().min(1).max(MAX_ENCODED_INSTRUCTIONS_LENGTH),
});

export interface InstructionsState {
  /** base64 (URL-safe) ciphertext — opaque to the API, or null when unset. */
  readonly instructions: string | null;
}

export function getInstructions(
  store: InstructionsStore,
  userId: string
): ResultAsync<InstructionsState, DomainError> {
  return store
    .read(userId)
    .map((blob) => ({ instructions: blob === null ? null : toBase64(blob) }));
}

export function saveInstructions(
  store: InstructionsStore,
  userId: string,
  encoded: string
): ResultAsync<{ readonly success: true }, DomainError> {
  let blob: Uint8Array;
  try {
    blob = fromBase64(encoded);
  } catch (error) {
    return errAsync(validationError('instructions must be valid base64', error));
  }
  if (blob.length > MAX_ENCRYPTED_INSTRUCTIONS_BYTES) {
    return errAsync(validationError('instructions blob exceeds the byte cap'));
  }
  return store.upsert(userId, blob).map(() => ({ success: true as const }));
}

/**
 * Deletion as a `byTransition` step: the DELETE either removed the row or
 * matched nothing — and a clear of nothing is already the requested end
 * state, so zero rows disambiguates to a no-op success.
 */
export function clearInstructions(
  store: InstructionsStore,
  userId: string
): ByTransitionParams<{ readonly success: true }, DomainError> {
  return {
    transition: () =>
      store.remove(userId).map((outcome) => (outcome === null ? null : { success: true as const })),
    onZeroRows: () => okAsync({ success: true as const }),
  };
}
