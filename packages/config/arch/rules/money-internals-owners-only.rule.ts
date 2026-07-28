import { Node, SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The money layer's internals are hidden from CONSUMERS of prices, not from
 * every package. `docs/BILLING.md` §Where the Code Lives keeps the pricing
 * machinery — rates, manifests, reducers, tier ratios, the reasoning-budget
 * ladder, per-candidate ceiling solvers and clamping — off both barrels, so a
 * surface that renders or decides on a price cannot reach it. Code that
 * PRODUCES prices is on the other side of that boundary: the server's estimator
 * is money-layer code that lives in `apps/api` because it runs on the Worker,
 * and the shared module cannot express what it needs — a compiled workflow
 * definition's fan-out/step/iteration multipliers arrive as opaque integers
 * (§Where the DAG lives), and settlement prices OBSERVED usage, a question the
 * producer surface does not answer at all.
 *
 * The export map alone cannot draw that line: it sees packages, and both the
 * estimator and the picker sit outside `packages/shared`. This rule draws it by
 * path instead. Every allowed file is named, so the owner set grows only by a
 * visible edit to this list.
 *
 * Scope is `apps/api`. `apps/web` is deliberately out: web code owes a stricter
 * obligation than this rule expresses (`docs/BILLING.md` §What is enforced — no
 * web code outside one named adapter hook may touch a pricing symbol at all),
 * nothing enforces it yet, and reaches there are still open, so extending this
 * rule over web would assert a boundary that is neither this rule's nor
 * currently true. The money module's own files reach their neighbours by
 * relative path, which is never a package specifier and so never matches.
 *
 * Only a specifier DEEPER than the barrel is walled: `@hushbox/shared` and
 * `@hushbox/shared/affordability` are the two sanctioned doors and are always
 * legal.
 */

const WALLED_PREFIX = '@hushbox/shared/affordability/';
const API_ROOT = 'apps/api/';

/**
 * Files that PRODUCE prices, plans and holds. Each reaches module internals
 * because the published surface answers a different question, and each is
 * money-layer code by role rather than by location. Colocated and satellite
 * tests are named too: a test that drives an owner's arithmetic to a pinned
 * amount is exercising the owner's own vocabulary, and deriving test paths
 * from source paths would silently admit any file that adopted the naming.
 */
const PRICE_OWNERS: readonly string[] = [
  // The server adapter over the shared estimator core: one call's billable
  // cost, media's deterministic price, observed usage at settlement, and the
  // declared run ceiling.
  'apps/api/src/slices/models/domain/estimate.ts',
  // Walks a compiled workflow definition into the admission hold.
  'apps/api/src/slices/models/domain/estimate-run.ts',
  'apps/api/src/slices/models/domain/estimate-run.test.ts',
  // The Smart Model candidate pool: per-candidate ceilings and the classifier
  // reserve's line items.
  'apps/api/src/slices/models/domain/smart-model-candidates.ts',
  'apps/api/src/slices/models/domain/smart-model-candidates.test.ts',
  // The trial gate's own price: the billable cost of one trial message.
  'apps/api/src/slices/models/domain/trial-eligibility.ts',
  'apps/api/src/slices/models/domain/trial-eligibility.test.ts',
  // Solves the turn's shared token count and stamps each sibling's cap — the
  // server-side clamp order, deliberately distinct from the module's.
  'apps/api/src/slices/chat/domain/turn-definition.ts',
  'apps/api/src/slices/chat/domain/turn-definition.test.ts',
  // Satellite tests of the two above: the ceiling property and the classifier
  // reserve basis.
  'apps/api/src/slices/chat/domain/turn-ceiling.property.test.ts',
  'apps/api/src/slices/chat/domain/turn-classifier.test.ts',
  // Resolves the turn's effort per model into the wire config and budget.
  'apps/api/src/slices/chat/domain/turn-reasoning.ts',
  'apps/api/src/slices/chat/domain/turn-reasoning.test.ts',
  // Prices the Smart Model slot's candidates and effort options.
  'apps/api/src/slices/chat/domain/smart-model-turn.ts',
  'apps/api/src/slices/chat/domain/smart-model-turn.test.ts',
];

/**
 * CONSUMER reaches that are not closed yet. Every entry is a defect with a
 * known fix, held here only so the gate is green while the fixes land in the
 * tasks that own the files. **This list must reach empty**; an entry that
 * cannot be removed belongs in `PRICE_OWNERS` with a stated reason, never here
 * indefinitely. Adding to it is not a way to pass the gate.
 *
 * Exported so the colocated test can ratchet its length. Without that, nothing
 * makes the list shrink and an allowlist becomes furniture: it may shrink
 * freely, and growing it means editing a number in the test and saying why.
 */
export const PENDING_CONSUMER_CLOSURES: readonly string[] = [
  // Resolve a classifier answer against the presented set, and turn the
  // decision into provider parameters. The barrel already publishes both
  // producers — `chooseFrom` and `wireFor` — so these are import rewrites in
  // files this task does not own.
  'apps/api/src/slices/workflows/nodes/turn-decision.ts',
  'apps/api/src/slices/workflows/nodes/turn-decision.test.ts',
  'apps/api/src/slices/workflows/nodes/model-call-execution.ts',
  'apps/api/src/slices/workflows/nodes/smart-model-execution.ts',
  'apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts',
  'apps/api/src/slices/workflows/engine/workflow-capabilities.test.ts',
  'apps/api/src/slices/workflows/engine/live-run.test.ts',
  // Reads the reasoning-budget ladder as a test fixture.
  'apps/api/src/slices/chat/routes.integration.test.ts',
];

const ALLOWED = [...PRICE_OWNERS, ...PENDING_CONSUMER_CLOSURES];

/** Suffix match, not substring: `.../estimate.ts` must not admit `.../my-estimate.ts`. */
function isAllowed(filePath: string): boolean {
  return ALLOWED.some((allowed) => filePath.endsWith(`/${allowed}`) || filePath === `/${allowed}`);
}

function isWalled(specifier: string): boolean {
  return specifier.startsWith(WALLED_PREFIX);
}

/**
 * Every syntactic route to a module specifier: static imports, RE-EXPORTS, and
 * the string-literal call forms. Re-exports matter as much as imports here —
 * an aliased `export { X as Y } from '<walled>'` republishes an internal under
 * a name no grep for the original finds, which is how five such sites survived
 * two inventories of this wall.
 */
function walledSpecifiers(sourceFile: SourceFile): { specifier: string; line: number }[] {
  const found: { specifier: string; line: number }[] = [];

  for (const declaration of [
    ...sourceFile.getImportDeclarations(),
    ...sourceFile.getExportDeclarations(),
  ]) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier !== undefined && isWalled(specifier)) {
      found.push({ specifier, line: declaration.getStartLineNumber() });
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const [firstArgument] = call.getArguments();
    if (firstArgument === undefined || !Node.isStringLiteral(firstArgument)) continue;
    const specifier = firstArgument.getLiteralValue();
    if (!isWalled(specifier)) continue;
    found.push({ specifier, line: call.getStartLineNumber() });
  }

  return found;
}

const rule: ArchRule = {
  name: 'money-internals-owners-only',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      if (!filePath.includes(API_ROOT) || isAllowed(filePath)) continue;
      for (const { specifier, line } of walledSpecifiers(sourceFile)) {
        violations.push({
          file: filePath,
          line,
          message:
            `'${specifier}' is a money-layer internal. The affordability module's ` +
            'internals are reachable only from the price OWNERS named in ' +
            'money-internals-owners-only.rule.ts; every other file in apps/api goes ' +
            "through '@hushbox/shared' or '@hushbox/shared/affordability' " +
            '(docs/BILLING.md §Where the Code Lives). If the barrel cannot express ' +
            'what you need, the producer is missing a function — report it rather ' +
            'than widening the wall.',
        });
      }
    }
    return violations;
  },
};

export default rule;
