import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './demo-isolation.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('demo-isolation', () => {
  it('flags a static import of a demo internal from production code', () => {
    const project = projectWith({
      'apps/web/src/router.tsx': "import { seedSession } from './demo/seed-session';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/apps/web/src/router.tsx', line: 1 });
    expect(violations[0]?.message).toContain('demo');
  });

  it('flags a static import of the demo bundle via the @/ alias', () => {
    const project = projectWith({
      'apps/web/src/lib/thing.ts': "import { mountDemo } from '@/demo/bootstrap';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/thing.ts');
  });

  it('flags a static import reaching demo internals through a parent path', () => {
    const project = projectWith({
      'apps/web/src/components/x.tsx':
        "import { fetchShim } from '../demo/mock-backend/fetch-shim';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes main.tsx dynamic import of the demo bundle', () => {
    const project = projectWith({
      'apps/web/src/main.tsx':
        "import { isDemoPath } from './lib/is-demo-path';\n" +
        'if (isDemoPath(location.pathname)) {\n' +
        "  const demo = await import('./demo/bootstrap');\n" +
        '  demo.mountDemo();\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes demo-internal imports (a demo file importing another demo file)', () => {
    const project = projectWith({
      'apps/web/src/demo/bootstrap.tsx':
        "import { seedSession } from './seed-session';\n" +
        "import { installFetchShim } from './mock-backend/fetch-shim';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag the is-demo-path helper import (not the demo directory)', () => {
    const project = projectWith({
      'apps/web/src/components/banner/announcement-banner.tsx':
        "import { isDemoPath } from '@/lib/is-demo-path';\n",
      'apps/web/src/main.tsx': "import { isDemoPath } from './lib/is-demo-path';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files that import demo internals directly', () => {
    const project = projectWith({
      'apps/web/src/demo/seed-session.test.ts': "import { seedSession } from './seed-session';\n",
      'apps/web/src/lib/is-demo-path.test.ts':
        "import { seedSession } from '../demo/seed-session';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the apps/web/src tree', () => {
    const project = projectWith({
      'apps/api/src/lib/thing.ts': "import { x } from '../demo/seed-session';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });
});
