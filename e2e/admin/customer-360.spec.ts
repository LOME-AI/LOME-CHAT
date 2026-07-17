import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { c360Panel, openCustomer360, searchCustomer360 } from './helpers/customer-360.js';
import { fetchAuditRows } from './helpers/op-modal.js';
import { mintLockedUser } from './helpers/targets.js';

/** Anything push-token-shaped: a long unbroken credential-ish run. The
 * devices panel renders platform tallies and counts only — no value this
 * shape may ever appear in it. */
const TOKEN_LIKE = /[\w+/=-]{30,}/;

/**
 * The Customer-360 screen through its four states — empty, invalid, miss,
 * hit — then the wire truth that the view itself was an audited read.
 *
 * READ BUDGET: the SPA actor spends 2 customer-360 reads of 120/hr (the
 * miss and the hit; the empty and invalid states never fire a request — the
 * query is disabled for non-lookup terms). The second dev actor spends 1
 * audit read of 240/hr.
 */
test.describe('Admin Customer 360', () => {
  test('empty → invalid → miss → hit render their states, and the view is read-audited', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);

    // Empty: no query at all.
    await adminPage.goto('/customer-360');
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Empty)).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });

    // Invalid: neither an email nor a uuid — the screen teaches instead of
    // fetching (no read spent, no 4xx provoked).
    await searchCustomer360(adminPage, 'not-a-user-lookup');
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Invalid)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });

    // Miss: a valid but nonexistent email — a deliberate 404.
    expectApiErrors(adminPage, [/404 .*GET .*\/admin\/users\/overview/]);
    expectConsoleErrors(adminPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
    const missEmail = `miss-${crypto.randomUUID()}@hushbox.test`;
    await searchCustomer360(adminPage, missEmail);
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Miss)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Miss)).toContainText(missEmail);

    // Hit: header + panels render for the minted user.
    await openCustomer360(adminPage, target.email);
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Header)).toContainText(target.email);

    // Money panel: registration settled both wallets (`wallet_type` enum:
    // purchased + free).
    const money = c360Panel(adminPage, 'Money');
    await expect(money.getByText('purchased', { exact: true })).toBeVisible();
    await expect(money.getByText('free', { exact: true })).toBeVisible();

    // Devices panel: renders (tallies or the no-devices message) and never
    // anything token-shaped — the wire carries platform-per-token only.
    const devices = c360Panel(adminPage, 'Devices');
    await expect(devices).toBeVisible();
    await expect(devices).not.toContainText(TOKEN_LIKE);

    // Wire truth via the second actor: the SPA's own view above was itself
    // an audited read targeting this user.
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const reads = await fetchAuditRows(api, {
      action: 'read.customer360',
      targetId: target.userId,
    });
    const spaRead = reads.find((row) => row.actor === DEV_ADMIN_ACTORS[0]);
    expect(spaRead).toBeDefined();
    expect(spaRead?.targetType).toBe('user');
  });
});
