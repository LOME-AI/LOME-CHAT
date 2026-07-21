import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './e2e-store-isolation.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('e2e-store-isolation', () => {
  it('flags a static import of the e2e store from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/auth-client.ts':
        "import { storeExportKeyProtected } from './device-key-store.e2e.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/auth-client.ts', line: 1 });
    expect(violations[0]?.message).toContain('E2E module variant');
  });

  it('flags a static import of the e2e store via the @/ alias', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts':
        "import { loadExportKeyProtected } from '@/lib/device-key-store.e2e';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/thing.ts');
  });

  it('flags a runtime dynamic import() of the e2e store from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/device-key-store.ts':
        'export async function storeExportKeyProtected(): Promise<void> {\n' +
        '  if (env.isE2E) {\n' +
        "    return (await import('./device-key-store.e2e.js')).storeExportKeyProtected();\n" +
        '  }\n' +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/device-key-store.ts', line: 3 });
  });

  it('flags a dynamic import() of any other *.e2e module from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "const module_ = await import('@/lib/other-helper.e2e');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/thing.ts');
  });

  it('exempts test files that dynamically import the e2e store', () => {
    const project = projectWith({
      'apps/web/src/lib/device-key-store.test.ts':
        "const module_ = await import('./device-key-store.e2e.js');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a dynamic import() of a non-e2e module', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "const module_ = await import('./lazy-panel.js');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a dynamic import() with a non-literal argument', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': 'const module_ = await import(somePath);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a static import of another *.e2e module from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "import { helper } from './other-helper.e2e.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/thing.ts');
  });

  it('does not scan any *.e2e module file itself', () => {
    const project = projectWith({
      'apps/web/src/lib/other-helper.e2e.ts': "import { x } from './sibling-helper.e2e.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files that statically import the e2e store', () => {
    const project = projectWith({
      'apps/web/src/lib/device-key-store.e2e.test.ts':
        "import { storeExportKeyProtected } from './device-key-store.e2e.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag the e2e module importing its own siblings', () => {
    const project = projectWith({
      'apps/web/src/lib/device-key-store.e2e.ts': "import { toBase64 } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag an unrelated import', () => {
    const project = projectWith({
      'apps/web/src/lib/auth-client.ts': "import { env } from '@/lib/env';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the apps/web/src tree', () => {
    const project = projectWith({
      'apps/api/src/lib/thing.ts':
        "import { storeExportKeyProtected } from '../device-key-store.e2e';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a named re-export of the e2e store from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/auth-client.ts':
        "export { storeExportKeyProtected } from './device-key-store.e2e.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/auth-client.ts', line: 1 });
    expect(violations[0]?.message).toContain('E2E module variant');
  });

  it('flags a star re-export of the e2e store from production code', () => {
    const project = projectWith({
      'apps/web/src/lib/barrel.ts': "export * from './device-key-store.e2e.js';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/lib/barrel.ts', line: 1 });
  });

  it('does not flag a bare export with no module specifier', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': 'const localVar = 1;\nexport { localVar };\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a production import of a bare/package specifier', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "import { useState } from 'react';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files that re-export the e2e store', () => {
    const project = projectWith({
      'apps/web/src/lib/reexport.test.ts':
        "export { storeExportKeyProtected } from './device-key-store.e2e.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });
});
