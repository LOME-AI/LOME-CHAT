# Task 11 — Shared effort options authority: union + Min — impl report 1

## Objective

One shared authority for a turn's effort choice set: `turnEffortOptions(models)`
(union across selected models' offeredLevels + Min when any model can disable)
and `resolveEffortForModel(model, chosen)` (per-model downgrade resolution:
nearest offered, downward only; mandatory-ladder-above → lowest rung). Hoist
`offeredEffortLabels` out of the web hook into shared. Authority + hoist only —
no consumer behavior change (T12/T13 wire consumers).

## EXACT exported signatures (the plan-amendment record for T12/T13/T14)

All exported from `packages/shared/src/estimate/effort-options.ts`, re-exported
through the estimate barrel and the `@hushbox/shared` root barrel:

```ts
/** A canonical rung or 'none' (displayed as Min — reasoning off). 'auto' is a
 *  selection, never a choice — it does not appear in the option set. */
export type EffortChoice = CanonicalReasoningEffort | 'none';

export interface EffortOption {
  readonly choice: EffortChoice;
  /** Largest reasoning budget any selected model runs at under this choice,
   *  after per-model downgrade resolution + catalog clamps (the B term of the
   *  shared headroom sizing). Min is 0 unless a mandatory sibling is forced up. */
  readonly maxReasoningBudgetTokens: number;
  /** Tightest declared provider completion ceiling (maxOutputTokens) across
   *  the selection — the A7 cap term for the client headroom min(). Undefined
   *  when no model declares a valid cap; identical on every option of a turn. */
  readonly completionCapTokens: number | undefined;
}

export type ResolvedEffort =
  | { readonly kind: 'level'; readonly level: OfferedLevel } // {label, wire} — feed planReasoning
  | { readonly kind: 'off' }      // explicit hard off — feed planReasoningOff
  | { readonly kind: 'default' }; // send NO reasoning wire (non-reasoning model,
                                  // or mandatory single-level no-choice model)

/** Ascending Min → Max; [] when nothing selected or nothing reasons. */
export function turnEffortOptions(models: readonly ReasoningPlanModel[]): EffortOption[];

export function resolveEffortForModel(
  model: ReasoningPlanModel,
  chosen: EffortChoice
): ResolvedEffort;

/** Hoisted verbatim (intersection semantics unchanged): the labels EVERY
 *  selected model offers; [] when any model offers nothing. Transitional gate
 *  for the current explicit-level clamp — the union authority is turnEffortOptions. */
export function offeredEffortLabels(
  models: readonly ReasoningPlanModel[]
): readonly CanonicalReasoningEffort[];
```

Input type is `ReasoningPlanModel` (already declares `maxOutputTokens`
explicitly — the A7 structural-passthrough hazard is closed at the shared seam).
Also newly exported from `reasoning-plan.ts`: `validCap(cap: number |
undefined): number | undefined` (was module-private; needed by the cap term —
One Implementation, Shared). It surfaces via the estimate barrel's `export *`
but is NOT added to the root `@hushbox/shared` barrel.

### Resolution semantics (implemented + property-pinned)

- Nearest offered rung at or below the choice (`'none'` sits below every rung,
  so exact-match and downgrade are one downward walk).
- Nothing at/below + model can disable (delegated to `planReasoningOff(model,
  1).feasible` so the predicate cannot drift from the wire path) → `off`
  (BILLING §Effort 8a; also the Min-on-disableable case).
- Nothing at/below + mandatory with offered rungs → lowest rung (§Effort 8b,
  the sole upward exception; also Min-on-mandatory).
- No offered rungs and no off (non-reasoning model, or mandatory single-level
  vocabulary) → `default` (no reasoning wire at all).
- Min inclusion: `'none'` ∈ options ⟺ ∃ selected model with
  `planReasoningOff` feasible.

## Files changed

- `packages/shared/src/estimate/effort-options.ts` — NEW: the shared authority
  (placed in `estimate/` beside `reasoning-plan.ts` because it composes
  `offeredLevels`/`planReasoningOff`/`reasoningBudgetForWire`/`validCap`, all
  estimate-internal; keeps the import graph acyclic and the barrel story flat).
- `packages/shared/src/estimate/effort-options.test.ts` — NEW: 32 tests (see below).
- `packages/shared/src/estimate/reasoning-plan.ts` — one-word change: `export`
  on `validCap` (T06 introduced it private; the cap term reuses it instead of
  mirroring the validity rule).
- `packages/shared/src/estimate/index.ts` — +1 line barrel re-export.
- `packages/shared/src/index.ts` — named exports: `offeredEffortLabels`,
  `resolveEffortForModel`, `turnEffortOptions`; types `EffortChoice`,
  `EffortOption`, `ResolvedEffort`.
- `apps/web/src/hooks/chat/use-reasoning-effort.ts` — deleted the local
  `offeredEffortLabels` implementation; `export { offeredEffortLabels } from
  '@hushbox/shared'` (unicorn/prefer-export-from form) + internal import for
  `effectiveReasoningSelection`; dropped now-unused `offeredLevels`/
  `CANONICAL_REASONING_EFFORTS` imports. No behavior change — intersection
  semantics hoisted verbatim.

## Tests added (all in effort-options.test.ts; behavior — criterion)

- turnEffortOptions (12): single-model ladder + Min; heterogeneous union;
  Min omitted when all-mandatory / mandatory+non-reasoning; Min present with
  any disableable sibling; empty selection → []; non-reasoning-only → [];
  option budget = largest resolved budget (high tier, Min 0); Min sized by the
  mandatory sibling's forced lowest rung (4096); per-model clamps before the
  cross-sibling max; tightest declared completion cap on every option; cap
  carried when a sibling declares none; cap undefined when only invalid caps.
- resolveEffortForModel (10): exact pick; downward-nearest; never-upward when a
  lower rung exists; below-whole-ladder disableable → off (8a); below mandatory
  ladder → lowest rung (8b); Min→off; Min-on-mandatory → lowest rung;
  mandatory no-choice → default; non-reasoning → default; exact offered wire
  carried.
- offeredEffortLabels hoist (5): the four web-test behaviors re-pinned in
  shared + empty selection.
- Bounded-exhaustive property block (4) over 19 reasoning shapes (vocab sizes
  0–6 × mandatory, budget-native, null-enumeration, non-reasoning; all 361
  pairs): (1) options = exact union of offered ladders + Min ⟺ any model can
  disable (independent mandatory/reasoning oracle, not the impl predicate);
  (2) resolution ≡ independent oracle restating the ruled semantics for every
  (model, choice); (3) every option's budget = `reasoningBudgetForWire` of the
  resolved rung; (4) single-model G3: `planReasoning` refuses every unoffered
  explicit label for every model in the space — preserved, `resolveEffortForModel`
  is wired to no caller yet.

No fast-check in the repo (adding a package needs approval), hence
bounded-exhaustive enumeration rather than randomized properties.

## Self-gate

- `pnpm test:shared` — pass (103 files, 2322 tests; per-file coverage gate is
  part of `test` and passed).
- `pnpm test:web` — pass (365 files, 6020 tests). First attempt failed on a
  coverage `.tmp` ENOTEMPTY rmdir teardown flake (environmental — matches the
  known vitest coverage-tmp instability; zero test failures in that run);
  clean rerun exit 0 after the final edits.
- `pnpm typecheck` (repo-wide, per A3) — pass, exit 0.
- `eslint` on owned files, run from each package dir AFTER the final edit —
  exit 0 (`packages/shared`: effort-options.ts/.test.ts, reasoning-plan.ts,
  estimate/index.ts, index.ts; `apps/web`: use-reasoning-effort.ts).
- TDD: test file written first; watched red ("Cannot find module
  './effort-options.js'" — feature missing); implemented to green (32/32).

## A3 sweep (contract-change, repo-wide)

- `offeredEffortLabels` consumers: `use-reasoning-effort.ts` (re-export +
  internal), `use-reasoning-effort.test.ts`, `reasoning-effort-menu.tsx`
  (imports via the hook — unchanged import site). All compile; web tests green.
- `turnEffortOptions` / `resolveEffortForModel` / `ResolvedEffort` /
  `EffortChoice`: no pre-existing references anywhere (new names, no
  collisions).
- `EffortOption`: `reasoning-effort-menu.tsx` declares its own local
  `EffortOption` interface (different shape); it does NOT import the shared
  one, so no conflict — T12 reworks that file and reconciles the name.
- `validCap`: no consumers outside `packages/shared/src/estimate/`.
- Repo-wide `pnpm typecheck` exit 0 (run after the last source edit).

## Deviations

- None from the acceptance criteria. Interface-shape choices the criteria left
  to me (recorded above as the amendment): `EffortOption` carries
  `maxReasoningBudgetTokens` + `completionCapTokens` (A7 cap term);
  `ResolvedEffort.level` is the full `OfferedLevel` (label + exact wire) so
  T13 needs no second ladder lookup; a third `default` variant exists because
  two real catalog shapes (non-reasoning; mandatory single-level vocabulary)
  can neither engage a rung nor send off.
- `completionCapTokens` is identical on every option of one turn (every
  sibling answers regardless of choice); kept per-option because the Handoff
  fixed the return type as `EffortOption[]`.

## Concerns and limitations

- The hoisted `offeredEffortLabels` keeps intersection semantics on purpose
  (behavior freeze); it coexists with the union authority until T12/T13 retire
  its consumers. Its shared doc comment marks it as the transitional gate.
- Min-only option set is possible for the degenerate catalog shape
  `supportedEfforts: []` non-mandatory (offers no rungs but can disable) —
  literal BILLING §Effort 4 reading; property-pinned; downstream single-choice
  handling is T13's §Effort 5 concern.
- Web `EffortModel` still lacks `maxOutputTokens` in its declared type (the A7
  hazard file-side); closing that belongs to T12 when it constructs
  `ReasoningPlanModel` inputs for `turnEffortOptions`.
- Knip (`lint:unused`) not run (not a scoped check; repo has heavy concurrent
  in-flight work): the three new root-barrel exports have no production
  consumers until T12/T13 — if a knip gate runs before T12 lands it may flag
  them.
- The shared package's working tree contains extensive concurrent-lane edits
  (T09/T04 lanes and earlier landed-uncommitted tasks); the `reasoning-plan.ts`
  git diff is almost entirely T06's landed work — my delta there is the one
  `export` keyword.

## Confidence

High — small, pure, exhaustively property-tested module; all scoped suites,
repo-wide typecheck, and per-file lint green; no caller behavior changed
(pinned by the untouched, green web hook/menu tests).
