/**
 * Pure layout/motion math for the announcement banner. Kept framework-agnostic
 * and side-effect free so it is unit-testable and shared verbatim by the React
 * and Astro shells via `create-banner`.
 */

/** Multi-message ticker speed. */
export const MARQUEE_SPEED_FAST_PX_PER_S = 90;
/** Single over-wide message: slower so it stays readable. */
export const MARQUEE_SPEED_READABLE_PX_PER_S = 55;
/** Floor so a near-empty or unmeasured track never animates absurdly fast. */
export const MIN_MARQUEE_DURATION_S = 4;

export type BannerMode = 'none' | 'static' | 'scroll';

/**
 * `none` when there is nothing to show; `scroll` whenever motion conveys "there
 * is more than fits" (always for multiple messages, and for a single message
 * wider than its viewport); otherwise `static`.
 */
export function computeBannerMode(
  messageCount: number,
  trackWidth: number,
  viewportWidth: number
): BannerMode {
  if (messageCount <= 0) return 'none';
  if (messageCount > 1) return 'scroll';
  return trackWidth > viewportWidth ? 'scroll' : 'static';
}

export function marqueeSpeedFor(messageCount: number): number {
  return messageCount > 1 ? MARQUEE_SPEED_FAST_PX_PER_S : MARQUEE_SPEED_READABLE_PX_PER_S;
}

/**
 * Seconds for one marquee loop to travel `distancePx` at `speedPxPerS`. Guards
 * against a zero/NaN measurement (a not-yet-laid-out track) so the CSS animation
 * duration is always a sane positive number.
 */
export function computeMarqueeDurationSeconds(distancePx: number, speedPxPerS: number): number {
  if (!Number.isFinite(distancePx) || distancePx <= 0) return MIN_MARQUEE_DURATION_S;
  if (!Number.isFinite(speedPxPerS) || speedPxPerS <= 0) return MIN_MARQUEE_DURATION_S;
  return Math.max(MIN_MARQUEE_DURATION_S, distancePx / speedPxPerS);
}
