import type { Page } from '@playwright/test';

import type { ActionLogger } from './action-logger.js';

/** Ease-in-out cubic — the "human hand" curve for cursor travel. */
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export interface SmoothMouseOptions {
  /** Travel duration in ms; scales with distance when omitted. */
  durationMs?: number;
  /** Interpolation steps; ~1 per 8ms of travel by default. */
  steps?: number;
}

/**
 * Cursor state lives here because Playwright does not expose the current
 * mouse position; every capture script must route ALL mouse movement through
 * one SmoothMouse instance or travel start points will be wrong.
 */
export class SmoothMouse {
  private x = 0;
  private y = 0;

  constructor(
    private readonly page: Page,
    private readonly logger: ActionLogger
  ) {}

  async moveTo(
    x: number,
    y: number,
    label: string,
    options: SmoothMouseOptions = {}
  ): Promise<void> {
    const distance = Math.hypot(x - this.x, y - this.y);
    const durationMs = options.durationMs ?? Math.min(1400, 350 + distance * 1.6);
    const steps = options.steps ?? Math.max(12, Math.round(durationMs / 8));

    for (let index = 1; index <= steps; index++) {
      const p = easeInOutCubic(index / steps);
      const px = this.x + (x - this.x) * p;
      const py = this.y + (y - this.y) * p;
      await this.page.mouse.move(px, py);
      this.logger.log('move', px, py, label);
      await this.page.waitForTimeout(durationMs / steps);
    }
    this.x = x;
    this.y = y;
  }

  /** Smooth travel to the element's center (by test-id), then click. */
  async clickTestId(testId: string, options: SmoothMouseOptions = {}): Promise<void> {
    const box = await this.page.getByTestId(testId).boundingBox();
    if (!box) throw new Error(`clickTestId: no visible element for test-id "${testId}"`);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await this.moveTo(cx, cy, testId, options);
    await this.page.waitForTimeout(120);
    await this.page.mouse.down();
    await this.page.waitForTimeout(70);
    await this.page.mouse.up();
    this.logger.log('click', cx, cy, testId);
  }
}
