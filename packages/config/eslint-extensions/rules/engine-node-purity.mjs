/**
 * The workflow engine/node purity rule. `WorkflowCtx` is closed: engine and
 * capability-node code touch time and randomness only through `ctx.clock` /
 * `ctx.rng` (deterministic flow control, testable in-process), never the raw
 * platform globals, and never the network. Node executions additionally get
 * their dependencies by injection — they must not import infra or another
 * slice's barrel for a runtime value; the ValueStore seam is their only
 * content access.
 *
 * Vendored (not core no-restricted-syntax / no-restricted-imports) because
 * flat config replaces, never merges, a rule key across config objects —
 * reusing a core rule here would clobber the base config's bans for every
 * matching file. Self-scopes by absolute filename, so the config glob stays
 * broad and the base path of the consuming package is irrelevant.
 */
import path from 'node:path';

const ENGINE_OR_NODES = /\/apps\/api\/src\/slices\/workflows\/(engine|nodes)\//;
const NODES = /\/apps\/api\/src\/slices\/workflows\/nodes\//;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CROSS_SLICE_BARREL = /\/apps\/api\/src\/slices\/(?!workflows\/)[^/]+\/index\.[cm]?[jt]s$/;
const BANNED_PACKAGE = /^@hushbox\/db(\/|$)/;

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw Date.now/Math.random/fetch in the workflow engine and node code (use ctx.clock/ctx.rng), and slice-barrel/infra value imports in node executions (inject dependencies instead).',
    },
    schema: [],
    messages: {
      dateNow:
        'Use ctx.clock.now() — raw Date.now() is banned in engine/node code (deterministic flow control).',
      mathRandom:
        'Use ctx.rng.random() — raw Math.random() is banned in engine/node code (deterministic flow control).',
      fetch: 'No network calls in engine/node code — nodes receive their ports by injection.',
      valueImport:
        "Node executions must not import '{{specifier}}' for a runtime value — inject the dependency through the registry (only `import type` is allowed for a barrel).",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    if (!ENGINE_OR_NODES.test(filename) || TEST_FILE.test(filename)) return {};
    const inNodes = NODES.test(filename);
    const importerDir = path.posix.dirname(filename);

    const checkNodeImport = (node) => {
      if (!inNodes || node.importKind === 'type') return;
      const source = node.source;
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      const banned = specifier.startsWith('.')
        ? CROSS_SLICE_BARREL.test(path.posix.resolve(importerDir, specifier))
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
      ImportDeclaration: checkNodeImport,
    };
  },
};
