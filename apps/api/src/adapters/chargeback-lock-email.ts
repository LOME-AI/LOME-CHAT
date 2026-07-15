import { chargebackLockEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { ChargebackLockEmailPort } from '../slices/billing/index.js';

export const CHARGEBACK_LOCK_EMAIL_SUBJECT = 'Your account was locked';

/**
 * The composition-root adapter behind billing's ChargebackLockEmailPort:
 * composes the notifications slice's chargeback-lock template and sends it
 * through the shared compose-and-send seam. Best-effort — the dispute flow
 * ignores a failed Result — so the failure's error code is logged (codes only)
 * and still returned on the error channel.
 */
export function createChargebackLockEmailAdapter(
  resolve: () => EmailSendDeps
): ChargebackLockEmailPort {
  return {
    sendChargebackLockEmail(args) {
      const content = chargebackLockEmail({});
      return sendComposedEmail(resolve(), {
        to: args.to,
        subject: CHARGEBACK_LOCK_EMAIL_SUBJECT,
        content,
        logFailure: (logger, errorCode) => {
          logger.warn('chargeback-lock email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppChargebackLockEmailPort(): ChargebackLockEmailPort {
  return createChargebackLockEmailAdapter(resolveEmailSendDeps);
}
