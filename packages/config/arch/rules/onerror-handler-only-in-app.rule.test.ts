import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './onerror-handler-only-in-app.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const APP_TS = 'apps/api/src/app.ts';

describe('onerror-handler-only-in-app', () => {
  it('passes when app.ts installs exactly one onError handler', () => {
    const project = projectWith({
      [APP_TS]:
        'export const app = base.onError((error, c) => c.json({ code: "INTERNAL" }, 500));\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a sub-router that installs its own onError', () => {
    const project = projectWith({
      [APP_TS]: 'export const app = base.onError((error, c) => c.json({}, 500));\n',
      'apps/api/src/slices/chat/routes.ts':
        'export const sub = router.onError((error, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: '/apps/api/src/slices/chat/routes.ts',
      line: 1,
    });
    expect(violations[0]?.message).toContain('Sub-routers must not install onError');
  });

  it('flags when no onError handler exists in app.ts', () => {
    const project = projectWith({
      [APP_TS]: 'export const app = base.notFound((c) => c.json({}, 404));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${APP_TS}`, line: 1 });
    expect(violations[0]?.message).toContain('found none');
  });

  it('flags when app.ts installs more than one onError handler', () => {
    const project = projectWith({
      [APP_TS]:
        'const a = base.onError((e, c) => c.json({}, 500));\nconst b = other.onError((e, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${APP_TS}`, line: 2 });
    expect(violations[0]?.message).toContain('found more than one');
  });

  it('does not trip on object-literal onError properties (workflow policy / streamText option)', () => {
    const project = projectWith({
      [APP_TS]: 'export const app = base.onError((error, c) => c.json({}, 500));\n',
      'apps/api/src/slices/workflows/builder/ports.ts':
        'export const node = { type: "modelCall", onError: "skip" };\n' +
        'export const agent = { onError: "fail" as const };\n',
      'apps/api/src/slices/models/adapters/language-adapter.ts':
        'const noopOnError = () => {};\n' +
        'export const opts = { onError: noopOnError };\n' +
        'export const branch = node.onError === "skip";\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files that build throwaway apps with their own onError', () => {
    const project = projectWith({
      [APP_TS]: 'export const app = base.onError((error, c) => c.json({}, 500));\n',
      'apps/api/src/middleware/pipeline-session.test.ts':
        'const app = build().onError((err, c) => c.json({ message: err.message }, 500));\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports only sub-router installs and no missing-handler when app.ts is not in scope', () => {
    const project = projectWith({
      'apps/api/src/slices/chat/routes.ts':
        'export const sub = router.onError((error, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('Sub-routers must not install onError');
  });

  it('ignores onError usage outside the apps/api/src tree', () => {
    const project = projectWith({
      [APP_TS]: 'export const app = base.onError((error, c) => c.json({}, 500));\n',
      'packages/shared/src/thing.ts': 'export const x = emitter.onError(() => {});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });
});
