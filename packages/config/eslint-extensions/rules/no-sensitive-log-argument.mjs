/**
 * Heuristic redaction rule (CODE-RULES, Telemetry): logging any expression
 * whose name matches /message|prompt|content|body|text/i through a
 * logger-shaped call fails lint. Advisory by design — renaming bypasses it;
 * the typed SafeLogFields logger and port-side scrubbing are the real
 * mechanisms — but it catches the honest mistake cheaply.
 *
 * "Logger-shaped" is a heuristic too: a member call whose method is a log
 * verb (log/debug/info/warn/error/trace/emitMetric/captureError) or whose
 * receiver is named like a logger (`log`, `logger`, anything containing
 * `telemetry`). Arguments are walked structurally — identifiers, member
 * properties, object keys and values, spreads, template expressions, and
 * nested call arguments (e.g. JSON.stringify(body)); callee names are not
 * matched, only what is being logged.
 *
 * Self-scopes by absolute filename like the other vendored rules; legacy-named
 * files (the demoted, non-running reference corpus) are skipped wholesale.
 */

const DEFAULT_FILES = String.raw`/apps/api/src/((slices|lib|middleware)/|app\.ts$)|/packages/realtime/src/`;

/** True when any path segment is legacy-named (`legacy`, `legacy_*`, `legacy-*`, `legacy.*`). */
function isLegacyPath(filename) {
  return filename.split('/').some((segment) => /^legacy([._-]|$)/.test(segment));
}
const SENSITIVE = /message|prompt|content|body|text/i;
const LOG_METHODS = new Set([
  'log',
  'debug',
  'info',
  'warn',
  'error',
  'trace',
  'emitMetric',
  'captureError',
]);
const LOGGER_RECEIVER = /^log(ger)?$|telemetry/i;

function receiverName(object) {
  if (object.type === 'Identifier') return object.name;
  if (object.type === 'MemberExpression' && object.property.type === 'Identifier') {
    return object.property.name;
  }
  return '';
}

function isLoggerCall(callee) {
  if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return false;
  return LOG_METHODS.has(callee.property.name) || LOGGER_RECEIVER.test(receiverName(callee.object));
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid logging any expression whose name matches the sensitive-content heuristic through a logger-shaped call.',
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
      sensitiveName:
        "'{{name}}' looks like a content carrier (/message|prompt|content|body|text/i) — content must never reach logs; log allowlisted SafeLogFields (ids, codes, counts) instead.",
    },
  },
  create(context) {
    const scope = new RegExp(context.options[0]?.files ?? DEFAULT_FILES);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename) || isLegacyPath(filename)) return {};

    const reportIfSensitive = (node, name) => {
      if (SENSITIVE.test(name)) {
        context.report({ node, messageId: 'sensitiveName', data: { name } });
      }
    };

    // One exhaustive switch over every AST shape an argument can hide content
    // in; splitting it would scatter the case coverage this rule is audited by.
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- exhaustive AST walker by design
    const walk = (node) => {
      switch (node.type) {
        case 'Identifier': {
          reportIfSensitive(node, node.name);
          return;
        }
        case 'MemberExpression': {
          walk(node.object);
          if (node.property.type === 'Identifier') {
            reportIfSensitive(node.property, node.property.name);
          } else if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
            reportIfSensitive(node.property, node.property.value);
          }
          return;
        }
        case 'ObjectExpression': {
          for (const property of node.properties) {
            if (property.type === 'SpreadElement') {
              walk(property.argument);
            } else {
              if (property.key.type === 'Identifier') {
                reportIfSensitive(property.key, property.key.name);
              } else if (
                property.key.type === 'Literal' &&
                typeof property.key.value === 'string'
              ) {
                reportIfSensitive(property.key, property.key.value);
              }
              // Shorthand values are the same node as the key — skip the
              // duplicate report.
              if (!property.shorthand) walk(property.value);
            }
          }
          return;
        }
        case 'ArrayExpression': {
          for (const element of node.elements) {
            if (element) walk(element);
          }
          return;
        }
        case 'TemplateLiteral': {
          for (const expression of node.expressions) walk(expression);
          return;
        }
        case 'CallExpression':
        case 'NewExpression': {
          for (const argument of node.arguments) walk(argument);
          return;
        }
        case 'SpreadElement':
        case 'AwaitExpression':
        case 'UnaryExpression': {
          walk(node.argument);
          return;
        }
        case 'BinaryExpression':
        case 'LogicalExpression': {
          // PrivateIdentifier can appear as `left` of `in` checks.
          if (node.left.type !== 'PrivateIdentifier') walk(node.left);
          walk(node.right);
          return;
        }
        case 'ConditionalExpression': {
          walk(node.consequent);
          walk(node.alternate);
          return;
        }
        case 'ChainExpression':
        case 'TSAsExpression':
        case 'TSNonNullExpression':
        case 'TSSatisfiesExpression': {
          walk(node.expression);
          return;
        }
        default:
      }
    };

    return {
      CallExpression(node) {
        if (!isLoggerCall(node.callee)) return;
        for (const argument of node.arguments) walk(argument);
      },
    };
  },
};
