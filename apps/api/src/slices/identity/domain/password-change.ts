import { z } from 'zod';
import { rotatePasswordCredentials } from './credentials.js';
import { requireUser } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { deserializeRegistrationRequest, runNewPasswordRegisterInit } from './opaque.js';
import { createStepUpFinishFlow, startStepUp } from './step-up.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  EvictUserPort,
  IdentityUsersStore,
  PasswordChangedEmailPort,
} from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';
import type { StepUpFinishOutcome } from './step-up.js';

export const changePasswordInitBodySchema = z.object({
  ke1: z.array(z.number()).min(1),
  newRegistrationRequest: z.array(z.number()).min(1),
});

export const changePasswordFinishBodySchema = z.object({
  ke3: z.array(z.number()).min(1),
  newRegistrationRecord: z.array(z.number()).min(1),
  newPasswordWrappedPrivateKey: z.string().min(1),
  changePasswordSessionId: z.uuid(),
});

export interface PasswordChangeInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
  readonly ke1: number[];
  readonly newRegistrationRequest: number[];
}

export interface PasswordChangeInitOutcome {
  readonly ke2: number[];
  readonly newRegistrationResponse: number[];
  readonly changePasswordSessionId: string;
}

/**
 * Round one of a password change: an OPAQUE step-up challenge over the current
 * password AND a fresh registerInit for the new one, both bound to the user's
 * id. The client proves the old password (KE3) and completes the new
 * registration in the finish round.
 */
export function startPasswordChange(
  args: PasswordChangeInitArgs
): ResultAsync<PasswordChangeInitOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    return startStepUp({
      redis: args.redis,
      definition: IDENTITY_KEYS.opaquePendingChangePassword,
      ke1: args.ke1,
      userId: args.userId,
      opaqueRegistration: user.opaqueRegistration,
      masterSecret: args.masterSecret,
    }).andThen((stepUp) =>
      deserializeRegistrationRequest(args.newRegistrationRequest)
        .asyncAndThen((request) =>
          runNewPasswordRegisterInit(args.masterSecret, args.userId, request)
        )
        .map(
          (newRegistrationResponse): PasswordChangeInitOutcome => ({
            ke2: stepUp.ke2,
            newRegistrationResponse,
            changePasswordSessionId: stepUp.stepUpSessionId,
          })
        )
    );
  });
}

export interface PasswordChangeFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly emailPort: PasswordChangedEmailPort;
  readonly logger: Telemetry;
  readonly userId: string;
  readonly ke3: number[];
  readonly changePasswordSessionId: string;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly now: number;
  /**
   * Realtime eviction fan-out, forwarded to `rotatePasswordCredentials` so the
   * pw-changed watermark's staled sessions have their live sockets closed
   * best-effort. Optional: absent until the worker wires it (ARCHITECTURE §15).
   */
  readonly evictUser?: EvictUserPort;
}

export interface PasswordChangeResult {
  readonly rotated: true;
}

/**
 * Round two: the step-up finish flow verifies the old password, then rotates
 * the OPAQUE record + password-wrapped key and stamps the pw-changed-at
 * watermark so every session issued before now (this one included) goes stale.
 */
export function createPasswordChangeFinishFlow(
  args: PasswordChangeFinishArgs
): OpaqueFinishFlow<StepUpFinishOutcome<PasswordChangeResult>> {
  return createStepUpFinishFlow<PasswordChangeResult>({
    redis: args.redis,
    definition: IDENTITY_KEYS.opaquePendingChangePassword,
    userId: args.userId,
    stepUpSessionId: args.changePasswordSessionId,
    ke3: args.ke3,
    onVerified: () => rotatePassword(args),
  });
}

function rotatePassword(
  args: PasswordChangeFinishArgs
): ResultAsync<PasswordChangeResult, DomainError> {
  return rotatePasswordCredentials({
    ...args,
    notify: (notice) => args.emailPort.sendPasswordChangedEmail(notice),
  }).map((): PasswordChangeResult => ({ rotated: true }));
}
