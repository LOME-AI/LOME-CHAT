import { planTravel, type SmoothMouseOptions } from './mouse-path.js';
import type { Page } from '@playwright/test';
import type { ActionLogger } from './action-logger.js';

/**
 * Cursor state lives here because Playwright does not expose the current
 * mouse position; every capture script must route ALL mouse movement through
 * one SmoothMouse instance or travel start points will be wrong. The path
 * geometry lives in planTravel (tested); this drives Playwright along it.
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
    const plan = planTravel({ x: this.x, y: this.y }, { x, y }, options);
    for (const point of plan.points) {
      await this.page.mouse.move(point.x, point.y);
      this.logger.log('move', point.x, point.y, label);
      await this.page.waitForTimeout(plan.stepDelayMs);
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
