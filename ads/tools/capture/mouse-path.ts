export interface SmoothMouseOptions {
  /** Travel duration in ms; scales with distance when omitted. */
  durationMs?: number;
  /** Interpolation steps; ~1 per 8ms of travel by default. */
  steps?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface TravelPlan {
  durationMs: number;
  steps: number;
  /** Eased waypoints (step 1..steps); the final point is exactly the target. */
  points: Point[];
  /** Delay between waypoints so the whole path takes durationMs. */
  stepDelayMs: number;
}

/** Ease-in-out cubic — the "human hand" curve for cursor travel. */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/**
 * Plans a smooth cursor path from one point to another: duration and step count
 * scale with distance (unless overridden), and each waypoint is eased. Pure so
 * the geometry is tested without a browser; SmoothMouse just walks the points.
 */
export function planTravel(from: Point, to: Point, options: SmoothMouseOptions = {}): TravelPlan {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const durationMs = options.durationMs ?? Math.min(1400, 350 + distance * 1.6);
  const steps = options.steps ?? Math.max(12, Math.round(durationMs / 8));

  const points: Point[] = [];
  for (let index = 1; index <= steps; index++) {
    const p = easeInOutCubic(index / steps);
    points.push({ x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p });
  }
  return { durationMs, steps, points, stepDelayMs: durationMs / steps };
}
