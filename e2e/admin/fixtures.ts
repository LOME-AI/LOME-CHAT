import { TEST_IDS } from '@hushbox/shared';
import { test as base, expect } from '../fixtures.js';
import { requireEnv } from '../helpers/env.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { DEV_ADMIN_ACTORS, type DevAdminActor } from './helpers/actors.js';
import type { APIRequestContext, Page } from '@playwright/test';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * Factory returning a Worker-direct `APIRequestContext` authenticated as the
 * given dev admin actor: mints a dev Access JWT from the dev-only
 * `GET /dev/admin-token` route (the same mint the SPA's dev-auth fetch wrapper
 * uses) and attaches it under the header the route names
 * (`Cf-Access-Jwt-Assertion`). Requests hit the Worker's bare paths
 * (`/admin/...`) — no `/api` prefix; that prefix exists only on the SPA's
 * proxied origin.
 */
export type AdminApiFactory = (actor?: DevAdminActor) => Promise<APIRequestContext>;

interface AdminFixtures {
  /** Per-actor authenticated API contexts for admin-plane routes. */
  adminApi: AdminApiFactory;
  /**
   * The admin SPA, navigated to the dashboard and settled (shell rendered).
   * Browser flows need no auth plumbing: the SPA self-authenticates in local
   * dev via its dev-auth fetch wrapper.
   */
  adminPage: Page;
}

interface MintedToken {
  token: string;
  header: string;
}

export const test = base.extend<AdminFixtures>({
  adminApi: async ({ playwright }, use) => {
    const contexts: APIRequestContext[] = [];

    const factory: AdminApiFactory = async (actor = DEV_ADMIN_ACTORS[0]) => {
      const mintContext = withRequestRetry(
        await playwright.request.newContext({ baseURL: apiUrl })
      );
      try {
        const response = await mintContext.get('/dev/admin-token', {
          params: { email: actor },
        });
        if (!response.ok()) {
          throw new Error(
            `adminApi: dev admin token mint failed for ${actor}: ${String(response.status())}`
          );
        }
        const { token, header } = (await response.json()) as MintedToken;
        const context = withRequestRetry(
          await playwright.request.newContext({
            baseURL: apiUrl,
            extraHTTPHeaders: { [header]: token },
          })
        );
        contexts.push(context);
        return context;
      } finally {
        await mintContext.dispose();
      }
    };

    await use(factory);

    for (const context of contexts) {
      await context.dispose();
    }
  },

  adminPage: async ({ page }, use) => {
    await page.goto('/');
    await expect(page.getByTestId(TEST_IDS.adminShell)).toBeVisible();
    await use(page);
  },
});

export { expect } from '../fixtures.js';
