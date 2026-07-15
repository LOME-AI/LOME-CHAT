import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonicalJson, uuidFromHex } from './canonical-json.js';

describe('canonicalJson', () => {
  it('produces identical output for objects whose keys are reordered', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array element order', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('drops object entries whose value is undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('serializes undefined inside arrays as null', () => {
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson(() => 1)).toThrow(/canonicalJson/);
    expect(() => canonicalJson(1n)).toThrow(/canonicalJson/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/canonicalJson/);
  });

  it('rejects cyclic structures', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(() => canonicalJson(cycle)).toThrow(/canonicalJson/);
  });

  it('rejects a Date instead of flattening it to {}', () => {
    expect(() => canonicalJson(new Date('2026-06-12T00:00:00.000Z'))).toThrow(/canonicalJson/);
  });

  it('rejects a class instance instead of flattening it to its own keys', () => {
    class Wrapper {
      constructor(readonly inner = 1) {}
    }
    expect(() => canonicalJson({ value: new Wrapper() })).toThrow(/canonicalJson/);
  });

  it('serializes a null-prototype object as a plain object', () => {
    const bare: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(canonicalJson(bare)).toBe('{"a":1}');
  });
});

describe('hashCanonicalJson', () => {
  it('hashes key-reordered bodies to the same digest', async () => {
    const a = await hashCanonicalJson({ x: 1, y: [{ b: 2, a: 1 }] });
    const b = await hashCanonicalJson({ y: [{ a: 1, b: 2 }], x: 1 });
    expect(a).toBe(b);
  });

  it('hashes different bodies to different digests', async () => {
    const a = await hashCanonicalJson({ x: 1 });
    const b = await hashCanonicalJson({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('returns lowercase hex of SHA-256 length', async () => {
    const digest = await hashCanonicalJson({});
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('uuidFromHex', () => {
  it('formats the first 32 hex chars as a uuid', () => {
    expect(uuidFromHex('0123456789abcdef0123456789abcdef')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef'
    );
  });

  it('ignores hex beyond the 32nd character (a full SHA-256 digest fits)', async () => {
    const digest = await hashCanonicalJson({ scope: 'x' });
    expect(uuidFromHex(digest)).toBe(uuidFromHex(digest.slice(0, 32)));
    expect(uuidFromHex(digest)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
