# Task 08 — Budgets endpoint hold-awareness — implementation report 2 (fix)

Status: DONE. One validated audit finding (Minor, test pin gap) addressed; nothing
else reworked.

## Objective

Pin the positional holds↔memberRows pairing in `buildBudgetsView`
(`budgets.ts:212,220`) with distinguishable per-scope held amounts, so an
index-off pairing (member A shown member B's held sum, or a member shown the
conversation's) cannot pass the suite. Production code believed correct
(structurally order-preserving); this is a discriminating test, not a bug fix —
and the transposition check confirmed no real pairing bug exists (`budgets.ts`
unchanged net).

## Files changed

- `apps/api/src/slices/conversations/domain/budgets.integration.test.ts` — new
  discriminating pairing test; hoisted a shared `resolveScopesFor` helper into
  the `hold-aware effective remaining` describe (the new test's scope
  resolution was structurally identical to the first hold test's inline
  closure — `sonarjs/no-identical-functions` fired; both tests now use the one
  helper, which is also the cleaner "production scope resolution only" shape).
- `apps/api/src/slices/conversations/domain/budgets.ts` — **no net change**. A
  deliberate transposition (`index + 1` → `holds.length - 1 - index`) was
  applied locally twice to observe the new test discriminate, and restored
  exactly both times (verified by grep of line 220 and a final green run).

## Test added

- `budgets.integration.test.ts › hold-aware effective remaining › pairs each
  member with their OWN held sum (distinct per-scope amounts)` — two members
  (cap A=1e9, cap B=2e9, spent 0), conversation cap 10e9, owner wallet 100e9;
  two REAL `admitRun` holds via the production `resolveBudgetScopes`:
  run 1 = 3e8 against {member A, conversation}, run 2 = 5e8 against
  {member B, conversation}. Held sums: A=3e8, B=5e8, conversation=8e8 — all
  pairwise distinct. Exact served assertions, rows found by `memberId` (no
  ordering assumption):
  - member A: min(1e9−0−3e8=7e8, 10e9−0−8e8=9.2e9, 100e9) = **`700000000`**
  - member B: min(2e9−0−5e8=1.5e9, 9.2e9, 100e9) = **`1500000000`**
  Holds released in a `finally` (test leaves no residue for siblings).
- Criterion covered: the audit finding's suggested direction verbatim (two
  members, two runs of different estimates against different scope sets, each
  member's distinct served remaining).

## Evidence the test discriminates (observed, this session)

Ran twice — once before and once after the lint-driven helper refactor, so the
FINAL test text is what was proven:

1. Transposed `budgets.ts:220` to `holdReadoutAt(holds, holds.length - 1 - index)`
   → new test **failed**: `AssertionError: expected '500000000' to be
   '700000000'` — member A served member B's held sum, the exact failure mode
   the finding describes. Notably the 15 pre-existing tests **all still passed**
   under the transposition, confirming the gap was real.
2. Restored the index → 16/16 green.
   The transposition was never committed; `git diff`-visible `budgets.ts`
   content is byte-identical to the pre-fix Task-08 state (line 220 =
   `holdReadoutAt(holds, index + 1)`).

## Self-gate (Verified, this session)

- `pnpm test:watch src/slices/conversations/domain/budgets.integration.test.ts`
  (the relevant file; real Postgres + Redis) — **16 passed (16)**, final run
  after the restore.
- `npx tsc --noEmit` (apps/api) — exit 0 after the refactor edits.
- `npx eslint src/slices/conversations/domain/budgets.integration.test.ts
src/slices/conversations/domain/budgets.ts` from `apps/api` — **exit 0 after
  the last edit** (the initial version tripped `sonarjs/no-identical-functions`;
  fixed by sharing the helper, not by disabling).

## Deviations

- The shared `resolveScopesFor` helper touched the FIRST hold test's two
  call sites (inline closure replaced by the helper) inside the owned test
  file. Forced by the lint rule; behavior and assertions of that test are
  unchanged (16/16 green includes it).

## Concerns and limitations

- None. Full `pnpm test:api` was not re-run for this one-file test addition;
  the change is test-only in a single file whose full suite ran green, and
  report 1 already attributed the full-suite state.

## Confidence

High — the pin was watched to fail under a deliberately transposed pairing (the
exact defect class the finding names) and pass when restored, with all three
held sums pairwise distinct so any index confusion (member↔member or
member↔conversation) breaks an exact-value assertion.
