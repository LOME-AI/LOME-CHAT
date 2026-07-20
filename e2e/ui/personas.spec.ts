import { test } from '../fixtures.js';
import { TEST_ID_BUILDERS } from '@hushbox/shared';

import { expect } from '../helpers/expect.js';

test.describe('Persona Login', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/dev/personas page loads with all persona cards', async ({ page }) => {
    await page.goto('/dev/personas', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /developer personas/i })).toBeVisible();

    await expect(page.getByTestId(TEST_ID_BUILDERS.personaCard('alice'))).toBeVisible();
    await expect(page.getByTestId(TEST_ID_BUILDERS.personaCard('bob'))).toBeVisible();
    await expect(page.getByTestId(TEST_ID_BUILDERS.personaCard('charlie'))).toBeVisible();
  });
});
