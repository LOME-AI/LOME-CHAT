# Task 05 — Structural fee-seam enforcement (impl-report-1)

## Objective

Make the fee-application confinement structural: a build gate that fails when a
fee helper (`applyMarkup` / `applyMarkupCeil`, and any future sibling) is
imported or re-exported outside the sanctioned seams, so the T02–T04
relocation cannot regress.

## Layer decision — ESLint (import graph), not arch/ts-morph

Justified, per the acceptance criterion "pick the layer that can actually see
the property":

1. **The property is an import-graph property.** "Who may import the fee
   helper" is visible at the import specifier. `packages/config/arch/README.md`
   states the split explicitly: *"Related structural rules that ESLint CAN
   express live in the eslint layer instead … one mechanism per rule, never
   both."* An arch rule here would duplicate a mechanism ESLint already owns
   (the `no-legacy-imports` precedent is the same shape: importer-filename
   allowlist + specifier match).
2. **Coverage is decisive.** `arch/run.ts`'s `SOURCE_GLOBS` cover
   `apps/api/src/slices`, `apps/web/src`, `packages/*/src` — they do **not**
   cover `scripts/`. One of the three definition-time seams lives at
   `scripts/lib/e2e-seeded-image-model.ts`, and a future violation anywhere in
   `scripts/`, `e2e/`, `ops/`, or `ads/` would be invisible to `arch:check`.
   ESLint runs in every package through `createBaseConfig`.
3. **Feedback + non-entanglement.** Lint fires in-editor and pre-push per file;
   `arch:check` is a separate root gate. Keeping the rule in the lint layer also
   keeps it decoupled from the out-of-run `arch:check` push-lane state, as the
   brief required. (`pnpm arch:check` is green as of this run — 11 rules, the
   same 11 as before; this task adds no arch rule.)

## Allowlist vs hoist — ALLOWLIST both definition-time sites

Decision: **allowlist**, not hoist. Neither file was touched, so both pinned
values are byte-identical and both original tasks' tests stay green untouched
(`packages/shared/src/estimate/search-reservation.test.ts`,
`scripts/lib/e2e-seeded-image-model.test.ts` — unmodified; verified by the
files-changed list below).

Justification per site:

- **`packages/shared/src/estimate/search-reservation.ts`** — the constant is
  `applyMarkupCeil(BigInt(MAX_SEARCH_TOOL_CALLS) × usdToNanoUsd(SEARCH_COST_PER_CALL))`,
  built from two **estimator-domain** constants in `estimate/constants.js`.
  Hoisting it into `money.ts` inverts the dependency: `money.ts` is a
  deliberately domain-free nano-USD primitive module, and it would have to
  import the estimator's search vocabulary. That trades a one-line data entry
  for a layering violation in the most-imported money module in the repo.
- **`scripts/lib/e2e-seeded-image-model.ts`** — a synthetic e2e catalog row's
  rate. Hoisting an e2e fixture value into `packages/shared/src/money.ts` would
  ship test-fixture data inside the production shared bundle consumed by web,
  api, and the sandbox origin. Strictly worse.
- **Both are genuinely seams, not violations.** Each bakes a *raw provider
  figure* billable exactly once at module init — semantically the same act as
  ingestion (`normalize.ts`), which is why they can't be priced "over billable
  rates". The rule's correct job is to *name* them with their reason, which the
  seam list does.

## Files changed

- `packages/config/eslint-extensions/rules/fee-seams.mjs` — **new.** The
  vendored rule: flags any import specifier or `export … from` source-side name
  matching `/^applyMarkup/`, plus star re-exports of a `money` module (the
  laundering path), unless the importing file is an allowlisted seam or a test
  file.
- `packages/config/eslint-extensions/rules/fee-seams.test.mjs` — **new.** 17
  programmatic ESLint cases (below).
- `packages/config/eslint-extensions/fee-seams.config.mjs` — **new.** The topic
  extension file; holds `FEE_APPLICATION_SEAMS`, the single authoritative seam
  list, each entry commented with why it is a seam. Loaded automatically by
  `load-extensions.mjs`, so every package linting through `createBaseConfig`
  gets it with no consumer-config change.
- `packages/config/eslint-extensions/README.md` — a "Current vendored rules"
  section per the directory's convention, naming where the seam list lives and
  stating that adding a seam is a billing-architecture decision, not a lint fix.
- `packages/shared/src/money.ts` — comment only: the `applyMarkup` docblock now
  records that this module is where fee application is *defined*, and that the
  rule matches by name prefix, so a future helper must keep the `applyMarkup`
  prefix to stay covered. (No code change; shared typecheck green.)
- `packages/shared/src/index.ts` — comment only: marks the barrel's money
  re-export as *publication, not application*, and points at the seam list.

The other four seam sites already carry explicit "why this is a seam" prose in
their existing docblocks (verified by reading each): `normalize.ts`
(`billableRate`: "the 15% markup, ceil-rounded against the user (BILLING.md
§Fee Structure)"), `billing/domain/money.ts`
(`providerUsdToBillableNanoUsd`: "the ONLY place the markup lands on the money
path … the other seam is catalog rate baking at ingestion"),
`search-reservation.ts` ("the billable reservation is baked ONCE here at
definition (ceil, against the user — the same seam rule as ingestion)"),
`e2e-seeded-image-model.ts` ("baked with the SAME ceil-markup helper normalize
uses, so this row can never drift"). Left untouched — no edit was needed to
satisfy the comment criterion, and touching them would risk the pinned values.

## The seam list (ONE place: `fee-seams.config.mjs`)

Exactly the A10 + A10-addendum inventory:

| Seam | Why |
| --- | --- |
| `packages/shared/src/money.ts` | Defines the helpers; fee math composes internally here and nowhere else. |
| `packages/shared/src/index.ts` | The root barrel publishes the helpers to the sanctioned seams (publication, not application). |
| `packages/shared/src/estimate/search-reservation.ts` | Web-search reservation constant: a raw provider per-call figure baked billable once at definition (ceil). |
| `apps/api/src/slices/models/domain/normalize.ts` | Catalog ingestion — every stored rate baked billable (ceil). Money-path seam #1. |
| `apps/api/src/slices/billing/domain/money.ts` | The ModelProvider port's charge conversion (half-even). Money-path seam #2. |
| `scripts/lib/e2e-seeded-image-model.ts` | Synthetic e2e catalog row, baked with the same ceil helper so the seeded row can never drift from ingestion. |

A test pins the list to exactly this set, so silently widening it fails
`test:config`.

## Tests added (`fee-seams.test.mjs`, 17 cases)

Fires on a violation:

- `flags an applyMarkupCeil import outside the sanctioned seams` — the base case (chat domain).
- `flags an applyMarkup import regardless of local alias` — `as bake` rename doesn't hide it (web).
- `flags a fee-helper import from any module path, not only the shared barrel` — relative `./money.js`.
- `flags a future fee helper matching the applyMarkup* name pattern` — `applyMarkupFloor`, the "designate by pattern" criterion.
- `flags a named re-export that launders a fee helper outward`.
- `flags a renaming re-export (matching is on the source-side name)`.
- `flags a star re-export of a money module outside the seams` — the barrel-laundering path.
- `reports one violation per matching specifier` — 2 of 3 specifiers flagged.
- `flags a string-literal import name (ES2022 arbitrary module namespace names)`.

Passes on legitimate code:

- `allows every sanctioned seam site to import the fee helpers` — iterates `FEE_APPLICATION_SEAMS`, so the list and the rule can never disagree.
- `allows the shared barrel to publish the helpers via named re-export`.
- `allows test files to import the helpers for expected-value math`.
- `allows unrelated imports from the shared barrel` (`usdToNanoUsd`, `roundHalfEvenDiv`).
- `allows star re-exports of non-money modules`.
- `allows default and namespace imports (no named fee binding)`.
- `ignores local declarations that merely match the name pattern`.
- `pins the seam list to exactly the sanctioned inventory`.

TDD: the suite was written first against a not-yet-existing
`fee-seams.config.mjs` and watched fail at import resolution, then the rule +
config were written to green. The two later edge cases (string-literal name,
default/namespace) were added after the first green as additional red→green
steps for branch coverage.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm vitest run --config vitest.package.config.ts eslint-extensions/rules/fee-seams.test.mjs` (coverage scoped to the rule) | **pass** — 17/17; rule file 100% stmts / 100% branch / 100% funcs / 100% lines |
| `pnpm test` in `packages/config` (the package test entry behind `pnpm test:config`) | **pass** — 348/348, coverage gate green |
| `npx eslint .` in `packages/config` (after final edit, from the package dir) | **pass** — exit 0 |
| `npx eslint .` in `packages/shared` | **pass** — exit 0 |
| `npx eslint .` in `scripts` | **pass** — exit 0 |
| `npx eslint .` in `apps/api` | fee-seams violations: **0** (pre-existing unrelated errors — see attribution) |
| `npx eslint .` in `apps/web` | fee-seams violations: **0** (pre-existing unrelated errors — see attribution) |
| `npx eslint .` in `packages/{crypto,db,realtime,ui}`, `e2e` | fee-seams violations: **0** each |
| `npx tsc --noEmit -p packages/shared/tsconfig.json` | **pass** — exit 0 |
| `pnpm arch:check` | **pass** — `OK — 11 rule(s) over 1932 file(s)` |

Repo-wide confirmation independent of lint: a grep for `applyMarkup` across
`apps packages scripts e2e ops ads` (excluding `node_modules`, test files, and
this rule's own tree) returns importers at exactly the six seam files and
nothing else — `apps/api/dist/**` hits are stale build output, not linted
source. Also verified the A10 surface claim holds: the billing domain barrel
re-exports `providerUsdToBillableNanoUsd`, not `applyMarkup`
(`apps/api/src/slices/billing/domain/index.ts:16-23`).

### Failure attribution

Every non-fee-seams lint error observed is pre-existing / concurrent-lane and
untouched by this task (`git status` snapshot taken before the first edit; none
of these files are in this task's changed set):

- `apps/api/src/slices/billing/domain/charge.integration.test.ts:17` — unused
  `sharedLinks` import (2 errors). Not a file this task touches; T18's lane owns
  that tree.
- `apps/web/src/hooks/billing/use-prompt-budget.ts` and a web test file —
  9 prettier/formatting errors. In-flight T12/T16/T19 web lane (A11, A1
  addendum 4 name this file).

Neither class involves `money/fee-seams`; the rule reports zero across the
whole repo, which is the "passes on the current tree" criterion.

## Acceptance criteria

1. **Rule fails the build on out-of-seam fee-helper use, at the layer that can
   see the property** — MET. Vendored ESLint rule `money/fee-seams`, error
   severity, repo-wide via the extension loader; layer choice justified above.
   Coverage extends beyond named helpers via the `/^applyMarkup/` pattern
   (test: `applyMarkupFloor`), and beyond direct imports to named re-exports,
   renaming re-exports, and money star re-exports.
2. **Seam list is data in ONE place, exactly the A10 inventory, every site
   commented with WHY** — MET. `FEE_APPLICATION_SEAMS` in
   `fee-seams.config.mjs`, six entries, each with its reason in the list's
   docblock and each seam file carrying its own why-prose in situ; pinned by a
   test.
3. **Rule tests: fires on synthetic violation, passes on the current tree** —
   MET. 9 firing cases, 8 passing cases, 100% rule coverage; the current tree
   verified violation-free by per-package lint runs plus the repo-wide grep,
   with in-flight dirt attributed above.
4. **Allowlist-vs-hoist decided and justified; pinned values untouched if
   hoisted** — MET. Allowlist chosen, reasoned per site; both files unmodified,
   so their pinned values are byte-identical and their tests stayed green
   untouched.
5. **Vendored-rule conventions per the READMEs** — MET. One topic file
   `<topic>.config.mjs` default-exporting an array of flat-config entries;
   self-scoped `files` glob with absolute-filename self-scoping inside the rule
   (the `no-legacy-imports` precedent, cited in the rule's docblock); rule
   implementation in `rules/<topic>.mjs` with a colocated
   `<topic>.test.mjs`; loader untouched; README updated.

## Deviations

None from the acceptance criteria. Two judgment calls the plan left open, both
exercised and recorded above: the lint-vs-arch layer choice, and
allowlist-over-hoist.

One thing the plan's Files line permitted that I did **not** need: no
allowlist-annotation or import-hoist edits at the seam sites. The only
out-of-`packages/config` touches are two comment-only edits in
`packages/shared/src/{money.ts,index.ts}` — named here as required. Both are
prose in existing docblocks; no code, no behavior, no pinned value changed.

## Concerns and limitations

- **Dynamic `import()` is not matched.** A `const { applyMarkup } = await
  import('@hushbox/shared')` would slip past. Documented in the rule's
  docblock. No sanctioned dynamic-import pattern for money math exists in the
  backend, and the shape is conspicuous in review; matching it would require
  tracking destructure patterns across an await boundary, which the "keep
  checks syntactic" convention argues against. Cheap to add if it ever appears.
- **Name-prefix coupling.** The pattern is `/^applyMarkup/`. A future fee helper
  named e.g. `bakeFee` would not be covered. This is why `money.ts`'s docblock
  now states the naming requirement at the point of definition — the one place
  a helper author will be reading.
- **Test files are exempt** by design (they compute expected values with the
  real helpers, e.g. `settlement.integration.test.ts`). A production fee bug
  cannot hide in a test file, but note the exemption is by filename suffix, so
  a non-test helper file named `*.test.ts` would be exempt — not a shape that
  exists.
- The rule reports on the specifier node, so a multi-symbol import yields one
  message per offending symbol (pinned by a test) — intended, since each is a
  separate leak.

## Confidence

**High.** The rule's behavior is pinned by 17 rule-level unit tests at 100%
coverage against synthetic fixtures (no dependence on the live tree's
in-flight state), the current tree is verified clean by both the lint runs and
an independent repo-wide grep, and the two judgment calls are argued from the
repo's own documented conventions (`arch/README.md`'s one-mechanism-per-rule
split, `money.ts`'s domain-free layering) rather than preference.
