/**
 * Requires the first argument (the msg / metric name) of logger-shaped calls
 * to be a compile-time string literal (CODE-RULES, Telemetry: dynamic strings
 * are the leak vector; fixed fields cannot describe a novel failure, so msg
 * exists but is literal-only).
 *
 * This rule is one half of a two-mechanism enforcement, and the halves are
 * documented in lib/telemetry/port.ts (`LiteralMsg`):
 * - the type level rejects `string`-typed VALUES (variables, concatenation)
 *   but template literals with expressions infer template-pattern types and
 *   slip through;
 * - this rule rejects any non-literal first-argument SYNTAX, closing the
 *   template-interpolation gap in backend paths.
 *
 * `captureError`'s errorCode (argument index 1) gets the same syntactic
 * closure: `LiteralErrorCode` rejects dynamic string VALUES and free text at
 * compile time, but a mixed template (`` `code_${x}` ``) infers a
 * template-pattern type and passes — and that caller-controlled string is the
 * one string crossing to the Sentry sink (tags + fingerprints) unscrubbed.
 * Only the interpolated-template form is banned here: literals and constant
 * references (ERROR_CODES.X) are legitimate call shapes the type level
 * already polices.
 *
 * Console receivers are skipped: raw console is no-raw-console's domain, and
 * the telemetry console adapter must keep passing JSON strings to console.
 * Self-scopes by absolute filename like the other vendored rules; legacy-named
 * files (the demoted, non-running reference corpus) are skipped wholesale.
 */

const DEFAULT_FILES = String.raw`/apps/api/src/((slices|lib|middleware)/|app\.ts$)|/packages/realtime/src/`;

/** True when any path segment is legacy-named (`legacy`, `legacy_*`, `legacy-*`, `legacy.*`). */
function isLegacyPath(filename) {
  return filename.split('/').some((segment) => /^legacy([._-]|$)/.test(segment));
}
const MSG_METHODS = new Set(['debug', 'info', 'warn', 'error', 'emitMetric']);

function isStringLiteral(node) {
  return (
    (node.type === 'Literal' && typeof node.value === 'string') ||
    (node.type === 'TemplateLiteral' && node.expressions.length === 0)
  );
}

function isInterpolatedTemplate(node) {
  return node.type === 'TemplateLiteral' && node.expressions.length > 0;
}

/** Matches `console` and chained receivers like `globalThis.console`. */
function isConsoleReceiver(node) {
  return (
    (node.type === 'Identifier' && node.name === 'console') ||
    (node.type === 'MemberExpression' &&
      node.property.type === 'Identifier' &&
      node.property.name === 'console')
  );
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require log messages and metric names to be compile-time string literals; dynamic strings can carry content.',
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
      nonLiteralMsg:
        'Log messages and metric names must be compile-time string literals — dynamic strings are the content-leak vector; put variable data in allowlisted SafeLogFields.',
      templateErrorCode:
        "captureError's errorCode must not be a template literal with expressions — interpolation smuggles caller-controlled strings past LiteralErrorCode into Sentry tags and fingerprints; use a fixed literal or an ERROR_CODES constant.",
    },
  },
  create(context) {
    const scope = new RegExp(context.options[0]?.files ?? DEFAULT_FILES);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename) || isLegacyPath(filename)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        if (isConsoleReceiver(callee.object)) return;
        if (callee.property.name === 'captureError') {
          const errorCode = node.arguments[1];
          if (errorCode && isInterpolatedTemplate(errorCode)) {
            context.report({ node: errorCode, messageId: 'templateErrorCode' });
          }
          return;
        }
        if (!MSG_METHODS.has(callee.property.name)) return;
        const first = node.arguments[0];
        if (!first || isStringLiteral(first)) return;
        context.report({ node: first, messageId: 'nonLiteralMsg' });
      },
    };
  },
};
