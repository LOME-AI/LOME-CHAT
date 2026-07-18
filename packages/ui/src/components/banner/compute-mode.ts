/**
 * Pure layout/motion math for the announcement banner. Kept framework-agnostic
 * and side-effect free so it is unit-testable and shared verbatim by the React
 * and Astro shells via `create-banner`.
 */

/** Multi-message ticker speed. */
export const MARQUEE_SPEED_FAST_PX_PER_S = 54;
/** Single over-wide message: slower so it stays readable. */
export const MARQUEE_SPEED_READABLE_PX_PER_S = 33;
/**
 * Duration used only when a measurement is zero/NaN (a not-yet-laid-out track).
 * Never applied to a real measurement: the loop travels a computed px distance,
 * so clamping the duration would break the entry/loop equal-speed invariant.
 */
export const FALLBACK_MARQUEE_DURATION_S = 4;

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
 * Seconds for the one-shot off-screen entry (track starts one viewport width to
 * the right) to reach the loop origin at the same speed as the loop itself, so
 * the hand-off between the entry and loop animations has no visible speed step.
 * Zero (skip the entry) when the viewport is unmeasured.
 */
export function computeEnterDurationSeconds(viewportWidthPx: number, speedPxPerS: number): number {
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) return 0;
  if (!Number.isFinite(speedPxPerS) || speedPxPerS <= 0) return 0;
  return viewportWidthPx / speedPxPerS;
}

/**
 * Seconds for one marquee loop to travel `distancePx` at `speedPxPerS` — exactly
 * distance / speed so the loop speed equals the entry speed for every track
 * length. Falls back only on a zero/NaN measurement (a not-yet-laid-out track)
 * so the CSS animation duration is always a sane positive number.
 */
export function computeMarqueeDurationSeconds(distancePx: number, speedPxPerS: number): number {
  if (!Number.isFinite(distancePx) || distancePx <= 0) return FALLBACK_MARQUEE_DURATION_S;
  if (!Number.isFinite(speedPxPerS) || speedPxPerS <= 0) return FALLBACK_MARQUEE_DURATION_S;
  return distancePx / speedPxPerS;
}

/**
 * Total copies of the periodic content the track needs so the viewport is
 * always covered through a full loop: viewport + one content period, i.e.
 * max(2, ceil((viewport + content) / content)). Two copies suffice only when
 * one copy is at least viewport-wide; narrower content needs more or the
 * window scrolls past the tail near the end of each cycle (visible dead air).
 * Falls back to the minimum two on zero/NaN measurements (jsdom, unlaid-out).
 */
export function computeMarqueeCopyCount(viewportWidthPx: number, contentWidthPx: number): number {
  if (!Number.isFinite(contentWidthPx) || contentWidthPx <= 0) return 2;
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) return 2;
  return Math.max(2, Math.ceil((viewportWidthPx + contentWidthPx) / contentWidthPx));
}
