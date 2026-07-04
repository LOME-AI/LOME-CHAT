/**
 * The workflow engine/node purity lint set. Two vendored rules, each with a
 * deliberately different scope; both self-scope by absolute filename, so the
 * broad `files` glob below is safe:
 *
 * - `engine-node-purity` is path-scoped-inert: it acts ONLY on files under
 *   slices/workflows/engine + nodes and is silent everywhere else. There it
 *   bans raw Date.now/Math.random/fetch (in favor of ctx.clock/ctx.rng and
 *   injected ports) and bans slice-barrel/infra value imports inside node
 *   executions. Billing and other slices are never flagged.
 * - `capability-registry-only` is repo-wide by design: it confines runtime
 *   imports of the capability node executions to the live execution registry,
 *   so a billing (or any other) file reaching into a `*-execution` module IS
 *   flagged — that is the point. It exempts only the registry, the node
 *   modules themselves, and test files.
 */
import engineNodePurity from './rules/engine-node-purity.mjs';
import capabilityRegistryOnly from './rules/capability-registry-only.mjs';

const enginePurityPlugin = {
  meta: { name: 'engine-purity', version: '1.0.0' },
  rules: {
    'engine-node-purity': engineNodePurity,
    'capability-registry-only': capabilityRegistryOnly,
  },
};

export default [
  {
    name: 'engine-purity',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'engine-purity': enginePurityPlugin },
    rules: {
      'engine-purity/engine-node-purity': 'error',
      'engine-purity/capability-registry-only': 'error',
    },
  },
];
