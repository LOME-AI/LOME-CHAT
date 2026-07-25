# Task 05 — Structural fee-seam enforcement (impl-report-2, fix cycle)

## Objective

Close the one validated audit finding: a module-object (namespace) import
bypassed the `money/fee-seams` rule with zero diagnostics, the gap was not in
the docblock's accepted-limitations sentence, and a test pinned the shape as
*allowed*. Orchestrator ruling: implement the stronger option — track the
module-object binding and report the member access — not the docs-only patch.
Everything else about Task 05 was left untouched.

## What changed (stronger option taken; no reason found to weaken it)

The rule now tracks bindings introduced by `import * as m from …` and
`import m from …` (both bind the whole module object, so no fee name appears at
the specifier where the old matcher looked) and reports the fee access at the
member expression: `m.applyMarkupCeil(…)` and `m['applyMarkupCeil'](…)`.

Soundness of the stronger option, checked before implementing:

- **No false positives on legitimate namespace use.** The report fires only on a
  member access whose property matches `/^applyMarkup/` on a binding that scope
  analysis resolves to an import. Namespace imports used for anything else are
  untouched (pinned: `allows a bare module-object binding with no fee-helper
  access`).
- **No cross-file analysis needed.** The property is visible in one file: the
  import plus the member access. Resolution uses `sourceCode.getDeclaredVariables`
  on the `ImportDeclaration` and walks that variable's own references, so a
  same-named local binding that shadows the import is a *different* variable and
  is not reported (pinned: `ignores a fee-helper access on a binding that shadows
  the namespace import`). A name-set match would have false-positived there.
- **Traversal ordering.** References are processed at `Program:exit`, because
  `parent` links are populated by the traversal and are not yet set on
  descendants when the `Program` node is entered. Recorded as a comment at the
  deferral, since it is the non-obvious reason the work is not done inline.

Default imports are tracked alongside namespace imports: both bind a module
object, the member-access shape is identical, and no legitimate default-imported
object in this repo exposes an `applyMarkup*` member. Covering only
`ImportNamespaceSpecifier` would have left the same hole one keyword away.

## Files changed

- `packages/config/eslint-extensions/rules/fee-seams.mjs` — module-object binding
  tracking + member-access reporting (`MODULE_OBJECT_SPECIFIERS`,
  `memberPropertyName`, the `ImportDeclaration`/`Program:exit` pair); docblock
  rewritten so the detection paragraph states the member-access path and the
  limitations sentence is accurate (below).
- `packages/config/eslint-extensions/rules/fee-seams.test.mjs` — 6 new cases; the
  misleading pin rewritten (below).

Nothing else was touched. `packages/config/eslint-extensions/README.md` needed no
change: it names the rule and points at the seam list, and makes no claim about
which syntactic shapes are matched. Its seam-list statement is still true.

## The previously-misleading pin — disposition

`allows default and namespace imports (no named fee binding)` asserted the exact
bypass shape was allowed. It is now
`allows a bare module-object binding with no fee-helper access`, same fixture
(`import shared …; import * as money …; export { shared, money }`), narrowed to
what is genuinely allowed: holding the binding without reaching a fee helper
through it. No test now asserts that the bypass is allowed.

## Tests added (all six red-first)

Fires on a violation:

- `flags a fee helper reached through a namespace import` — `import * as shared`
  + `shared.applyMarkupCeil(1n)` at `chat/domain/turn-context.ts`; the exact
  finding's shape.
- `flags a fee helper reached through a default module-object import` — same via
  `import shared from …` at a web path.
- `flags a string-literal fee-helper access on a namespace import` —
  `shared['applyMarkupCeil'](1n)`; the computed-key variant.

Passes on legitimate code:

- `allows a namespace fee-helper call at every sanctioned seam` — iterates
  `FEE_APPLICATION_SEAMS`, so seam and rule cannot disagree on the new path
  either.
- `ignores a fully dynamic namespace member access` — `shared[key]`; the
  documented limitation, pinned as a limitation rather than left implicit.
- `ignores a fee-helper access on a binding that shadows the namespace import` —
  the false-positive guard that justifies scope resolution over a name set.

TDD evidence (RED): with the tests written and the rule unchanged, the run was
`3 failed | 20 passed` — the three firing cases each `expected [] to have a
length of 1 but got +0`, i.e. failing precisely because the namespace/default
member path was unmatched. The three allow/ignore cases passed before and after
(they guard against false positives the fix could introduce). After the rule
change: `23 passed (23)`.

## Docblock limitations — now accurate

The limitations sentence previously named only dynamic `import()`. It now names
the three shapes that remain unmatched, and each was verified to have **zero
instances in the tree**:

| Limitation | Live instances (grep over `apps packages scripts e2e ops ads`, excluding `node_modules` and `dist`) |
| --- | --- |
| dynamic `import()` destructure of a fee helper | 0 |
| fully dynamic module-object member access (`m[key]`) | 0 |
| `export * as ns from` a non-`money` module | 0 (`export * as` appears nowhere) |

The third is newly named: `export * as ns from './money.js'` was already flagged
(money basename), but the same shape over a non-money source (e.g. the shared
barrel) republishes a module object the star-re-export check does not cover, and
its consumer holds a *named* binding, not a module object, so the new member path
does not see it either. Naming it is the honest statement; closing it was out of
the ruled scope and has no live instance.

## Self-gate

| Command (run from the package dir) | Result |
| --- | --- |
| `npx vitest run --config vitest.package.config.ts eslint-extensions/rules/fee-seams.test.mjs` (rule tests, pre-fix) | **red as designed** — 3 failed / 20 passed |
| same, post-fix, with coverage scoped to the rule file | **pass** — 23/23; **100% stmts (40/40), 100% branch (30/30), 100% funcs (11/11), 100% lines (35/35)** |
| `pnpm test` in `packages/config` (the entry behind `pnpm test:config`) | **354/354 pass**, coverage gate green; run fails only on the POLE gate — see attribution |
| `npx eslint eslint-extensions/rules/fee-seams.mjs eslint-extensions/rules/fee-seams.test.mjs` in `packages/config`, after the final edit | **exit 0** |

### Live probe — the real loader, the real apps/api config

Run from `apps/api` via `eslint --stdin --stdin-filename …` (default formatter),
with a control case so silence is distinguishable from a broken probe:

| Probe | Fixture | Result |
| --- | --- | --- |
| **A — control**, non-seam `src/slices/chat/domain/turn-context.ts` | `import { applyMarkupCeil } from '@hushbox/shared'` | `1:10 error 'applyMarkupCeil' applies the customer fee and is confined to the sanctioned seams … money/fee-seams` — ✖ 1 problem |
| **B — the finding's shape**, same non-seam file | `import * as shared …; shared.applyMarkupCeil(1n)` | `2:21 error 'applyMarkupCeil' … money/fee-seams` — ✖ 1 problem. **The bypass is closed live**, reported at the member expression (col 21), not the import. |
| **C — same code at a seam**, `src/slices/models/domain/normalize.ts` | identical namespace fixture | **no output** — zero errors/warnings; the seam short-circuit still applies to the new path. |

Note on method: the first attempt used `--format compact`, which ESLint 9 removed
from core — it prints `The compact formatter is no longer part of core ESLint`
and no diagnostics, for violating and clean input alike. That probe shape cannot
distinguish "silent" from "did not run"; the table above uses the default
formatter plus the control case instead.

### Failure attribution

- **POLE gate (`packages/config`)** — `eslint-extensions/rules/runtime-primitives.test.mjs`
  19.1s = 57% of the package's test-work. Exactly A1 addendum 6: pre-existing,
  load-sensitive, file unmodified vs HEAD, not touched by this task; this task's
  edits only add test-work elsewhere, which lowers that share. Attributed, not
  chased. (The box was under load average 28–45 from concurrent lanes during
  this run, which inflates the pole's wall-clock share.)
- **`packages/config/arch/rules/single-writer-per-table.rule.{ts,test.ts}` and
  `eslint-extensions/README.md` show as modified in `git status`** — not this
  cycle's work. My only edits this session were the two fee-seams files (the
  README edit is from Task 05's first cycle; the arch-rule edits belong to
  another lane). Untouched, unreverted.

## Acceptance criteria (delta only — the rest are unchanged from impl-report-1)

1. **Rule fails the build on out-of-seam fee-helper use** — still MET, and now
   strictly wider: the module-object bypass is closed on both the namespace and
   default forms, static and string-literal member keys.
2. **Rule tests: fires on synthetic violation, passes on the current tree** —
   still MET. 12 firing cases, 11 passing cases, 100% rule coverage. The wider
   rule adds **zero** violations to the live tree: a repo-wide grep for
   member-style fee access (`.applyMarkup…` / `['applyMarkup…']`) over
   `apps packages scripts e2e ops ads` returns nothing, so there is no existing
   namespace call site to break.
3. Criteria 2, 4, 5 (seam list, allowlist-vs-hoist, vendored-rule conventions)
   are untouched by this cycle and remain as reported in impl-report-1.

## Deviations

None. The stronger of the two offered directions was implemented, plus the
docblock correction (the weaker option) — the finding's remedy either/or was
resolved as both, since an accurate limitations sentence is required regardless
once the set of unmatched shapes changed.

## Concerns and limitations

- **The audit's live-probe method was inconclusive, though its conclusion was
  right.** `eslint --stdin … --format compact` does not work on ESLint 9 — the
  formatter was removed from core, so the command exits after printing
  `The compact formatter is no longer part of core ESLint`, i.e. it prints no
  diagnostics for *any* input, violating or not. I reproduced that first, then
  re-probed with the default formatter (results above) and used a control case
  (a named import, which must fire) so silence could be distinguished from a
  broken probe. The finding itself was independently correct: the rule-level
  RED run proves the shape was unmatched.
- **Limitations remain, and are now named** (table above), each with zero live
  instances.
- The name-prefix coupling (`/^applyMarkup/`) and the test-file exemption are
  unchanged from impl-report-1 and still apply.

## Confidence

**High.** The gap is closed by construction rather than by convention: the fix is
pinned by 6 new rule-level cases (3 watched red for the right reason), the rule
file holds 100% statement/branch/function/line coverage, the false-positive risk
is bounded by scope resolution and pinned by a shadowing case, and a repo-wide
grep confirms the wider rule changes nothing about the current tree's lint
status.

## Cycle 2 — limitations sentence completed (wording + one pin)

**Finding closed:** the limitations sentence named "a dynamic `import()`
destructure" only. With static namespace access now matched, that list reads as
the complete set of unmatched shapes, so the dynamic *module-object* form
(`const m = await import('@hushbox/shared'); m.applyMarkupCeil(1n)`) looked
covered when it is not — the same "documentation implies coverage that does not
exist" defect the cycle-1 fix was ordered to remove.

**Docblock (fee-seams.mjs):** the clause now reads "any dynamic `import()`
binding, whether destructured or held as a module object
(`const m = await import(…); m.applyMarkup…`) — only static import declarations
are tracked". One clause covers both forms, and the trailing half states the
*reason* (the tracking is rooted at `ImportDeclaration`), so a reader can derive
the boundary instead of memorising a list of shapes.

**Test pin added (judgment call — I took the optional pin):**
`ignores a dynamic import() module-object binding (documented limitation)`.
Rationale: the file already pins its other gap the same way
(`ignores a fully dynamic namespace member access`), so the docblock's
limitation list is executable rather than prose that can silently rot — if
someone later closes the gap, the pin fails and forces the docblock to be
updated with it. That is exactly the failure mode this finding is about.

**No behavior change.** Rule source is untouched apart from the docblock; the
new case asserts zero diagnostics.

| Command (from `packages/config`, after the final edit) | Result |
| --- | --- |
| `npx vitest run --config vitest.package.config.ts eslint-extensions/rules/fee-seams.test.mjs` (coverage scoped to the rule) | **pass** — 24/24; still 100% stmts (40/40), branch (30/30), funcs (11/11), lines (35/35) |
| `npx eslint eslint-extensions/rules/fee-seams.mjs eslint-extensions/rules/fee-seams.test.mjs` | **exit 0** |

Unchanged limitations, all still zero live instances: dynamic `import()` (both
forms), fully dynamic member access `m[key]`, and `export * as ns from` a
non-`money` module.
