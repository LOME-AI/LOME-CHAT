import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { err, fromPromise } from '../../../lib/result/index.js';
import { auditToWire, jobToWire, loadCustomer360 } from './customer-360.js';
import { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type {
  AdminAuditSearchFilter,
  AdminJobCounts,
  AdminJobQueueFilter,
  SqlPanel,
  SqlPanelResult,
} from '../ports/index.js';
import type {
  AdminAuditWire,
  AdminJobWire,
  Customer360Deps,
  Customer360Query,
  Customer360View,
} from './customer-360.js';

export interface AdminReadSurfaceDeps extends Customer360Deps {
  readonly sqlPanel: SqlPanel;
}

export interface AuditSearchWire {
  readonly rows: readonly AdminAuditWire[];
  readonly nextCursor: string | null;
}

export interface JobQueueWire {
  readonly rows: readonly AdminJobWire[];
  readonly nextCursor: string | null;
}

export interface DashboardWire {
  readonly jobs: AdminJobCounts;
  readonly recentActions: readonly AdminAuditWire[];
}

/**
 * The admin plane's bespoke read surface (reads skip the op-engine tx
 * machinery but stay audited and volume-capped per the Charter). One
 * factory, one wire mapping — routes hold no business logic.
 */
export interface AdminReadSurface {
  customer360(params: {
    readonly actor: string;
    readonly query: Customer360Query;
  }): Promise<Result<Customer360View, DomainError>>;
  auditSearch(filter: AdminAuditSearchFilter): Promise<Result<AuditSearchWire, DomainError>>;
  dashboard(): Promise<Result<DashboardWire, DomainError>>;
  jobQueue(filter: AdminJobQueueFilter): Promise<Result<JobQueueWire, DomainError>>;
  sqlPanel(params: {
    readonly actor: string;
    readonly query: string;
  }): Promise<Result<SqlPanelResult, DomainError>>;
}

export function createAdminReadSurface(deps: AdminReadSurfaceDeps): AdminReadSurface {
  return {
    customer360: (params) => loadCustomer360(deps, params),

    async auditSearch(filter) {
      const result = await fromPromise(deps.auditReads.search(deps.db, filter), (cause) =>
        unavailableError('audit search failed', cause)
      );
      return result.map((page) => ({
        rows: page.rows.map((row) => auditToWire(row)),
        nextCursor: page.nextCursor,
      }));
    },

    async dashboard() {
      const result = await fromPromise(
        Promise.all([
          deps.crossSlice.jobCounts(),
          deps.auditReads.recent(deps.db, DASHBOARD_RECENT_ACTIONS),
        ]),
        (cause) => unavailableError('dashboard read failed', cause)
      );
      return result.map(([jobs, recent]) => ({
        jobs,
        recentActions: recent.map((row) => auditToWire(row)),
      }));
    },

    async jobQueue(filter) {
      const result = await fromPromise(deps.crossSlice.listJobs(filter), (cause) =>
        unavailableError('job queue read failed', cause)
      );
      return result.map((page) => ({
        rows: page.rows.map((row) => jobToWire(row)),
        nextCursor: page.nextCursor,
      }));
    },

    async sqlPanel({ actor, query }) {
      const trimmed = query.trim();
      if (trimmed === '') {
        return err(validationError('sql panel query is empty'));
      }
      // Audit BEFORE executing: a refused or failed query is still on the
      // record, and the row counts toward the read-volume story either way.
      await writeReadAudit(deps.stores, deps.db, {
        actor,
        action: READ_AUDIT_ACTIONS.sqlPanel,
        details: { query: trimmed },
      });
      return deps.sqlPanel.run(trimmed);
    },
  };
}

/** Dashboard feed depth — a screenful, not an export. */
const DASHBOARD_RECENT_ACTIONS = 20;
