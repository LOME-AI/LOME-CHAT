/**
 * Admin op-body purity lint rule. Path-scoped-inert: acts ONLY on non-test
 * files under `apps/api/src/slices/admin/domain/operations/` and is silent
 * everywhere else. Op bodies compose published `*WithinTx` helpers on the
 * engine-owned `SettlementTx` — no raw platform time/randomness, no network,
 * no infra/adapter value imports (the ts-morph `admin-op-purity` arch rule
 * carries the structural half: ops importable only by the registry wiring).
 */
import path from 'node:path';

const OP_BODY = /\/apps\/api\/src\/slices\/admin\/domain\/operations\//;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const BANNED_PACKAGE =
  /^(?:drizzle-orm|@hushbox\/db|@neondatabase|@upstash|resend|aws4fetch|cockatiel)(?:\/|$)/;
const ADAPTER_MODULE = /\/adapters\//;

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw Date.now/Math.random/fetch and infra/adapter value imports in admin op bodies (compose published *WithinTx helpers on the engine-owned SettlementTx instead).',
    },
    schema: [],
    messages: {
      dateNow: 'Admin op bodies must not call Date.now() — deterministic effects only.',
      mathRandom: 'Admin op bodies must not call Math.random() — deterministic effects only.',
      fetch:
        'Admin op bodies must not call fetch — no external calls in op bodies (this is what makes preview rollback total).',
      valueImport:
        "Admin op bodies must not value-import '{{specifier}}' — compose published slice barrels on the engine-owned SettlementTx.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!OP_BODY.test(filename) || TEST_FILE.test(filename)) return {};
    const importerDir = path.posix.dirname(filename);

    const checkImport = (node) => {
      if (node.importKind === 'type') return;
      const source = node.source;
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      const banned = specifier.startsWith('.')
        ? ADAPTER_MODULE.test(path.posix.resolve(importerDir, specifier))
        : BANNED_PACKAGE.test(specifier);
      if (banned) context.report({ node, messageId: 'valueImport', data: { specifier } });
    };

    const dateNow = (node) => {
      context.report({ node, messageId: 'dateNow' });
    };
    const mathRandom = (node) => {
      context.report({ node, messageId: 'mathRandom' });
    };
    const bannedFetch = (node) => {
      context.report({ node, messageId: 'fetch' });
    };

    // Both the bare form (`Date.now`) and the global-rooted form
    // (`globalThis.Date.now` / `window.Date.now` / `self.Date.now`); likewise
    // fetch as a bare call and off `globalThis`/`window`/`self`.
    return {
      'MemberExpression[object.name="Date"][property.name="now"]': dateNow,
      'MemberExpression[object.type="MemberExpression"][object.property.name="Date"][property.name="now"]':
        dateNow,
      'MemberExpression[object.name="Math"][property.name="random"]': mathRandom,
      'MemberExpression[object.type="MemberExpression"][object.property.name="Math"][property.name="random"]':
        mathRandom,
      'CallExpression[callee.type="Identifier"][callee.name="fetch"]': bannedFetch,
      'MemberExpression[object.name=/^(globalThis|window|self)$/][property.name="fetch"]':
        bannedFetch,
      ImportDeclaration: checkImport,
    };
  },
};
