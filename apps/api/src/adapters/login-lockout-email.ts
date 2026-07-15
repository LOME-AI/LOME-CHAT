import { accountLockedEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { AccountLockedEmailPort } from '../slices/identity/index.js';

export const LOGIN_LOCKOUT_EMAIL_SUBJECT = 'Your account has been temporarily locked';

/**
 * The composition-root adapter behind identity's AccountLockedEmailPort:
 * composes the notifications slice's failed-sign-in `accountLockedEmail`
 * template (distinct from billing's chargeback-lock notification) and sends it
 * through the shared compose-and-send seam. Best-effort — the login flow
 * ignores a failed Result — so the failure's error code is logged (codes only)
 * and still returned on the error channel.
 */
export function createLoginLockoutEmailAdapter(
  resolve: () => EmailSendDeps
): AccountLockedEmailPort {
  return {
    sendAccountLockedEmail(args) {
      const content = accountLockedEmail({
        lockoutMinutes: args.lockoutMinutes,
        ...(args.userName === undefined ? {} : { userName: args.userName }),
      });
      return sendComposedEmail(resolve(), {
        to: args.to,
        subject: LOGIN_LOCKOUT_EMAIL_SUBJECT,
        content,
        logFailure: (logger, errorCode) => {
          logger.warn('login-lockout email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppLoginLockoutEmailPort(): AccountLockedEmailPort {
  return createLoginLockoutEmailAdapter(resolveEmailSendDeps);
}
