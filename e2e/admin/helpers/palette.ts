import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import { expect } from '../fixtures.js';
import type { Locator, Page } from '@playwright/test';

/**
 * Command-palette helpers: the global ⌘K/Ctrl+K toggle and the option list.
 * The palette is keyboard-first by design (apps/admin CLAUDE.md), so these
 * drive it exclusively through the keyboard.
 */

export function palette(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminPalette);
}

export function paletteInput(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminPaletteInput);
}

export function paletteOptions(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminPaletteOption);
}

/** Open via the global shortcut and wait for the dialog. */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible({ timeout: TIMEOUTS.MODAL });
}

/** Type a query into the (auto-focused) palette input. */
export async function searchPalette(page: Page, query: string): Promise<void> {
  await paletteInput(page).fill(query);
}
