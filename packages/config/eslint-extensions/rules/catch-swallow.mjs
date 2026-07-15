/**
 * No-silent-catch-swallow lint rule (audit F20). Path-scoped-inert: acts ONLY
 * on non-test files under `apps/api/src/{slices,lib}/` and is silent
 * everywhere else. In that tree a `catch` block must visibly handle the
 * failure — the founder-ruled heuristic is that its body contains at least
 * one of: a `throw`, a `captureError(...)` call, or the construction/return of
 * a typed error/Result (an `err(...)` call or a `*DomainError` reference).
 * Empty catch blocks are banned outright. A rare legitimate swallow escapes
 * via a justified `eslint-disable` line — that is the intended and only escape
 * hatch (there is no config allowlist).
 *
 * The search is deliberately confined to the catch's own control-flow frame:
 * the walk does not descend into nested functions or nested `catch` handlers,
 * because a throw/handler there belongs to a different frame and does not
 * handle this catch.
 *
 * Self-scopes by ABSOLUTE filename (default: the API's slices and lib trees)
 * instead of relying on config `files` globs, because flat-config glob base
 * paths differ per consuming package while context.filename is always
 * absolute.
 */

const DEFAULT_FILES = String.raw`/apps/api/src/(slices|lib)/`;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DOMAIN_ERROR = /DomainError$/;

/** The callee's simple name — the identifier, or a member expression's property. */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return '';
}

/** A nested function/catch — a different control-flow frame; not walked. */
function isFrameBoundary(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'CatchClause'
  );
}

/** A single node that visibly handles a failure. */
function isHandlingNode(node) {
  if (node.type === 'ThrowStatement') return true;
  if (node.type === 'CallExpression') {
    const name = calleeName(node.callee);
    return name === 'captureError' || name === 'err';
  }
  if (node.type === 'Identifier') return DOMAIN_ERROR.test(node.name);
  return false;
}

/** Recurses into a node's child nodes (arrays and single nodes), skipping `parent`. */
function visitChildren(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value && typeof value.type === 'string') {
      visit(value);
    }
  }
}

/**
 * True when the catch block visibly handles its failure. Walks the block's own
 * frame, stopping at nested function/catch boundaries.
 */
function handlesFailure(block) {
  let handled = false;

  const visit = (node) => {
    if (handled || typeof node?.type !== 'string' || isFrameBoundary(node)) return;
    if (isHandlingNode(node)) {
      handled = true;
      return;
    }
    visitChildren(node, visit);
  };

  for (const statement of block.body) visit(statement);
  return handled;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban silent catch-swallow in slice/lib code: a catch block must throw, call captureError, or construct/return a typed error/Result (err(...) / *DomainError). Empty catches are banned; rare legitimate swallows use a justified eslint-disable.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; non-matching files are skipped.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      emptyCatch:
        'Empty catch block swallows the failure silently — throw, call captureError, or return a typed error/Result (err(...) / *DomainError). Justify a rare deliberate swallow with an eslint-disable line.',
      silentCatch:
        'This catch swallows the failure silently — it must throw, call captureError, or construct/return a typed error/Result (err(...) / *DomainError). Justify a rare deliberate swallow with an eslint-disable line.',
    },
  },
  create(context) {
    const scope = new RegExp(context.options[0]?.files ?? DEFAULT_FILES);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename) || TEST_FILE.test(filename)) return {};

    return {
      CatchClause(node) {
        const block = node.body;
        if (block.body.length === 0) {
          context.report({ node, messageId: 'emptyCatch' });
          return;
        }
        if (!handlesFailure(block)) {
          context.report({ node, messageId: 'silentCatch' });
        }
      },
    };
  },
};
