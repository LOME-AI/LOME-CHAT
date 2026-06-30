// @ts-check
import { crossPlatformRestrictedSyntax } from '../eslint-parts/cross-platform-restricted-syntax.mjs';

/**
 * `vi.mock` ban on internal-slice imports.
 *
 * Internal slices are never mocked: tests call the real barrel (CODE-RULES:
 * mocks exist only at true external seams — gateway, payments, email, push).
 * Those seams live under a slice's `adapters/` directory, so `vi.mock`
 * targets under `adapters/` (and plain npm modules) stay allowed.
 *
 * Both entries re-list the base cross-platform selectors because flat config
 * replaces (never merges) the `no-restricted-syntax` rule key.
 */

const MOCK_BAN_MESSAGE =
  'Internal slices are never mocked — tests call the real barrel. vi.mock is allowed only for true external seams (gateway, payments, email, push adapters).';

/**
 * `vi.mock('…slices/…')` targeting a slice barrel or slice internal, by any
 * path shape (relative, alias, or package-style), unless the target points
 * into an `adapters/` directory (the external seams).
 */
const mockSlicePathSelector = {
  selector: String.raw`CallExpression[callee.object.name='vi'][callee.property.name='mock'][arguments.0.value=/(^|\u002F)slices\u002F(?!.*\u002Fadapters\u002F)/]`,
  message: MOCK_BAN_MESSAGE,
};

/**
 * Relative `vi.mock('./…' | '../…')` inside a slice's own tests resolves to a
 * slice-internal module by construction, except targets under `adapters/`.
 */
const mockRelativeSliceSelector = {
  selector: String.raw`CallExpression[callee.object.name='vi'][callee.property.name='mock'][arguments.0.value=/^\.\.?\u002F(?!.*adapters\u002F)/]`,
  message: MOCK_BAN_MESSAGE,
};

export default [
  {
    // Enumerated lib dirs for the same base-path reason as boundaries.config.mjs.
    files: [
      '**/src/lib/{result,errors,resilience,idempotency,jobs,telemetry,context}/**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...crossPlatformRestrictedSyntax, mockSlicePathSelector],
    },
  },
  {
    files: ['**/src/slices/**/*.test.ts'],
    ignores: ['**/src/slices/_template/**', '**/src/legacy/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...crossPlatformRestrictedSyntax,
        mockSlicePathSelector,
        mockRelativeSliceSelector,
      ],
    },
  },
];
