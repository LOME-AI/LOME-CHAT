import { createEnvUtilities } from '@hushbox/shared';
import {
  createCloudflareAccessLogReader,
  createFakeAccessLogReader,
} from '../slices/admin/index.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { AccessLogReader } from '../slices/admin/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { CronEntry } from './cron.js';

/**
 * The ~6-hourly Access-log auditor (read-only — it never touches domain
 * state; its only outputs are telemetry alerts). Two rules, both pages:
 * an authentication by an email outside the actor allowlist (the edge wall
 * admitted someone the in-Worker allowlist would refuse), and ANY
 * enrollment-shaped event — the physical ceremony is the only enrollment
 * path, so an enrollment in the logs is an attacker enrolling a factor.
 * Free-tier Access retains logs 24 h; the 6-hour
 * cadence with an overlap-margined lookback gives multiple retries inside
 * that window.
 */

export const ACCESS_LOG_LOOKBACK_MS = 7 * 60 * 60 * 1000;

export interface AccessLogAuditEntryDeps {
  /** Resolved inside `run` so a config fault is an isolated entry failure. */
  readonly resolveReader: () => AccessLogReader;
  readonly allowlist: () => ReadonlySet<string>;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
}

export function createAccessLogAuditEntry(deps: AccessLogAuditEntryDeps): CronEntry {
  return {
    name: 'admin-access-log-audit',
    run: async (): Promise<void> => {
      const until = deps.now();
      const since = new Date(until.getTime() - ACCESS_LOG_LOOKBACK_MS);
      const events = await deps.resolveReader().listEvents({ since, until });
      const allowlist = deps.allowlist();
      for (const event of events) {
        if (event.kind === 'enrollment') {
          deps.telemetry.error('access log shows an enrollment-shaped event', {
            errorCode: 'admin_access_enrollment_event',
          });
          deps.telemetry.captureError(
            new Error('access log shows an enrollment-shaped event'),
            FINGERPRINT_CODES.adminAccessEnrollmentEvent
          );
          continue;
        }
        if (!allowlist.has(event.email.toLowerCase())) {
          deps.telemetry.error('access log shows an authentication outside the allowlist', {
            errorCode: 'admin_access_unexpected_actor',
          });
          deps.telemetry.captureError(
            new Error('access log shows an authentication outside the allowlist'),
            FINGERPRINT_CODES.adminAccessUnexpectedActor
          );
        }
      }
    },
  };
}

interface AccessLogReaderEnv extends EnvContext {
  readonly CLOUDFLARE_ACCESS_LOG_API_TOKEN?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
}

/**
 * Reader selection: the fake (no events, no network) everywhere the real
 * Cloudflare API is not exercisable — local dev, CI, E2E (the honest
 * boundary). Production binds the real adapter and fails fast and loud on a
 * missing token or account id VALUE — never a fake fallback: a production
 * auditor that silently reads canned data would hide a compromised edge wall.
 */
export function createAccessLogReaderFromEnv(env: AccessLogReaderEnv): AccessLogReader {
  const { isProduction } = createEnvUtilities(env);
  if (!isProduction) {
    return createFakeAccessLogReader([]);
  }
  const apiToken = env.CLOUDFLARE_ACCESS_LOG_API_TOKEN;
  if (apiToken === undefined || apiToken === '') {
    throw new Error('access-log audit: CLOUDFLARE_ACCESS_LOG_API_TOKEN is required in production');
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId === undefined || accountId === '') {
    throw new Error('access-log audit: CLOUDFLARE_ACCOUNT_ID is required in production');
  }
  return createCloudflareAccessLogReader({
    accountId,
    apiToken,
    // Bound so the adapter's stored reference keeps its global receiver.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
