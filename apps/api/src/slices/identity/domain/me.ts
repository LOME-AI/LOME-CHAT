import { toBase64 } from '@hushbox/shared';
import { requireUser } from './guards.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUserRecord, IdentityUsersStore } from '../ports/index.js';

/**
 * The `/me` bootstrap payload. `/me` is `session`-class, so the pipeline
 * guarantees a full principal (a revoked session is downgraded before
 * authorization — the redundant legacy `sessionActive` recheck is dropped) and
 * a pending-2fa principal is refused at the gate rather than served the legacy
 * reduced shape. Crypto-key fields therefore always ride along.
 * `customInstructionsEncrypted` is owned by the account slice; the client
 * fetches it from `/account/instructions` separately (single-writer).
 */
export interface MeResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly username: string;
    readonly emailVerified: boolean;
    readonly totpEnabled: boolean;
    readonly hasAcknowledgedPhrase: boolean;
  };
  readonly passwordWrappedPrivateKey: string;
  readonly publicKey: string;
}

/**
 * Resolves the authenticated user's bootstrap profile. A vanished row under an
 * authenticated principal is a defect (`requireUser` throws → 500), never a
 * client outcome.
 */
export function resolveMe(
  store: IdentityUsersStore,
  userId: string
): ResultAsync<MeResponse, DomainError> {
  return store.findById(userId).map((found) => buildMeResponse(requireUser(found)));
}

function buildMeResponse(user: IdentityUserRecord): MeResponse {
  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      emailVerified: user.emailVerified,
      totpEnabled: user.totpEnabled,
      hasAcknowledgedPhrase: user.hasAcknowledgedPhrase,
    },
    passwordWrappedPrivateKey: toBase64(user.passwordWrappedPrivateKey),
    publicKey: toBase64(user.publicKey),
  };
}
