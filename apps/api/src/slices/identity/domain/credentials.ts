import { redisSet } from '../../../lib/redis/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { decodeBase64Field } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { deserializeRegistrationRecord } from './opaque.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUsersStore, PasswordChangedEmailPort } from '../ports/index.js';
import type { RedisClient } from './keys.js';

export interface RotateCredentialsArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly emailPort: PasswordChangedEmailPort;
  readonly userId: string;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly now: number;
}

/**
 * Rotates the OPAQUE record + password-wrapped key in one store update, then
 * stamps the pw-changed watermark staling every session issued before now —
 * the shared back half of a password change and a recovery reset.
 *
 * The revocation watermark lands in Redis only after the rotate commits.
 * Accepted window: a Redis failure right here leaves prior sessions live
 * against the new credentials until they expire or log out — the established
 * revocation ordering; failing the request instead would leave a rotated
 * password the client believes was rejected.
 */
export function rotatePasswordCredentials(
  args: RotateCredentialsArgs
): ResultAsync<void, DomainError> {
  return deserializeRegistrationRecord(args.newRegistrationRecord)
    .andThen((record) =>
      decodeBase64Field(args.newPasswordWrappedPrivateKey, 'newPasswordWrappedPrivateKey').map(
        (wrapped) => ({ recordBytes: new Uint8Array(record.serialize()), wrapped })
      )
    )
    .asyncAndThen((decoded) =>
      args.store.rotatePassword(args.userId, decoded.recordBytes, decoded.wrapped)
    )
    .andThen(() => redisSet(args.redis, IDENTITY_KEYS.passwordChangedAt, args.now, args.userId))
    .andThen(() => notifyPasswordChanged(args));
}

/**
 * The password-changed security notification, dispatched only after the
 * rotation (and its revocation watermark) committed. Best-effort end to end:
 * the recipient lookup and the send are swallowed together, so a store or
 * sender outage never fails a password change the store already committed —
 * send-failure observability lives with the adapter behind the port.
 */
function notifyPasswordChanged(args: RotateCredentialsArgs): ResultAsync<void, DomainError> {
  return args.store
    .findById(args.userId)
    .andThen((user) =>
      user === null
        ? okAsync()
        : args.emailPort.sendPasswordChangedEmail({ to: user.email, userName: user.username })
    )
    .orElse(() => okAsync());
}
