// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Architectural boundaries for the backend (slices + lib + middleware).
 *
 * Enforces the boundary rules from docs/ARCHITECTURE.md:
 * - a slice's `index.ts` barrel is its only public surface (cross-slice
 *   imports of slice internals fail);
 * - routes import only their own domain barrel + middleware (+ externals);
 * - domain imports only its own slice's ports/domain, other slices' barrels,
 *   and the lib dirs — never adapters, never infra libraries;
 * - only adapters import infra libraries;
 * - backend code never reaches into files outside these trees (unknown local
 *   imports fail), which keeps the demoted legacy corpus unreachable.
 *
 * `boundaries/dependencies` rules: the LAST matching rule wins, so broad
 * allows come first and targeted disallows (infra in domain/routes/ports)
 * come last.
 */

// eslint-plugin-boundaries anchors element patterns to process.cwd() unless
// `boundaries/root-path` is set, and `**` never crosses the repo root from a
// package cwd — so under turbo (which lints each package with the package dir
// as cwd) a workspace-package import resolving to ../../packages/*/src would
// classify as an unknown local. Anchor matching to the repo root, derived from
// this file's own location (packages/config/eslint-extensions/) so the value
// is machine-independent.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Module patterns for infra clients that only adapters may import. */
const INFRA_MODULES = [
  '@neondatabase/*',
  '@upstash/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'ioredis',
  'redis',
  'postgres',
  'pg',
  'aws4fetch',
  'resend',
];

// The lib dirs are enumerated (not `lib/**`) because these `files` globs are
// resolved against each consuming package's eslint.config.js base path — a
// bare `**/src/lib/**` would also capture unrelated trees such as the web
// app's `src/lib`. Keep this list in sync with the API's lib layout.
const LIB_GLOB =
  '**/src/lib/{result,errors,resilience,idempotency,jobs,telemetry,context,redis}/**/*';

/**
 * Element layers. Order matters: the first matching descriptor wins, so the
 * specific file-level types (routes, barrels) precede the directory catch-alls
 * and `slice-other` stays last among slice patterns.
 */
const elements = [
  {
    type: 'slice-routes',
    mode: 'full',
    pattern: ['**/src/slices/(*)/routes.ts'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-domain-barrel',
    mode: 'full',
    pattern: ['**/src/slices/(*)/domain/index.ts'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-domain',
    mode: 'full',
    pattern: ['**/src/slices/(*)/domain/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-ports',
    mode: 'full',
    pattern: ['**/src/slices/(*)/ports/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-adapters',
    mode: 'full',
    pattern: ['**/src/slices/(*)/adapters/**/*'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-barrel',
    mode: 'full',
    pattern: ['**/src/slices/(*)/index.ts'],
    capture: ['base', 'slice'],
  },
  {
    type: 'slice-other',
    mode: 'full',
    pattern: ['**/src/slices/(*)/**/*'],
    capture: ['base', 'slice'],
  },
  { type: 'lib', mode: 'full', pattern: [LIB_GLOB] },
  { type: 'middleware', mode: 'full', pattern: ['**/src/middleware/**/*'] },
  // Workspace packages (@hushbox/*) resolve into packages/*/src; classify them
  // so cross-package imports stay allowed instead of failing as unknown locals.
  {
    type: 'internal-package',
    mode: 'full',
    pattern: ['**/packages/(*)/src/**/*'],
    capture: ['base', 'pkg'],
  },
];

const SAME_SLICE = { slice: '{{ from.captured.slice }}' };

export default [
  {
    files: ['**/src/slices/**/*.ts', `${LIB_GLOB}.ts`, '**/src/middleware/**/*.ts'],
    ignores: ['**/*.test.ts', '**/src/slices/_template/**', '**/src/legacy/**'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': REPO_ROOT,
      'boundaries/elements': elements,
      'boundaries/dependency-nodes': ['import', 'export', 'dynamic-import'],
      'import/resolver': { typescript: {} },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          checkUnknownLocals: true,
          rules: [
            // npm packages and node builtins are broadly allowed...
            {
              from: { type: '(slice-*|lib|middleware)' },
              allow: { to: { origin: '(external|core)' } },
            },
            // ...and workspace packages are open to backend code.
            {
              from: { type: '(slice-*|lib|middleware)' },
              allow: { to: { type: 'internal-package' } },
            },
            // The slice barrel re-exports anything from its own slice.
            {
              from: { type: 'slice-barrel' },
              allow: { to: { type: 'slice-*', captured: SAME_SLICE } },
            },
            // Routes: own domain barrel + middleware only.
            {
              from: { type: 'slice-routes' },
              allow: {
                to: [{ type: 'slice-domain-barrel', captured: SAME_SLICE }, { type: 'middleware' }],
              },
            },
            // Domain: own domain/ports + other slices' barrels + lib.
            {
              from: { type: '(slice-domain|slice-domain-barrel)' },
              allow: {
                to: [
                  {
                    type: '(slice-domain|slice-domain-barrel|slice-ports)',
                    captured: SAME_SLICE,
                  },
                  { type: 'slice-barrel' },
                  { type: 'lib' },
                ],
              },
            },
            // Ports: own ports + lib.
            {
              from: { type: 'slice-ports' },
              allow: {
                to: [{ type: 'slice-ports', captured: SAME_SLICE }, { type: 'lib' }],
              },
            },
            // Adapters: own ports/adapters + lib (infra via the external allow).
            {
              from: { type: 'slice-adapters' },
              allow: {
                to: [
                  { type: '(slice-ports|slice-adapters)', captured: SAME_SLICE },
                  { type: 'lib' },
                ],
              },
            },
            // Other slice files (helpers at slice root etc.): own slice + barrels + lib + middleware.
            {
              from: { type: 'slice-other' },
              allow: {
                to: [
                  { type: 'slice-*', captured: SAME_SLICE },
                  { type: 'slice-barrel' },
                  { type: 'lib' },
                  { type: 'middleware' },
                ],
              },
            },
            { from: { type: 'lib' }, allow: { to: { type: 'lib' } } },
            {
              from: { type: 'middleware' },
              allow: {
                to: [{ type: 'lib' }, { type: 'middleware' }, { type: 'slice-barrel' }],
              },
            },
            // Targeted override (last wins): infra clients never appear outside adapters.
            {
              from: { type: '(slice-routes|slice-domain|slice-domain-barrel|slice-ports)' },
              disallow: { to: { origin: 'external' }, dependency: { module: INFRA_MODULES } },
            },
          ],
        },
      ],
    },
  },
];
