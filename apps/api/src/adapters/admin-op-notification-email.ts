import { getContext } from 'hono/context-storage';
import {
  adminOpNotificationEmail,
  adminOpNotificationSubject,
} from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { AdminOpExecutedNotice } from '../slices/admin/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/** What one notification fan-out needs; resolved fresh per notice. */
export interface AdminOpNotifyDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
  readonly adminEmails: readonly string[];
  readonly now: () => Date;
}

/**
 * The engine's `onExecuted` notifier: composes the admin op-notification
 * template and fans it out to every allowlisted admin. Best-effort by
 * doctrine (telemetry, never a control): a failed send is logged per
 * recipient (codes only) and never throws — the engine additionally guards
 * with its own capture, so a defect here can never fail a committed op.
 */
export function createAdminOpNotifierAdapter(
  resolve: () => AdminOpNotifyDeps
): (notice: AdminOpExecutedNotice) => Promise<void> {
  return async (notice: AdminOpExecutedNotice): Promise<void> => {
    const deps = resolve();
    const content = adminOpNotificationEmail({
      opName: notice.opName,
      actorEmail: notice.actor,
      targetType: notice.target?.type ?? 'none',
      targetId: notice.target?.id ?? 'none',
      reason: notice.reason,
      occurredAt: deps.now().toISOString(),
      isUndo: notice.isUndo,
      auditId: notice.auditId,
    });
    const subject = adminOpNotificationSubject({ opName: notice.opName, isUndo: notice.isUndo });
    for (const to of deps.adminEmails) {
      // Best-effort: the failure is logged by `logFailure`; the error value
      // itself is deliberately discarded so one recipient never blocks the rest.
      await sendComposedEmail(
        { sender: deps.sender, logger: deps.logger },
        {
          to,
          subject,
          content,
          logFailure: (logger, errorCode) => {
            logger.warn('admin op notification email send failed', { errorCode });
          },
        }
      ).unwrapOr(null);
    }
  };
}

/**
 * Parses the comma-separated `ADMIN_ACTOR_ALLOWLIST` into recipient emails —
 * the notification audience IS the actor allowlist (every admin sees every
 * mutation; the tripwire against a compromised-but-valid session). Missing
 * config fails fast; the engine's notifier guard captures it.
 */
export function parseAdminNotificationRecipients(raw?: string): readonly string[] {
  const recipients = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  if (recipients.length === 0) {
    throw new Error(
      'admin op notification: ADMIN_ACTOR_ALLOWLIST is missing or parses to zero recipients'
    );
  }
  return recipients;
}

/** The production binding: resolves env sender, recipients, and clock per notice. */
export function createAppAdminOpNotifier(): (notice: AdminOpExecutedNotice) => Promise<void> {
  return createAdminOpNotifierAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      ...resolveEmailSendDeps(),
      adminEmails: parseAdminNotificationRecipients(c.env.ADMIN_ACTOR_ALLOWLIST),
      now: () => new Date(),
    };
  });
}
