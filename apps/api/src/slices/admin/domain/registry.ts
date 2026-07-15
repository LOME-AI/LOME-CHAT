import type { z } from 'zod';
import type { AdminOpContract, AnyAdminOpContract } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';

/**
 * One typed effect description an op returns; preview renders these as the
 * change list, and they land verbatim in the audit row's `details`. Values
 * must stay wire-JSON (no bigint) — the engine fail-fasts on anything the
 * audit jsonb column cannot serialize.
 */
export interface AdminOpEffect {
  readonly label: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** The audit row's polymorphic target (no FK by design). */
export interface AdminOpTarget {
  readonly type: string;
  readonly id: string;
}

/**
 * A post-commit ephemeral effect (Redis watermark bumps, best-effort socket
 * eviction). Op bodies stay Postgres-only inside the settlement transaction;
 * the engine runs registered ephemeral effects ONLY after a successful
 * commit — never inside the transaction, never in preview — and their
 * failure is logged best-effort, never failing the executed op.
 */
export interface AdminEphemeralEffect {
  readonly name: string;
  run(): Promise<void>;
}

export interface AdminOpOutcome {
  readonly effects: readonly AdminOpEffect[];
  readonly target?: AdminOpTarget;
  /**
   * Wire-shape input for the registered inverse op, captured from PRE-state
   * at execute time (inverse snapshot semantics — never recomputed at undo
   * time). Required from durable ops; ephemeral ops omit it.
   */
  readonly inverseInput?: Record<string, unknown>;
}

/**
 * The narrow, closed context an op body receives: the engine-owned
 * `SettlementTx`, the composed slice dependencies, and the ephemeral-effect
 * registrar. Nothing else — no db handle, no fetch, no adapters (the
 * admin-op purity arch rule + lint extension enforce the import side).
 */
export interface AdminOpContext<Deps> {
  readonly tx: SettlementTx;
  readonly deps: Deps;
  registerEphemeral(effect: AdminEphemeralEffect): void;
}

/**
 * A registered op: the shared contract bound to its executable body.
 * `execute` is declared method-style deliberately — bivariance lets a
 * specifically-typed op (input inferred from its own contract) widen into
 * the registry's element type.
 */
export interface AdminOpImplementation<Deps, In extends z.ZodObject = z.ZodObject> {
  readonly contract: AdminOpContract<In>;
  execute(
    ctx: AdminOpContext<Deps>,
    input: z.output<In>
  ): ResultAsync<AdminOpOutcome, DomainError> | Promise<Result<AdminOpOutcome, DomainError>>;
}

/** Binds a shared contract to an op body with the input type inferred. */
export function defineAdminOp<Deps, In extends z.ZodObject>(
  contract: AdminOpContract<In>,
  body: Pick<AdminOpImplementation<Deps, In>, 'execute'>
): AdminOpImplementation<Deps, In> {
  return { contract, execute: body.execute };
}

declare const ADMIN_OP_REGISTRY: unique symbol;

interface AdminOpRegistrySurface<Deps> {
  get(name: string): AdminOpImplementation<Deps> | undefined;
  /** Exhaustive contract listing (the `GET /ops` and CLI read surface). */
  list(): readonly AnyAdminOpContract[];
}

/**
 * The branded registry type (compile-time-only phantom intersection, same
 * mechanism as `SettlementTx`): `createAdminOpRegistry` below is the sole
 * mint point, so holding an `AdminOpRegistry` proves the Iron Law gate ran —
 * a hand-built structural `{ get, list }` cannot satisfy `AdminOpEngineDeps`
 * and bypass it.
 */
export type AdminOpRegistry<Deps> = AdminOpRegistrySurface<Deps> & {
  readonly [ADMIN_OP_REGISTRY]: 'AdminOpRegistry';
};

/**
 * Registry construction is the Iron Law gate: a durable mutation whose
 * inverse is not ALSO registered fails here, at module load / app boot —
 * an irreversible admin operation cannot exist at runtime.
 */
export function createAdminOpRegistry<Deps>(
  implementations: readonly AdminOpImplementation<Deps>[]
): AdminOpRegistry<Deps> {
  const byName = new Map<string, AdminOpImplementation<Deps>>();
  for (const implementation of implementations) {
    const { name } = implementation.contract;
    if (byName.has(name)) {
      throw new Error(`admin op registry: duplicate registration of ${name}`);
    }
    byName.set(name, implementation);
  }
  for (const implementation of byName.values()) {
    assertIronLaw(implementation.contract, byName);
  }
  const registry: AdminOpRegistrySurface<Deps> = {
    get: (name) => byName.get(name),
    list: () =>
      [...byName.values()]
        .map((implementation) => implementation.contract)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
  };
  // The single brand mint (mirrors `brandSettlementTx`): legal only here,
  // after the Iron Law assertions above have passed.
  return registry as AdminOpRegistry<Deps>;
}

function assertIronLaw(contract: AnyAdminOpContract, byName: ReadonlyMap<string, unknown>): void {
  if (contract.kind !== 'mutation' || contract.effectClass !== 'durable') return;
  // The shared contract constructor already refuses a null inverse on a
  // durable op; this re-check guards raw contract literals that bypassed it.
  if (contract.inverse === null) {
    throw new Error(`admin op registry: durable mutation ${contract.name} names no inverse`);
  }
  if (!byName.has(contract.inverse)) {
    throw new Error(
      `admin op registry: durable mutation ${contract.name} requires its inverse ` +
        `${contract.inverse}, which is not registered (Reversibility Iron Law)`
    );
  }
}
