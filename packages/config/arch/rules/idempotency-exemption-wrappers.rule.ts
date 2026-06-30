import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every route that declares an Idempotency-Key exemption must visibly use
 * the wrapper that makes the exemption safe — no unclassified mutation can
 * ship.
 *
 * # The checkable contract (syntactic, by design)
 *
 * - `idempotencyExempt('<class>')` may appear only as an argument of a route
 *   registration (a `.post/.put/.patch/.delete/.all/.on` member call) or a
 *   subtree `.use` registration.
 * - Inline form: the registration's TERMINAL handler (its last argument)
 *   must lexically reference `idempotent.<wrapper>` for one of the class's
 *   allowed wrappers. An inline handler is searched directly; an identifier
 *   is resolved against same-file declarations (function or variable). A
 *   handler defined in another file fails — the wrapper call must stay
 *   visible at the route seam.
 * - Subtree form (`.use(path, idempotencyExempt(...))`): the declaration
 *   defers the wrapper check to the routes beneath it, so the contract is
 *   file-local by construction — every same-file route registration whose
 *   literal path falls under the subtree prefix must satisfy the terminal-
 *   handler check above; a subtree covering no same-file route is flagged
 *   (the routes it exempts must be co-located); a `.route()` sub-app mount
 *   overlapping the prefix is flagged (its routes would inherit the runtime
 *   exemption invisibly to this check). The prefix must be a string literal;
 *   a trailing `*` is stripped (`/webhooks/*` covers `/webhooks` and
 *   everything beneath it).
 * - Two classes carry no `idempotent.*` requirement of their own mechanism
 *   (`opaque-protocol` dedups via Redis challenge state, `token-is-key` via
 *   the deterministic token), but their handlers still claim atomically —
 *   the allowed-wrapper map below records the wrapper each class is expected
 *   to compose underneath.
 */
const ALLOWED_WRAPPERS: Record<string, readonly string[]> = {
  'opaque-protocol': ['byEventId'],
  'token-is-key': ['byUpsert', 'byKey'],
  'webhook-event-id': ['byEventId'],
  'internal-consumer': ['byEventId', 'byTransition'],
  'naturally-idempotent': ['byUpsert', 'byTransition'],
};

const ROUTE_METHODS = new Set(['post', 'put', 'patch', 'delete', 'all', 'on']);

const REGISTRATION_METHODS = new Set([...ROUTE_METHODS, 'use']);

function isExemptionCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === 'idempotencyExempt';
}

function declaredClass(call: CallExpression): string | undefined {
  const [argument] = call.getArguments();
  return Node.isStringLiteral(argument) ? argument.getLiteralText() : undefined;
}

/** The registration call this declaration is a direct argument of, if any. */
function enclosingRegistration(call: CallExpression): CallExpression | undefined {
  const parent = call.getParent();
  if (!Node.isCallExpression(parent)) return undefined;
  if (!parent.getArguments().includes(call)) return undefined;
  const callee = parent.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  return REGISTRATION_METHODS.has(callee.getName()) ? parent : undefined;
}

const WRAPPER_REFERENCE = /\bidempotent\s*\.\s*(by\w+)\b/g;

/** Wrapper names referenced in the handler's text, or undefined when the
 * handler is an identifier that cannot be resolved within the file. */
function handlerWrapperNames(registration: CallExpression): Set<string> | undefined {
  const handler = registration.getArguments().at(-1);
  if (handler === undefined) return new Set();
  let searchText: string | undefined = handler.getText();
  if (Node.isIdentifier(handler)) {
    searchText = resolveSameFileDeclaration(handler.getSourceFile(), handler.getText());
  }
  if (searchText === undefined) return undefined;
  const names = new Set<string>();
  for (const match of searchText.matchAll(WRAPPER_REFERENCE)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function resolveSameFileDeclaration(sourceFile: SourceFile, name: string): string | undefined {
  const function_ = sourceFile.getFunction(name);
  if (function_ !== undefined) return function_.getText();
  const variable = sourceFile.getVariableDeclaration(name);
  if (variable !== undefined) return variable.getText();
  return undefined;
}

function registrationMethod(registration: CallExpression): string {
  const callee = registration.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : '';
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

/** A mount overlaps when it sits under the prefix or the prefix under it. */
function mountOverlaps(prefix: string, mountPath: string): boolean {
  return isCovered(prefix, mountPath) || prefix.startsWith(`${mountPath}/`);
}

function wrapperViolation(
  registration: CallExpression,
  cls: string,
  allowed: readonly string[],
  filePath: string
): ArchViolation | undefined {
  const line = registration.getStartLineNumber();
  const referenced = handlerWrapperNames(registration);
  if (referenced === undefined) {
    return {
      file: filePath,
      line,
      message: `exempted route handler must be inline or declared in the same file so its idempotent.* wrapper stays visible at the route seam (class ${cls}).`,
    };
  }
  if (!allowed.some((wrapper) => referenced.has(wrapper))) {
    const allowedList = allowed.map((w) => `idempotent.${w}`).join(' or ');
    return {
      file: filePath,
      line,
      message: `exempted route (class ${cls}) must use ${allowedList} in its terminal handler.`,
    };
  }
  return undefined;
}

/**
 * A subtree `.use` declaration defers the wrapper check to the routes
 * beneath it: every same-file route registration with a literal path under
 * the prefix must pass the terminal-handler check; overlapping `.route()`
 * mounts and uncovered subtrees are flagged outright.
 */
// The subtree walk is one pass over the route registrations with the full
// claim context; an options object or a split would obscure that contract.
// eslint-disable-next-line max-params, complexity, sonarjs/cognitive-complexity -- single-pass walk by design
function checkSubtreeDeclaration(
  call: CallExpression,
  registration: CallExpression,
  cls: string,
  allowed: readonly string[],
  filePath: string
): ArchViolation[] {
  const line = call.getStartLineNumber();
  const rawPath = literalArgument(registration, 0);
  if (rawPath === undefined) {
    return [
      {
        file: filePath,
        line,
        message: `a subtree idempotencyExempt (class ${cls}) must declare a literal path prefix as the .use() call's first argument.`,
      },
    ];
  }
  const prefix = subtreePrefix(rawPath);
  const violations: ArchViolation[] = [];
  let coveredRoutes = 0;
  for (const candidate of registration
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const method = registrationMethod(candidate);
    if (method === 'route') {
      const mountPath = literalArgument(candidate, 0);
      if (mountPath !== undefined && mountOverlaps(prefix, mountPath)) {
        violations.push({
          file: filePath,
          line: candidate.getStartLineNumber(),
          message: `a sub-app mount overlapping an exempted subtree (class ${cls}) hides its routes from this check — declare the exemption inside the mounted app's own registrations.`,
        });
      }
      continue;
    }
    if (!ROUTE_METHODS.has(method)) continue;
    const routePath = literalArgument(candidate, method === 'on' ? 1 : 0);
    if (routePath === undefined || !isCovered(prefix, routePath)) continue;
    coveredRoutes += 1;
    const violation = wrapperViolation(candidate, cls, allowed, filePath);
    if (violation !== undefined) violations.push(violation);
  }
  if (coveredRoutes === 0 && violations.length === 0) {
    violations.push({
      file: filePath,
      line,
      message: `subtree exemption (class ${cls}) covers no same-file route registrations — declare it inline on each route or co-locate the routes it exempts.`,
    });
  }
  return violations;
}

function checkDeclaration(call: CallExpression, filePath: string): ArchViolation[] {
  const line = call.getStartLineNumber();
  const cls = declaredClass(call);
  const allowed = cls === undefined ? undefined : ALLOWED_WRAPPERS[cls];
  if (cls === undefined || allowed === undefined) {
    return [
      {
        file: filePath,
        line,
        message: `idempotencyExempt: unknown exemption class ${call.getArguments()[0]?.getText() ?? '(none)'} — the set is closed.`,
      },
    ];
  }
  const registration = enclosingRegistration(call);
  if (registration === undefined) {
    return [
      {
        file: filePath,
        line,
        message:
          'idempotencyExempt must be declared inline in a route registration (.post/.put/.patch/.delete/.all/.on) or a subtree .use().',
      },
    ];
  }
  if (registrationMethod(registration) === 'use') {
    return checkSubtreeDeclaration(call, registration, cls, allowed, filePath);
  }
  const violation = wrapperViolation(registration, cls, allowed, filePath);
  return violation === undefined ? [] : [violation];
}

const rule: ArchRule = {
  name: 'idempotency-exemption-wrappers',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath().replace(/^\//, '');
      if (!filePath.includes('apps/api/src/')) continue;
      if (filePath.endsWith('.test.ts')) continue;
      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!isExemptionCall(call)) continue;
        violations.push(...checkDeclaration(call, filePath));
      }
    }
    return violations;
  },
};

export default rule;
