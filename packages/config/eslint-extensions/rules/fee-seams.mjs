/**
 * Confines fee application to the sanctioned seams.
 *
 * BILLING.md §Fee Structure: the customer markup lands in exactly two places —
 * catalog rate baking at ingestion (ceil) and the ModelProvider port's charge
 * conversion (half-even) — plus the definition-time reservation constants that
 * bake a raw provider figure billable exactly once at module init. Everything
 * else prices over already-billable rates through the shared estimator. A fee
 * helper imported anywhere else re-applies (or forgets) the markup and
 * silently drifts client, admission, and settlement apart.
 *
 * Detection is syntactic and name-based at the import/re-export seam: any
 * import specifier or `export … from` source-side name matching the
 * fee-helper pattern (`applyMarkup*` — every fee-application helper in
 * `packages/shared/src/money.ts` must keep that prefix so the pattern covers
 * it) is flagged unless the importing file is on the sanctioned-seam
 * allowlist (rule options — the single data source, in the topic config) or
 * is a test file (tests compute expected values). Star re-exports of a
 * `money` module are flagged too, so the helpers cannot be laundered through
 * an intermediate barrel. A module-object import binds no fee name at the
 * specifier, so those bindings (`import * as m` / `import m`) are tracked
 * through scope analysis and the fee access is flagged at the member
 * expression (`m.applyMarkupCeil(…)`) instead — shadowing is resolved by the
 * scope manager, so a same-named local parameter is not a false positive.
 *
 * Limitations (documented, accepted), each a shape no repo code uses and a
 * reviewer sees: any dynamic `import()` binding, whether destructured or held
 * as a module object (`const m = await import(…); m.applyMarkup…`) — only
 * static import declarations are tracked; a fully dynamic member access on a
 * module object (`m[key]` — a statically-known string key is matched); and
 * `export * as ns from` republication of a non-`money` module, whose consumer
 * holds a named binding rather than a module object.
 *
 * A vendored rule instead of core `no-restricted-imports` for the same reason
 * as no-legacy-imports: flat config replaces (never merges) a rule key, and
 * the allowlist is by absolute importer filename, which the core rule cannot
 * express.
 */

const FEE_HELPER_NAME_PATTERN = /^applyMarkup/;
const TEST_FILE_PATTERN = /\.test\.(?:mjs|mts|jsx?|tsx?)$/;
/** Import specifiers that bind the whole module object rather than a name. */
const MODULE_OBJECT_SPECIFIERS = new Set(['ImportNamespaceSpecifier', 'ImportDefaultSpecifier']);

/** The source-side name of an import/export specifier (ESTree allows Literal). */
function specifierName(spec) {
  const id = spec.type === 'ExportSpecifier' ? spec.local : spec.imported;
  if (!id) return '';
  return id.type === 'Literal' ? String(id.value) : id.name;
}

/** The statically-known property name of a member access ('' when dynamic). */
function memberPropertyName(node) {
  if (!node.computed) return node.property.name;
  return node.property.type === 'Literal' ? String(node.property.value) : '';
}

/** True when the linted file is one of the sanctioned seam files. */
function isSanctionedSeam(filename, allowedFiles) {
  return allowedFiles.some((seam) => filename === seam || filename.endsWith(`/${seam}`));
}

/** True when a star re-export source is a money module (basename `money`). */
function isMoneyModule(source) {
  const basename = source.split('/').at(-1);
  return /^money(?:\.[cm]?[jt]s)?$/.test(basename);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Confine fee-application helpers (applyMarkup*) to the sanctioned seams: ' +
        'catalog ingestion, the ModelProvider port conversion, and the definition-time reservation constants.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['allowedFiles'],
        additionalProperties: false,
      },
    ],
    messages: {
      confined:
        "'{{name}}' applies the customer fee and is confined to the sanctioned seams " +
        '(fee-seams.config.mjs). Price over billable catalog rates or the shared estimator instead ' +
        'of re-applying the markup here.',
      starLaunder:
        "Star re-exporting '{{source}}' would republish the fee-application helpers outside the " +
        'sanctioned seams (fee-seams.config.mjs). Re-export the needed non-fee symbols by name instead.',
    },
  },

  create(context) {
    const { allowedFiles } = context.options[0];
    const filename = context.filename.replaceAll('\\', '/');
    if (TEST_FILE_PATTERN.test(filename) || isSanctionedSeam(filename, allowedFiles)) {
      return {};
    }

    const checkSpecifiers = (node) => {
      for (const spec of node.specifiers) {
        const name = specifierName(spec);
        if (FEE_HELPER_NAME_PATTERN.test(name)) {
          context.report({ node: spec, messageId: 'confined', data: { name } });
        }
      }
    };

    // Deferred to Program:exit: `parent` links exist only once the traversal
    // that populates them has reached the end of the program.
    const moduleObjectVariables = [];

    return {
      ImportDeclaration(node) {
        checkSpecifiers(node);
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          if (MODULE_OBJECT_SPECIFIERS.has(variable.defs[0].node.type)) {
            moduleObjectVariables.push(variable);
          }
        }
      },
      'Program:exit'() {
        for (const variable of moduleObjectVariables) {
          for (const { identifier } of variable.references) {
            if (identifier.parent.type !== 'MemberExpression') continue;
            const name = memberPropertyName(identifier.parent);
            if (FEE_HELPER_NAME_PATTERN.test(name)) {
              context.report({ node: identifier.parent, messageId: 'confined', data: { name } });
            }
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSpecifiers(node);
      },
      ExportAllDeclaration(node) {
        if (typeof node.source.value === 'string' && isMoneyModule(node.source.value)) {
          context.report({
            node,
            messageId: 'starLaunder',
            data: { source: node.source.value },
          });
        }
      },
    };
  },
};
