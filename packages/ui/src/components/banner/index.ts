export { createBanner } from './create-banner.js';
export type { CreateBannerOptions, BannerTeardown } from './create-banner.js';
export {
  computeBannerMode,
  marqueeSpeedFor,
  computeMarqueeDurationSeconds,
  type BannerMode,
} from './compute-mode.js';
export {
  readDismissedBannerHash,
  isBannerDismissed,
  markBannerDismissed,
} from './dismissal-store.js';
