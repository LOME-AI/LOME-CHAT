import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { err, fromPromise, ok } from '../../../lib/result/index.js';
import { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type {
  AdminAuditReads,
  AdminAuditThreadedRow,
  AdminConversationCounts,
  AdminCrossSliceReads,
  AdminJobRow,
  AdminStores,
} from '../ports/index.js';

/** The safe identity projection for the 360 header (never key material,
 * never the OPAQUE registration record). */
export interface AdminUserSummary {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly emailVerified: boolean;
  readonly totpEnabled: boolean;
  readonly lockedAt: Date | null;
  readonly hasAcknowledgedPhrase: boolean;
}

/** Bound to identity's published stores at composition (structural subset). */
export interface AdminIdentityReader {
  findByEmail(email: string): ResultAsync<AdminUserSummary | null, DomainError>;
  findById(id: string): ResultAsync<AdminUserSummary | null, DomainError>;
}

/** Structural shapes of billing's published reads (bound at composition). */
export interface AdminBalanceView {
  readonly purchasedNanoUsd: bigint;
  readonly freeNanoUsd: bigint;
  readonly allowance: {
    readonly day: string;
    readonly limitNanoUsd: bigint;
    readonly spentNanoUsd: bigint;
    readonly remainingNanoUsd: bigint;
  };
}

export interface AdminLedgerRow {
  readonly createdAt: Date;
  readonly kind: string;
  readonly amountNanoUsd: bigint;
  readonly balanceAfterNanoUsd: bigint;
}

export interface AdminUsageBreakdown {
  readonly models: readonly {
    readonly modelId: string;
    readonly totalNanoUsd: bigint;
    readonly recordCount: number;
    readonly estimatedCount: number;
  }[];
  readonly nextCursor: string | null;
}

export interface AdminBillingReader {
  balance(userId: string, now: Date): ResultAsync<AdminBalanceView, DomainError>;
  ledgerHistory(
    userId: string,
    window: { readonly start: Date; readonly end: Date; readonly limit: number }
  ): ResultAsync<readonly AdminLedgerRow[], DomainError>;
  usage(userId: string): ResultAsync<AdminUsageBreakdown, DomainError>;
}

export interface Customer360Deps {
  readonly db: Database;
  readonly stores: AdminStores;
  readonly auditReads: AdminAuditReads;
  readonly crossSlice: AdminCrossSliceReads;
  readonly identity: AdminIdentityReader;
  readonly billing: AdminBillingReader;
  readonly clock: { now(): Date };
}

/** Exactly one of the two lookups (the route schema enforces it too). */
export type Customer360Query =
  | { readonly email: string; readonly userId?: undefined }
  | { readonly userId: string; readonly email?: undefined };

/** A panel either loaded or failed on its own — one broken query never
 * blanks the page (per-panel isolation is server-shaped for the SPA). */
export type Panel<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface MoneyPanel {
  readonly balance: {
    readonly purchasedNanoUsd: string;
    readonly freeNanoUsd: string;
    readonly allowance: {
      readonly day: string;
      readonly limitNanoUsd: string;
      readonly spentNanoUsd: string;
      readonly remainingNanoUsd: string;
    };
  };
  readonly recentLedger: readonly {
    readonly createdAt: string;
    readonly kind: string;
    readonly amountNanoUsd: string;
    readonly balanceAfterNanoUsd: string;
  }[];
}

export interface UsagePanel {
  readonly models: readonly {
    readonly modelId: string;
    readonly totalNanoUsd: string;
    readonly recordCount: number;
    readonly estimatedCount: number;
  }[];
}

export interface AdminJobWire {
  readonly id: string;
  readonly type: string;
  readonly shard: string;
  readonly status: string;
  readonly discarded: boolean;
  readonly failures: number;
  readonly claims: number;
  readonly payload: unknown;
  readonly errors: readonly { at: string; claim: number; error: string }[];
  readonly nextAttemptAt: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface AdminAuditWire {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly details: unknown;
  readonly undoes: string | null;
  readonly undoneBy: string | null;
  readonly createdAt: string;
}

export interface Customer360View {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly username: string;
    readonly emailVerified: boolean;
    readonly totpEnabled: boolean;
    readonly lockedAt: string | null;
    readonly hasAcknowledgedPhrase: boolean;
  };
  readonly panels: {
    readonly money: Panel<MoneyPanel>;
    readonly usage: Panel<UsagePanel>;
    readonly conversations: Panel<AdminConversationCounts>;
    readonly jobs: Panel<{ readonly jobs: readonly AdminJobWire[] }>;
    readonly adminHistory: Panel<{ readonly actions: readonly AdminAuditWire[] }>;
  };
}

export function jobToWire(row: AdminJobRow): AdminJobWire {
  return {
    ...row,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}

export function auditToWire(row: AdminAuditThreadedRow): AdminAuditWire {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** Recent-ledger window: enough for a remediation conversation, hard-bounded. */
const LEDGER_WINDOW_DAYS = 90;
const LEDGER_LIMIT = 25;
const JOBS_PANEL_LIMIT = 20;
const ADMIN_HISTORY_LIMIT = 25;

/** One failing panel never blanks the view — it degrades to its error code. */
async function panelOf<T>(load: () => PromiseLike<Result<T, DomainError>>): Promise<Panel<T>> {
  const result = await load();
  return result.match(
    (data): Panel<T> => ({ ok: true, data }),
    (error): Panel<T> => ({ ok: false, error: error.code })
  );
}

function moneyPanel(
  deps: Customer360Deps,
  userId: string,
  now: Date
): ResultAsync<MoneyPanel, DomainError> {
  const start = new Date(now.getTime() - LEDGER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return deps.billing.balance(userId, now).andThen((balance) =>
    deps.billing
      .ledgerHistory(userId, { start, end: now, limit: LEDGER_LIMIT })
      .map((ledger): MoneyPanel => {
        return {
          balance: {
            purchasedNanoUsd: balance.purchasedNanoUsd.toString(10),
            freeNanoUsd: balance.freeNanoUsd.toString(10),
            allowance: {
              day: balance.allowance.day,
              limitNanoUsd: balance.allowance.limitNanoUsd.toString(10),
              spentNanoUsd: balance.allowance.spentNanoUsd.toString(10),
              remainingNanoUsd: balance.allowance.remainingNanoUsd.toString(10),
            },
          },
          recentLedger: ledger.map((row) => ({
            createdAt: row.createdAt.toISOString(),
            kind: row.kind,
            amountNanoUsd: row.amountNanoUsd.toString(10),
            balanceAfterNanoUsd: row.balanceAfterNanoUsd.toString(10),
          })),
        };
      })
  );
}

function usagePanel(deps: Customer360Deps, userId: string): ResultAsync<UsagePanel, DomainError> {
  return deps.billing.usage(userId).map(
    (breakdown): UsagePanel => ({
      models: breakdown.models.map((row) => ({
        modelId: row.modelId,
        totalNanoUsd: row.totalNanoUsd.toString(10),
        recordCount: row.recordCount,
        estimatedCount: row.estimatedCount,
      })),
    })
  );
}

/**
 * Assembles the Customer-360 view: safe identity header + independent
 * panels, one coarse read-audit row per view (Charter #3 — sensitive reads
 * are audited), written only when a user was actually found (a miss reveals
 * nothing and targets no one).
 */
export async function loadCustomer360(
  deps: Customer360Deps,
  params: { readonly actor: string; readonly query: Customer360Query }
): Promise<Result<Customer360View, DomainError>> {
  const { query } = params;
  const lookup =
    query.email === undefined
      ? deps.identity.findById(query.userId)
      : deps.identity.findByEmail(query.email);
  const found = await lookup;
  if (found.isErr()) return err(found.error);
  const user = found.value;
  if (user === null) return err(notFoundError('no user matches the 360 query'));

  await writeReadAudit(deps.stores, deps.db, {
    actor: params.actor,
    action: READ_AUDIT_ACTIONS.customer360,
    targetType: 'user',
    targetId: user.id,
    details: { query },
  });

  const now = deps.clock.now();
  const [money, usage, conversations, jobs, adminHistory] = await Promise.all([
    panelOf(() => moneyPanel(deps, user.id, now)),
    panelOf(() => usagePanel(deps, user.id)),
    panelOf(() =>
      fromPromise(deps.crossSlice.conversationCounts(user.id), (cause) =>
        unavailableError('conversation counts read failed', cause)
      )
    ),
    panelOf(() =>
      fromPromise(deps.crossSlice.jobsTouchingUser(user.id, JOBS_PANEL_LIMIT), (cause) =>
        unavailableError('jobs panel read failed', cause)
      ).map((rows) => ({ jobs: rows.map((row) => jobToWire(row)) }))
    ),
    panelOf(() =>
      fromPromise(
        deps.auditReads.search(deps.db, {
          targetType: 'user',
          targetId: user.id,
          limit: ADMIN_HISTORY_LIMIT,
        }),
        (cause) => unavailableError('admin history read failed', cause)
      ).map((page) => ({ actions: page.rows.map((row) => auditToWire(row)) }))
    ),
  ]);

  return ok({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      emailVerified: user.emailVerified,
      totpEnabled: user.totpEnabled,
      lockedAt: user.lockedAt === null ? null : user.lockedAt.toISOString(),
      hasAcknowledgedPhrase: user.hasAcknowledgedPhrase,
    },
    panels: { money, usage, conversations, jobs, adminHistory },
  });
}
