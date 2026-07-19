import { getContext } from 'hono/context-storage';
import { ROUTES } from '@hushbox/shared';
import { newsletterConfirmationEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { NewsletterConfirmEmailPort } from '../slices/newsletter/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { AppEnv } from '../lib/context/index.js';

export const NEWSLETTER_CONFIRM_EMAIL_SUBJECT = 'Confirm your subscription';

/** The shared send deps plus the marketing base URL this port owns. */
export interface NewsletterConfirmEmailSendDeps extends EmailSendDeps {
  readonly marketingUrl: string;
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
      const { sender, marketingUrl, logger } = resolve();
      const link = new URL(ROUTES.NEWSLETTER_CONFIRMED, marketingUrl);
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
interface MarketingUrlEnv extends EnvContext {
  readonly MARKETING_URL?: string;
}

function requireMarketingUrl(env: MarketingUrlEnv): string {
  if (env.MARKETING_URL === undefined || env.MARKETING_URL === '') {
    throw new Error('MARKETING_URL is required to build the newsletter confirm link');
  }
  return env.MARKETING_URL;
}

/**
 * The production binding: resolves the env sender + request logger per send
 * (single-sourced) and adds the marketing base URL — the confirm link points at
 * the marketing confirmed page, not the API verb route. Missing MARKETING_URL is
 * a deployment misconfiguration: a fail-fast defect, never a silently unsent
 * email.
 */
export function createAppNewsletterConfirmEmailPort(): NewsletterConfirmEmailPort {
  return createNewsletterConfirmEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return { ...resolveEmailSendDeps(), marketingUrl: requireMarketingUrl(c.env) };
  });
}
