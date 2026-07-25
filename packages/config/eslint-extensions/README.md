# ESLint config-extension slot

This directory is the extension point for the shared ESLint config.
`packages/config/eslint.config.js` automatically loads every file in this
directory matching `*.config.mjs` (via `load-extensions.mjs`) and appends the
entries to the array returned by `createBaseConfig()`. Every package that lints
through `createBaseConfig` therefore picks extensions up automatically — no
consumer config changes needed.

## Contract

- **One file per topic**, named `<topic>.config.mjs`
  (e.g. `boundaries.config.mjs`). Each file owns exactly one concern; edit the
  file that owns your concern, and never edit the loader
  (`load-extensions.mjs`) — add a new topic file instead.
- Each file must **default-export an array** of flat-config entries
  (`import('eslint').Linter.Config[]`).
- Every entry **must scope itself with `files` globs**. Extensions are
  appended after the base config, so for matching files an extension's value
  for a rule key _replaces_ the base config's value — flat config replaces,
  never merges, a rule key. If you override a rule key the base config also
  sets (e.g. `no-restricted-syntax`), re-list the base selectors (see
  `../eslint-parts/`).
- `files` globs resolve against each consuming package's eslint.config.js
  base path. A glob meant for one app's tree must therefore be either
  layout-specific enough not to match other packages, or the rule must
  self-scope by ABSOLUTE filename (see the vendored rules in `rules/`).
- Files are loaded in **lexicographic filename order**, so composition is
  deterministic.
- A broken extension file **fails loudly**: a missing/non-array default export
  or an import-time error breaks every lint run. There is no silent skip — fix
  the file or delete it.
- Vendored rule implementations live in `rules/` as topic-named `.mjs` files
  with colocated `<topic>.test.mjs` suites and `__test-fixtures-<topic>__/`
  fixture trees (anything not matching `*.config.mjs` directly in this
  directory is ignored by the loader).

## Current vendored rules

Topic files are self-documenting (each opens with its rationale). Two carry
data an editor must know about:

- `no-legacy-imports` — bans imports into the quarantined repo-root `/legacy/`
  corpus, repo-wide, exempting the corpus itself.
- `fee-seams` — confines the fee-application helpers (`applyMarkup*` from
  shared money) to the sanctioned seams. **The seam list is data in exactly one
  place**: `FEE_APPLICATION_SEAMS` in `fee-seams.config.mjs`, each entry
  carrying the reason it is a seam. Adding a seam is a billing-architecture
  decision (BILLING.md §Fee Structure), not a lint fix — the default remedy for
  a violation is to price over already-billable rates instead.

## Why this exists

Multiple lint concerns land in the same shared config. Without an append-only
slot they would all edit `eslint.config.js` and conflict. With it, each
concern ships exactly one topic file here.
