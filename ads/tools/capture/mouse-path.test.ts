import { describe, expect, it } from 'vitest';

import { easeInOutCubic, planTravel } from './mouse-path.js';

describe('easeInOutCubic', () => {
  it('pins the endpoints and midpoint', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('eases below the midpoint on the cubic-in branch', () => {
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625, 4);
  });

  it('eases above the midpoint on the cubic-out branch', () => {
    expect(easeInOutCubic(0.75)).toBeCloseTo(0.9375, 4);
  });
});

describe('planTravel', () => {
  it('scales duration and step count with distance by default', () => {
    const plan = planTravel({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(plan.durationMs).toBe(510);
    expect(plan.steps).toBe(64);
    expect(plan.points).toHaveLength(64);
  });

  it('lands its final waypoint exactly on the target', () => {
    const plan = planTravel({ x: 0, y: 0 }, { x: 100, y: 200 });
    expect(plan.points.at(-1)).toEqual({ x: 100, y: 200 });
  });

  it('honours explicit duration and step overrides', () => {
    const plan = planTravel({ x: 0, y: 0 }, { x: 100, y: 0 }, { durationMs: 800, steps: 10 });
    expect(plan.steps).toBe(10);
    expect(plan.points).toHaveLength(10);
    expect(plan.stepDelayMs).toBe(80);
  });

  it('floors the step count at twelve for short travel', () => {
    const plan = planTravel({ x: 0, y: 0 }, { x: 10, y: 0 }, { durationMs: 50 });
    expect(plan.steps).toBe(12);
  });
});
