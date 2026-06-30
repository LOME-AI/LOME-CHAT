import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONSTRAINT_KINDS } from './constraint-registry.js';
import { jsonTag, listTag, mediaTag, textTag } from './type-tag.js';
import type {
  ConstraintEntryOf,
  ConstraintKind,
  NamedConstraintEntry,
  NamedConstraintRegistry,
  ParameterConstraintEntry,
  PredicateConstraintEntry,
  ReducerConstraintEntry,
  SchemaConstraintEntry,
} from './constraint-registry.js';

describe('CONSTRAINT_KINDS', () => {
  it('is the closed set the one registry serves: schemas, predicates, reducers, param constraints', () => {
    expect(CONSTRAINT_KINDS).toEqual(['schema', 'predicate', 'reducer', 'paramConstraint']);
  });
});

describe('constraint entry contracts (types only — the live registry is slice-owned)', () => {
  it('expresses a named schema entry resolving json<schemaName>', () => {
    const entry: SchemaConstraintEntry = {
      kind: 'schema',
      name: 'route',
      version: 1,
      schema: z.object({ model: z.string() }),
    };
    expect(entry.schema.safeParse({ model: 'gpt' }).success).toBe(true);
  });

  it('expresses a typed predicate entry (branch/loop conditions)', () => {
    const entry: PredicateConstraintEntry = {
      kind: 'predicate',
      name: 'isDone',
      version: 1,
      input: jsonTag('loopState'),
    };
    expect(entry.input).toEqual({ kind: 'json', schemaName: 'loopState' });
  });

  it('expresses the tuple-typed fanIn reducer: N images + a text prompt → one model input', () => {
    const entry: ReducerConstraintEntry = {
      kind: 'reducer',
      name: 'imagesPlusPrompt',
      version: 1,
      in: [listTag(mediaTag('image', ['image/png', 'image/jpeg'])), textTag()],
      out: jsonTag('modelInput'),
    };
    expect(entry.in).toHaveLength(2);
    expect(entry.out).toEqual({ kind: 'json', schemaName: 'modelInput' });
  });

  it('expresses a ParamSpec escape-hatch constraint entry', () => {
    const entry: ParameterConstraintEntry = {
      kind: 'paramConstraint',
      name: 'sizeMatrixForModelX',
      version: 1,
    };
    expect(entry.kind).toBe('paramConstraint');
  });

  it('a registry implementation resolves entries by kind and name', () => {
    const schemaEntry: SchemaConstraintEntry = {
      kind: 'schema',
      name: 'route',
      version: 1,
      schema: z.object({}),
    };
    const entries: NamedConstraintEntry[] = [schemaEntry];
    const registry: NamedConstraintRegistry = {
      resolve<K extends ConstraintKind>(kind: K, name: string): ConstraintEntryOf<K> | undefined {
        const found = entries.find((entry) => entry.kind === kind && entry.name === name);
        // The runtime kind check guarantees the narrowing the type system can't see.
        return found as ConstraintEntryOf<K> | undefined;
      },
    };
    expect(registry.resolve('schema', 'route')).toBe(schemaEntry);
    expect(registry.resolve('reducer', 'route')).toBeUndefined();
  });
});
