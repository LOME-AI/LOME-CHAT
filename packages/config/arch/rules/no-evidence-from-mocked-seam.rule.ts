import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, ObjectLiteralExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A `service_evidence` row is a claim that our code really talked to a real
 * external service: `pnpm verify:evidence --require=<svc>` hard-fails CI when
 * the row is missing, so the row is the only thing standing between an
 * integration going silently dark and a red build. That guarantee is worth
 * exactly as much as the transport underneath it, and it has been broken
 * before — `push-fcm` and `resend` both landed evidence rows from a `vi.fn()`
 * fetch, so `verify:evidence` was green while nothing had ever reached Google
 * or Resend.
 *
 * THE INVARIANT: an adapter may write evidence only where its real
 * implementation actually executes in CI.
 *
 * That is true for helcim (a real sandbox charge), hookdeck, r2 (a real S3
 * PUT) and openrouter (a real, cassette-backed catalog fetch) — their adapters
 * therefore record evidence themselves. It is FALSE for fcm, webpush and
 * resend: those senders are deliberately replaced by mocks in local dev and CI
 * (`push-sender-factory.ts`, `email-sender-factory.ts`) because FCM has no
 * sandbox, a real adapter would fire real sends at the junk tokens every E2E
 * notification path seeds, and the `/dev/push` capture surface depends on the
 * mock. Those factories are CORRECT and must not be "fixed" — evidence for
 * those three belongs in a separate CI-gated test that makes the real call
 * itself, never in the adapter the factory mocks away.
 *
 * The checkable residue of that invariant, and what this rule enforces: one
 * file must not both fake the HTTP transport and enable a service-evidence
 * write.
 *
 * SEPARATING A FAKE FROM A REAL-DELEGATING WRAPPER — the whole difficulty. The
 * live FCM test hands the adapter a `fetchImpl` too, but its wrapper awaits the
 * real global `fetch` and only clones the response; the cassette transport
 * likewise closes over `globalThis.fetch`. Both are ordinary first-party
 * functions, so keying on the presence of a `fetchImpl` would flag the one
 * shape that is correct. The discriminator is vitest's mocking surface: a
 * `vi.fn`/`vi.mock`/`vi.doMock` value, or a `vi.stubGlobal` replacement of the
 * global `fetch`, has no socket behind it, and a wrapper that delegates never
 * needs one. `vi.spyOn` is in that set for a different reason — it is the entry
 * point to `mockImplementation`, the shape a fake takes when it replaces an
 * existing function. A bare `vi.spyOn(globalThis, 'fetch')` with no
 * `mockImplementation` does call through to the real `fetch`, so a
 * capture-and-delegate spy passed to an adapter alongside `isCI: true` is
 * flagged even though its transport is real. That is a known, accepted
 * over-fire, not a reason to drop `spyOn`: dropping it would let every
 * `spyOn(...).mockImplementation(...)` fake through.
 *
 * WHAT THIS DOES NOT PROVE: that an evidence write in a passing file followed a
 * genuine network call. No static rule can. This catches the mocked-seam shape
 * — the shape the two historical defects had — and nothing more.
 */

/** A property or binding whose name mentions fetch is the transport slot. */
const FETCH_NAME = /fetch/i;

/**
 * Vitest's mock-installing surface. `fn`/`mock`/`doMock`/`stubGlobal` produce a
 * value with no socket behind it; `spyOn` is included because it is the entry
 * point to `mockImplementation` — a bare delegating spy is an accepted
 * over-fire (see the header), never a reason to remove it from this set.
 */
const MOCK_FACTORIES = new Set(['fn', 'mock', 'doMock', 'spyOn', 'stubGlobal']);

/** Web code writes no service evidence; every other rule gates to the backend too. */
const WEB_SRC = 'apps/web/src/';

/** `vi.<method>(…)` where `<method>` mints or installs a mock, else undefined. */
function viMockMethod(call: CallExpression): string | undefined {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return undefined;
  if (expression.getExpression().getText() !== 'vi') return undefined;
  const method = expression.getName();
  return MOCK_FACTORIES.has(method) ? method : undefined;
}

/** The node is, or lexically contains, a vitest mock-factory call. */
function containsMockFactory(node: Node): boolean {
  if (Node.isCallExpression(node) && viMockMethod(node) !== undefined) return true;
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((call) => viMockMethod(call) !== undefined);
}

/** The leftmost identifier of a reference expression (`a.b.c()` → `a`). */
function rootIdentifier(node: Node): string | undefined {
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isPropertyAccessExpression(node)) return rootIdentifier(node.getExpression());
  if (Node.isCallExpression(node)) return rootIdentifier(node.getExpression());
  if (Node.isAsExpression(node)) return rootIdentifier(node.getExpression());
  return undefined;
}

/**
 * Names bound to a mock somewhere in the file — a `const`, a reassignment, or a
 * factory function that returns one. Indirection through any of the three is
 * how both historical violators reached the adapter.
 */
function mockedBindingNames(file: SourceFile): Set<string> {
  return new Set([
    ...mockedDeclarationNames(file),
    ...mockedAssignmentNames(file),
    ...mockedFactoryFunctionNames(file),
  ]);
}

/** `const fetchImpl = vi.fn()`. */
function mockedDeclarationNames(file: SourceFile): string[] {
  return file
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((declaration) => {
      const initializer = declaration.getInitializer();
      return initializer !== undefined && containsMockFactory(initializer);
    })
    .map((declaration) => declaration.getName());
}

/** `fetchImpl = vi.fn()` — the `let`-then-assign shape a `beforeAll` forces. */
function mockedAssignmentNames(file: SourceFile): string[] {
  return file
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter(
      (assignment) =>
        assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        containsMockFactory(assignment.getRight())
    )
    .map((assignment) => rootIdentifier(assignment.getLeft()))
    .filter((name) => name !== undefined);
}

/** `function okFetch() { return vi.fn(…); }`. */
function mockedFactoryFunctionNames(file: SourceFile): string[] {
  return file
    .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
    .filter((declaration) => containsMockFactory(declaration))
    .map((declaration) => declaration.getName())
    .filter((name) => name !== undefined);
}

/** A value is a faked transport when it is, or resolves to, a vitest mock. */
function isFakedTransport(value: Node, mockedNames: Set<string>): boolean {
  if (containsMockFactory(value)) return true;
  const root = rootIdentifier(value);
  return root !== undefined && mockedNames.has(root);
}

/** A `fetch`-named property in an options object whose value is a faked transport. */
function isFakedTransportProperty(property: Node, mockedNames: Set<string>): boolean {
  if (Node.isShorthandPropertyAssignment(property)) {
    const name = property.getName();
    return FETCH_NAME.test(name) && mockedNames.has(name);
  }
  if (!Node.isPropertyAssignment(property) || !FETCH_NAME.test(property.getName())) return false;
  const initializer = property.getInitializer();
  return initializer !== undefined && isFakedTransport(initializer, mockedNames);
}

/** Every options object in the file that receives a faked transport. */
function objectLiteralsReceivingFakes(
  file: SourceFile,
  mockedNames: Set<string>
): ObjectLiteralExpression[] {
  return file
    .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
    .filter((objectLiteral) =>
      objectLiteral
        .getProperties()
        .some((property) => isFakedTransportProperty(property, mockedNames))
    );
}

/** The faked-transport properties themselves — where a reader should look first. */
function fakedTransportProperties(file: SourceFile, mockedNames: Set<string>): Node[] {
  return file
    .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
    .flatMap((objectLiteral) =>
      objectLiteral
        .getProperties()
        .filter((property) => isFakedTransportProperty(property, mockedNames))
    );
}

/** `vi.stubGlobal('fetch', …)` — the transport is faked process-wide. */
function globalFetchStubs(file: SourceFile): CallExpression[] {
  return file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    if (viMockMethod(call) !== 'stubGlobal') return false;
    const [target] = call.getArguments();
    return (
      target !== undefined &&
      Node.isStringLiteral(target) &&
      FETCH_NAME.test(target.getLiteralValue())
    );
  });
}

/** The `isCI: true` in an options object — the adapter's evidence gate, forced open. */
function hardcodedEvidenceGate(objectLiteral: ObjectLiteralExpression): Node | undefined {
  for (const property of objectLiteral.getProperties()) {
    if (!Node.isPropertyAssignment(property) || property.getName() !== 'isCI') continue;
    if (property.getInitializer()?.getKind() === SyntaxKind.TrueKeyword) return property;
  }
  return undefined;
}

function evidenceCalls(file: SourceFile): CallExpression[] {
  return file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const expression = call.getExpression();
    const name = Node.isPropertyAccessExpression(expression)
      ? expression.getName()
      : expression.getText();
    return name === 'recordServiceEvidence';
  });
}

/**
 * Nodes that enable an evidence write next to a faked transport: an `isCI: true`
 * sitting in the very options object that receives the fake, or any direct
 * `recordServiceEvidence` call in a file that fakes the transport at all.
 */
function evidenceAnchors(file: SourceFile, fakedOptions: ObjectLiteralExpression[]): Node[] {
  const anchors: Node[] = [];
  for (const objectLiteral of fakedOptions) {
    const gate = hardcodedEvidenceGate(objectLiteral);
    if (gate !== undefined) anchors.push(gate);
  }
  anchors.push(...evidenceCalls(file));
  return anchors;
}

function earliestLine(nodes: Node[]): number {
  return Math.min(...nodes.map((node) => node.getStartLineNumber()));
}

const rule: ArchRule = {
  name: 'no-evidence-from-mocked-seam',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const file of project.getSourceFiles()) {
      const filePath = file.getFilePath();
      if (filePath.includes(WEB_SRC)) continue;

      const mockedNames = mockedBindingNames(file);
      const fakedOptions = objectLiteralsReceivingFakes(file, mockedNames);
      const fakes: Node[] = [
        ...fakedTransportProperties(file, mockedNames),
        ...globalFetchStubs(file),
      ];
      if (fakes.length === 0) continue;

      const anchors = evidenceAnchors(file, fakedOptions);
      if (anchors.length === 0) continue;

      violations.push({
        file: filePath,
        line: earliestLine(anchors),
        message:
          `Service evidence must never be written behind a faked HTTP transport (mock installed at line ${String(earliestLine(fakes))}). ` +
          'An evidence row is what `verify:evidence` treats as proof that a real call to the real service happened, ' +
          'so an adapter may record it only where its real implementation actually runs in CI. ' +
          'The fcm, webpush and resend senders are mocked in CI by design — their evidence belongs in a separate ' +
          'CI-gated test that makes the real call itself, never in a file that fakes fetch.',
      });
    }
    return violations;
  },
};

export default rule;
