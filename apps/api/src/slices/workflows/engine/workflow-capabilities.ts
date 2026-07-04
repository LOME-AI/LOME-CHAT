import { listTag, optionalTag, textTag } from '@hushbox/shared';
import type {
  ConstraintEntryOf,
  ConstraintKind,
  NamedConstraintEntry,
  NamedConstraintRegistry,
  TypeTag,
} from '@hushbox/shared';
import type { z } from 'zod';
import type { RegisteredPredicate, RegisteredReducer } from './execution-registry.js';

/**
 * The live named-constraint capabilities: the single source that pairs each
 * predicate/reducer's TYPE signature (what the compiler checks) with its
 * versioned CODE (what the interpreter runs) — "definition data names
 * registered, versioned code", one mechanism. The compile-time
 * `NamedConstraintRegistry` and the runtime predicate/reducer code maps are
 * both derived from it, so the two can never drift.
 */

export interface LiveSchema {
  readonly name: string;
  readonly version: number;
  readonly schema: z.ZodType;
}

export interface LivePredicate {
  readonly name: string;
  readonly version: number;
  readonly input: TypeTag;
  readonly run: RegisteredPredicate;
}

export interface LiveReducer {
  readonly name: string;
  readonly version: number;
  readonly in: readonly TypeTag[];
  readonly out: TypeTag;
  readonly run: RegisteredReducer;
}

export interface WorkflowCapabilities {
  readonly schemas: readonly LiveSchema[];
  readonly predicates: readonly LivePredicate[];
  readonly reducers: readonly LiveReducer[];
}

function typeEntries(capabilities: WorkflowCapabilities): NamedConstraintEntry[] {
  return [
    ...capabilities.schemas.map(
      (schema): NamedConstraintEntry => ({
        kind: 'schema',
        name: schema.name,
        version: schema.version,
        schema: schema.schema,
      })
    ),
    ...capabilities.predicates.map(
      (predicate): NamedConstraintEntry => ({
        kind: 'predicate',
        name: predicate.name,
        version: predicate.version,
        input: predicate.input,
      })
    ),
    ...capabilities.reducers.map(
      (reducer): NamedConstraintEntry => ({
        kind: 'reducer',
        name: reducer.name,
        version: reducer.version,
        in: reducer.in,
        out: reducer.out,
      })
    ),
  ];
}

export function createConstraintRegistry(
  capabilities: WorkflowCapabilities
): NamedConstraintRegistry {
  const entries = typeEntries(capabilities);
  return {
    resolve: <K extends ConstraintKind>(kind: K, name: string): ConstraintEntryOf<K> | undefined =>
      entries.find((entry) => entry.kind === kind && entry.name === name) as
        | ConstraintEntryOf<K>
        | undefined,
  };
}

export function predicateCode(
  capabilities: WorkflowCapabilities
): ReadonlyMap<string, RegisteredPredicate> {
  return new Map(capabilities.predicates.map((predicate) => [predicate.name, predicate.run]));
}

export function reducerCode(
  capabilities: WorkflowCapabilities
): ReadonlyMap<string, RegisteredReducer> {
  return new Map(capabilities.reducers.map((reducer) => [reducer.name, reducer.run]));
}

function presentTexts(inputs: readonly unknown[]): string[] {
  return (inputs[0] as readonly (string | undefined)[]).filter(
    (value): value is string => value !== undefined
  );
}

/**
 * The launch capability set: generic, reusable predicate/reducer code the
 * shipped definitions compose. `joinOptionalTexts` is the tuple-typed
 * multi-model combine — it drops the failed (absent) branches and joins the
 * successful subset, which is exactly the optional-branch fan-in semantics.
 */
export const DEFAULT_WORKFLOW_CAPABILITIES: WorkflowCapabilities = {
  schemas: [],
  predicates: [
    {
      name: 'loopUntilNonEmpty',
      version: 1,
      input: textTag(),
      run: (input) => typeof input === 'string' && input.length > 0,
    },
    {
      name: 'routeByFirstWord',
      version: 1,
      input: textTag(),
      run: (input) => {
        if (typeof input !== 'string') return '';
        const space = input.indexOf(' ');
        return space === -1 ? input : input.slice(0, space);
      },
    },
  ],
  reducers: [
    {
      name: 'joinOptionalTexts',
      version: 1,
      in: [listTag(optionalTag(textTag()))],
      out: textTag(),
      run: (inputs) => presentTexts(inputs).join('\n'),
    },
    {
      name: 'joinTexts',
      version: 1,
      in: [listTag(textTag())],
      out: textTag(),
      run: (inputs) => (inputs[0] as readonly string[]).join('\n'),
    },
    {
      name: 'pairTexts',
      version: 1,
      in: [textTag(), textTag()],
      out: textTag(),
      run: (inputs) => `${String(inputs[0])} ${String(inputs[1])}`,
    },
  ],
};
