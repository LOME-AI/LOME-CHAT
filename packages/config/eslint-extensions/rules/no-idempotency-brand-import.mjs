/**
 * Confines imports of the brand-minting module
 * (apps/api/src/lib/idempotency/brands.ts) to the idempotency module itself.
 *
 * The module exports `brandIdempotent`/`brandSettlementTx` so the wrappers
 * and the settlement entry point can mint, but a deep import from slice code
 * would forge the brands without any cast — invisible to the cast ban.
 * Together the two rules make the `idempotent.*` wrappers and the settlement
 * entry point the sole producers (the barrel deliberately re-exports only the
 * brand TYPES, never the constructors).
 *
 * Detection is syntactic: a relative specifier is resolved against the
 * importing file's absolute path; a resolution landing on the brands module
 * is banned unless the importer itself lives under
 * apps/api/src/lib/idempotency/. Package specifiers cannot reach the module
 * (the api app exports only its app entry), so relative resolution covers the
 * whole surface. Type-only imports are banned too — the types are available
 * from the barrel.
 *
 * Vendored (not core no-restricted-imports) because flat config replaces,
 * never merges, a rule key across config objects — reusing the core rule
 * would silently clobber the base config's no-restricted-imports entries.
 * Self-scopes by absolute filename (like the sibling rules) because
 * flat-config glob base paths differ per consuming package.
 */
import path from 'node:path';

const INTERNAL_DIR = /\/apps\/api\/src\/lib\/idempotency\//;
const BRANDS_MODULE = /\/apps\/api\/src\/lib\/idempotency\/brands(?:\.[cm]?[jt]s)?$/;

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow importing the idempotency brands module outside lib/idempotency; the brand constructors are internal to the wrappers and the settlement entry point.',
    },
    schema: [],
    messages: {
      banned:
        "'{{specifier}}' reaches the brand-minting module — only lib/idempotency may import it. Compose through the idempotent.* wrappers / the settlement entry point; the brand types are exported from the barrel.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (INTERNAL_DIR.test(filename)) return {};
    const importerDir = path.posix.dirname(filename);

    const checkSource = (node, source) => {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      if (!specifier.startsWith('.')) return;
      const resolved = path.posix.resolve(importerDir, specifier);
      if (BRANDS_MODULE.test(resolved)) {
        context.report({ node, messageId: 'banned', data: { specifier } });
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
