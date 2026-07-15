import { z } from 'zod';

/** Admin op names are always `<area>.<verb>` (e.g. `wallet.credit`). */
export type AdminOpName = `${string}.${string}`;

/**
 * Guardrails are op metadata, enforced by the engine before execute; an
 * over-cap request refuses and the refusal is audited.
 */
export interface AdminOpGuardrails {
  /** Absolute cap on a money input, in nano-USD. */
  readonly maxAmountNanoUsd?: bigint;
  /** Maximum targets a single invocation may touch. */
  readonly maxTargets?: number;
  /** Rate-limit registry entry consumed per invocation. */
  readonly rateLimitKey?: string;
}

/**
 * One admin operation, defined once and consumed by the engine, the SPA
 * form renderer, and the CLI. Inputs are FLAT Zod objects (the generic form
 * renderer depends on it) and every mutation input ends with a required
 * non-blank `reason` that lands in the audit row.
 */
export interface AdminOpContract<In extends z.ZodObject = z.ZodObject> {
  readonly name: AdminOpName;
  readonly title: string;
  readonly kind: 'mutation' | 'read';
  readonly input: In;
  /**
   * The Reversibility Iron Law: durable mutations MUST name a registered
   * inverse; ephemeral ops (deleted state the user recreates by acting)
   * never may.
   */
  readonly inverse: AdminOpName | null;
  readonly effectClass: 'durable' | 'ephemeral';
  readonly guardrails?: AdminOpGuardrails;
}

/** A contract with its input widened — the registry/list element type. */
export type AnyAdminOpContract = AdminOpContract;

/** Every wrapper whose `def.innerType` is the schema it decorates. */
const VALUE_WRAPPERS = [
  z.ZodOptional,
  z.ZodNullable,
  z.ZodDefault,
  z.ZodPrefault,
  z.ZodReadonly,
  z.ZodCatch,
  z.ZodNonOptional,
] as const;

/** Unwrap value wrappers so `z.object(...).optional()` cannot smuggle nesting. */
function unwrapValueWrappers(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (VALUE_WRAPPERS.some((wrapper) => current instanceof wrapper)) {
    current = (current.def as unknown as { innerType: z.ZodType }).innerType;
  }
  return current;
}

/** Object/collection-valued schemas — always nested. */
const CONTAINER_SCHEMAS = [
  z.ZodObject,
  z.ZodArray,
  z.ZodRecord,
  z.ZodTuple,
  z.ZodMap,
  z.ZodSet,
] as const;

function isNestedSchema(schema: z.ZodType): boolean {
  const current = unwrapValueWrappers(schema);
  // A lazy schema hides behind a getter that cannot be statically inspected
  // (and may recurse) — fail closed and reject it outright, even for scalars.
  if (current instanceof z.ZodLazy) {
    return true;
  }
  // Composite wrappers recurse: a union is nested iff any option is; an
  // intersection iff either side is; a pipe iff either side is (scalar
  // transform pipes like NanoUSD stay flat).
  if (current instanceof z.ZodUnion) {
    return (current.def.options as readonly z.ZodType[]).some((option) => isNestedSchema(option));
  }
  if (current instanceof z.ZodIntersection) {
    return (
      isNestedSchema(current.def.left as z.ZodType) ||
      isNestedSchema(current.def.right as z.ZodType)
    );
  }
  if (current instanceof z.ZodPipe) {
    return (
      isNestedSchema(current.def.in as z.ZodType) || isNestedSchema(current.def.out as z.ZodType)
    );
  }
  return CONTAINER_SCHEMAS.some((container) => current instanceof container);
}

function assertInverseRule(contract: AnyAdminOpContract): void {
  if (contract.effectClass === 'durable' && contract.inverse === null) {
    throw new Error(`admin op ${contract.name}: durable ops must name an inverse (Iron Law)`);
  }
  if (contract.effectClass === 'ephemeral' && contract.inverse !== null) {
    throw new Error(`admin op ${contract.name}: ephemeral ops never declare an inverse`);
  }
}

function assertFlatInput(name: AdminOpName, shape: Record<string, z.ZodType>): void {
  for (const [key, field] of Object.entries(shape)) {
    if (isNestedSchema(field)) {
      throw new Error(`admin op ${name}: input field '${key}' is nested — inputs must stay flat`);
    }
  }
}

function assertReasonField(name: AdminOpName, shape: Record<string, z.ZodType>): void {
  const reasonField = shape['reason'];
  if (!reasonField) {
    throw new Error(`admin op ${name}: mutation input must include reason`);
  }
  if (
    reasonField.safeParse('').success ||
    reasonField.safeParse(' \t\n ').success ||
    !reasonField.safeParse('valid reason').success
  ) {
    throw new Error(`admin op ${name}: reason must be a required non-blank string`);
  }
}

/**
 * Fail-fast constructor for admin op contracts. Throws at module load on a
 * contract violating the Iron Law (durable ⟺ inverse), the flat-input rule,
 * or the required non-blank `reason` on mutations.
 */
export function defineAdminOpContract<In extends z.ZodObject>(
  contract: AdminOpContract<In>
): AdminOpContract<In> {
  assertInverseRule(contract);
  const shape = contract.input.shape as Record<string, z.ZodType>;
  assertFlatInput(contract.name, shape);
  if (contract.kind === 'mutation') {
    assertReasonField(contract.name, shape);
  }
  return contract;
}
