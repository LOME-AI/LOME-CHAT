import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_OP_NAMES } from '@hushbox/shared';
import { collectAdminOpBatteryCoverage } from './battery-coverage.js';

/**
 * The Reversibility Iron Law is enforced by *construction* (the registry rejects
 * a durable mutation without a registered inverse), but inverse *coverage* — that
 * every registered op actually ships the `describeAdminOp` battery — was only
 * conventional: a new op could ship with zero reversibility tests and green CI.
 *
 * `collectAdminOpBatteryCoverage` derives, from the operation test sources
 * themselves, the set of ops that invoke the battery. The aggregate test below
 * asserts that set equals `ADMIN_OP_NAMES`, so an op without a battery fails CI.
 * Source-scanning (not a runtime module set) is deliberate: Vitest isolates each
 * test file in its own module registry, so a set mutated by `describeAdminOp` in
 * one file is invisible to an aggregate test in another; the only way to observe
 * every battery invocation without re-running the entire admin DB suite is to
 * read the call sites.
 */

const OPERATIONS_DIR = fileURLToPath(new URL('.', import.meta.url));

function operationTestSources(): readonly string[] {
  return readdirSync(OPERATIONS_DIR)
    .filter((file) => file.endsWith('.integration.test.ts'))
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));
}

describe('collectAdminOpBatteryCoverage', () => {
  it('records an op whose battery references a named contract constant', () => {
    const source = [
      "const CREDIT_CONTRACT = ADMIN_OP_CONTRACTS['wallet.credit'];",
      'describeAdminOp({',
      '  contract: CREDIT_CONTRACT,',
      '  validInput: () => ({}),',
      '});',
    ].join('\n');

    expect(collectAdminOpBatteryCoverage([source])).toEqual(new Set(['wallet.credit']));
  });

  it('records an op whose battery references the contract inline', () => {
    const source = [
      'describeAdminOp({',
      "  contract: ADMIN_OP_CONTRACTS['banner.set'],",
      '  validInput: () => ({}),',
      '});',
    ].join('\n');

    expect(collectAdminOpBatteryCoverage([source])).toEqual(new Set(['banner.set']));
  });

  it('records every battery invocation in a multi-op source', () => {
    const source = [
      "const LOCK_CONTRACT = ADMIN_OP_CONTRACTS['user.lock'];",
      "const UNLOCK_CONTRACT = ADMIN_OP_CONTRACTS['user.unlock'];",
      'describeAdminOp({ contract: LOCK_CONTRACT });',
      'describeAdminOp({ contract: UNLOCK_CONTRACT });',
    ].join('\n');

    expect(collectAdminOpBatteryCoverage([source])).toEqual(new Set(['user.lock', 'user.unlock']));
  });

  it('omits an op that is referenced but never given a battery', () => {
    const source = [
      "const CREDIT_CONTRACT = ADMIN_OP_CONTRACTS['wallet.credit'];",
      "const CLAWBACK_CONTRACT = ADMIN_OP_CONTRACTS['wallet.clawback'];",
      'describeAdminOp({ contract: CREDIT_CONTRACT });',
    ].join('\n');

    expect(collectAdminOpBatteryCoverage([source])).toEqual(new Set(['wallet.credit']));
  });

  it('ignores a battery invocation whose contract cannot be resolved', () => {
    const source = 'describeAdminOp({ validInput: () => ({}) });';

    expect(collectAdminOpBatteryCoverage([source])).toEqual(new Set());
  });

  it('ignores a battery whose contract identifier has no binding', () => {
    const source = 'describeAdminOp({ contract: UNBOUND_CONTRACT });';

    expect(collectAdminOpBatteryCoverage([source])).toEqual(new Set());
  });
});

describe('admin op reversibility battery coverage', () => {
  it('covers every registered admin op with a describeAdminOp battery', () => {
    const covered = collectAdminOpBatteryCoverage(operationTestSources());
    const byName = (a: string, b: string): number => a.localeCompare(b);

    expect([...covered].toSorted(byName)).toEqual([...ADMIN_OP_NAMES].toSorted(byName));
  });
});
