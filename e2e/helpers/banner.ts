import { TEST_SIGNALS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from './env.js';
import { withRequestRetry } from './resilient-request.js';
import type { BannerVariant } from '@hushbox/shared';
import type { APIRequest, APIRequestContext, Locator, Page } from '@playwright/test';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * One of the two dev actors the API's dev-mode `ADMIN_ACTOR_ALLOWLIST` admits
 * (mirrors `e2e/admin/helpers/actors.ts`, which is the admin project's copy).
 */
const DEV_ADMIN_ACTOR = 'admin@hushbox.test';

/** The `banner.set` admin-op message shape (packages/shared/src/admin/ops.ts). */
export interface BannerMessageSeed {
  variant: BannerVariant;
  text: string;
  href?: string;
  linkText?: string;
}

export interface BannerSetInput {
  enabled: boolean;
  messages: BannerMessageSeed[];
}

/**
 * Worker-direct admin API context for banner seeding: mints a dev Access JWT
 * from the dev-only `GET /dev/admin-token` route and attaches it under the
 * header the route names — the same mint `e2e/admin/fixtures.ts` performs.
 * Caller owns disposal.
 */
export async function mintBannerAdminContext(request: APIRequest): Promise<APIRequestContext> {
  const mintContext = withRequestRetry(await request.newContext({ baseURL: apiUrl }));
  try {
    const response = await mintContext.get('/dev/admin-token', {
      params: { email: DEV_ADMIN_ACTOR },
    });
    if (!response.ok()) {
      throw new Error(`dev admin token mint failed: ${String(response.status())}`);
    }
    const { token, header } = (await response.json()) as { token: string; header: string };
    return withRequestRetry(
      await request.newContext({ baseURL: apiUrl, extraHTTPHeaders: { [header]: token } })
    );
  } finally {
    await mintContext.dispose();
  }
}

/**
 * Seed the single global `banner_config` row via the registered admin op —
 * `POST /admin/ops/banner.set/execute` with the engine-required
 * `Idempotency-Key` header (wire shape mirrors `e2e/admin/helpers/op-modal.ts`).
 * Throws on any non-200 so a broken seed fails at the seed, not mid-test.
 */
export async function setBanner(api: APIRequestContext, input: BannerSetInput): Promise<void> {
  const response = await api.post('/admin/ops/banner.set/execute', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: {
      input: {
        enabled: input.enabled,
        messages: input.messages,
        reason: 'e2e announcement-banner seed',
      },
    },
  });
  if (response.status() !== 200) {
    throw new Error(`banner.set execute failed: ${String(response.status())}`);
  }
}

/**
 * Wait for the banner mount's settled signal: the payload fetch resolved AND
 * the show/hide decision is applied. Distinguishes "no banner" from "not
 * loaded yet". `state: 'attached'` (not visible): with no active banner the
 * mount node is an empty, zero-size div that still carries the attribute.
 */
export async function waitForBannerSettled(
  page: Page,
  timeout: number = TIMEOUTS.APP_STABLE
): Promise<void> {
  await page
    .locator(`[${TEST_SIGNALS.bannerSettled}="true"]`)
    .waitFor({ state: 'attached', timeout });
}

/** The link inside a banner message. The scrolling track is `aria-hidden`
 * (the sr-only live region carries the text for AT), so role-based lookup
 * can't reach it; the raw anchor selector is confined here per suite rules. */
export function bannerMessageLink(message: Locator): Locator {
  return message.locator('a.hb-link');
}
