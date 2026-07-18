import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  ERROR_CODES,
  FEEDBACK_STATUSES,
  NEWSLETTER_STATUSES,
} from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { IDEMPOTENCY_KEY_HEADER, createErrorResponse, idempotencyExempt } from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Database } from '@hushbox/db';
import type { AnyAdminOpContract } from '@hushbox/shared';
import type { AppEnv, Principal } from '../../middleware/pipeline-manifest.js';
import type {
  AdminOpEngine,
  AdminOpPrefill,
  AdminOpRunResult,
  AdminReadSurface,
  Customer360Query,
  DomainError,
  DomainErrorCode,
  RunAdminOpParams,
  Telemetry,
} from './domain/index.js';

/** What the read-surface factory may see of the request environment. */
export interface AdminReadContext {
  readonly db: Database;
  readonly telemetry: Telemetry;
  /** Raw bindings — the SQL panel's second connection string lives here and
   * the composition root owns its own fail-fast (like OPAQUE's secret). */
  readonly env: { readonly ADMIN_SQL_PANEL_DATABASE_URL?: string };
  readonly isDev: boolean;
}

export interface AdminRouteDeps {
  /**
   * Per-request engine over the pipeline's `c.var.db` + logger. The
   * composition root constructs it WITHOUT engine hooks: `afterAudit` is a
   * test-only seam and must be unreachable in production wiring.
   */
  readonly engine: (db: Database, telemetry: Telemetry) => AdminOpEngine;
  /** The registry's contract catalog (the `GET /ops` read surface). */
  readonly listOps: () => readonly AnyAdminOpContract[];
  /**
   * Resolve an op's current-state form prefill over the pipeline's
   * `c.var.db`; `null` when the op is unknown OR registers no resolver —
   * indistinguishable by design (no catalog advertisement exists; the SPA
   * probes blindly and treats any failure as "open blank"). The composition
   * root runs the registered resolver with the same composed deps the op
   * bodies receive. Payloads are wire-JSON input values, never `reason`.
   */
  readonly prefill: (db: Database, name: string) => AdminOpPrefill | null;
  /** Per-request bespoke read surface (360, dashboard, jobs, audit, SQL). */
  readonly reads: (context: AdminReadContext) => AdminReadSurface;
}

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. The
 * context is typed with hono's base `Env` because the hook's `E` is not
 * inferred from the route chain — `AppEnv` here would fail contravariance.
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The op input rides an `input` envelope (never spread into the body root)
 * so route-level fields — `undoes`, future envelope fields — can never
 * collide with an op's own flat input keys. The envelope stays `unknown`-
 * valued: the CONTRACT schema is the validator, applied by the engine.
 */
const previewBodySchema = z.object({
  input: z.record(z.string(), z.unknown()),
});

const executeBodySchema = z.object({
  input: z.record(z.string(), z.unknown()),
  /** The audit row id being undone when this execute is an undo. */
  undoes: z.uuid().optional(),
});

/**
 * The engine seam the idempotency arch check requires lexically in every
 * `admin-engine`-exempted terminal handler: all op traffic — preview and
 * execute — flows through the engine's own key-row machinery (claim /
 * replay / fenced flips), never `runMutation`/`idempotent.*` at the route.
 */
function runAdminOp(engine: AdminOpEngine, params: RunAdminOpParams) {
  return engine.run(params);
}

/** The authorizer admits only the admin-actor kind to `admin`-classed
 * routes, so any other kind here is a pipeline defect, not a client error. */
function adminActorEmail(principal: Principal): string {
  if (principal.kind !== 'admin-actor') {
    throw new Error('admin routes: handler reached without an admin-actor principal');
  }
  return principal.email;
}

/** The catalog entry the SPA form renderer and the CLI consume — wire-JSON
 * only (guardrail money caps serialize as NanoUSD strings). */
function describeContract(contract: AnyAdminOpContract): Record<string, unknown> {
  const guardrails = contract.guardrails;
  return {
    name: contract.name,
    title: contract.title,
    kind: contract.kind,
    effectClass: contract.effectClass,
    inverse: contract.inverse,
    fields: Object.keys(contract.input.shape),
    ...(guardrails === undefined
      ? {}
      : {
          guardrails: {
            ...(guardrails.maxAmountNanoUsd === undefined
              ? {}
              : { maxAmountNanoUsd: guardrails.maxAmountNanoUsd.toString(10) }),
            ...(guardrails.maxTargets === undefined ? {} : { maxTargets: guardrails.maxTargets }),
            ...(guardrails.rateLimitKey === undefined
              ? {}
              : { rateLimitKey: guardrails.rateLimitKey }),
          },
        }),
  };
}

/** Preview never committed, so its rolled-back audit id must not leak. */
function previewResponse(run: AdminOpRunResult): Record<string, unknown> {
  return { effects: run.effects, inverseInput: run.inverseInput };
}

/** One lookup key: `email` wins when both arrive (zod strips the loser),
 * neither refuses — the union's output IS the domain's `Customer360Query`. */
const overviewQuerySchema = z.union([
  z.object({ email: z.email() }),
  z.object({ userId: z.uuid() }),
]);

const auditQuerySchema = z.object({
  actor: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.uuid().optional(),
});

const jobsQuerySchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'cancelled', 'dead', 'discarded']).optional(),
  type: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

const feedbackQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const feedbackDetailParameterSchema = z.object({ id: z.uuid() });

const newsletterIssuesQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const newsletterRenderBodySchema = z.object({
  subject: z.string().trim().min(1),
  bodyMarkdown: z.string().min(1),
});

const newsletterSubscribersQuerySchema = z.object({
  status: z.enum(NEWSLETTER_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sqlQuerySchema = z.object({ query: z.string().min(1) });

/** The read-surface factory's view of the request (never raw `c` deeper in). */
function readContextOf(c: Context<AppEnv>): AdminReadContext {
  return {
    db: c.var.db,
    telemetry: c.var.logger,
    env: c.env,
    isDev: c.var.envUtils.isDev,
  };
}

/**
 * The admin plane's HTTP surface: the generic ops routes over the audited
 * engine (one definition, many surfaces — Charter #8; the SPA and CLI hit
 * exactly these). Every route is `admin`-classed: only the `admin-actor`
 * principal minted by the verified Access assertion passes. The mutating
 * routes are `admin-engine`-exempt from the Idempotency-Key stage: the
 * engine itself claims/replays/fences on the key row and REJECTS an execute
 * without a client key, and preview commits nothing by construction.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createAdminManifest(deps: AdminRouteDeps) {
  return defineSliceManifest({
    basePath: '/admin',
    routes: new Hono<AppEnv>()
      .get('/ops', routeClass('admin'), (c) =>
        c.json({ ops: deps.listOps().map((contract) => describeContract(contract)) }, 200)
      )
      // Read-only and unaudited on purpose: it returns admin-authored config
      // (what the op's own preview would show), never customer metadata.
      .get('/ops/:name/prefill', routeClass('admin'), async (c) => {
        const pending = deps.prefill(c.var.db, c.req.param('name'));
        if (pending === null) {
          return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
        }
        const result = await pending;
        return result.match(
          (input) => c.json({ input }, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .post(
        '/ops/:name/preview',
        routeClass('admin'),
        idempotencyExempt('admin-engine'),
        zValidator('json', previewBodySchema, rejectInvalid),
        async (c) => {
          const result = await runAdminOp(deps.engine(c.var.db, c.var.logger), {
            name: c.req.param('name'),
            input: c.req.valid('json').input,
            actor: adminActorEmail(c.var.principal),
            mode: 'preview',
          });
          return result.match(
            (run) => c.json(previewResponse(run), 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/ops/:name/execute',
        routeClass('admin'),
        idempotencyExempt('admin-engine'),
        zValidator('json', executeBodySchema, rejectInvalid),
        async (c) => {
          const { input, undoes } = c.req.valid('json');
          const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);
          const result = await runAdminOp(deps.engine(c.var.db, c.var.logger), {
            name: c.req.param('name'),
            input,
            actor: adminActorEmail(c.var.principal),
            mode: 'execute',
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            ...(undoes === undefined ? {} : { undoes }),
          });
          return result.match(
            (run) => c.json(run, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/users/overview',
        routeClass('admin'),
        zValidator('query', overviewQuerySchema, rejectInvalid),
        async (c) => {
          const query: Customer360Query = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).customer360({
            actor: adminActorEmail(c.var.principal),
            query,
          });
          return result.match(
            (view) => c.json(view, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/dashboard', routeClass('admin'), async (c) => {
        const result = await deps.reads(readContextOf(c)).dashboard();
        return result.match(
          (view) => c.json(view, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/jobs',
        routeClass('admin'),
        zValidator('query', jobsQuerySchema, rejectInvalid),
        async (c) => {
          const { status, type, limit, cursor } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).jobQueue({
            limit,
            ...(status === undefined ? {} : { status }),
            ...(type === undefined ? {} : { type }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // The feedback triage surface: a keyset inbox page and an audited detail
      // read, both composing the feedback slice's published barrel (this slice
      // never touches the `feedback` table). The read-volume cap is mounted in
      // app.ts on both paths, like the other sensitive reads.
      .get(
        '/feedback',
        routeClass('admin'),
        zValidator('query', feedbackQuerySchema, rejectInvalid),
        async (c) => {
          const { status, cursor, limit } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).feedbackInbox({
            limit,
            ...(status === undefined ? {} : { status }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/feedback/:id',
        routeClass('admin'),
        zValidator('param', feedbackDetailParameterSchema, rejectInvalid),
        async (c) => {
          const result = await deps.reads(readContextOf(c)).feedbackDetail({
            actor: adminActorEmail(c.var.principal),
            id: c.req.valid('param').id,
          });
          return result.match(
            (detail) => c.json(detail, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Newsletter issues table: admin-authored content over the newsletter
      // slice's published keyset read — unaudited like the feedback inbox
      // (nothing customer-derived); the query schema caps the page size.
      .get(
        '/newsletter/issues',
        routeClass('admin'),
        zValidator('query', newsletterIssuesQuerySchema, rejectInvalid),
        async (c) => {
          const { cursor, limit } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).newsletterIssues({
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Compose-screen preview: renders the exact issue template the
      // dispatch job sends (inert '#' unsubscribe — never a live URL).
      // A POST for body size, but a pure read: no exemption class fits a
      // wrapperless read, so it rides the universal Idempotency-Key demand.
      .post(
        '/newsletter/render',
        routeClass('admin'),
        zValidator('json', newsletterRenderBodySchema, rejectInvalid),
        async (c) => {
          const result = await deps.reads(readContextOf(c)).renderIssue(c.req.valid('json'));
          return result.match(
            (rendered) => c.json(rendered, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Aggregate subscriber counts — no per-person data, so unaudited like
      // the dashboard. The per-row consent-evidence list below is the
      // audited, volume-capped one (its rate-limit mount lives in app.ts
      // with the other sensitive reads).
      .get('/newsletter/subscribers/stats', routeClass('admin'), async (c) => {
        const result = await deps.reads(readContextOf(c)).newsletterSubscriberStats();
        return result.match(
          (stats) => c.json(stats, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/newsletter/subscribers',
        routeClass('admin'),
        zValidator('query', newsletterSubscribersQuerySchema, rejectInvalid),
        async (c) => {
          const { status, cursor, limit } = c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).newsletterSubscribers({
            actor: adminActorEmail(c.var.principal),
            limit,
            ...(status === undefined ? {} : { status }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Catalog data, not customer metadata — outside the audited read set
      // and, like dashboard/jobs, not actor-rate-limited (the sensitive,
      // actor-rate-limited reads are 360/audit/sql/feedback and the
      // newsletter subscriber list). Single capped page, no cursor:
      // the catalog is small-by-design (see ADMIN_CATALOG_MODEL_CAP).
      .get('/models', routeClass('admin'), async (c) => {
        const result = await deps.reads(readContextOf(c)).modelsCatalog();
        return result.match(
          (page) => c.json(page, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/audit',
        routeClass('admin'),
        zValidator('query', auditQuerySchema, rejectInvalid),
        async (c) => {
          const { actor, action, targetType, targetId, from, to, limit, cursor } =
            c.req.valid('query');
          const result = await deps.reads(readContextOf(c)).auditSearch({
            limit,
            ...(actor === undefined ? {} : { actor }),
            ...(action === undefined ? {} : { action }),
            ...(targetType === undefined ? {} : { targetType }),
            ...(targetId === undefined ? {} : { targetId }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(from === undefined ? {} : { from: new Date(from) }),
            ...(to === undefined ? {} : { to: new Date(to) }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // A GET on purpose: the panel is a read, and a POST would demand an
      // Idempotency-Key exemption class whose arch evidence (an
      // `idempotent.*` wrapper) a read can never honestly show.
      .get(
        '/sql',
        routeClass('admin'),
        zValidator('query', sqlQuerySchema, rejectInvalid),
        async (c) => {
          const result = await deps.reads(readContextOf(c)).sqlPanel({
            actor: adminActorEmail(c.var.principal),
            query: c.req.valid('query').query,
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
