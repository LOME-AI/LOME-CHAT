// Sanctioned in-process seed surface consumed by `scripts/seed.ts`.
//
// The unified seed script composes the new backend's REAL data factories in
// process (pure dependency-injected functions — no Hono/Worker bindings). This
// barrel is the single package subpath (`@hushbox/api/dev-seed`) through which
// `@hushbox/scripts` reaches those factories, so seeding never deep-reaches into
// `apps/api` internals. It re-exports only the DI-shaped seed functions and
// their param/result types from `factories.ts`, `wallet.ts`, `seed-user.ts`,
// and `seed-billing-history.ts` (persona minting + rich billing-history
// producers); the Hono `routes.ts` dev surface is deliberately excluded.
//
// It also exposes the collaborators `scripts/seed.ts` needs to assemble
// `MintSeedUserDeps` / `SeedBillingDeps` without deep-reaching into slice
// internals or depending on `neverthrow`: the identity/billing store factories,
// and `createNoopSeedEmailPorts()` — a best-effort no-op email-port pair the
// script would otherwise have to build from `neverthrow` types it doesn't have.

import { okAsync } from '../../lib/result/index.js';
import type { WelcomeEmailPort } from '../../slices/billing/index.js';
import type { VerificationEmailPort } from '../../slices/identity/index.js';

export { createIdentityStores } from '../../slices/identity/index.js';
export { createBillingStores } from '../../slices/billing/index.js';
export type { IdentityStores } from '../../slices/identity/index.js';
export type { BillingStores, WelcomeEmailPort } from '../../slices/billing/index.js';
export type { VerificationEmailPort } from '../../slices/identity/index.js';

// The real, live catalog refresh, exposed to `scripts/refresh-catalog.ts` so
// dev startup and `e2e:prepare` populate `model_catalog` from OpenRouter's
// public metadata endpoints with the exact same job the hourly cron runs — no
// hand-authored descriptors. `OPENROUTER_BASE_URL` single-sources the gateway
// base URL; `createConsoleTelemetry` gives the script the Telemetry the refresh
// needs to alert on excluded models.
export { refreshCatalog, OPENROUTER_BASE_URL, EXCLUDE_REASONS } from '../../slices/models/index.js';
export type {
  ExcludeReason,
  RefreshCatalogDeps,
  RefreshSummary,
} from '../../slices/models/index.js';
export { createConsoleTelemetry } from '../../lib/telemetry/index.js';
export type { Telemetry } from '../../lib/telemetry/index.js';

/**
 * The best-effort email ports `mintSeedUser`/`completeRegistration` expect,
 * exposed so `scripts/seed.ts` builds them without touching `neverthrow`.
 */
export interface SeedEmailPorts {
  readonly welcomeEmail: WelcomeEmailPort;
  readonly verificationEmail: VerificationEmailPort;
}

/**
 * No-op email ports for seeding — registration fires them outside the tx and
 * dev seeding never sends real mail. Mirrors the port construction in
 * `seed-user.integration.test.ts` (methods returning a success `ResultAsync`).
 */
export function createNoopSeedEmailPorts(): SeedEmailPorts {
  return {
    welcomeEmail: { sendWelcomeEmail: () => okAsync() },
    verificationEmail: { sendVerificationEmail: () => okAsync() },
  };
}

export {
  createDevConversation,
  createDevMultiModelConversation,
  createDevGroupChat,
  createDevMediaConversation,
  pickSeedTextModels,
} from './factories.js';
export type {
  CreateDevConversationParams,
  CreateDevConversationResult,
  CreateDevMultiModelConversationParams,
  CreateDevGroupChatParams,
  CreateDevGroupChatResult,
  CreateDevMediaConversationParams,
  CreateDevMediaConversationResult,
} from './factories.js';

export { setWalletBalance } from './wallet.js';
export type { SetWalletBalanceParams, SetWalletBalanceResult } from './wallet.js';

export { seedAdminOpTargets } from './seed-admin-targets.js';
export type { SeedAdminTargetsParams, SeedAdminTargetsSummary } from './seed-admin-targets.js';

export { mintSeedUser } from './seed-user.js';
export type {
  SeedPersonaCrypto,
  SeedCryptoProvider,
  SeedUserPersona,
  MintSeedUserDeps,
  MintSeedUserResult,
} from './seed-user.js';

export { seedPaymentsHistory, seedUsageHistory, usdToNanoUsd } from './seed-billing-history.js';
export type {
  SeedBillingDeps,
  PaymentSpec,
  SeedPaymentsHistoryParams,
  SeedPaymentsHistoryResult,
  UsageTokens,
  UsageSpec,
  SeedUsageHistoryParams,
  SeedUsageHistoryResult,
} from './seed-billing-history.js';
