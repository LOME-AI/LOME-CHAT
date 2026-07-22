import { describe, expect, it } from 'vitest';
import { isUniqueViolation, isUniqueViolationOn } from './unique-violation.js';

const CONSTRAINT = 'some_table_name_unique';

describe('isUniqueViolationOn', () => {
  it('matches a 23505 carrying the exact constraint name', () => {
    expect(isUniqueViolationOn({ code: '23505', constraint: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it('matches via the message when the constraint field is absent (message fallback)', () => {
    const error = Object.assign(
      new Error(`duplicate key value violates unique constraint "${CONSTRAINT}"`),
      {
        code: '23505',
      }
    );

    expect(isUniqueViolationOn(error, CONSTRAINT)).toBe(true);
  });

  it('does not fall back to the message when the constraint field is present but different', () => {
    expect(isUniqueViolationOn({ code: '23505', constraint: 'other_unique' }, CONSTRAINT)).toBe(
      false
    );
  });

  it('does not fall back to the message on a non-Error carrier with no constraint field', () => {
    // A plain object (not an Error) has no `.message` to inspect, so a 23505
    // without a structured constraint cannot match by name.
    expect(isUniqueViolationOn({ code: '23505' }, CONSTRAINT)).toBe(false);
  });

  it('does not match when the message lacks the constraint name', () => {
    const error = Object.assign(
      new Error('duplicate key value violates unique constraint "unrelated"'),
      {
        code: '23505',
      }
    );

    expect(isUniqueViolationOn(error, CONSTRAINT)).toBe(false);
  });

  it('walks the cause chain to a nested 23505', () => {
    const cause = { code: '23505', constraint: CONSTRAINT };

    expect(isUniqueViolationOn(new Error('query failed', { cause }), CONSTRAINT)).toBe(true);
  });

  it('rejects a non-unique-violation code and non-objects', () => {
    expect(isUniqueViolationOn({ code: '23503', constraint: CONSTRAINT }, CONSTRAINT)).toBe(false);
    expect(isUniqueViolationOn('boom', CONSTRAINT)).toBe(false);
    expect(isUniqueViolationOn(null, CONSTRAINT)).toBe(false);
  });

  it('stops walking at the depth cap and never reaches a violation past it', () => {
    // A cause chain longer than MAX_CAUSE_DEPTH (16): the 23505 sits deeper
    // than the cap, so the walk gives up before reaching it.
    let deep: Record<string, unknown> = { code: '23505', constraint: CONSTRAINT };
    for (let index = 0; index < 20; index += 1) {
      deep = { cause: deep };
    }

    expect(isUniqueViolationOn(deep, CONSTRAINT)).toBe(false);
  });

  it('finds a violation that sits exactly within the depth cap', () => {
    // 15 wrapper layers then the violation at depth 16 — inside the cap.
    let chain: Record<string, unknown> = { code: '23505', constraint: CONSTRAINT };
    for (let index = 0; index < 15; index += 1) {
      chain = { cause: chain };
    }

    expect(isUniqueViolationOn(chain, CONSTRAINT)).toBe(true);
  });
});

describe('isUniqueViolation', () => {
  it('is true for any 23505 regardless of constraint', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23505', constraint: 'anything' })).toBe(true);
  });

  it('walks the cause chain to a nested 23505', () => {
    expect(isUniqueViolation(new Error('wrap', { cause: { code: '23505' } }))).toBe(true);
  });

  it('is false when no layer carries a 23505', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it('stops walking at the depth cap', () => {
    let deep: Record<string, unknown> = { code: '23505' };
    for (let index = 0; index < 20; index += 1) {
      deep = { cause: deep };
    }

    expect(isUniqueViolation(deep)).toBe(false);
  });
});
