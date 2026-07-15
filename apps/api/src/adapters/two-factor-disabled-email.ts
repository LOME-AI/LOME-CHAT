import { twoFactorDisabledEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { TwoFactorDisabledEmailPort } from '../slices/identity/index.js';

export const TWO_FACTOR_DISABLED_EMAIL_SUBJECT = 'Two-factor authentication disabled';

/**
 * The composition-root adapter behind identity's TwoFactorDisabledEmailPort:
 * composes the notifications slice's 2FA-disabled template and sends it through
 * the shared compose-and-send seam. Best-effort — the disable flow ignores a
 * failed Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
 */
export function createTwoFactorDisabledEmailAdapter(
  resolve: () => EmailSendDeps
): TwoFactorDisabledEmailPort {
  return {
    sendTwoFactorDisabledEmail(args) {
      const content = twoFactorDisabledEmail(
        args.userName === undefined ? {} : { userName: args.userName }
      );
      return sendComposedEmail(resolve(), {
        to: args.to,
        subject: TWO_FACTOR_DISABLED_EMAIL_SUBJECT,
        content,
        logFailure: (logger, errorCode) => {
          logger.warn('2fa-disabled email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppTwoFactorDisabledEmailPort(): TwoFactorDisabledEmailPort {
  return createTwoFactorDisabledEmailAdapter(resolveEmailSendDeps);
}
