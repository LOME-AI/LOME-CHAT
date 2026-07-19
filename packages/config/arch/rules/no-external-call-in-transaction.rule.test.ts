import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './no-external-call-in-transaction.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const STORES_PATH = 'apps/api/src/slices/billing/adapters/stores.ts';

describe('no-external-call-in-transaction', () => {
  it('accepts a transaction whose body only touches the db', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await tx.insert(ledger).values(legs);
        return tx.update(wallets).set({ balance }).where(cond);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a bare fetch inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await tx.insert(payments).values(row);
        await fetch('https://provider.example/charge', { method: 'POST' });
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: STORES_PATH });
    expect(violations[0]?.message).toMatch(/fetch/);
  });

  it('flags a globalThis.fetch inside a transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await globalThis.fetch('https://provider.example/charge');
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a fetch nested deeper inside the transaction callback', () => {
    const project = projectWith(
      STORES_PATH,
      `db.transaction(async (tx) => {
        await Promise.all(rows.map((row) => fetch(row.url)));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a fetch that lives outside any transaction (pattern D keeps the external call out)', () => {
    const project = projectWith(
      STORES_PATH,
      `async function preClaimThenCharge() {
        await db.transaction(async (tx) => tx.insert(payments).values(row));
        const external = await fetch('https://provider.example/charge');
        await db.transaction(async (tx) => tx.update(payments).set({ external }).where(cond));
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/adapters/stores.test.ts',
      `db.transaction(async (tx) => {
        await fetch('https://provider.example/charge');
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'packages/shared/src/notes.ts',
      `db.transaction(async (tx) => {
        await fetch('https://provider.example/charge');
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});
