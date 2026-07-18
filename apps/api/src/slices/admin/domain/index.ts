export { createAdminOpEngine, resolveClaimForExecute } from './engine.js';
export { createAdminOpRegistry, defineAdminOp } from './registry.js';
export {
  adminJobOperations,
  adminModelOperations,
  adminOperations,
  adminShareOperations,
  adminUserOperations,
  adminWalletOperations,
} from './operations/index.js';
export type {
  AdminJobDeps,
  AdminModelDeps,
  AdminOperationsDeps,
  AdminOpsClock,
  AdminShareDeps,
  AdminUserDeps,
  AdminWalletDeps,
  WalletSnapshotRedis,
} from './operations/index.js';
export type {
  AdminOpEngine,
  AdminOpEngineDeps,
  AdminOpEngineHooks,
  AdminOpExecutedNotice,
  AdminOpRunResult,
  RunAdminOpParams,
} from './engine.js';
export type {
  AdminEphemeralEffect,
  AdminOpContext,
  AdminOpEffect,
  AdminOpImplementation,
  AdminOpOutcome,
  AdminOpPrefill,
  AdminOpRegistry,
  AdminOpTarget,
} from './registry.js';
// Deliberately NOT exported: describe-admin-op (the test battery harness —
// imports vitest, test-file consumers only) and fixture-ops (test-only ops).

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor, the
// exemption marker, and the Idempotency-Key header name the execute route
// forwards to the engine — is published here rather than imported from lib
// directly in routes.ts (the account slice's established pattern).
export { createErrorResponse } from '../../../lib/errors/index.js';
export { IDEMPOTENCY_KEY_HEADER, idempotencyExempt } from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
export type { Telemetry } from '../../../lib/telemetry/index.js';

// The bespoke read surface (Customer-360, dashboard, jobs queue, audit
// search, SQL panel) — reads skip the op engine but stay audited and
// volume-capped.
export { loadCustomer360 } from './customer-360.js';
export type {
  AdminAuditWire,
  AdminBillingReader,
  AdminIdentityReader,
  AdminJobWire,
  AdminUserSummary,
  Customer360Deps,
  Customer360Query,
  Customer360View,
  DevicesPanel,
  MoneyPanel,
  Panel,
  UsagePanel,
} from './customer-360.js';
export { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
export { createAdminReadSurface } from './read-surface.js';
export type {
  AdminReadSurface,
  AdminReadSurfaceDeps,
  AuditSearchWire,
  DashboardWire,
  JobQueueWire,
} from './read-surface.js';
