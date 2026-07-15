import { z } from 'zod';
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
} from '../../../lib/errors/index.js';
import {
  REQUEST_LEASE_SECONDS,
  claimKeyRow,
  failKeyRow,
  hashCanonicalJson,
  uuidFromHex,
  requestInProgressError,
  runSettlement,
  succeedKeyRow,
} from '../../../lib/idempotency/index.js';
import { ResultAsync, err, ok } from '../../../lib/result/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { UndoAlreadyClaimedError } from '../ports/index.js';
import type { Database } from '@hushbox/db';
import type { AnyAdminOpContract } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  IdempotencyScope,
  KeyRowClaim,
  KeyRowFence,
  SettlementTx,
} from '../../../lib/idempotency/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdminAuditInsertRow, AdminStores } from '../ports/index.js';
import type {
  AdminEphemeralEffect,
  AdminOpEffect,
  AdminOpImplementation,
  AdminOpRegistry,
  AdminOpTarget,
} from './registry.js';

/**
 * The admin ops engine — one code path, two modes. Both modes run the SAME
 * body (op execute → audit insert, inside one settlement transaction);
 * `preview` throws the `PreviewRollback` sentinel so the transaction rolls
 * back and the computed effect diff becomes the plan; `execute` commits,
 * fenced by the shared idempotency-key row so a retried execute replays the
 * stored response and never re-runs effects.
 *
 * Note on the idempotency wrapper: the Charter names `idempotent.byKey`, but
 * `byKey` opens a plain transaction and cannot mint the `SettlementTx` op
 * bodies require. The engine therefore composes byKey's own published
 * primitives — `claimKeyRow` (claim / replay / in-progress semantics,
 * canonical body hash, lease) + `runSettlement` (the sole `SettlementTx`
 * mint) + the fenced `succeedKeyRow`/`failKeyRow` flips — exactly the
 * composition the workflows engine's fenced settlement already uses. Same
 * machinery, same semantics, no parallel implementation.
 */

export interface RunAdminOpParams {
  readonly name: string;
  /** Wire-shape JSON input (validated against the contract's Zod schema). */
  readonly input: unknown;
  /** The Cloudflare Access identity (or CLI token name) performing the op. */
  readonly actor: string;
  readonly mode: 'preview' | 'execute';
  /** Client-minted Idempotency-Key; required in execute mode. */
  readonly idempotencyKey?: string;
  /**
   * The audit row id being undone when this run is an inverse-as-undo. The
   * audit insert claims the `undoes` UNIQUE column, so a second undo of the
   * same row fails with `conflict` — undo is exactly-once by construction.
   */
  readonly undoes?: string;
}

export interface AdminOpRunResult {
  readonly auditId: string;
  readonly effects: readonly AdminOpEffect[];
  readonly inverseInput: Record<string, unknown> | null;
}

/** Replay validation for responses stored on the idempotency-key row. */
const adminOpRunResultSchema = z.object({
  auditId: z.uuid(),
  effects: z.array(
    z.object({
      label: z.string(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    })
  ),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});

export interface AdminOpEngineHooks {
  /**
   * Test seam for the audit-atomicity battery: runs inside the settlement
   * transaction after the op body and the audit insert, before the key-row
   * flip / rollback sentinel. A throw here must roll back effects AND audit
   * together. Production wiring leaves it undefined.
   */
  afterAudit?: () => void | Promise<void>;
}

/** What the post-commit notifier learns about one committed execute. */
export interface AdminOpExecutedNotice {
  readonly opName: string;
  readonly actor: string;
  readonly reason: string;
  readonly target?: AdminOpTarget;
  readonly auditId: string;
  readonly isUndo: boolean;
}

export interface AdminOpEngineDeps<Deps> {
  readonly db: Database;
  readonly registry: AdminOpRegistry<Deps>;
  readonly stores: AdminStores;
  readonly telemetry: Telemetry;
  /** The composed slice dependencies op bodies receive as `ctx.deps`. */
  readonly opDeps: Deps;
  /** Claimant identity recorded as the key-row fence (`claimedBy`). */
  readonly executorId: string;
  readonly hooks?: AdminOpEngineHooks;
  /**
   * Best-effort mutation notification (telemetry, never a control — the
   * admin plane's remaining tripwire against a compromised-but-valid
   * session). Fires once per COMMITTED execute, after the ephemeral
   * effects: never in preview, never on replay, never on a failed op. A
   * throw is captured and never fails the already-committed op.
   */
  readonly onExecuted?: (notice: AdminOpExecutedNotice) => Promise<void>;
}

export interface AdminOpEngine {
  run(params: RunAdminOpParams): ResultAsync<AdminOpRunResult, DomainError>;
}

/** Rollback sentinel: module-private, carries the computed plan out of the
 * deliberately-aborted preview transaction. A real error can never be an
 * instance of this class, so it cannot be mistaken for the sentinel. */
class PreviewRollback extends Error {
  constructor(readonly result: AdminOpRunResult) {
    super('admin engine: preview rollback');
    this.name = 'PreviewRollback';
  }
}

/** Carries an expected op failure (a `Result` err) across the transaction
 * boundary so Drizzle rolls everything back. */
class OpFailed extends Error {
  constructor(readonly domainError: DomainError) {
    super('admin engine: op execution failed');
    this.name = 'OpFailed';
  }
}

/** Aborts the transaction when the completion fence finds a zombie claimant. */
class FenceLost extends Error {
  constructor() {
    super('admin engine: completion fence lost');
  }
}

export function createAdminOpEngine<Deps>(deps: AdminOpEngineDeps<Deps>): AdminOpEngine {
  return {
    run(params: RunAdminOpParams): ResultAsync<AdminOpRunResult, DomainError> {
      return new ResultAsync(runInternal(deps, params));
    },
  };
}

async function runInternal<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  params: RunAdminOpParams
): Promise<Result<AdminOpRunResult, DomainError>> {
  const op = deps.registry.get(params.name);
  if (op === undefined) {
    return err(notFoundError('admin op is not registered'));
  }
  if (op.contract.kind !== 'mutation') {
    // Reads skip the tx machinery entirely (a later task's surface); a read
    // contract reaching the mutation engine is a wiring defect.
    throw new Error(`admin engine: ${op.contract.name} is not a mutation op`);
  }
  const parsed = op.contract.input.safeParse(params.input);
  if (!parsed.success) {
    return err(validationError('admin op input failed validation'));
  }
  const violation = guardrailViolation(op.contract, parsed.data);
  if (violation !== null) {
    // The refusal is audited (Charter #7) — but only on execute: preview
    // surfaces it as the blocking error and commits nothing, like every
    // other preview outcome.
    if (params.mode === 'execute') {
      await deps.stores.insertAudit(deps.db, {
        actor: params.actor,
        action: op.contract.name,
        details: { refusal: violation, input: auditWireInput(params.input, op.contract.input) },
      });
    }
    return err(forbiddenError(`admin op guardrail refused: ${violation}`));
  }
  const run: OpRun<Deps> = { op, parsed: parsed.data, params };
  return params.mode === 'preview' ? previewRun(deps, run) : executeRun(deps, run);
}

/**
 * `maxAmountNanoUsd` caps every money field of the parsed input (money
 * parses to bigint; nothing else does). `maxTargets` has no input dimension
 * yet — inputs are flat and single-target by the shared contract rules — and
 * `rateLimitKey` is consumed by the HTTP layer's rate-limit middleware, not
 * here.
 */
function guardrailViolation(
  contract: AnyAdminOpContract,
  parsed: Record<string, unknown>
): string | null {
  const cap = contract.guardrails?.maxAmountNanoUsd;
  if (cap === undefined) return null;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'bigint' && value > cap) {
      return `${key} exceeds maxAmountNanoUsd`;
    }
  }
  return null;
}

interface PerformedOp {
  readonly result: AdminOpRunResult;
  readonly ephemeralEffects: readonly AdminEphemeralEffect[];
  readonly target?: AdminOpTarget;
}

/** One validated run: the op, its parsed input, and the raw run params. */
interface OpRun<Deps> {
  readonly op: AdminOpImplementation<Deps>;
  readonly parsed: Record<string, unknown>;
  readonly params: RunAdminOpParams;
}

/** Details shape every executed-effect audit row carries; a guardrail-
 * refusal row (`{ refusal, input }`) fails it — a refusal records a refused
 * attempt and has no effect to undo. */
const executedAuditDetailsSchema = z.object({
  effects: z.array(z.unknown()),
  inverseInput: z.record(z.string(), z.unknown()).nullable(),
});

const auditIdSchema = z.uuid();

/**
 * Validates the undo-target relationship inside the settlement transaction,
 * before the op body and the audit insert: the target row must exist, must
 * be an executed-effect row, and the running op must be the target action's
 * REGISTERED inverse — a caller can never burn an arbitrary row's one undo
 * slot (`undoes` is UNIQUE on an append-only table) or write a false
 * undone-by linkage. Undoing an undo row is legal by explicit decision:
 * inverse pairs register bidirectionally, so the inverse chain makes it a
 * redo, and each row still gets at most one undo via the UNIQUE claim.
 * Mismatches throw `OpFailed` (typed refusals mapped to error Results, like
 * any op-body refusal), never a defect.
 */
async function assertUndoTarget<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  tx: SettlementTx,
  run: OpRun<Deps>
): Promise<void> {
  const undoes = run.params.undoes;
  if (undoes === undefined) return;
  if (!auditIdSchema.safeParse(undoes).success) {
    throw new OpFailed(validationError('admin undo target id is not a uuid'));
  }
  const target = await deps.stores.getAuditForUndo(tx, undoes);
  if (target === undefined) {
    throw new OpFailed(notFoundError('admin undo target audit row does not exist'));
  }
  if (!executedAuditDetailsSchema.safeParse(target.details).success) {
    throw new OpFailed(forbiddenError('admin undo target is not an executed-effect audit row'));
  }
  const targetOp = deps.registry.get(target.action);
  if (targetOp?.contract.inverse !== run.op.contract.name) {
    throw new OpFailed(
      forbiddenError(
        `admin op ${run.op.contract.name} is not the registered inverse of the undo target`
      )
    );
  }
}

/**
 * The audit copy of the input: the raw wire values (bigint money stays in
 * its string wire form — `parsed.data` cannot cross the jsonb boundary)
 * picked down to the contract schema's known keys, so unvalidated payload
 * keys never land in the permanent audit row.
 */
function auditWireInput(raw: unknown, schema: z.ZodObject): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(schema.shape)
      .filter((key) => key in source)
      .map((key) => [key, source[key]])
  );
}

/** The one op body + audit-in-tx path both modes share. */
async function performOp<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  tx: SettlementTx,
  run: OpRun<Deps>
): Promise<PerformedOp> {
  const { op, parsed, params } = run;
  await assertUndoTarget(deps, tx, run);
  const ephemeralEffects: AdminEphemeralEffect[] = [];
  const outcome = await op.execute(
    {
      tx,
      deps: deps.opDeps,
      registerEphemeral: (effect) => ephemeralEffects.push(effect),
    },
    parsed
  );
  if (outcome.isErr()) throw new OpFailed(outcome.error);
  const value = outcome.value;
  if (op.contract.effectClass === 'durable' && value.inverseInput === undefined) {
    throw new Error(
      `admin engine: durable op ${op.contract.name} returned no inverseInput (Iron Law)`
    );
  }
  const details = {
    input: auditWireInput(params.input, op.contract.input),
    effects: value.effects,
    inverseInput: value.inverseInput ?? null,
  };
  assertWireJson(details, op.contract.name);
  const { id } = await deps.stores.insertAudit(
    tx,
    auditRowFor(op.contract.name, params, value.target, details)
  );
  await deps.hooks?.afterAudit?.();
  return {
    result: {
      auditId: id,
      effects: value.effects,
      inverseInput: value.inverseInput ?? null,
    },
    ephemeralEffects,
    ...(value.target === undefined ? {} : { target: value.target }),
  };
}

/** Assembles the executed-effect audit row (target and undoes are optional). */
function auditRowFor(
  action: string,
  params: RunAdminOpParams,
  target: AdminOpTarget | undefined,
  details: unknown
): AdminAuditInsertRow {
  return {
    actor: params.actor,
    action,
    ...(target === undefined ? {} : { targetType: target.type, targetId: target.id }),
    details,
    ...(params.undoes === undefined ? {} : { undoes: params.undoes }),
  };
}

/** Audit details must survive the jsonb boundary — fail fast, not mid-insert. */
function assertWireJson(details: unknown, opName: string): void {
  try {
    JSON.stringify(details);
  } catch (error) {
    throw new Error(`admin engine: op ${opName} produced non-JSON audit details`, {
      cause: error,
    });
  }
}

async function previewRun<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  run: OpRun<Deps>
): Promise<Result<AdminOpRunResult, DomainError>> {
  try {
    // The body always throws (the sentinel), so this transaction never
    // commits — preview cannot lie because it IS execute, rolled back.
    return await runSettlement(deps.db, async (tx) => {
      const performed = await performOp(deps, tx, run);
      throw new PreviewRollback(performed.result);
    });
    // eslint-disable-next-line catch-swallow/no-silent-catch -- catches the preview-rollback sentinel; maps to a Result via mapRunError.
  } catch (error) {
    return mapRunError(error);
  }
}

async function executeRun<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  run: OpRun<Deps>
): Promise<Result<AdminOpRunResult, DomainError>> {
  const { op, params } = run;
  if (params.idempotencyKey === undefined || params.idempotencyKey === '') {
    return err(validationError('admin op execute requires an idempotency key'));
  }
  const scope: IdempotencyScope = {
    userId: await actorScopeId(params.actor),
    route: `admin/ops/${op.contract.name}`,
    key: params.idempotencyKey,
  };
  const bodyHash = await hashCanonicalJson({
    input: params.input,
    undoes: params.undoes ?? null,
  });
  const claim = await claimKeyRow(deps.db, {
    scope,
    kind: 'request',
    bodyHash,
    executorId: deps.executorId,
    leaseSeconds: REQUEST_LEASE_SECONDS,
  });
  if (claim.isErr()) return err(claim.error);
  const resolved = resolveClaimForExecute(claim.value, deps.executorId);
  if (resolved.outcome === 'replay') {
    return ok(adminOpRunResultSchema.parse(resolved.response));
  }
  return executeClaimed(deps, run, resolved.fence);
}

/**
 * Post-claim resolution, exported for the attach-defect test: the engine
 * always claims kind=request and `claimKeyRow` attaches only run-kind
 * claims, so no store state can reach the attach arm through `run()` itself
 * — this guards the contract against future state-machine changes.
 */
export function resolveClaimForExecute(
  claim: KeyRowClaim,
  executorId: string
): { outcome: 'replay'; response: unknown } | { outcome: 'execute'; fence: KeyRowFence } {
  if (claim.outcome === 'replay') {
    return { outcome: 'replay', response: claim.response };
  }
  if (claim.outcome === 'attach') {
    throw new Error('admin engine: attach outcome on a request-kind claim');
  }
  return {
    outcome: 'execute',
    fence: { id: claim.row.id, executorId, claims: claim.row.claims },
  };
}

async function executeClaimed<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  run: OpRun<Deps>,
  fence: KeyRowFence
): Promise<Result<AdminOpRunResult, DomainError>> {
  try {
    const performed = await runSettlement(deps.db, async (tx) => {
      const inner = await performOp(deps, tx, run);
      const flip = await succeedKeyRow(tx, fence, inner.result);
      if (flip.isErr()) throw new OpFailed(flip.error);
      if (flip.value === 'lost') throw new FenceLost();
      return inner;
    });
    await runEphemeralEffects(performed.ephemeralEffects, deps.telemetry);
    await notifyExecuted(deps, run, performed);
    return ok(performed.result);
  } catch (error) {
    // Drizzle has already rolled the transaction back: nothing committed —
    // no effects, no audit row (atomic total auditability).
    if (error instanceof FenceLost) return err(requestInProgressError());
    await markFailed(deps.db, fence);
    return mapRunError(error);
  }
}

/** Expected failures become Results; everything else is a defect and rethrows. */
function mapRunError(error: unknown): Result<AdminOpRunResult, DomainError> {
  if (error instanceof PreviewRollback) return ok(error.result);
  if (error instanceof OpFailed) return err(error.domainError);
  if (error instanceof UndoAlreadyClaimedError) {
    return err(conflictError('admin audit row has already been undone', error));
  }
  throw error;
}

/**
 * Best-effort failed flip (mirrors `byKey`): if the fence write itself fails
 * the row stays as it is and lease expiry takes over — recovery is
 * in-mechanism, never a second delivery path.
 */
async function markFailed(db: Database, fence: KeyRowFence): Promise<void> {
  const flip = await failKeyRow(db, fence);
  flip.unwrapOr('lost');
}

/**
 * Post-commit ephemeral effects (Redis watermark bumps, best-effort socket
 * eviction). Never inside the transaction, never in preview; a failure is
 * captured and never fails the already-committed op.
 */
async function runEphemeralEffects(
  effects: readonly AdminEphemeralEffect[],
  telemetry: Telemetry
): Promise<void> {
  for (const effect of effects) {
    try {
      await effect.run();
    } catch (error) {
      telemetry.captureError(
        error instanceof Error
          ? error
          : new Error('admin ephemeral effect threw a non-Error value'),
        FINGERPRINT_CODES.adminEphemeralEffectFailed
      );
    }
  }
}

/**
 * Best-effort post-commit notification (the `onExecuted` dep's contract).
 * Runs only on this path — a replay returns before `executeClaimed`, preview
 * never commits — so a committed execute notifies exactly once. `reason` is
 * read from the parsed input (every mutation contract requires it).
 */
async function notifyExecuted<Deps>(
  deps: AdminOpEngineDeps<Deps>,
  run: OpRun<Deps>,
  performed: PerformedOp
): Promise<void> {
  if (deps.onExecuted === undefined) return;
  // Every mutation contract requires `reason: z.string()` (Charter #6), so
  // the parsed value is a string by construction.
  const reason = run.parsed['reason'] as string;
  try {
    await deps.onExecuted({
      opName: run.op.contract.name,
      actor: run.params.actor,
      reason,
      ...(performed.target === undefined ? {} : { target: performed.target }),
      auditId: performed.result.auditId,
      isUndo: run.params.undoes !== undefined,
    });
  } catch (error) {
    deps.telemetry.captureError(
      error instanceof Error ? error : new Error('admin op notifier threw a non-Error value'),
      FINGERPRINT_CODES.adminOpNotificationFailed
    );
  }
}

/**
 * The idempotency scope's `userId` column is a uuid, but the admin actor is
 * a Cloudflare Access identity (an email / token name). Derive a stable,
 * deterministic per-actor uuid from the canonical hash so the scope stays
 * per-actor without putting the identity in the uuid column.
 */
async function actorScopeId(actor: string): Promise<string> {
  return uuidFromHex(await hashCanonicalJson({ adminActor: actor }));
}
