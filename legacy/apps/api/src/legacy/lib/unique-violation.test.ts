import { describe, it, expect } from 'vitest';
import { getUniqueViolationConstraint, isUniqueViolation } from './unique-violation.js';

describe('getUniqueViolationConstraint', () => {
  it('returns null for non-Error values', () => {
    expect(getUniqueViolationConstraint(null)).toBeNull();
    expect(getUniqueViolationConstraint('boom')).toBeNull();
    expect(getUniqueViolationConstraint(42)).toBeNull();
    expect(getUniqueViolationConstraint(Symbol('s'))).toBeNull();
  });

  it('returns null for an Error with no cause and a non-matching message', () => {
    expect(getUniqueViolationConstraint(new Error('boom'))).toBeNull();
  });

  it('returns the constraint name when cause has code=23505 and constraint', () => {
    const cause = { code: '23505', constraint: 'users_username_unique' };
    const error = Object.assign(new Error('insert failed'), { cause });
    expect(getUniqueViolationConstraint(error)).toBe('users_username_unique');
  });

  it('walks two levels of cause to find the structured error', () => {
    const inner = { code: '23505', constraint: 'users_email_unique' };
    const middle = { message: 'wrapping', cause: inner };
    const error = Object.assign(new Error('outer'), { cause: middle });
    expect(getUniqueViolationConstraint(error)).toBe('users_email_unique');
  });

  it('returns empty string when the message matches but no structured constraint is present', () => {
    expect(getUniqueViolationConstraint(new Error('duplicate key value'))).toBe('');
  });

  it('returns empty string for a plain message about a unique constraint', () => {
    expect(getUniqueViolationConstraint(new Error('violates unique constraint'))).toBe('');
  });

  it('returns empty string when forks index name is in the message', () => {
    expect(getUniqueViolationConstraint(new Error('conversation_forks_conv_name_idx clash'))).toBe(
      ''
    );
  });

  it('returns empty string when code is 23505 but constraint is missing', () => {
    // Detection succeeded (clearly a unique violation) but the driver
    // didn't surface a constraint name, so callers can't discriminate.
    const error = Object.assign(new Error('insert failed'), { cause: { code: '23505' } });
    expect(getUniqueViolationConstraint(error)).toBe('');
  });

  it('returns null for a non-23505 code', () => {
    const error = Object.assign(new Error('insert failed'), {
      cause: { code: '23503', constraint: 'fk_foo' },
    });
    expect(getUniqueViolationConstraint(error)).toBeNull();
  });

  it('handles a cycle in the cause chain without infinite-looping', () => {
    const a: { code?: string; cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    // Neither object carries a unique-violation signature; helper should
    // walk a few steps and bail. We mainly assert that it returns at all.
    expect(() => getUniqueViolationConstraint(a)).not.toThrow();
  });
});

describe('isUniqueViolation', () => {
  it('returns true when constraint name is present', () => {
    const error = Object.assign(new Error('insert failed'), {
      cause: { code: '23505', constraint: 'users_username_unique' },
    });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('returns true when only the message matches', () => {
    expect(isUniqueViolation(new Error('duplicate key value violates'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isUniqueViolation(new Error('something else'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
