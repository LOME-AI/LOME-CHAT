/**
 * Bans imports of legacy-named artifacts from non-legacy code.
 *
 * Legacy-prefixed files (`legacy_*` files, `legacy-*` dirs, `legacy/` trees)
 * are a non-running reference corpus; new code must never depend on them. If
 * new work needs an existing file's logic, that file keeps its real name and
 * is evolved in place instead of being legacy-renamed.
 *
 * Detection is syntactic on the import specifier: a specifier names a legacy
 * artifact when any of its path segments is legacy-named. Importing files
 * that are themselves legacy-named (by absolute filename) are exempt — the
 * corpus may reference itself.
 *
 * A vendored rule instead of core `no-restricted-imports` because flat config
 * replaces (never merges) a rule key across config objects — reusing the core
 * rule would silently clobber the base config's no-restricted-imports entries
 * for every matching file.
 */

/** True when any path segment is legacy-named (`legacy`, `legacy_*`, `legacy-*`, `legacy.*`). */
function hasLegacySegment(modulePath) {
  return modulePath.split('/').some((segment) => /^legacy([._-]|$)/.test(segment));
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid non-legacy code from importing legacy-named artifacts; the legacy corpus is reference-only.',
    },
    schema: [],
    messages: {
      banned:
        "'{{specifier}}' is a legacy reference-corpus artifact — new code never imports legacy files. Evolve the real module in place instead.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (hasLegacySegment(filename)) return {};

    const checkSource = (node, source) => {
      if (
        source &&
        source.type === 'Literal' &&
        typeof source.value === 'string' &&
        hasLegacySegment(source.value)
      ) {
        context.report({ node, messageId: 'banned', data: { specifier: source.value } });
      }
    };

    return {
      ImportDeclaration(node) {
        checkSource(node, node.source);
      },
      ImportExpression(node) {
        checkSource(node, node.source);
      },
      ExportNamedDeclaration(node) {
        checkSource(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source);
      },
    };
  },
};
