import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every mutating route (`.post/.put/.patch/.delete`) that is NOT declared
 * exempt must be statically proven to route its write through the idempotency
 * seam. This is the complement of `idempotency-exemption-wrappers`: that rule
 * proves DECLARED-EXEMPT routes carry their wrapper; this rule closes the
 * blind spot on the other side — a non-exempt mutating handler that never
 * reaches an idempotency mechanism (a bare `db.insert(...)` with no
 * `Idempotency-Key` accounting) fails the build.
 *
 * # what counts as proof (syntactic, by design)
 *
 * A non-exempt mutating handler passes when its terminal-handler text shows
 * one of the three sanctioned idempotency mechanisms:
 *  - `runMutation(...)` or `idempotent.<wrapper>` (the HTTP wrapper — the five
 *    wrappers are the only entry to `runMutation`, which accepts only
 *    `Idempotent<T>`);
 *  - a same-file wrapper helper that itself routes through one of those (e.g.
 *    conversations' `runByKey`), resolved by fix-point so one layer of local
 *    indirection stays visible at the route seam;
 *  - the ConversationRoom DO run-control seam (`.startRun`/`.stopRun`): a chat
 *    run's referee is the idempotency-key row claimed inside the DO, not an
 *    HTTP wrapper (ARCHITECTURE.md §Money & settlement, §Streaming & realtime).
 *
 * # exemption
 *
 * A route is skipped (its wrapper is the other rule's concern) when it carries
 * an inline `idempotencyExempt('<class>')` argument, or falls under a same-file
 * `.use('<prefix>', idempotencyExempt(...))` subtree declaration.
 *
 * A handler defined in another file cannot be proven at the route seam and is
 * flagged — inline it or route it through a same-file wrapper so the evidence
 * stays local (the same discipline the exemption rule enforces).
 */

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const WRAPPERS = ['byKey', 'byUpsert', 'byTransition', 'byEventId', 'byExternalPreClaim'];

/** Direct lexical evidence of the HTTP idempotency wrapper. */
const WRAPPER_EVIDENCE = new RegExp(
  String.raw`\brunMutation\b|\bidempotent\s*\.\s*(?:${WRAPPERS.join('|')})\b`
);

/** The ConversationRoom DO run-control seam (run-claim is the referee). */
const RUN_CONTROL_EVIDENCE = /\.\s*(?:startRun|stopRun)\s*\(/;

function calleeName(call: CallExpression): string {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
}

/** The member method of a route registration (`post`, `get`, `use`, …). */
function registrationMethod(call: CallExpression): string {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
}

/** The line of the `.post`/`.put`/… token — accurate even inside a method
 * chain, where the call expression's own start is the chain root. */
function registrationLine(call: CallExpression): number {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee)
    ? callee.getNameNode().getStartLineNumber()
    : call.getStartLineNumber();
}

function literalArgument(call: CallExpression, index: number): string | undefined {
  const argument = call.getArguments()[index];
  return argument !== undefined && Node.isStringLiteral(argument)
    ? argument.getLiteralText()
    : undefined;
}

/** `'/webhooks/*'` and `'/webhooks/'` both normalize to `'/webhooks'`. */
function subtreePrefix(raw: string): string {
  const starless = raw.endsWith('*') ? raw.slice(0, -1) : raw;
  return starless.endsWith('/') ? starless.slice(0, -1) : starless;
}

function isCovered(prefix: string, routePath: string): boolean {
  return routePath === prefix || routePath.startsWith(`${prefix}/`);
}

function isExemptionCall(call: CallExpression): boolean {
  return calleeName(call) === 'idempotencyExempt';
}

/** Prefixes of every same-file `.use(path, idempotencyExempt(...))` subtree. */
function subtreeExemptionPrefixes(sourceFile: SourceFile): string[] {
  const prefixes: string[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (registrationMethod(call) !== 'use') continue;
    const declaresExemption = call
      .getArguments()
      .some((argument) => Node.isCallExpression(argument) && isExemptionCall(argument));
    if (!declaresExemption) continue;
    const raw = literalArgument(call, 0);
    if (raw !== undefined) prefixes.push(subtreePrefix(raw));
  }
  return prefixes;
}

function referencesName(text: string, name: string): boolean {
  return new RegExp(String.raw`\b${name}\b`).test(text);
}

interface NamedDeclaration {
  readonly name: string;
  readonly text: string;
}

/** Every named top-level function and variable declaration in the file. */
function namedDeclarations(sourceFile: SourceFile): NamedDeclaration[] {
  const declarations: NamedDeclaration[] = [];
  for (const function_ of sourceFile.getFunctions()) {
    const name = function_.getName();
    if (name !== undefined) declarations.push({ name, text: function_.getText() });
  }
  for (const variable of sourceFile.getVariableDeclarations()) {
    declarations.push({ name: variable.getName(), text: variable.getText() });
  }
  return declarations;
}

/** One fix-point pass: adds any declaration that references a known helper;
 * returns whether the set grew. */
function growHelpers(declarations: NamedDeclaration[], helpers: Set<string>): boolean {
  let grew = false;
  for (const declaration of declarations) {
    if (helpers.has(declaration.name)) continue;
    if ([...helpers].some((helper) => referencesName(declaration.text, helper))) {
      helpers.add(declaration.name);
      grew = true;
    }
  }
  return grew;
}

/**
 * Same-file identifiers whose declaration routes (transitively) through the
 * HTTP wrapper — the local indirection helpers like `runByKey`.
 */
function wrapperHelperNames(sourceFile: SourceFile): Set<string> {
  const declarations = namedDeclarations(sourceFile);
  const helpers = new Set<string>(
    declarations.filter((declaration) => WRAPPER_EVIDENCE.test(declaration.text)).map((d) => d.name)
  );
  let growing = true;
  while (growing) growing = growHelpers(declarations, helpers);
  return helpers;
}

/** The registration's terminal-handler text, or undefined when it is an
 * identifier that cannot be resolved within the file. */
function handlerText(registration: CallExpression): string | undefined {
  const handler = registration.getArguments().at(-1);
  if (handler === undefined) return '';
  if (Node.isIdentifier(handler)) {
    const sourceFile = handler.getSourceFile();
    const name = handler.getText();
    const function_ = sourceFile.getFunction(name);
    if (function_ !== undefined) return function_.getText();
    const variable = sourceFile.getVariableDeclaration(name);
    if (variable !== undefined) return variable.getText();
    return undefined;
  }
  return handler.getText();
}

function hasProof(text: string, helpers: Set<string>): boolean {
  if (WRAPPER_EVIDENCE.test(text) || RUN_CONTROL_EVIDENCE.test(text)) return true;
  return [...helpers].some((helper) => referencesName(text, helper));
}

/**
 * A Hono route registration, not a `.delete(table)` query builder or a
 * `Map.delete(key)`: a mutating member method whose first argument is a
 * `/`-prefixed string-literal path. Drizzle deletes take a table identifier and
 * `Map.delete` takes a key expression, so neither is mistaken for a route.
 */
function isRouteRegistration(call: CallExpression): boolean {
  if (!MUTATING_METHODS.has(registrationMethod(call))) return false;
  const path = literalArgument(call, 0);
  return path?.startsWith('/') ?? false;
}

function checkRegistration(
  registration: CallExpression,
  prefixes: string[],
  helpers: Set<string>,
  filePath: string
): ArchViolation | undefined {
  if (!isRouteRegistration(registration)) return undefined;
  const method = registrationMethod(registration);

  const directlyExempt = registration
    .getArguments()
    .some((argument) => Node.isCallExpression(argument) && isExemptionCall(argument));
  if (directlyExempt) return undefined;

  const routePath = literalArgument(registration, 0);
  if (routePath !== undefined && prefixes.some((prefix) => isCovered(prefix, routePath))) {
    return undefined;
  }

  const line = registrationLine(registration);
  const text = handlerText(registration);
  if (text === undefined) {
    return {
      file: filePath,
      line,
      message: `mutating ${method.toUpperCase()} route handler is defined in another file — idempotency routing cannot be proven at the route seam; inline it or route it through a same-file runMutation/idempotent.* wrapper.`,
    };
  }
  if (hasProof(text, helpers)) return undefined;
  return {
    file: filePath,
    line,
    message: `mutating ${method.toUpperCase()} route is neither idempotencyExempt nor routed through runMutation/idempotent.* (nor the run-claim seam) — every non-exempt mutating route must prove idempotency.`,
  };
}

const rule: ArchRule = {
  name: 'mutating-routes-prove-idempotency',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath().replace(/^\//, '');
      if (!filePath.includes('apps/api/src/')) continue;
      if (filePath.endsWith('.test.ts')) continue;

      const prefixes = subtreeExemptionPrefixes(sourceFile);
      const helpers = wrapperHelperNames(sourceFile);
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const violation = checkRegistration(call, prefixes, helpers, filePath);
        if (violation !== undefined) violations.push(violation);
      }
    }
    return violations;
  },
};

export default rule;
