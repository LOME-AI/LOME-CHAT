import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { dashboardJobCountCells } from './helpers/dashboard.js';

/**
 * HARNESS SMOKE — verifies the admin e2e project is wired end-to-end (admin
 * dev server up, `/api` proxy to the Worker, dev-JWT self-auth, live DB
 * reads). This is harness verification only, NOT the admin spec suite: the
 * spec catalog is founder-reviewed separately and no op/denial/audit specs
 * exist yet by design.
 */
test.describe('Admin harness smoke', () => {
  test('the dashboard renders live job counts through the self-authenticating SPA', async ({
    adminPage,
  }) => {
    const cells = dashboardJobCountCells(adminPage);
    // Four numeric cells (pending / running / dead / discarded) prove a real
    // authenticated round trip: SPA → dev-JWT mint → proxied Worker → DB.
    await expect(cells).toHaveText([/^\d+$/, /^\d+$/, /^\d+$/, /^\d+$/]);
  });

  test('the admin API helper authenticates a dev actor against the Worker directly', async ({
    adminApi,
  }) => {
    const ops = await adminApi(DEV_ADMIN_ACTORS[1]);
    const response = await ops.get('/admin/dashboard');
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { jobs: Record<string, unknown> };
    for (const bucket of ['pending', 'running', 'dead', 'discarded']) {
      expect(typeof body.jobs[bucket]).toBe('number');
    }
  });
});
