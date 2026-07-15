// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import noSecrets from 'eslint-plugin-no-secrets';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import pluginPromise from 'eslint-plugin-promise';
import unusedImports from 'eslint-plugin-unused-imports';
import importPlugin from 'eslint-plugin-import';
import eslintPluginAstro from 'eslint-plugin-astro';
import playwright from 'eslint-plugin-playwright';
import { loadEslintExtensions } from './eslint-extensions/load-extensions.mjs';
import { crossPlatformRestrictedSyntax } from './eslint-parts/cross-platform-restricted-syntax.mjs';

// Per-task config-extension slot: every *.config.mjs in eslint-extensions/ is
// appended to createBaseConfig()'s output so extension rules win flat-config
// rule-key replacement for the files they scope. Contract in
// eslint-extensions/README.md. Top-level await is fine here: ESLint loads
// config files through dynamic import, which resolves the whole module graph.
const extensionConfigs = await loadEslintExtensions(new URL('eslint-extensions/', import.meta.url));

/**
 * Creates the base ESLint configuration with correct TypeScript project resolution.
 * @param {string} tsconfigRootDir - Absolute path to the package/app root (use import.meta.dirname)
 * @returns {import('eslint').Linter.Config[]}
 */
export function createBaseConfig(tsconfigRootDir) {
  return [
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/__test-fixtures-*__/**',
        '**/src/slices/_template/**',
        '**/*.d.ts',
        '**/*.config.js',
        '**/*.config.ts',
        '**/.lintstagedrc.js',
        '**/drizzle.config.ts',
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    sonarjs.configs.recommended,
    pluginPromise.configs['flat/recommended'],
    unicorn.configs.recommended,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      plugins: {
        'no-secrets': noSecrets,
        'unused-imports': unusedImports,
        import: importPlugin,
      },
      settings: {
        // import/* rules (notably import/no-cycle) need a resolver that
        // understands the codebase's `.js`-suffixed ESM relative imports
        // (`./foo.js` -> `foo.tsx`). Without one, resolution silently
        // traverses nothing and the cycle guard catches no cycles.
        // `alwaysTryTypes` lets `.d.ts` declarations resolve too; `project`
        // is scoped to the linting package's own tsconfig via tsconfigRootDir.
        'import/resolver': {
          typescript: {
            alwaysTryTypes: true,
            project: tsconfigRootDir,
          },
        },
      },
      rules: {
        // Import ordering — enforces the project convention from CODE-RULES.md:
        //   1. External dependencies
        //   2. Internal packages (@hushbox/*)
        //   3. Relative imports
        //   4. Type imports last (complements consistent-type-imports below)
        // Most violations auto-fix with `eslint --fix`.
        // Circular dependency guard. A cycle means two modules can't be loaded,
        // tested, or reasoned about independently, and produces order-dependent
        // initialization bugs (a re-exported binding can read as `undefined` if
        // it's touched before the other half of the cycle finishes evaluating).
        // `maxDepth: Infinity` catches indirect cycles, not just direct A↔B.
        // `ignoreExternal` stops traversal into node_modules: cycles through
        // third-party deps aren't ours to fix, and walking them parses
        // un-parseable generated files (e.g. lucide-static's bundled ESM).
        'import/no-cycle': ['error', { maxDepth: Number.POSITIVE_INFINITY, ignoreExternal: true }],

        'import/order': [
          'error',
          {
            groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index'], 'type'],
            pathGroups: [
              {
                pattern: '@hushbox/**',
                group: 'internal',
                position: 'before',
              },
              {
                pattern: '@/**',
                group: 'internal',
                position: 'after',
              },
            ],
            pathGroupsExcludedImportTypes: ['type'],
            'newlines-between': 'ignore',
          },
        ],

        // Secret detection (patterns based on env.config.ts)
        'no-secrets/no-secrets': [
          'error',
          {
            tolerance: 4.2,
            additionalRegexes: {
              'GitHub Token': 'gh[pousr]_[A-Za-z0-9_]{36,}',
              'OpenRouter Key': 'sk-or-[a-zA-Z0-9-]+',
              'Resend Key': 're_[a-zA-Z0-9_]+',
              'Helcim Token': 'api-[a-f0-9]{32}',
            },
          },
        ],

        // Cognitive complexity (strict: 10)
        'sonarjs/cognitive-complexity': ['error', 10],

        // Additional complexity limits
        complexity: ['error', { max: 10 }],
        'max-params': ['error', { max: 4 }],
        'max-depth': ['error', { max: 4 }],
        'max-nested-callbacks': ['error', { max: 3 }],

        // Async patterns (all errors, no warnings)
        'promise/no-nesting': 'error',
        'promise/prefer-await-to-then': 'error',

        // Unused imports (replaces @typescript-eslint/no-unused-vars for imports)
        '@typescript-eslint/no-unused-vars': 'off',
        'unused-imports/no-unused-imports': 'error',
        'unused-imports/no-unused-vars': [
          'error',
          {
            vars: 'all',
            varsIgnorePattern: '^_',
            args: 'after-used',
            argsIgnorePattern: '^_',
          },
        ],

        // Console logging - prevents debug logs in production
        // Errors on: console.log(), console.info(), console.debug(), console.trace(), etc.
        // Allows only: console.warn() and console.error() (legitimate error reporting)
        'no-console': ['error', { allow: ['warn', 'error'] }],

        // Force separate `import type { ... }` lines instead of inline `import { type ... }`.
        // `disallowTypeAnnotations: false` keeps `typeof import('./foo.js')` patterns (used
        // by vitest's `importOriginal<typeof import('./mock.js')>()` mock pattern) working.
        // Keeps top-level type and value imports visually distinct so changes to either
        // don't accidentally pull in the other.
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', disallowTypeAnnotations: false },
        ],

        // Unicorn overrides for project conventions
        'unicorn/prevent-abbreviations': [
          'error',
          {
            replacements: {
              props: false,
              params: false,
              args: false,
              ref: false,
              env: false,
              db: false,
              ctx: false,
              req: false,
              res: false,
              err: false,
              val: false,
              dev: false,
              el: false,
              msg: false,
              dir: false,
              e: false,
            },
          },
        ],
        'unicorn/no-null': 'off',
        'unicorn/filename-case': 'off',
        'unicorn/prefer-ternary': 'off',
        'sonarjs/slow-regex': 'off',

        // Accessibility — force use of accessibility-aware animation hook.
        // Raw window.requestAnimationFrame ignores prefers-reduced-motion settings,
        // so animations keep running for users who explicitly opted out of motion.
        'no-restricted-globals': [
          'error',
          {
            name: 'requestAnimationFrame',
            message:
              'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
          },
        ],

        // Accessibility — block JS animation libraries that don't respect
        // prefers-reduced-motion or our accessibility settings out of the box.
        // framer-motion (project standard) honours MotionConfig + reduced-motion.
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'gsap',
                message:
                  'Use CSS animations or framer-motion — they respect accessibility settings.',
              },
              { name: 'animejs', message: 'Use CSS animations or framer-motion.' },
              {
                name: 'motion-one',
                message: 'Use framer-motion — same author, but framer-motion is project standard.',
              },
            ],
          },
        ],

        // Cross-platform shell-out bans. Selectors live in eslint-parts/ so
        // config entries that override this rule key for a subset of files can
        // re-list them (flat config replaces, never merges, a rule key).
        'no-restricted-syntax': ['error', ...crossPlatformRestrictedSyntax],
      },
    },
    ...extensionConfigs,
  ];
}

/** @type {import('eslint').Linter.Config[]} */
export const testConfig = [
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      // Allow deeper nesting for describe/it/act patterns (standard BDD testing)
      'max-nested-callbacks': ['error', { max: 5 }],

      // Test code often asserts on renderHook results and mock-captured variables
      // that TypeScript narrows to null (control flow can't see mock callbacks)
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Vitest mock functions (vi.fn()) are standalone — not class methods with this binding
      '@typescript-eslint/unbound-method': 'off',

      // Vitest mocks return `any` by design
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Test fixtures contain fake secrets/passwords/IPs
      'no-secrets/no-secrets': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-clear-text-protocols': 'off',

      // Test setup uses nested functions and empty callbacks
      'sonarjs/no-nested-functions': 'off',
      '@typescript-eslint/no-empty-function': 'off',

      // Tests routinely interleave `vi.mock(...)` calls with imports of the
      // mocked module — strict import ordering breaks that pattern. Source
      // files keep the rule on; only tests opt out.
      'import/order': 'off',

      // Tests may use Math.random for test data
      'sonarjs/pseudo-random': 'off',

      // Allow helper functions defined in test scope
      'unicorn/consistent-function-scoping': 'off',
    },
  },
  {
    // Integration tests may need CI debug output
    files: ['**/*.integration.test.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const scriptsConfig = [
  {
    // Match all .ts files when running ESLint from scripts directory
    files: ['**/*.ts'],
    rules: {
      // CLI scripts need console output
      'no-console': 'off',
      // Scripts need process.exit for status codes
      'unicorn/no-process-exit': 'off',
      // Scripts use async IIFE pattern with isMain guard
      'unicorn/prefer-top-level-await': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const devServicesConfig = [
  {
    // The two dev-only service implementations that intentionally log to
    // console: the console email sender and the local Helcim webhook mock.
    // Exact file paths, never a mock* name wildcard — a name-shaped glob
    // silently exempts any future file under a services dir.
    files: ['**/services/email/console.ts', '**/services/helcim/mock-webhook.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const reactConfig = [
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      // Accessibility — recommended baseline. Strict adds stricter
      // role/interaction rules that produce too many false positives in our
      // codebase (Radix primitives, custom interactive wrappers). Recommended
      // catches the high-signal issues without drowning real bugs.
      ...jsxA11y.flatConfigs.recommended.rules,
      'react/prop-types': 'off',

      // Accessibility — block JSX patterns that bypass user accessibility settings.
      // 1. Inline color/font in style props can't be overridden by the global
      //    accessibility CSS layer (contrast, font-scaling, dyslexia fonts, etc.).
      //    Use Tailwind classes or CSS custom properties so the cascade can win.
      // 2. Raw <img> bypasses our <Img>/<Logo> wrappers, which set
      //    `data-no-invert` for invert-colors mode and enforce alt text typing.
      // 3. `window`/`globalThis`.(request|cancel)AnimationFrame is the member-
      //    expression form the `no-restricted-globals` bare-name ban can't see;
      //    both route around `useAnimationFrame`'s reduced-motion handling.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property[key.name=/^(color|backgroundColor|borderColor|fontFamily|fontSize|fill|stroke)$/]",
          message:
            'Do not set color/font in inline styles. Use Tailwind classes or CSS variables so accessibility settings (contrast, font scaling) can override them.',
        },
        {
          selector: "JSXOpeningElement[name.name='img']",
          message: 'Use <Img> from @hushbox/ui (content) or <Logo> (decorative) — never raw <img>.',
        },
        {
          selector:
            "MemberExpression[object.name=/^(window|globalThis)$/][property.name=/^(request|cancel)AnimationFrame$/]",
          message:
            'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
        },
      ],
    },
  },
  {
    // Component-side test-id discipline: every test-id must come from the typed
    // TEST_IDS registry, never a hardcoded literal.
    // reactConfig is composed only into the three product UIs (apps/web,
    // packages/ui, apps/marketing); each lints from its own root, so the `src`
    // glob is relative to that root and covers exactly those source trees. Test
    // and story files are exempt.
    //
    // The style/img selectors from the block above are repeated here because
    // ESLint's no-restricted-syntax does not merge across config blocks — a
    // second `no-restricted-syntax` for these files would otherwise silently
    // drop the accessibility bans. Keep the two selector sets in sync.
    files: ['src/**/*.tsx'],
    ignores: ['**/*.test.*', '**/*.stories.*'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='style'] ObjectExpression > Property[key.name=/^(color|backgroundColor|borderColor|fontFamily|fontSize|fill|stroke)$/]",
          message:
            'Do not set color/font in inline styles. Use Tailwind classes or CSS variables so accessibility settings (contrast, font scaling) can override them.',
        },
        {
          selector: "JSXOpeningElement[name.name='img']",
          message: 'Use <Img> from @hushbox/ui (content) or <Logo> (decorative) — never raw <img>.',
        },
        {
          // Member-expression rAF form (kept in sync with the block above).
          selector:
            "MemberExpression[object.name=/^(window|globalThis)$/][property.name=/^(request|cancel)AnimationFrame$/]",
          message:
            'Use useAnimationFrame from @hushbox/ui instead — respects accessibility motion settings.',
        },
        {
          // Hardcoded string-literal data-testid attribute.
          selector: "JSXAttribute[name.name='data-testid'] > Literal",
          message: 'No literal data-testid — reference the typed TEST_IDS registry.',
        },
        {
          // Template-literal data-testid with a leading literal segment
          // (e.g. `foo-${x}`). Whole-prefix templates whose first segment is an
          // expression (e.g. `${prefix}-x`) and bare `{identifier}` are allowed.
          selector:
            "JSXAttribute[name.name='data-testid'] > JSXExpressionContainer > TemplateLiteral > TemplateElement.quasis:first-child[value.raw!='']",
          message:
            'No literal data-testid segment — build the id from the typed TEST_IDS registry.',
        },
      ],
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const nodeConfig = [
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const workersConfig = [
  {
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.serviceworker,
      },
    },
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const astroConfig = [
  ...eslintPluginAstro.configs.recommended,
  {
    files: ['**/*.astro'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: true,
      },
    },
  },
];

/**
 * Playwright E2E lint enforcement.
 *
 * Lives here, not in `e2e/eslint.config.js`, because `eslint-plugin-playwright`
 * resolves from this package (where it is a dependency) but not from `e2e/`.
 * Composed ONLY into the e2e config, so these rules never reach app/unit code.
 *
 * File globs are relative to the e2e package root (the suite lints via
 * `eslint .` with cwd `e2e/`), so `**` matches every e2e file.
 *
 * The plugin is registered explicitly rather than via `flat/recommended` so the
 * enabled rule set is exactly the rule set we intend, with no extra rules
 * leaking in (recommended would turn on rules we don't want).
 *
 * The e2e-wide `no-restricted-syntax` and `no-restricted-imports` blocks
 * supersede the base config's identical rule keys for e2e files (flat config
 * replaces, not merges, a rule key across matching objects). E2E owns these
 * syntax/import bans; the base execa and animation-library bans have no e2e
 * usage to protect.
 *
 * Because flat config replaces (never merges) a rule key, the spec-only block
 * below must re-list the universal e2e selectors alongside its spec-only ones —
 * otherwise the universal bans would silently vanish on `*.spec.ts` files, where
 * they matter most. The shared selectors are defined once and spread into both.
 */

/**
 * E2E `no-restricted-syntax` selectors that apply to every e2e file (specs and
 * helpers/pages/setup alike): timeout literals, literal test-ids, wall-clock
 * waits, serial describes, and direct `@hushbox/db` imports.
 * @type {{selector: string, message: string}[]}
 */
const e2eUniversalRestrictedSyntax = [
  {
    // (a) numeric literal used as a `timeout:` property value. Matches on `raw`
    // (the source text) not `value`: esquery regex-attribute matching only
    // applies to string values, so `[value=/.../]` silently never matches a
    // numeric literal. `raw` also captures numeric separators (e.g. 30_000).
    selector: "Property[key.name='timeout'] > Literal[raw=/^[0-9][0-9_]*$/]",
    message: 'No inline timeout literals — use a named budget from the timeouts module.',
  },
  {
    // (b) string-literal data-testid as a JSX attribute
    selector: "JSXAttribute[name.name='data-testid'] > Literal",
    message: 'No literal data-testid — reference the typed TEST_IDS registry.',
  },
  {
    // (b) string-literal passed to getByTestId('literal')
    selector: "CallExpression[callee.property.name='getByTestId'] > Literal",
    message: 'No literal test id — reference the typed TEST_IDS registry.',
  },
  {
    // (b) raw `[data-testid="..."]` string selector passed to .locator()
    selector: "CallExpression[callee.property.name='locator'] > Literal[value=/\\[data-testid=/]",
    message: 'No raw [data-testid="..."] selector — build it from the typed TEST_IDS registry.',
  },
  {
    // (c) setTimeout / setInterval calls
    selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
    message: 'No wall-clock waits — gate on app-emitted readiness signals.',
  },
  {
    // (d) test.describe.configure({ mode: 'serial' })
    selector:
      "CallExpression[callee.property.name='configure'] ObjectExpression > Property[key.name='mode'][value.value='serial']",
    message: 'No serial describes outside the @serial allowlist — keep tests order-independent.',
  },
  {
    // (d) describe.serial
    selector: "MemberExpression[object.name='describe'][property.name='serial']",
    message: 'No serial describes outside the @serial allowlist — keep tests order-independent.',
  },
  {
    // (f) importing @hushbox/db (covers static imports the import ban also catches)
    selector: 'ImportDeclaration[source.value=/^@hushbox\\/db(\\/.*)?$/]',
    message: 'Specs must not touch the DB directly — set up state via API/dev endpoints.',
  },
  {
    // (g) Reaching a page's own request context (`page.request.get()`,
    // `authenticatedPage.request.post()`, `this.page.request.get()`) bypasses the
    // single retry mechanism, so a transient saturation drop (5xx envelope or
    // thrown socket hang up) silently isn't retried — the classic way setup
    // flakes enter. The `request`/`authenticatedRequest` fixtures (and every
    // `playwright.request.newContext` the harness creates) are already wrapped by
    // `withRequestRetry`, so use those — or wrap explicitly with
    // `withRequestRetry(page.request)`. A helper's own `this.request` field is
    // expected to already hold a wrapped context, so it is exempt.
    selector:
      "CallExpression[callee.object.type='MemberExpression'][callee.object.property.name='request'][callee.object.object.type!='ThisExpression'][callee.property.name=/^(get|head|post|put|patch|delete|fetch)$/]",
    message:
      'No raw page.request.<method>() — use the wrapped request/authenticatedRequest fixture, or withRequestRetry(page.request), so transient saturation drops are retried.',
  },
];

/** @type {import('eslint').Linter.Config[]} */
export const playwrightConfig = [
  {
    files: ['**/*.ts'],
    plugins: { playwright },
    rules: {
      'playwright/no-element-handle': 'error',
      'playwright/no-eval': 'error',
      'playwright/no-networkidle': 'error',
      'playwright/no-force-option': 'error',
      'playwright/missing-playwright-await': 'error',
      'playwright/no-focused-test': 'error',

      // Raw CSS/signal/media selectors are confined to the page-object + helper
      // abstraction layer, where this rule is intentionally off; specs get it at
      // error (block below). Positional selection (.first/.last/.nth) is a
      // legitimate, clear pattern in this suite, so it is not restricted.
      'playwright/no-raw-locators': 'off',

      // Every async assertion awaited; no floating promises in test flow.
      '@typescript-eslint/no-floating-promises': 'error',

      'playwright/no-wait-for-timeout': 'error',
      'playwright/no-skipped-test': 'error',

      // Point-in-time reads used as assertions are banned; only web-first
      // retrying assertions are allowed.
      'playwright/prefer-web-first-assertions': 'error',

      // Ban implicit per-assertion settling: explicit quiescence only.
      // @hushbox/db ban enforces isolation.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*settled-expect', '*settled-expect.js'],
              message:
                'Import explicit quiescence helpers instead of the auto-settling expect; use waitForSettled where opt-in settling is needed.',
            },
            {
              group: ['node:timers', 'node:timers/promises', 'timers', 'timers/promises'],
              message:
                'No timer primitives in e2e — wall-clock waits are banned (an aliased setTimeout evades the syntax rule). Gate on app-emitted readiness signals or a dev endpoint instead of sleeping.',
            },
            {
              group: ['@hushbox/db', '@hushbox/db/*'],
              message: 'Specs must not touch the DB directly — set up state via API/dev endpoints.',
            },
          ],
        },
      ],
    },
  },
  {
    // Specs must select via semantic locators or page-object methods. Raw
    // CSS/signal selectors belong in the page-object/helper layer (off above),
    // not in specs. Contract tests assert raw signal attributes by design, so
    // they are excluded.
    files: ['**/*.spec.ts'],
    ignores: ['**/contracts/**'],
    plugins: { playwright },
    rules: {
      'playwright/no-raw-locators': 'error',
    },
  },
  {
    // Universal e2e syntax bans. Applies to every e2e file EXCEPT specs, which
    // get the superset block below (flat config replaces this key for
    // *.spec.ts, so the spec block re-lists these).
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax],
    },
  },
  {
    // Spec bans = universal bans + spec-only bans. The spec-only additions:
    // deterministic data, spec-scoped so legitimate logging
    // `new Date().toISOString()` in fixtures stays valid; and cleanup hooks,
    // afterEach/afterAll banned in specs only since setup files legitimately use
    // lifecycle hooks. The universal selectors are re-listed because flat config
    // replaces (never merges) this rule key per file.
    files: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...e2eUniversalRestrictedSyntax,
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'No Math.random in specs — use deterministic, seeded data. Control randomness at the fixture boundary.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'No bare new Date() in specs — pass an explicit timestamp or use page.clock for deterministic time.',
        },
        {
          selector: 'CallExpression[callee.name=/^(afterEach|afterAll)$/]',
          message: 'No afterEach/afterAll in specs — clean up via fixture teardown instead.',
        },
      ],
    },
  },
  {
    // Every test makes ≥1 real assertion. Scoped to specs and
    // excludes setup files, which legitimately lack inline expects. Custom
    // assertion helpers (expect*/assert*/waitFor*/unsettled*) count as assertions.
    files: ['**/*.spec.ts'],
    ignores: ['**/*.setup.ts'],
    plugins: { playwright },
    rules: {
      'playwright/expect-expect': [
        'error',
        {
          assertFunctionPatterns: ['^expect[A-Z]', '^assert[A-Z]', '^waitFor[A-Z]', '^unsettled'],
        },
      ],
    },
  },
];

/** @type {import('eslint').Linter.Config} */
export const prettierConfig = eslintPluginPrettierRecommended;

/**
 * Lints this package itself: ESLint resolves `eslint .` here to this very
 * file, so without a default export the rule-vendoring package would run with
 * an empty config and sit outside the lint gate. Named exports above stay the
 * factory surface other packages import.
 */
/** @type {import('eslint').Linter.Config[]} */
export default [
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  prettierConfig,
];
