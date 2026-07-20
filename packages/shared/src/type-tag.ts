import { z } from 'zod';
import { MediaValue } from './content-value.js';
import { MODALITIES } from './modality.js';
import type { Modality } from './modality.js';

/**
 * The closed TypeTag algebra typed workflow edges run on.
 * Deliberately minimal: exactly four assignability rules, written as the
 * laws table below. `zodFor(tag)` is the single source of node runtime
 * typing — node schemas are derived from declared ports, never hand-written
 * alongside them. `union<…>` extensions arrive behind the same
 * `isAssignable` signature; callers unchanged, laws table grows.
 */

/** Media tags carry a non-text modality — text is its own primitive. */
export type MediaTagModality = Exclude<Modality, 'text'>;

/** Derived from the single modality source; never a second enum. */
export const MEDIA_TAG_MODALITIES = MODALITIES.filter(
  (modality): modality is MediaTagModality => modality !== 'text'
);

export interface TextTag {
  readonly kind: 'text';
}

export interface MediaTag {
  readonly kind: 'media';
  readonly modality: MediaTagModality;
  readonly mimeTypes: readonly string[];
}

/**
 * `json` is never bare: the schema name references the named-constraint
 * registry and `zodFor` resolves the registered schema. A bare `json` tag
 * would make runtime re-validation decorative (`z.unknown()`) at the most
 * common joint (classifier → branch).
 */
export interface JsonTag {
  readonly kind: 'json';
  readonly schemaName: string;
}

export interface OptionalTag {
  readonly kind: 'optional';
  readonly inner: TypeTag;
}

export interface ListTag {
  readonly kind: 'list';
  readonly inner: TypeTag;
}

export type TypeTag = TextTag | MediaTag | JsonTag | OptionalTag | ListTag;

const MEDIA_TAG_MODALITY_VALUES = MEDIA_TAG_MODALITIES as [MediaTagModality, ...MediaTagModality[]];

/** Runtime schema for the grammar; bare `json` is unparseable. */
export const TypeTagSchema: z.ZodType<TypeTag> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text') }),
    z.object({
      kind: z.literal('media'),
      modality: z.enum(MEDIA_TAG_MODALITY_VALUES),
      mimeTypes: z.array(z.string().min(1)).min(1),
    }),
    z.object({ kind: z.literal('json'), schemaName: z.string().min(1) }),
    z.object({ kind: z.literal('optional'), inner: TypeTagSchema }),
    z.object({ kind: z.literal('list'), inner: TypeTagSchema }),
  ])
);

export function textTag(): TextTag {
  return { kind: 'text' };
}

export function mediaTag(
  modality: MediaTagModality,
  mimeTypes: readonly [string, ...string[]]
): MediaTag {
  return { kind: 'media', modality, mimeTypes };
}

export function jsonTag(schemaName: string): JsonTag {
  if (schemaName.length === 0) {
    throw new Error('Bare json tags are forbidden: a json tag requires a schema name');
  }
  return { kind: 'json', schemaName };
}

export function optionalTag(inner: TypeTag): OptionalTag {
  return { kind: 'optional', inner };
}

export function listTag(inner: TypeTag): ListTag {
  return { kind: 'list', inner };
}

/**
 * The written laws table `isAssignable` implements — exactly these, nothing
 * else. Property tests assert each law over generated tags.
 */
export const TYPE_TAG_LAWS = [
  'L1 (reflexivity): isAssignable(t, t) for every well-formed tag t.',
  'L2 (json exact equality): json<a> → json<b> iff a === b; equality is on the registered schema name, never on the resolved schema.',
  'L3 (media modality): media(m1, P) → media(m2, C) requires m1 === m2.',
  'L4 (media subset): media(m, P) → media(m, C) iff P ⊆ C — producer mimes a subset of the consumer accepted set.',
  'L5 (media-subset transitivity): P ⊆ Q and Q ⊆ R imply media(m, P) → media(m, R).',
  'L6 (optional introduction): T → optional<T> — a present producer satisfies a maybe-absent consumer.',
  'L7 (optional covariance): optional<A> → optional<B> iff A → B.',
  'L8 (optional never erases): optional<T> → T is false — a maybe-absent producer cannot feed a required consumer.',
  'L9 (list covariance): list<A> → list<B> iff A → B; list<T> → T and T → list<T> are false (no implicit wrap/unwrap).',
  'L10 (kind discrimination): tags of different kinds are never assignable, except through L6 optional introduction.',
] as const;

/**
 * Edge-compatibility predicate over the laws table: may `from` (a producer
 * port) feed `to` (a consumer port)? Checked at build() and
 * re-validated at runtime. Format mismatches insert an explicit adapter
 * node — never a silent coercion.
 */
export function isAssignable(from: TypeTag, to: TypeTag): boolean {
  if (to.kind === 'optional') {
    // L6 introduction + L7 covariance: unwrap the consumer; an optional
    // producer is only assignable into an optional consumer (L8).
    const producer = from.kind === 'optional' ? from.inner : from;
    return isAssignable(producer, to.inner);
  }
  if (from.kind === 'optional') return false; // L8
  return isRequiredAssignable(from, to);
}

function isRequiredAssignable(from: Exclude<TypeTag, OptionalTag>, to: TypeTag): boolean {
  switch (from.kind) {
    case 'text': {
      return to.kind === 'text';
    }
    case 'json': {
      return to.kind === 'json' && from.schemaName === to.schemaName; // L2
    }
    case 'media': {
      return to.kind === 'media' && isMediaAssignable(from, to);
    }
    case 'list': {
      return to.kind === 'list' && isAssignable(from.inner, to.inner); // L9
    }
  }
}

function isMediaAssignable(from: MediaTag, to: MediaTag): boolean {
  return (
    from.modality === to.modality && // L3
    from.mimeTypes.every((mime) => to.mimeTypes.includes(mime)) // L4
  );
}

/**
 * Resolution contract for `json<schemaName>` tags: maps registered schema
 * names to Zod schemas. The live registry instance belongs to the workflows
 * node registry; this interface is the seam shared code validates through.
 */
export interface SchemaNameRegistry {
  resolveSchema(name: string): z.ZodType | undefined;
}

/**
 * The single source of node runtime typing: derives the runtime Zod schema
 * for any tag. Hand-writing a node schema alongside its declared ports is an
 * architecture violation (the dual-type-system failure this kills).
 */
export function zodFor(tag: TypeTag, registry: SchemaNameRegistry): z.ZodType {
  switch (tag.kind) {
    case 'text': {
      return z.string();
    }
    case 'json': {
      const schema = registry.resolveSchema(tag.schemaName);
      if (schema === undefined) {
        throw new Error(`No schema registered for json<${tag.schemaName}>`);
      }
      return schema;
    }
    case 'media': {
      return MediaValue.refine(
        (value) => value.modality === tag.modality && tag.mimeTypes.includes(value.mimeType),
        { message: `Expected ${formatTypeTag(tag)}` }
      );
    }
    case 'optional': {
      return zodFor(tag.inner, registry).optional();
    }
    case 'list': {
      return z.array(zodFor(tag.inner, registry));
    }
  }
}

/** A node implementation's declared ports: `ports(config) → {in, out}`. */
export interface NodePortDeclaration {
  readonly in: readonly TypeTag[];
  readonly out: TypeTag;
}

export interface DerivedNodeSchemas {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

/**
 * Derives a node's runtime input/output schemas from its declared ports via
 * `zodFor` — the mechanism the arch gate later enforces repo-wide.
 */
export function deriveNodeSchemas(
  ports: NodePortDeclaration,
  registry: SchemaNameRegistry
): DerivedNodeSchemas {
  const inputSchemas = ports.in.map((tag) => zodFor(tag, registry));
  return {
    input: z.tuple(inputSchemas as []),
    output: zodFor(ports.out, registry),
  };
}

/** Canonical display form, used in diagnostics and law statements. */
export function formatTypeTag(tag: TypeTag): string {
  switch (tag.kind) {
    case 'text': {
      return 'text';
    }
    case 'json': {
      return `json<${tag.schemaName}>`;
    }
    case 'media': {
      return `media<${tag.modality}:${tag.mimeTypes.join('|')}>`;
    }
    case 'optional': {
      return `optional<${formatTypeTag(tag.inner)}>`;
    }
    case 'list': {
      return `list<${formatTypeTag(tag.inner)}>`;
    }
  }
}

/**
 * Node identifier within a definition; `'end'` is the early-exit sentinel.
 * `#` is excluded: runtime charge keys and stream ids suffix the node id as
 * `<nodeId>#<segment>` (fan-out branch index, auxiliary-generation suffix),
 * and settlement resolves a suffixed charge's content anchor by stripping the
 * LAST `#` segment — an id containing `#` would corrupt that resolution.
 */
export const NodeId = z
  .string()
  .min(1)
  .regex(/^[^#]*$/)
  .brand<'NodeId'>();
export type NodeId = z.infer<typeof NodeId>;

/** Reserved early-exit sentinel. */
export const END_NODE_ID = 'end' as NodeId;

/** Output-channel identifier: every node's output is addressable by an Edge. */
export const PortId = z.string().min(1).brand<'PortId'>();
export type PortId = z.infer<typeof PortId>;

/** A reference to one node's port. */
export const PortRef = z.object({ node: NodeId, port: PortId });
export type PortRef = z.infer<typeof PortRef>;

/**
 * A typed channel between two ports. Channel types are not stored on the
 * edge — they come from the node registrations' declared ports, and
 * compatibility is `isAssignable(producer, consumer)`.
 */
export const Edge = z.object({ from: PortRef, to: PortRef });
export type Edge = z.infer<typeof Edge>;
