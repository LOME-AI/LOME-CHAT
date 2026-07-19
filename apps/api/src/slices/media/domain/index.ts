export { authorizePresign } from './presign-authz.js';
export type { PresignAuthzDeps, PresignPrincipal } from './presign-authz.js';
export { LINK_CREDENTIAL_HEADER, resolveMediaCaller } from './caller.js';
export type { ResolveMediaCallerArgs } from './caller.js';
export {
  contentItemParameterSchema,
  mintDownloadUrl,
  sharedPresignParameterSchema,
} from './presign.js';
export type { DownloadUrlGrant, MintDownloadUrlDeps } from './presign.js';
export { MEDIA_RATE_LIMITS, evaluateRemint, reserveShareRemint } from './rate-limit.js';
export type { RedisClient, RemintDecision } from './rate-limit.js';
export { MEDIA_GC_GRACE_MARGIN_SECONDS, MEDIA_GC_MIN_AGE_SECONDS, runMediaGc } from './gc.js';
export type { MediaGcDeps, MediaGcReport } from './gc.js';
export {
  MEDIA_RECLAIM_HEARTBEAT_CHUNK,
  MEDIA_RECLAIM_USER_JOB_TYPE,
  createMediaReclaimUserJob,
  mediaReclaimUserPayloadSchema,
} from './reclaim-user.js';
export type { MediaReclaimUserJobDeps } from './reclaim-user.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib and port surfaces the route seam needs are published here rather than
// imported from lib or ports directly in routes.ts.
export { createErrorResponse, domainWireCode } from '../../../lib/errors/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
export type { PresignReaders, Storage } from '../ports/index.js';
export type { LinkResolutionPort } from '../../identity/index.js';
