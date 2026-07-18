import { getContext } from 'hono/context-storage';
import { newsletterConfirmationEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { NewsletterConfirmEmailPort } from '../slices/newsletter/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { AppEnv } from '../lib/context/index.js';

export const NEWSLETTER_CONFIRM_EMAIL_SUBJECT = 'Confirm your subscription';

/** The shared send deps plus the frontend base URL this port owns. */
export interface NewsletterConfirmEmailSendDeps extends EmailSendDeps {
  readonly frontendUrl: string;
}

/**
 * The composition-root adapter behind the newsletter slice's
 * NewsletterConfirmEmailPort: composes the notifications slice's
 * double-opt-in template, owns the frontend-link construction (the domain
 * passes a bare token), and sends it through the shared compose-and-send
 * seam. Best-effort — the domain ignores a failed Result — so the failure's
 * error code is logged (codes only) and still returned on the error channel.
 */
export function createNewsletterConfirmEmailAdapter(
  resolve: () => NewsletterConfirmEmailSendDeps
): NewsletterConfirmEmailPort {
  return {
    sendConfirmation(args) {
      const { sender, frontendUrl, logger } = resolve();
      const link = new URL('/newsletter/confirm', frontendUrl);
      link.searchParams.set('token', args.token);
      const content = newsletterConfirmationEmail({ confirmUrl: link.toString() });
      return sendComposedEmail(
        { sender, logger },
        {
          to: args.to,
          subject: NEWSLETTER_CONFIRM_EMAIL_SUBJECT,
          content,
          logFailure: (log, errorCode) => {
            log.warn('newsletter confirmation email send failed', { errorCode });
          },
        }
      );
    },
  };
}

/**
 * Extends EnvContext (the `EmailSenderEnv` pattern): a weak all-optional shape
 * would fail assignability from `Bindings`, which declares neither var.
 */
interface FrontendUrlEnv extends EnvContext {
  readonly FRONTEND_URL?: string;
}

function requireFrontendUrl(env: FrontendUrlEnv): string {
  if (env.FRONTEND_URL === undefined || env.FRONTEND_URL === '') {
    throw new Error('FRONTEND_URL is required to build the newsletter confirm link');
  }
  return env.FRONTEND_URL;
}

/**
 * The production binding: resolves the env sender + request logger per send
 * (single-sourced) and adds the frontend base URL. Missing FRONTEND_URL is a
 * deployment misconfiguration: a fail-fast defect, never a silently unsent
 * email.
 */
export function createAppNewsletterConfirmEmailPort(): NewsletterConfirmEmailPort {
  return createNewsletterConfirmEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return { ...resolveEmailSendDeps(), frontendUrl: requireFrontendUrl(c.env) };
  });
}
