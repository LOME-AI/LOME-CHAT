import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { FINGERPRINT_CODES, createRequestTelemetry } from './lib/telemetry/index.js';
import { OPENROUTER_BASE_URL } from './slices/models/index.js';
import {
  createBillingAuditProbes,
  createLedgerConservationEntry,
  createSnapshotDriftEntry,
} from './jobs/billing-auditor-entries.js';
import { runCronEntries } from './jobs/cron.js';
import {
  createDispatcherWake,
  createJobsHealthEntry,
  createJobsHealthProbes,
} from './jobs/jobs-health-entry.js';
import { createMediaGcEntry, productionMediaGcDeps } from './jobs/media-gc-entry.js';
import { createCatalogRefreshEntry, productionRefreshJitter } from './jobs/poller-entries.js';
import { createRetentionEntry, createRetentionSteps } from './jobs/retention-entries.js';
import {
  createCatalogModelMetaResolver,
  createPublicStatsSnapshotEntry,
} from './jobs/public-stats-snapshot-entry.js';
import { createPublicStatsStores } from './slices/billing/index.js';
import {
  createAccessLogAuditEntry,
  createAccessLogReaderFromEnv,
} from './jobs/access-log-audit-entry.js';
import { createAdminDigestEntry } from './jobs/admin-digest-entry.js';
import { parseAdminNotificationRecipients } from './adapters/admin-op-notification-email.js';
import { createEmailSenderFromEnv } from './slices/notifications/index.js';
import type { Database } from '@hushbox/db';
import type { RefreshJitter } from './slices/models/index.js';
import type { Bindings } from './lib/context/index.js';
import type { JobDispatcherNamespace } from './lib/jobs/index.js';
import type { Telemetry } from './lib/telemetry/index.js';
import type { CronEntry } from './jobs/cron.js';

/**
 * The production cron surface: pollers, retention deletes, and read-only
 * auditors only — delivery work never runs here (the jobs system owns it).
 * Each schedule constant mirrors one wrangler `[triggers]` cron expression
 * (asserted by test); same-cadence entries share one trigger and run
 * isolated, so one failing entry never stops its siblings.
 *
 * Deferred until their external API clients exist: the aggregate-metrics
 * auditor (no metrics sink today — metrics are structured Workers Logs +
 * Sentry) and the monthly OpenRouter usage reconciliation (account usage vs
 * Σ usage_records per modality).
 */

export const JOBS_HEALTH_CRON = '*/15 * * * *';
// ~6-hourly is load-bearing: free-tier Access retains its logs 24 h, so a
// once-daily pull that fails once loses that window permanently.
export const ACCESS_LOG_CRON = '0 */6 * * *';
export const HOURLY_MAINTENANCE_CRON = '0 * * * *';
export const DAILY_RETENTION_CRON = '0 3 * * *';

/** The Worker bindings plus the dispatcher DO namespace the wake nudge uses. */
export interface ScheduledBindings extends Bindings {
  readonly JOB_DISPATCHER?: JobDispatcherNamespace;
}

/** The structural slice of `ExecutionContext` the cron path needs. */
export interface CronContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface CronDependencies {
  readonly env: ScheduledBindings;
  readonly db: Database;
  readonly redis: Redis;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
  readonly isCI: boolean;
  /** Catalog-poller seams: tests replay the gateway; production binds live fetch. */
  readonly catalogFetch: typeof globalThis.fetch;
  readonly gatewayBaseUrl: string;
  readonly refreshJitter: RefreshJitter;
}

export function cronEntriesFor(cron: string, deps: CronDependencies): CronEntry[] | undefined {
  if (cron === JOBS_HEALTH_CRON) {
    return [
      createJobsHealthEntry({
        probes: createJobsHealthProbes(deps.db),
        telemetry: deps.telemetry,
        wake: createDispatcherWake(deps.env),
      }),
    ];
  }
  if (cron === HOURLY_MAINTENANCE_CRON) {
    const billingProbes = createBillingAuditProbes(deps.db, deps.redis);
    return [
      createCatalogRefreshEntry({
        db: deps.db,
        fetch: deps.catalogFetch,
        gatewayBaseUrl: deps.gatewayBaseUrl,
        telemetry: deps.telemetry,
        now: deps.now,
        jitter: deps.refreshJitter,
        // Production keeps the 6-connection cap; dev refreshes fan out wider.
        endpointConcurrency: createEnvUtilities(deps.env).isProduction ? 6 : 30,
      }),
      createMediaGcEntry(() =>
        // Thread the flush-capable cron telemetry (createTelemetry binds
        // scheduleFlush to ctx.waitUntil) so a captured GC delete failure is
        // actually flushed to Sentry before the cron isolate freezes; the env
        // fallback in productionMediaGcDeps has no scheduleFlush and would drop it.
        productionMediaGcDeps({
          env: deps.env,
          db: deps.db,
          now: deps.now,
          isCI: deps.isCI,
          telemetry: deps.telemetry,
        })
      ),
      createLedgerConservationEntry({ audit: billingProbes.audit, telemetry: deps.telemetry }),
      createSnapshotDriftEntry({
        listWalletIds: billingProbes.listWalletIds,
        compare: billingProbes.compare,
        telemetry: deps.telemetry,
      }),
    ];
  }
  if (cron === DAILY_RETENTION_CRON) {
    const steps = createRetentionSteps(deps.db);
    return [
      createRetentionEntry('idempotency-key-purge', steps.purgeIdempotencyKeys),
      createRetentionEntry('jobs-succeeded-prune', steps.pruneSucceededJobs),
      createRetentionEntry('jobs-discarded-prune', steps.pruneDiscardedJobs),
      createRetentionEntry('account-deletion-events-purge', steps.purgeDeletionEvents),
      createAdminDigestEntry({
        db: deps.db,
        telemetry: deps.telemetry,
        now: deps.now,
        resolveSend: () => ({
          sender: createEmailSenderFromEnv(deps.env, deps.db),
          adminEmails: parseAdminNotificationRecipients(deps.env.ADMIN_ACTOR_ALLOWLIST),
        }),
      }),
      createPublicStatsSnapshotEntry({
        db: deps.db,
        stores: createPublicStatsStores(),
        now: deps.now,
        resolveModelMeta: createCatalogModelMetaResolver({
          db: deps.db,
          telemetry: deps.telemetry,
        }),
      }),
    ];
  }
  if (cron === ACCESS_LOG_CRON) {
    return [
      createAccessLogAuditEntry({
        resolveReader: () => createAccessLogReaderFromEnv(deps.env),
        allowlist: () => new Set(parseAdminNotificationRecipients(deps.env.ADMIN_ACTOR_ALLOWLIST)),
        telemetry: deps.telemetry,
        now: deps.now,
      }),
    ];
  }
  return undefined;
}

/** The infra seams the handler needs; tests fake them, production binds live clients. */
export interface ScheduledRuntime {
  createDb(env: ScheduledBindings): Database;
  createRedis(env: ScheduledBindings): Redis;
  createTelemetry(env: ScheduledBindings, ctx: CronContext): Telemetry;
  entriesFor(cron: string, deps: CronDependencies): CronEntry[] | undefined;
}

export function createScheduledHandler(
  runtime: ScheduledRuntime
): (controller: { cron: string }, env: ScheduledBindings, ctx: CronContext) => Promise<void> {
  return async (controller, env, ctx): Promise<void> => {
    const telemetry = runtime.createTelemetry(env, ctx);
    const { isCI } = createEnvUtilities(env);
    const db = runtime.createDb(env);
    try {
      const entries = runtime.entriesFor(controller.cron, {
        env,
        db,
        redis: runtime.createRedis(env),
        telemetry,
        now: () => new Date(),
        isCI,
        catalogFetch: globalThis.fetch.bind(globalThis),
        gatewayBaseUrl: OPENROUTER_BASE_URL,
        refreshJitter: productionRefreshJitter(),
      });
      if (entries === undefined) {
        telemetry.error('scheduled trigger fired with an unregistered cron expression', {
          errorCode: 'cron_unknown_schedule',
        });
        telemetry.captureError(
          new Error('scheduled trigger fired with an unregistered cron expression'),
          FINGERPRINT_CODES.cronUnknownSchedule
        );
        return;
      }
      await runCronEntries(entries, telemetry);
    } finally {
      // The cron path opens its own connection (no request context), so it
      // also closes it — an idle Worker holds no sockets between triggers.
      await db.$client.end();
    }
  };
}

export const productionScheduledRuntime: ScheduledRuntime = {
  createDb(env: ScheduledBindings): Database {
    const databaseUrl = env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error(
        'scheduled handler: missing required binding DATABASE_URL — the cron fails fast instead of degrading.'
      );
    }
    const { isDev } = createEnvUtilities(env);
    return isDev
      ? createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG })
      : createDb(databaseUrl);
  },
  createRedis(env: ScheduledBindings): Redis {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (url === undefined || url === '' || token === undefined || token === '') {
      throw new Error(
        'scheduled handler: missing required bindings UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — the cron fails fast instead of degrading.'
      );
    }
    return new Redis({ url, token });
  },
  createTelemetry(env: ScheduledBindings, ctx: CronContext): Telemetry {
    return createRequestTelemetry(env, { scheduleFlush: ctx.waitUntil.bind(ctx) });
  },
  entriesFor: cronEntriesFor,
};

export const scheduledHandler = createScheduledHandler(productionScheduledRuntime);
