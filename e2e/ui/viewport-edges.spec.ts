import type { Locator, Page } from '../fixtures.js';
import { isMobileWidth, TEST_IDS } from '@hushbox/shared';

import { test, expect } from '../fixtures.js';

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

async function getBoundingBox(locator: Locator, name: string): Promise<BoundingBox> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Expected ${name} bounding box`);
  return box;
}

async function expectVisibleInViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport();
}

function expectBoxAtOrigin(box: BoundingBox): void {
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
}

function expectBoxWithinViewport(box: BoundingBox, viewport: ViewportSize): void {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

async function verifySidebarConstraints(
  sidebarHeader: Locator,
  sidebarFooter: Locator,
  viewport: ViewportSize
): Promise<void> {
  await expectVisibleInViewport(sidebarHeader);
  await expectVisibleInViewport(sidebarFooter);

  const headerBox = await getBoundingBox(sidebarHeader, 'sidebar header');
  const footerBox = await getBoundingBox(sidebarFooter, 'sidebar footer');

  expectBoxAtOrigin(headerBox);
  expect(footerBox.x).toBe(0);
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewport.height);
}

async function verifyNoScrollbars(page: Page): Promise<void> {
  const hasVerticalScrollbar = await page.evaluate(() => {
    return document.documentElement.scrollHeight > document.documentElement.clientHeight;
  });
  expect(hasVerticalScrollbar).toBe(false);

  const hasHorizontalScrollbar = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(hasHorizontalScrollbar).toBe(false);
}

/**
 * Viewport edge visibility tests.
 * Ensures all four corners of the UI are visible and nothing overflows.
 * These tests run on ALL devices (desktop, mobile, tablet) to catch
 * viewport height issues like the iOS Safari 100vh bug.
 */
test.describe('Viewport edge visibility', () => {
  test('all viewport constraints are satisfied', async ({ authenticatedPage }) => {
    const page = authenticatedPage;
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId(TEST_IDS.appShell)).toBeVisible();

    const viewportSize = page.viewportSize();
    if (!viewportSize) throw new Error('Viewport size not available');

    const isDesktop = !isMobileWidth(viewportSize.width);
    const sidebarHeader = page.getByTestId(TEST_IDS.sidebarHeader);
    const sidebarFooter = page.getByTestId(TEST_IDS.sidebarFooter);

    if (isDesktop) {
      await verifySidebarConstraints(sidebarHeader, sidebarFooter, viewportSize);
    }

    const modelSelector = page.getByTestId(TEST_IDS.modelSelectorButton);
    await expectVisibleInViewport(modelSelector);
    const modelBox = await getBoundingBox(modelSelector, 'model selector');
    expect(modelBox.y).toBeGreaterThanOrEqual(0);
    expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(viewportSize.width);

    const promptInput = page.getByRole('textbox', { name: 'Ask me anything...' });
    await expectVisibleInViewport(promptInput);
    const inputBox = await getBoundingBox(promptInput, 'prompt input');
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(viewportSize.height);

    const appShell = page.getByTestId(TEST_IDS.appShell);
    const shellBox = await getBoundingBox(appShell, 'app shell');
    expectBoxAtOrigin(shellBox);
    expectBoxWithinViewport(shellBox, viewportSize);

    await verifyNoScrollbars(page);
  });
});
