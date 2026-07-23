# impl-report-4 — video duration slider inverted range fix

## Objective

Founder-ordered fix (investigator side finding, plan §Known-foreign-failures item): `modality-config-panel.tsx` derives the video duration slider's min/max positionally (`supportedDurations[0]` / `.at(-1)`) from `videoDurationsFor`, which returned the catalog intersection unsorted — an unsorted catalog duration set (e.g. `[8, 4, 6]`) rendered an impossible inverted range (`min="8" max="6"`), breaking video cost-preview e2e specs. Fix: sort ascending at the single derivation point (`videoDurationsFor`), never per consumer.

## Files changed

- `apps/web/src/components/chat/media/modality-config-panel.tsx` — `videoDurationsFor` now returns the intersection sorted ascending (`toSorted((a, b) => a - b)`), with a comment recording why the sort lives at the derivation point. 5-line additive diff; no restructure (file carries another workstream's uncommitted edits).
- `apps/web/src/components/chat/media/modality-config-panel.test.tsx` — one new test (additive, inside the existing `VideoDurationControl` describe block).

## Why not `agreedOptions` or the store

- `agreedOptions` (`src/lib/multi-model-agreement.ts`) is shared with resolution/aspect-ratio pills whose documented contract is "preserving the first-model ordering" — sorting there would change pill ordering semantics for non-duration consumers. Out of bounds and wrong.
- The store's `snapDuration` path uses `snapToNearest`, which is nearest-neighbour and order-independent — no other consumer takes durations positionally. Verified by reading `src/stores/model.ts` and `src/lib/multi-model-agreement.ts`.

## Tests added

- `derives min/max from an unsorted catalog duration set without inverting the range` — one selected video model whose catalog `supportedVideoDurationsSeconds` is `[8, 4, 6]`; asserts slider `min="4"` / `max="8"`. Covers the fix's single acceptance criterion.

## TDD

- RED verified: test failed with `min="8"` (the exact inverted-range symptom from the diagnosis) before the fix.
- GREEN verified: 50/50 tests pass in the file after the fix.

## Self-gate (scoped per §Gate-policy-amendment)

- `pnpm vitest run src/components/chat/media/modality-config-panel.test.tsx` (from `apps/web`) — pass, 50/50.
- `npx eslint <both touched files>` after final edit, from `apps/web` — pass (first run caught `unicorn/no-array-sort`; fixed by switching to `toSorted`).
- `npx tsc --noEmit -p tsconfig.json` (apps/web) — 2 errors, both verbatim §Known-foreign-failures entries, on files I never touched:
  - `../api/src/middleware/pipeline-bindings.ts(59,29)` `ExecutionContext` — attributed foreign.
  - `src/components/chat/model-selector/model-list-body.test.tsx(41,5)` — attributed foreign (pre-existing committed code per plan).
  No errors in my touched files.

## Acceptance criteria

- Duration set sorted ascending at the derivation point, single authority — **met** (sort inside `videoDurationsFor`; consumers unchanged).
- TDD with unsorted-catalog fixture, watched red — **met** (RED failure `min="8"` observed, then GREEN).
- Additive/minimal diff, no restructure of the foreign-edited file — **met** (5 lines in the helper + 1 test).

## Deviations

None.

## Concerns and limitations

- Pre-existing duplication noted, not touched (out of bounds): `src/stores/model.ts` has its own `agreedVideoOptions` intersection re-implementing `agreedOptions`'s logic — a One-Implementation-Shared candidate for a future ruling; harmless to this fix since that path is order-independent.

## Confidence

High — RED reproduced the exact reported symptom, GREEN pinned it, all 50 file tests pass, lint clean, both remaining typecheck failures match the plan's recorded foreign failures exactly.
