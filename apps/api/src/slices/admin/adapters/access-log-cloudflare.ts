import { z } from 'zod';
import type { AccessLogEvent, AccessLogReader, AccessLogWindow } from '../ports/index.js';

/**
 * The real Cloudflare Access authentication-log adapter. Request shape
 * (Cloudflare API v4, "Access authentication logs"):
 *
 *   GET https://api.cloudflare.com/client/v4/accounts/{account_id}/access/logs/access_requests
 *       ?since=<ISO 8601>&until=<ISO 8601>&limit=<n>&direction=desc
 *   Authorization: Bearer <token with the Access: Audit Logs read scope>
 *
 * responding `{ success, result: [{ user_email, action, allowed,
 * created_at, … }] }`. Mapping is fail-closed: `action === 'login'` is an
 * ordinary authentication; ANY other action (registration/enrollment or a
 * future event type) maps to `enrollment` so the audit cron alerts on it.
 * Free-tier Access retains these logs for only 24 hours — the ~6-hourly
 * cadence is load-bearing.
 *
 * Not locally exercisable: dev/CI bind the
 * fake adapter; this client is covered by stubbed-fetch unit tests only.
 */

export const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

const ACCESS_LOG_PAGE_LIMIT = 1000;

const accessRequestRowSchema = z.object({
  user_email: z.string(),
  action: z.string(),
  created_at: z.string(),
});

const accessRequestsResponseSchema = z.object({
  success: z.boolean(),
  result: z.array(accessRequestRowSchema),
});

export interface CloudflareAccessLogConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
}

export function createCloudflareAccessLogReader(
  config: CloudflareAccessLogConfig
): AccessLogReader {
  return {
    async listEvents(window: AccessLogWindow): Promise<readonly AccessLogEvent[]> {
      const url = new URL(
        `${CLOUDFLARE_API_BASE_URL}/accounts/${config.accountId}/access/logs/access_requests`
      );
      url.searchParams.set('since', window.since.toISOString());
      url.searchParams.set('until', window.until.toISOString());
      url.searchParams.set('limit', String(ACCESS_LOG_PAGE_LIMIT));
      url.searchParams.set('direction', 'desc');
      const response = await config.fetch(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${config.apiToken}` },
      });
      if (!response.ok) {
        // Codes only, never response content (it could carry identities).
        throw new Error(
          `cloudflare access-log request failed with status ${String(response.status)}`
        );
      }
      const parsed = accessRequestsResponseSchema.parse(await response.json());
      if (!parsed.success) {
        throw new Error('cloudflare access-log request returned success=false');
      }
      return parsed.result.map((row) => ({
        email: row.user_email,
        kind: row.action === 'login' ? 'authentication' : 'enrollment',
        occurredAt: row.created_at,
      }));
    },
  };
}
