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
  /** Rate-limit registry entry consumed per invocation. */
  readonly rateLimitKey?: string;
}

/**
 * One admin operation, defined once and consumed by the engine, the SPA
 * form renderer, and the CLI. Inputs are FLAT Zod objects (the generic form
 * renderer depends on it) — the one exception is a repeatable group, an
 * array of flat-scalar objects (see `isRepeatableGroup`) — and every
 * mutation input ends with a required non-blank `reason` that lands in the
 * audit row.
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

/**
 * Scalar kinds a top-level field may unwrap to. The flat law is FAIL-CLOSED:
 * anything not on this list (or a composite of it, below) — `z.any()`,
 * `z.unknown()`, `z.record()`, a new zod kind — is rejected at definition
 * time rather than admitted by omission, so no field can smuggle arbitrary
 * nested data past the shape walk.
 */
// ZodStringFormat (z.uuid(), z.email(), …) is a sibling of ZodString in
// zod 4, not a subclass — both are needed to cover string-valued fields.
const TOP_LEVEL_SCALAR_SCHEMAS = [
  z.ZodString,
  z.ZodStringFormat,
  z.ZodNumber,
  z.ZodBoolean,
  z.ZodEnum,
] as const;

function isFlatScalar(schema: z.ZodType): boolean {
  const current = unwrapValueWrappers(schema);
  // A lazy schema hides behind a getter that cannot be statically inspected
  // (and may recurse) — fail closed and reject it outright, even for scalars.
  if (current instanceof z.ZodLazy) {
    return false;
  }
  // Composite wrappers recurse: a union is flat iff every option is; an
  // intersection iff both sides are; a pipe iff its in side is and its out
  // side is flat or the transform itself (scalar transform pipes like
  // NanoUSD stay flat).
  if (current instanceof z.ZodUnion) {
    return (current.def.options as readonly z.ZodType[]).every((option) => isFlatScalar(option));
  }
  if (current instanceof z.ZodIntersection) {
    return (
      isFlatScalar(current.def.left as z.ZodType) && isFlatScalar(current.def.right as z.ZodType)
    );
  }
  if (current instanceof z.ZodPipe) {
    const outSide = current.def.out as z.ZodType;
    return (
      isFlatScalar(current.def.in as z.ZodType) &&
      (outSide instanceof z.ZodTransform || isFlatScalar(outSide))
    );
  }
  return TOP_LEVEL_SCALAR_SCHEMAS.some((scalar) => current instanceof scalar);
}

/**
 * Scalar kinds a repeatable-group sub-field may be. Deliberately narrower
 * than the top-level rule (no unions, no pipes): the form renderer draws a
 * group row as one input per sub-field, and only these map to one widget.
 */
const GROUP_SCALAR_SCHEMAS = [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodEnum] as const;

/**
 * A repeatable group — the one sanctioned departure from flat inputs: an
 * array of objects whose sub-fields are all flat scalars (each optionally
 * wrapped in optional/default/etc.). Anything deeper stays rejected.
 */
function isRepeatableGroup(schema: z.ZodType): boolean {
  const current = unwrapValueWrappers(schema);
  if (!(current instanceof z.ZodArray)) {
    return false;
  }
  const element = unwrapValueWrappers(current.def.element as z.ZodType);
  if (!(element instanceof z.ZodObject)) {
    return false;
  }
  // A catchall (looseObject/passthrough/.catchall) admits undeclared keys the
  // shape walk below never sees — arbitrary nesting would smuggle through.
  // Fail closed on ANY catchall, strict ones included.
  if (element.def.catchall !== undefined) {
    return false;
  }
  return Object.values(element.shape as Record<string, z.ZodType>).every((subField) => {
    const unwrapped = unwrapValueWrappers(subField);
    return GROUP_SCALAR_SCHEMAS.some((scalar) => unwrapped instanceof scalar);
  });
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
    if (isRepeatableGroup(field)) {
      continue;
    }
    if (!isFlatScalar(field)) {
      throw new Error(
        `admin op ${name}: input field '${key}' is not a recognized flat scalar — inputs must stay flat`
      );
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
