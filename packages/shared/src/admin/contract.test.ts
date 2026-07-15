import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { defineAdminOpContract } from './contract';

const reason = z.string().trim().min(1);

describe('defineAdminOpContract', () => {
  it('returns the contract unchanged when all invariants hold', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ targetId: z.uuid(), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.name).toBe('thing.do');
    expect(contract.inverse).toBe('thing.undo');
  });

  it('rejects a durable mutation without an inverse', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: null,
        effectClass: 'durable',
      })
    ).toThrow(/durable/);
  });

  it('rejects an ephemeral mutation that names an inverse', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason }),
        inverse: 'thing.undo',
        effectClass: 'ephemeral',
      })
    ).toThrow(/ephemeral/);
  });

  it('rejects a mutation whose input lacks reason', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid() }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/reason/);
  });

  it('rejects a mutation whose reason accepts the empty string', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason: z.string() }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/reason/);
  });

  it('rejects a nested (non-flat) input object', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.object({ inner: z.string() }), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden behind a default', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).default({ inner: 'x' }),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('accepts a flat field carrying a default', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.string().default('safe'), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.input.parse({ reason: 'r' }).mode).toBe('safe');
  });

  it('rejects a nested object hidden behind optional', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.object({ inner: z.string() }).optional(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden inside a union', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.union([z.object({ inner: z.string() }), z.string()]),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('accepts a union of scalar options', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.union([z.string(), z.number()]), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a record field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.record(z.string(), z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a tuple field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.tuple([z.string(), z.number()]), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden inside a pipe', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).pipe(z.object({ inner: z.string() })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('accepts a scalar transform pipe field (the NanoUSD shape)', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ amount: z.string().transform(BigInt), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.input.parse({ amount: '5', reason: 'r' }).amount).toBe(5n);
  });

  it('rejects a nested object hidden behind z.lazy', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.lazy(() => z.object({ inner: z.string() })), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects even a scalar z.lazy — lazy schemas cannot be statically inspected', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ mode: z.lazy(() => z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object inside an intersection', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.intersection(z.object({ inner: z.string() }), z.object({ other: z.string() })),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('accepts an intersection of scalar schemas', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.intersection(z.string(), z.string().min(1)), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a nested object hidden behind readonly', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.object({ inner: z.string() }).readonly(), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('accepts a flat readonly scalar', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      input: z.object({ mode: z.string().readonly(), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.input.parse({ mode: 'x', reason: 'r' }).mode).toBe('x');
  });

  it('rejects a nested object hidden behind catch', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          // eslint-disable-next-line promise/prefer-await-to-then -- zod's schema .catch(), not a Promise
          nested: z.object({ inner: z.string() }).catch({ inner: 'x' }),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('accepts a flat scalar with catch', () => {
    const contract = defineAdminOpContract({
      name: 'thing.do',
      title: 'Do thing',
      kind: 'mutation',
      // eslint-disable-next-line promise/prefer-await-to-then -- zod's schema .catch(), not a Promise
      input: z.object({ mode: z.string().catch('safe'), reason }),
      inverse: 'thing.undo',
      effectClass: 'durable',
    });
    expect(contract.input.parse({ mode: 1 as unknown as string, reason: 'r' }).mode).toBe('safe');
  });

  it('rejects a nested object hidden behind nonoptional', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).optional().nonoptional(),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a nested object hidden behind prefault', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({
          nested: z.object({ inner: z.string() }).prefault({ inner: 'x' }),
          reason,
        }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a map field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.map(z.string(), z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a set field', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ nested: z.set(z.string()), reason }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/flat/);
  });

  it('rejects a mutation whose reason accepts a whitespace-only string', () => {
    expect(() =>
      defineAdminOpContract({
        name: 'thing.do',
        title: 'Do thing',
        kind: 'mutation',
        input: z.object({ targetId: z.uuid(), reason: z.string().min(1) }),
        inverse: 'thing.undo',
        effectClass: 'durable',
      })
    ).toThrow(/reason/);
  });
});
