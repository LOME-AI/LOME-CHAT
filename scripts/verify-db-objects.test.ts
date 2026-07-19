import { describe, it, expect } from 'vitest';

import { formatDbObjects, isDrifted } from './verify-db-objects.js';

describe('formatDbObjects', () => {
  it('places a function definition under a "-- function: <name>" header', () => {
    const output = formatDbObjects(
      [{ name: 'assert_ledger_transaction_balanced', definition: 'CREATE FUNCTION foo() ...' }],
      []
    );

    expect(output).toContain('-- function: assert_ledger_transaction_balanced');
    expect(output).toContain('CREATE FUNCTION foo() ...');
  });

  it('places a trigger definition under a "-- trigger: <table>.<name>" header', () => {
    const output = formatDbObjects(
      [],
      [
        {
          name: 'ledger_entries_zero_sum',
          table_name: 'ledger_entries',
          definition: 'CREATE CONSTRAINT TRIGGER ledger_entries_zero_sum ...',
        },
      ]
    );

    expect(output).toContain('-- trigger: ledger_entries.ledger_entries_zero_sum');
    expect(output).toContain('CREATE CONSTRAINT TRIGGER ledger_entries_zero_sum ...');
  });

  it('strips trailing whitespace from definition lines so the golden stays stable', () => {
    const output = formatDbObjects([{ name: 'f', definition: 'line one   \nline two\t' }], []);

    expect(output).toContain('line one\nline two');
    expect(output).not.toMatch(/line one +\n/);
  });

  it('ends with exactly one trailing newline', () => {
    const output = formatDbObjects([{ name: 'f', definition: 'body' }], []);

    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });
});

describe('isDrifted', () => {
  it('reports no drift when the dump matches the golden exactly', () => {
    expect(isDrifted('same\n', 'same\n')).toBe(false);
  });

  it('reports drift when the dump differs from the golden', () => {
    expect(isDrifted('altered\n', 'original\n')).toBe(true);
  });
});
