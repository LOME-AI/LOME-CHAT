import { z } from 'zod';
import { jsonTag, listTag, mediaTag, optionalTag, textTag } from '@hushbox/shared';
import type {
  ConstraintEntryOf,
  ConstraintKind,
  NamedConstraintEntry,
  NamedConstraintRegistry,
  NodePortDeclaration,
} from '@hushbox/shared';
import type { CompileContext, NodeRegistryContext } from './context.js';

/**
 * Shared test doubles for the compile and builder suites — not production
 * wiring. The live registries are owned by the node-registry module; these
 * fakes pin a small, stable vocabulary the tests speak.
 */

export const CLASSIFICATION_SCHEMA_NAME = 'classification';

export const PNG = 'image/png';

export function makeFakeConstraints(): NamedConstraintRegistry {
  const entries: NamedConstraintEntry[] = [
    {
      kind: 'schema',
      name: CLASSIFICATION_SCHEMA_NAME,
      version: 1,
      schema: z.object({ label: z.string() }),
    },
    {
      kind: 'predicate',
      name: 'routeByLabel',
      version: 1,
      input: optionalTag(jsonTag(CLASSIFICATION_SCHEMA_NAME)),
    },
    { kind: 'predicate', name: 'textDone', version: 1, input: textTag() },
    {
      kind: 'predicate',
      name: 'labelDone',
      version: 1,
      input: jsonTag(CLASSIFICATION_SCHEMA_NAME),
    },
    {
      kind: 'reducer',
      name: 'captionsWithPrompt',
      version: 1,
      in: [listTag(optionalTag(textTag())), textTag()],
      out: textTag(),
    },
    { kind: 'reducer', name: 'pairJoin', version: 1, in: [textTag(), textTag()], out: textTag() },
  ];
  return {
    resolve: <K extends ConstraintKind>(kind: K, name: string): ConstraintEntryOf<K> | undefined =>
      entries.find((entry) => entry.kind === kind && entry.name === name) as
        | ConstraintEntryOf<K>
        | undefined,
  };
}

const FAKE_MODEL_PORTS: Readonly<Record<string, NodePortDeclaration>> = {
  'answer-model': { in: [textTag()], out: textTag() },
  'classifier-model': { in: [textTag()], out: jsonTag(CLASSIFICATION_SCHEMA_NAME) },
  'vision-model': { in: [mediaTag('image', [PNG])], out: textTag() },
  // Declares two inputs where modelCall's shape allows exactly one.
  'two-port-model': { in: [textTag(), textTag()], out: textTag() },
  'ghost-schema-model': { in: [textTag()], out: jsonTag('ghost') },
  // A malformed tag a registry could only produce through a defect upstream.
  'forged-tag-model': { in: [textTag()], out: { kind: 'json', schemaName: '' } },
};

const FAKE_TRANSFORM_PORTS: Readonly<Record<string, NodePortDeclaration>> = {
  caption: { in: [mediaTag('image', [PNG])], out: textTag() },
  echo: { in: [textTag()], out: textTag() },
};

const FAKE_SUB_WORKFLOW_PORTS: Readonly<Record<string, NodePortDeclaration>> = {
  summarize: { in: [textTag(), textTag()], out: textTag() },
};

export function makeFakeNodeRegistry(): NodeRegistryContext {
  return {
    hasNode: (_type, version) => version === 1,
    resolveValuePorts: (node) => {
      if (node.type === 'modelCall') return FAKE_MODEL_PORTS[node.model];
      if (node.type === 'transform') return FAKE_TRANSFORM_PORTS[node.transform];
      return FAKE_SUB_WORKFLOW_PORTS[node.ref];
    },
  };
}

export function makeFakeCompileContext(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    nodes: makeFakeNodeRegistry(),
    constraints: makeFakeConstraints(),
    workflowInputs: { prompt: textTag() },
    ...overrides,
  };
}
