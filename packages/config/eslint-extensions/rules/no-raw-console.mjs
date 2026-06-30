/**
 * Bans raw `console.*` calls in backend paths (CODE-RULES, Telemetry):
 * everything logs through the typed Telemetry port, whose console adapter is
 * the single allowed console caller (exempted by filename). Two findings:
 * - any console call with a non-literal argument is the content-leak vector
 *   (interpolation, template expressions, variables) and gets the sharper
 *   message;
 * - all-literal console calls are still banned — they bypass the allowlist
 *   logger and Workers Logs structure.
 *
 * Self-scopes by absolute filename (like the other vendored rules) because
 * flat-config glob base paths differ per consuming package while
 * context.filename is always absolute. Legacy-named files (the demoted,
 * non-running reference corpus) are skipped wholesale.
 */

const DEFAULT_FILES = String.raw`/apps/api/src/((slices|lib|middleware)/|app\.ts$)|/packages/realtime/src/`;
const DEFAULT_ALLOWED = String.raw`/apps/api/src/lib/telemetry/console-adapter\.ts$`;

/** True when any path segment is legacy-named (`legacy`, `legacy_*`, `legacy-*`, `legacy.*`). */
function isLegacyPath(filename) {
  return filename.split('/').some((segment) => /^legacy([._-]|$)/.test(segment));
}

function isLiteralArgument(node) {
  return (
    node.type === 'Literal' || (node.type === 'TemplateLiteral' && node.expressions.length === 0)
  );
}

/** Matches the console receiver in every form: bare `console` and any member
 * chain ending in `.console` (`globalThis.console`, `self.console` in
 * Workers) — the same sink must not evade the ban behind a receiver alias.
 * Deliberately identical to logger-msg-literal's isConsoleReceiver skip set:
 * every console-shaped receiver is this rule's domain, so no call is
 * double-flagged or orphaned between the two rules. */
function isConsoleReference(node) {
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
        'Ban raw console calls in backend paths; the telemetry console adapter is the single allowed console caller.',
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
          allowedFiles: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; matching files may call console.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      banned:
        'Raw console calls are banned in backend paths — log through the Telemetry port (lib/telemetry); only its console adapter talks to console.',
      interpolation:
        'console.* with a non-literal argument can leak content into Workers Logs — log through the Telemetry port with allowlisted SafeLogFields instead.',
    },
  },
  create(context) {
    const scope = new RegExp(context.options[0]?.files ?? DEFAULT_FILES);
    const allowed = new RegExp(context.options[0]?.allowedFiles ?? DEFAULT_ALLOWED);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename) || allowed.test(filename) || isLegacyPath(filename)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (!isConsoleReference(callee.object)) return;
        const hasNonLiteral = node.arguments.some((argument) => !isLiteralArgument(argument));
        context.report({ node, messageId: hasNonLiteral ? 'interpolation' : 'banned' });
      },
    };
  },
};
