import type { TypeTag } from './type-tag.js';
import type { z } from 'zod';

/**
 * One closed named-constraint registry, reused three ways:
 * loop/branch predicates, fanIn reducers, and ParamSpec cross-field
 * constraints are all "definition data names registered, versioned code" —
 * one mechanism, not three ad-hoc string registries. Named JSON schemas
 * (`json<schemaName>` resolution) live in the same registry.
 *
 * This module is the CONTRACT only; the live registry instance is owned by
 * the workflows/models slices.
 */
export const CONSTRAINT_KINDS = ['schema', 'predicate', 'reducer', 'paramConstraint'] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

interface ConstraintEntryBase<K extends ConstraintKind> {
  readonly kind: K;
  readonly name: string;
  readonly version: number;
}

/** A named Zod schema — what `zodFor` resolves `json<schemaName>` through. */
export interface SchemaConstraintEntry extends ConstraintEntryBase<'schema'> {
  readonly schema: z.ZodType;
}

/** A typed predicate over state — `branch.predicate` / `loop.until` name these. */
export interface PredicateConstraintEntry extends ConstraintEntryBase<'predicate'> {
  readonly input: TypeTag;
}

/**
 * A tuple-typed fanIn reducer registration: `(in: TypeTag[], out: TypeTag)`
 * — fully static at graph-compile, expressive enough for "N images + a text
 * prompt → one model input". Reducers over `optional<T>` elements
 * (skipped branches) are explicit in the `in` tags.
 */
export interface ReducerConstraintEntry extends ConstraintEntryBase<'reducer'> {
  readonly in: readonly TypeTag[];
  readonly out: TypeTag;
}

/** The ParamSpec escape hatch: a constraint beyond the closed shape. */
export type ParameterConstraintEntry = ConstraintEntryBase<'paramConstraint'>;

export type NamedConstraintEntry =
  | SchemaConstraintEntry
  | PredicateConstraintEntry
  | ReducerConstraintEntry
  | ParameterConstraintEntry;

export type ConstraintEntryOf<K extends ConstraintKind> = Extract<
  NamedConstraintEntry,
  { kind: K }
>;

/** Lookup seam over the closed registry. */
export interface NamedConstraintRegistry {
  resolve<K extends ConstraintKind>(kind: K, name: string): ConstraintEntryOf<K> | undefined;
}
