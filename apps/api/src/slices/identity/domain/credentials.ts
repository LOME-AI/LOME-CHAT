import { redisSet } from '../../../lib/redis/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { decodeBase64Field } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { deserializeRegistrationRecord } from './opaque.js';
import { evictUserBestEffort } from './session.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  EvictUserPort,
  IdentityUsersStore,
  PasswordChangedEmailPort,
} from '../ports/index.js';
import type { RedisClient } from './keys.js';

export interface RotateCredentialsArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly emailPort: PasswordChangedEmailPort;
  readonly logger: Telemetry;
  readonly userId: string;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly now: number;
  /**
   * Realtime eviction fan-out, invoked best-effort after the pw-changed
   * watermark stales the user's sessions. Optional: absent until the worker
   * wires it (ARCHITECTURE §15).
   */
  readonly evictUser?: EvictUserPort;
}

/**
 * Rotates the OPAQUE record + password-wrapped key in one store update, then
 * stamps the pw-changed watermark staling every session issued before now —
 * the shared back half of a password change and a recovery reset.
 *
 * The revocation watermark lands in Redis only after the rotate commits, and
 * a watermark failure propagates: the request errors even though the store
 * already rotated — accepted, because the security notification must never
 * outrun session staling. Only the tail is best-effort: the realtime eviction
 * fan-out (which closes the staled sessions' live sockets) then the
 * password-changed notification (recipient lookup + send).
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
    .andThen(() => evictUserBestEffort(args.evictUser, args.userId))
    .andThen(() => notifyPasswordChanged(args));
}

/**
 * The password-changed security notification, dispatched only after the
 * rotation (and its revocation watermark) committed. Best-effort end to end:
 * neither a lookup nor a send failure fails a password change the store
 * already committed. A failed recipient lookup is warned here (code only,
 * never the address); send-failure observability lives with the adapter
 * behind the port.
 */
function notifyPasswordChanged(args: RotateCredentialsArgs): ResultAsync<void, DomainError> {
  return args.store
    .findById(args.userId)
    .orElse((error) => {
      args.logger.warn('password-changed email recipient lookup failed', {
        errorCode: error.code,
      });
      return okAsync(null);
    })
    .andThen((user) =>
      user === null
        ? okAsync()
        : args.emailPort.sendPasswordChangedEmail({ to: user.email, userName: user.username })
    )
    .orElse(() => okAsync());
}
