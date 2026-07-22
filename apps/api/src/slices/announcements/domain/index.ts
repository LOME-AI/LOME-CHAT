export { callerUserId } from './principal.js';
export { getActiveBanner } from './banner.js';
export {
  bannerHashQuerySchema,
  putBannerDismissalBodySchema,
  getBannerDismissal,
  saveBannerDismissal,
} from './dismissal.js';
export type { BannerReadResult } from './banner.js';
export type { BannerDismissalState } from './dismissal.js';
export type { AnnouncementsStoresFactory } from '../ports/index.js';

// Routes import only this barrel and the middleware (boundaries): publish the
// uniform error-body constructor and the idempotency wrappers here.
export { createErrorResponse, domainWireCode } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
