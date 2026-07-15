import { Node } from 'ts-morph';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Exactly one Hono `.onError()` handler exists in the app tree, and it lives
 * in `app.ts` (audit fix F19). Error mapping is owned by the assembly: a
 * defect must answer with the same `{code: INTERNAL}` shape everywhere, so a
 * sub-router installing its own `onError` would fork error handling and drop
 * the telemetry the assembly's handler emits.
 *
 * Matching is deliberately narrow — `onError` appears in three unrelated
 * forms, and only the first is a handler installation:
 *   1. the Hono method call `app.onError((error, c) => …)` — a CallExpression
 *      whose callee is a `.onError` PropertyAccessExpression. COUNTED.
 *   2. the workflow DAG node's error policy `onError: 'skip' | 'fail'` — a
 *      PropertyAssignment. Never a CallExpression callee, so never matched.
 *   3. the AI-SDK streamText option `onError: noopOnError` — likewise a
 *      PropertyAssignment. Never matched.
 * Iterating CallExpressions and testing the callee keeps forms 2 and 3 out by
 * construction (they are object-literal members, not call callees).
 *
 * Test files are exempt — they build throwaway Hono apps with their own
 * `onError` to assert error mapping in isolation. `app.ts` is always in the
 * harness scope (run.ts SOURCE_GLOBS), so the missing-handler check anchors on
 * it; if it is somehow absent, only sub-router installs are reported.
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function isInScope(filePath: string): boolean {
  return filePath.includes('apps/api/src/') && !TEST_FILE.test(filePath);
}

function isAppTs(filePath: string): boolean {
  return filePath.endsWith('apps/api/src/app.ts');
}

/** Every `X.onError(...)` method-call site in a file (form 1 above). */
function onErrorHandlerCalls(sourceFile: SourceFile): CallExpression[] {
  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'onError') {
      calls.push(node);
    }
  });
  return calls;
}

/** A sub-router (any file but app.ts) may not install onError. */
function subRouterViolations(filePath: string, calls: CallExpression[]): ArchViolation[] {
  return calls.map((call) => ({
    file: filePath,
    line: call.getStartLineNumber(),
    message:
      'Sub-routers must not install onError — error mapping is owned by app.ts (audit fix F19).',
  }));
}

/** app.ts must carry exactly one handler: none and more-than-one both fail. */
function appTsViolations(appTsFile: SourceFile, calls: CallExpression[]): ArchViolation[] {
  if (calls.length === 0) {
    return [
      {
        file: appTsFile.getFilePath(),
        line: 1,
        message: 'app.ts must install exactly one onError handler; found none.',
      },
    ];
  }
  return calls.slice(1).map((extra) => ({
    file: appTsFile.getFilePath(),
    line: extra.getStartLineNumber(),
    message: 'app.ts must install exactly one onError handler; found more than one.',
  }));
}

const rule: ArchRule = {
  name: 'onerror-handler-only-in-app',
  check(project) {
    const violations: ArchViolation[] = [];
    let appTsFile: SourceFile | undefined;
    const appTsCalls: CallExpression[] = [];

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      if (!isInScope(filePath)) continue;
      const calls = onErrorHandlerCalls(sourceFile);
      if (isAppTs(filePath)) {
        appTsFile = sourceFile;
        appTsCalls.push(...calls);
      } else {
        violations.push(...subRouterViolations(filePath, calls));
      }
    }

    // app.ts is always in the harness scope; guard only for defensiveness.
    if (appTsFile !== undefined) {
      violations.push(...appTsViolations(appTsFile, appTsCalls));
    }
    return violations;
  },
};

export default rule;
