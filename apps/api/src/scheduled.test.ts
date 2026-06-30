import { describe, it, expect } from 'vitest';
import { scheduledHandler } from './scheduled.js';

describe('scheduledHandler', () => {
  it('resolves as a no-op', async () => {
    await expect(scheduledHandler()).resolves.toBeUndefined();
  });
});
