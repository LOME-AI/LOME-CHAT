/**
 * Bans imports that reach into the quarantined `/legacy/` corpus.
 *
 * The legacy corpus lives in the repo-root `/legacy/` directory — outside every
 * workspace package, invisible to typecheck/lint/test/coverage. It is a
 * non-running reference archive; new code must never depend on it. If new work
 * needs an archived file's logic, that logic is reimplemented in a real module,
 * never imported back out of the archive.
 *
 * Detection is syntactic on the import specifier: a specifier reaches the corpus
 * when any of its path segments is exactly `legacy` (a relative path climbing
 * into `/legacy/`, or a `legacy` package subpath). Importing files that
 * themselves live under `/legacy/` are exempt — the corpus may reference itself.
 *
 * A vendored rule instead of core `no-restricted-imports` because flat config
 * replaces (never merges) a rule key across config objects — reusing the core
 * rule would silently clobber the base config's no-restricted-imports entries
 * for every matching file.
 */

/** True when any path segment is exactly `legacy` (the repo-root quarantine dir). */
function hasLegacySegment(modulePath) {
  return modulePath.split('/').includes('legacy');
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid new code from importing the quarantined /legacy/ corpus; the archive is reference-only.',
    },
    schema: [],
    messages: {
      banned:
        "'{{specifier}}' reaches into the quarantined /legacy/ corpus — new code never imports the archive. Reimplement the logic in a real module instead.",
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
