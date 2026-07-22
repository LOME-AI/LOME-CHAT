# T7 — fix round (1 validated Minor finding) — impl report 3

## Objective

Comment-only fix in `smart-model-execution.ts`: `paramsRespectingHardOff` was
inserted between `answerParamsWithEffort`'s JSDoc and its function, leaving two
stacked doc blocks — `answerParamsWithEffort` had no attached doc, and the
orphaned doc's claim "Runs reasoning-free (params untouched) when no effort was
classified" was stale (the no-effort branch now delegates to
`paramsRespectingHardOff`). Move the doc to its function and amend the
no-effort sentence.

## Files changed

- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — removed the
  orphaned doc block from above `paramsRespectingHardOff` (whose own doc now
  sits directly on its function) and re-attached it directly above
  `answerParamsWithEffort` with the no-effort sentence amended: "When no
  effort was classified, delegates to `paramsRespectingHardOff` (which
  forwards or strips a built hard-off wire per resolved candidate); params
  stay untouched when the resolved model offers no level or the node carries
  no integer completion cap (G2 — …)". No code line changed.

## Tests added

None — comment-only change; no behavior to pin (TDD does not apply to a doc
move). Existing suite re-run as the regression check.

## Self-gate (scoped per §Gate-policy-amendment)

- `pnpm test:watch src/slices/workflows/nodes/smart-model-execution.test.ts --run`
  (from apps/api) — pass (39/39).
- `npx eslint src/slices/workflows/nodes/smart-model-execution.ts` from
  apps/api, run AFTER the final edit — pass (exit 0).

## Acceptance criteria (per the fix brief)

- Doc block moved to `answerParamsWithEffort` — MET: each of the two
  functions now carries exactly its own attached JSDoc.
- Stale no-effort sentence amended — MET: the doc now states the delegation
  to `paramsRespectingHardOff` (forward-or-strip of the off wire) instead of
  "params untouched"; the no-level / no-cap untouched cases and the G2 note
  are preserved accurately (they still return `node.params` directly).

## Deviations, with reasons

None.

## Concerns and limitations

None. The pre-existing modified state of sibling files in the working tree
(`model-call-execution.*`, the test file) is from earlier T7 rounds /
concurrent tasks and was not touched.

## Confidence

high — a two-edit comment move verified against the code paths it describes;
scoped tests and lint green after the final edit.
