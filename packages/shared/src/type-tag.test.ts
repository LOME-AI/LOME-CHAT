import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  deriveNodeSchemas,
  Edge,
  END_NODE_ID,
  formatTypeTag,
  isAssignable,
  jsonTag,
  listTag,
  MEDIA_TAG_MODALITIES,
  mediaTag,
  NodeId,
  optionalTag,
  PortId,
  PortRef,
  textTag,
  TYPE_TAG_LAWS,
  TypeTagSchema,
  zodFor,
} from './type-tag.js';
import { intBetween, mulberry32, pick } from './__tests__/seeded-prng.js';
import type { SchemaNameRegistry, TypeTag } from './type-tag.js';
import type { MediaTagModality } from './type-tag.js';
import type { Rng } from './__tests__/seeded-prng.js';

const MIME_POOL = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg'] as const;

function randomMimes(rng: Rng, pool: readonly string[] = MIME_POOL): [string, ...string[]] {
  const count = intBetween(rng, 1, pool.length);
  const shuffled = pool.toSorted(() => rng() - 0.5);
  return shuffled.slice(0, count) as [string, ...string[]];
}

function randomTag(rng: Rng, depth: number): TypeTag {
  const kinds =
    depth > 0
      ? (['text', 'media', 'json', 'optional', 'list'] as const)
      : (['text', 'media', 'json'] as const);
  const kind = pick(rng, kinds);
  switch (kind) {
    case 'text': {
      return textTag();
    }
    case 'media': {
      return mediaTag(pick(rng, MEDIA_TAG_MODALITIES), randomMimes(rng));
    }
    case 'json': {
      return jsonTag(pick(rng, ['answer', 'route', 'summary']));
    }
    case 'optional': {
      return optionalTag(randomTag(rng, depth - 1));
    }
    case 'list': {
      return listTag(randomTag(rng, depth - 1));
    }
  }
}

describe('TypeTag grammar', () => {
  it('parses every constructor output', () => {
    const tags = [
      textTag(),
      mediaTag('image', ['image/png']),
      jsonTag('route'),
      optionalTag(textTag()),
      listTag(mediaTag('video', ['video/mp4'])),
    ];
    for (const tag of tags) {
      expect(TypeTagSchema.parse(tag)).toEqual(tag);
    }
  });

  it('rejects bare json at parse (schemaName missing)', () => {
    expect(TypeTagSchema.safeParse({ kind: 'json' }).success).toBe(false);
  });

  it('rejects an empty schemaName', () => {
    expect(TypeTagSchema.safeParse({ kind: 'json', schemaName: '' }).success).toBe(false);
  });

  it('rejects bare json at the constructor', () => {
    expect(() => jsonTag('')).toThrow();
  });

  it('rejects a media tag with text modality', () => {
    expect(
      TypeTagSchema.safeParse({ kind: 'media', modality: 'text', mimeTypes: ['text/plain'] })
        .success
    ).toBe(false);
  });

  it('rejects a media tag with an empty mime set', () => {
    expect(
      TypeTagSchema.safeParse({ kind: 'media', modality: 'image', mimeTypes: [] }).success
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(TypeTagSchema.safeParse({ kind: 'union', members: [] }).success).toBe(false);
  });

  it('derives media tag modalities from the single modality source', () => {
    expect(MEDIA_TAG_MODALITIES).toEqual(['image', 'audio', 'video', 'embedding']);
  });
});

describe('TYPE_TAG_LAWS', () => {
  it('is the written ten-line laws table', () => {
    expect(TYPE_TAG_LAWS).toHaveLength(10);
    for (const law of TYPE_TAG_LAWS) {
      expect(typeof law).toBe('string');
      expect(law.length).toBeGreaterThan(0);
    }
  });
});

describe('isAssignable — property tests against the written laws (seeded)', () => {
  it('L1 reflexivity: every generated tag is assignable to itself', () => {
    const rng = mulberry32(101);
    for (let index = 0; index < 300; index += 1) {
      const tag = randomTag(rng, 3);
      expect(isAssignable(tag, tag)).toBe(true);
    }
  });

  it('L2 json exact equality on the schema name', () => {
    expect(isAssignable(jsonTag('a'), jsonTag('a'))).toBe(true);
    expect(isAssignable(jsonTag('a'), jsonTag('b'))).toBe(false);
  });

  it('L3 media modality must match', () => {
    const rng = mulberry32(103);
    for (let index = 0; index < 100; index += 1) {
      const mimes = randomMimes(rng);
      const [first, second] = [pick(rng, MEDIA_TAG_MODALITIES), pick(rng, MEDIA_TAG_MODALITIES)];
      const result = isAssignable(mediaTag(first, mimes), mediaTag(second, mimes));
      expect(result).toBe(first === second);
    }
  });

  it('L4 media subset: producer mimes ⊆ consumer mimes', () => {
    const rng = mulberry32(104);
    for (let index = 0; index < 200; index += 1) {
      const modality: MediaTagModality = pick(rng, MEDIA_TAG_MODALITIES);
      const consumer = randomMimes(rng);
      const producer = randomMimes(rng, consumer);
      expect(isAssignable(mediaTag(modality, producer), mediaTag(modality, consumer))).toBe(true);
      const outside = MIME_POOL.find((mime) => !consumer.includes(mime));
      if (outside !== undefined) {
        expect(
          isAssignable(mediaTag(modality, [...producer, outside]), mediaTag(modality, consumer))
        ).toBe(false);
      }
    }
  });

  it('L5 media-subset transitivity: P ⊆ Q ⊆ R composes', () => {
    const rng = mulberry32(105);
    for (let index = 0; index < 200; index += 1) {
      const modality: MediaTagModality = pick(rng, MEDIA_TAG_MODALITIES);
      const r = randomMimes(rng);
      const q = randomMimes(rng, r);
      const p = randomMimes(rng, q);
      expect(isAssignable(mediaTag(modality, p), mediaTag(modality, q))).toBe(true);
      expect(isAssignable(mediaTag(modality, q), mediaTag(modality, r))).toBe(true);
      expect(isAssignable(mediaTag(modality, p), mediaTag(modality, r))).toBe(true);
    }
  });

  it('L6 optional introduction: T → optional<T>', () => {
    const rng = mulberry32(106);
    for (let index = 0; index < 300; index += 1) {
      const tag = randomTag(rng, 3);
      expect(isAssignable(tag, optionalTag(tag))).toBe(true);
    }
  });

  it('L7 optional covariance: optional<A> → optional<B> iff A → B', () => {
    const rng = mulberry32(107);
    for (let index = 0; index < 300; index += 1) {
      const a = randomTag(rng, 2);
      const b = randomTag(rng, 2);
      expect(isAssignable(optionalTag(a), optionalTag(b))).toBe(isAssignable(a, b));
    }
  });

  it('L8 optional never erases: optional<T> → T is false', () => {
    const rng = mulberry32(108);
    for (let index = 0; index < 300; index += 1) {
      const tag = randomTag(rng, 2);
      if (tag.kind !== 'optional') {
        expect(isAssignable(optionalTag(tag), tag)).toBe(false);
      }
    }
  });

  it('L9 list covariance: list<A> → list<B> iff A → B; no wrap/unwrap coercion', () => {
    const rng = mulberry32(109);
    for (let index = 0; index < 300; index += 1) {
      const a = randomTag(rng, 2);
      const b = randomTag(rng, 2);
      expect(isAssignable(listTag(a), listTag(b))).toBe(isAssignable(a, b));
      expect(isAssignable(listTag(a), a)).toBe(false);
      expect(isAssignable(a, listTag(a))).toBe(false);
    }
  });

  it('L10 kind discrimination: distinct non-optional kinds are never assignable', () => {
    const rng = mulberry32(110);
    for (let index = 0; index < 300; index += 1) {
      const from = randomTag(rng, 2);
      const to = randomTag(rng, 2);
      if (from.kind !== to.kind && from.kind !== 'optional' && to.kind !== 'optional') {
        expect(isAssignable(from, to)).toBe(false);
      }
    }
  });
});

const registry: SchemaNameRegistry = {
  resolveSchema(name: string): z.ZodType | undefined {
    if (name === 'route') return z.object({ model: z.string() });
    return undefined;
  },
};

describe('zodFor', () => {
  it('text tag validates strings', () => {
    const schema = zodFor(textTag(), registry);
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it('json tag resolves the registered schema by name', () => {
    const schema = zodFor(jsonTag('route'), registry);
    expect(schema.safeParse({ model: 'gpt' }).success).toBe(true);
    expect(schema.safeParse({ model: 7 }).success).toBe(false);
  });

  it('json tag with an unregistered name fails fast', () => {
    expect(() => zodFor(jsonTag('missing'), registry)).toThrow(/missing/);
  });

  it('media tag validates MediaValue shape including mimeType membership', () => {
    const schema = zodFor(mediaTag('image', ['image/png', 'image/jpeg']), registry);
    const value = {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 10,
      metadata: {},
    };
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, mimeType: 'image/webp' }).success).toBe(false);
    expect(schema.safeParse({ ...value, modality: 'video' }).success).toBe(false);
  });

  it('optional tag accepts the absent value', () => {
    const schema = zodFor(optionalTag(textTag()), registry);
    let absent: unknown;
    expect(schema.safeParse(absent).success).toBe(true);
    expect(schema.safeParse('present').success).toBe(true);
    expect(schema.safeParse(3).success).toBe(false);
  });

  it('list tag validates element-wise', () => {
    const schema = zodFor(listTag(textTag()), registry);
    expect(schema.safeParse(['a', 'b']).success).toBe(true);
    expect(schema.safeParse('a').success).toBe(false);
    expect(schema.safeParse([1]).success).toBe(false);
  });
});

describe('deriveNodeSchemas', () => {
  it('derives the input tuple and output schema from declared ports', () => {
    const { input, output } = deriveNodeSchemas(
      { in: [mediaTag('image', ['image/png']), textTag()], out: jsonTag('route') },
      registry
    );
    const media = {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 1,
      metadata: {},
    };
    expect(input.safeParse([media, 'prompt']).success).toBe(true);
    expect(input.safeParse(['prompt']).success).toBe(false);
    expect(output.safeParse({ model: 'gpt' }).success).toBe(true);
  });

  it('derives an empty input tuple for source nodes', () => {
    const { input } = deriveNodeSchemas({ in: [], out: textTag() }, registry);
    expect(input.safeParse([]).success).toBe(true);
    expect(input.safeParse(['extra']).success).toBe(false);
  });

  it('derives runtime schemas for representative ports of every v1 node type', () => {
    // One declared-port shape per node type; runtime schemas come only from
    // zodFor — the mechanism the arch gate later enforces repo-wide.
    const image = mediaTag('image', ['image/png']);
    const portsByNodeType = {
      modelCall: { in: [textTag()], out: textTag() },
      transform: { in: [image], out: mediaTag('image', ['image/png', 'image/webp']) },
      fanOut: { in: [listTag(textTag())], out: textTag() },
      fanIn: { in: [listTag(image), textTag()], out: jsonTag('route') },
      branch: { in: [jsonTag('route')], out: jsonTag('route') },
      loop: { in: [jsonTag('route')], out: jsonTag('route') },
      subWorkflow: { in: [textTag()], out: textTag() },
    } as const;
    for (const ports of Object.values(portsByNodeType)) {
      const { input, output } = deriveNodeSchemas(ports, registry);
      expect(input.safeParse(Array.from({ length: ports.in.length + 1 })).success).toBe(false);
      expect(output).toBeDefined();
    }
    const fanIn = deriveNodeSchemas(portsByNodeType.fanIn, registry);
    const media = {
      ref: 'media/c/m/u',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 1,
      metadata: {},
    };
    expect(fanIn.input.safeParse([[media, media], 'combine these']).success).toBe(true);
    expect(fanIn.output.safeParse({ model: 'gpt' }).success).toBe(true);
  });
});

describe('formatTypeTag', () => {
  it('formats each grammar production canonically', () => {
    expect(formatTypeTag(textTag())).toBe('text');
    expect(formatTypeTag(jsonTag('route'))).toBe('json<route>');
    expect(formatTypeTag(mediaTag('image', ['image/png', 'image/jpeg']))).toBe(
      'media<image:image/png|image/jpeg>'
    );
    expect(formatTypeTag(optionalTag(listTag(textTag())))).toBe('optional<list<text>>');
  });
});

describe('PortId / NodeId / PortRef / Edge', () => {
  it('parses a port reference', () => {
    expect(PortRef.parse({ node: 'n1', port: 'out' })).toEqual({ node: 'n1', port: 'out' });
  });

  it('parses an edge of two port references', () => {
    const edge = { from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } };
    expect(Edge.parse(edge)).toEqual(edge);
  });

  it('rejects empty identifiers', () => {
    expect(NodeId.safeParse('').success).toBe(false);
    expect(PortId.safeParse('').success).toBe(false);
  });

  it("reserves 'end' as the early-exit sentinel", () => {
    expect(END_NODE_ID).toBe('end');
    expect(NodeId.parse('end')).toBe(END_NODE_ID);
  });
});
