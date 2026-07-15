import { welcomeEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { WelcomeEmailPort } from '../slices/billing/index.js';

export const WELCOME_EMAIL_SUBJECT = 'Welcome to HushBox';

/**
 * The composition-root adapter behind billing's WelcomeEmailPort: composes the
 * notifications slice's welcome template and sends it through the shared
 * compose-and-send seam (`sendComposedEmail`). Best-effort — billing ignores a
 * failed Result — so the failure's error code is logged (codes only, never the
 * address or content) and still returned on the error channel.
 */
export function createWelcomeEmailAdapter(resolve: () => EmailSendDeps): WelcomeEmailPort {
  return {
    sendWelcomeEmail(args) {
      const content = welcomeEmail(args.userName === undefined ? {} : { userName: args.userName });
      return sendComposedEmail(resolve(), {
        to: args.to,
        subject: WELCOME_EMAIL_SUBJECT,
        content,
        logFailure: (logger, errorCode) => {
          logger.warn('welcome email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppWelcomeEmailPort(): WelcomeEmailPort {
  return createWelcomeEmailAdapter(resolveEmailSendDeps);
}
