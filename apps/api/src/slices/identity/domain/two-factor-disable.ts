import { z } from 'zod';
import { okAsync } from '../../../lib/result/index.js';
import { requireUser } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { MAX_KE_ARRAY_LENGTH } from './opaque.js';
import { createStepUpFinishFlow, startStepUp } from './step-up.js';
import { verifyUserTotp } from './totp.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  IdentityUserRecord,
  IdentityUsersStore,
  TwoFactorDisabledEmailPort,
} from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';
import type { StepUpFinishOutcome } from './step-up.js';

const TOTP_CODE = z
  .string()
  .length(6)
  .regex(/^\d{6}$/);

export const disable2faInitBodySchema = z.object({
  ke1: z.array(z.number()).min(1).max(MAX_KE_ARRAY_LENGTH),
});

export const disable2faFinishBodySchema = z.object({
  ke3: z.array(z.number()).min(1).max(MAX_KE_ARRAY_LENGTH),
  code: TOTP_CODE,
  disable2FASessionId: z.uuid(),
});

export interface Disable2faInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
  readonly ke1: number[];
}

export type Disable2faInitOutcome =
  | { readonly kind: 'not-enabled' }
  | { readonly kind: 'started'; readonly ke2: number[]; readonly disable2FASessionId: string };

/** Round one of 2FA disable: refuse when TOTP is off, else open a step-up. */
export function startDisable2fa(
  args: Disable2faInitArgs
): ResultAsync<Disable2faInitOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    if (!user.totpEnabled)
      return okAsync<Disable2faInitOutcome, DomainError>({ kind: 'not-enabled' });
    return startStepUp({
      redis: args.redis,
      definition: IDENTITY_KEYS.opaquePending2FADisable,
      ke1: args.ke1,
      userId: args.userId,
      opaqueRegistration: user.opaqueRegistration,
      masterSecret: args.masterSecret,
    }).map(
      (stepUp): Disable2faInitOutcome => ({
        kind: 'started',
        ke2: stepUp.ke2,
        disable2FASessionId: stepUp.stepUpSessionId,
      })
    );
  });
}

export type Disable2faResult =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'invalid-code' }
  | { readonly kind: 'not-enabled' }
  | { readonly kind: 'disabled' };

export interface Disable2faFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
  readonly ke3: number[];
  readonly code: string;
  readonly disable2FASessionId: string;
  readonly now: Date;
  /** Best-effort security notification dispatched when TOTP flips to disabled. */
  readonly disabledEmail: TwoFactorDisabledEmailPort;
}

/**
 * Round two: the step-up verifies the password, then a valid TOTP code (with
 * the shared lockout) actually disables 2FA. Disable requires BOTH factors.
 */
export function createDisable2faFinishFlow(
  args: Disable2faFinishArgs
): OpaqueFinishFlow<StepUpFinishOutcome<Disable2faResult>> {
  return createStepUpFinishFlow<Disable2faResult>({
    redis: args.redis,
    definition: IDENTITY_KEYS.opaquePending2FADisable,
    userId: args.userId,
    stepUpSessionId: args.disable2FASessionId,
    ke3: args.ke3,
    onVerified: () => verifyCodeThenDisable(args),
  });
}

function verifyCodeThenDisable(
  args: Disable2faFinishArgs
): ResultAsync<Disable2faResult, DomainError> {
  return verifyUserTotp(args).andThen(({ user, verdict }) => {
    if (verdict.kind === 'locked') {
      return okAsync<Disable2faResult, DomainError>({
        kind: 'locked',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }
    if (verdict.kind === 'not-configured') {
      return okAsync<Disable2faResult, DomainError>({ kind: 'not-configured' });
    }
    if (verdict.kind === 'invalid') {
      return okAsync<Disable2faResult, DomainError>({ kind: 'invalid-code' });
    }
    return args.store
      .disableTotp(args.userId)
      .andThen((outcome) =>
        outcome === 'disabled'
          ? notifyTotpDisabled(args, user).map((): Disable2faResult => ({ kind: 'disabled' }))
          : okAsync<Disable2faResult, DomainError>({ kind: 'not-enabled' })
      );
  });
}

/**
 * Best-effort TOTP-disabled security notification, sent to the account whose
 * second factor was just removed (its record was already resolved by the code
 * verification). A send failure is swallowed so it never fails the disable.
 */
function notifyTotpDisabled(
  args: Disable2faFinishArgs,
  user: IdentityUserRecord
): ResultAsync<void, DomainError> {
  if (!user.email) return okAsync();
  return args.disabledEmail
    .sendTwoFactorDisabledEmail({ to: user.email, userName: user.username })
    .orElse(() => okAsync());
}
