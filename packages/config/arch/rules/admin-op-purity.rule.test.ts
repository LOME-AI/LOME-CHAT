import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './admin-op-purity.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const OP_PATH = 'apps/api/src/slices/admin/domain/operations/wallet-credit.ts';

describe('admin-op-purity', () => {
  it('flags an infra value import in an op body', () => {
    const project = projectWith({
      [OP_PATH]: `import { eq } from 'drizzle-orm';\nexport const x = eq;\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/infra library 'drizzle-orm'/);
  });

  it('flags a @hushbox/db value import in an op body', () => {
    const project = projectWith({
      [OP_PATH]: `import { wallets } from '@hushbox/db';\nexport const x = wallets;\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('allows type-only imports in an op body', () => {
    const project = projectWith({
      [OP_PATH]: `import type { Database } from '@hushbox/db';\nexport type Db = Database;\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an adapter import in an op body', () => {
    const project = projectWith({
      [OP_PATH]: `import { createAdminStores } from '../../adapters/stores.js';\nexport const s = createAdminStores;\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/adapter module/);
  });

  it("flags a reach into another slice's internals from an op body", () => {
    const project = projectWith({
      [OP_PATH]: `import { chargeWithinTx } from '../../../billing/domain/charge.js';\nexport const c = chargeWithinTx;\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/another slice's internals/);
  });

  it("allows another slice's barrel import in an op body", () => {
    const project = projectWith({
      [OP_PATH]: `import { chargeWithinTx } from '../../../billing/index.js';\nexport const c = chargeWithinTx;\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags fetch calls in an op body (bare and global-rooted)', () => {
    const project = projectWith({
      [OP_PATH]: `export async function run(): Promise<void> {\n  await fetch('https://x');\n  await globalThis.fetch('https://x');\n}\n`,
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('flags an op import from outside the admin domain', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/domain/sneaky.ts': `import { walletCredit } from '../../admin/domain/operations/wallet-credit.js';\nexport const w = walletCredit;\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/only by the admin registry wiring/);
  });

  it('allows the admin registry and op tests to import op modules', () => {
    const project = projectWith({
      'apps/api/src/slices/admin/domain/registry-wiring.ts': `import { walletCredit } from './operations/wallet-credit.js';\nexport const w = walletCredit;\n`,
      'apps/api/src/slices/admin/domain/operations/wallet-credit.test.ts': `import { walletCredit } from './wallet-credit.js';\nexport const w = walletCredit;\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores unrelated files entirely', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/domain/charge.ts': `import { eq } from 'drizzle-orm';\nexport const x = eq;\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });
});
