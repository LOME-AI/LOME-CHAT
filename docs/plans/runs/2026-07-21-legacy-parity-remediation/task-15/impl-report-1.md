# T15 impl-report-1 — R17 per-model discrete video-duration pre-flight

**Status: DONE.** Rounds 1–2 surfaced blockers; the coordinator ruled them (rulings 1, 3,
A, B). Implemented against those rulings, TDD, all self-gates green. `wire-params.ts` and the
video-adapter left untouched per ruling A.

## Objective
Reject out-of-set video durations at pre-flight with `UNSUPPORTED_DURATION` (matching legacy's
per-model 400), instead of failing at the provider.

## Design as implemented (per rulings)
- **Ruling 1 (key rename):** video-duration ParamSpec key `duration`→`durationSeconds`, aligning the spec key with the request-parameter name every consumer uses.
- **Ruling B (value type):** the duration enum's VALUES are built as integer seconds (`model.durations.map(Number).filter(Number.isInteger && >0)`), so a numeric request `durationSeconds` matches `compileParamSpec`'s strict `includes` membership (the wire catalog carries durations as strings; without this a valid in-set `8` was wrongly rejected).
- **Ruling A / Path 1 (wiring):** the pre-flight runs in `runModelCall` (the modelCall node entry — smartModel's generations bypass it via `streamModelCall`, so classifier/language stay unaffected) using the node-reachable `@hushbox/shared` `compileParamSpec` primitive (a runtime cross-slice barrel value import — the unreachable `compileWireParams` — is banned by engine-node-purity; boundaries also bar the adapter from `../domain`). On out-of-set → `err({ reason: ERROR_CODES.UNSUPPORTED_DURATION })` (NodeRunError.reason → wire code); the wireCode lives at that err site. `compileWireParams`/`wire-params.ts` left untouched (pre-existing dead code, flagged for a Phase-4 note).
- **Ruling 3 (escape hatch):** the gate is scoped by presence of a `durationSeconds` enum spec — a video model that declared no durations (and every non-video model) has no such spec, so any duration passes.

## Files changed (all in-bounds; wire-params.ts + video-adapter untouched)
- `apps/api/src/slices/models/domain/normalize.ts` — `videoParameters()`: key `duration`→`durationSeconds`; enum values → integer seconds (durable comment on why).
- `apps/api/src/slices/models/domain/list-models.ts` — `enumIntegers(descriptor,'durationSeconds')` (reads the renamed key; `supportedVideoDurationsSeconds` wire field name unchanged).
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts` — added `compileParamSpec` import; added `durationOutOfSupportedSet()` helper; wired the video-only, discrete-set-only pre-flight in `runModelCall` before the streamed call.
- `apps/api/src/slices/models/domain/normalize.test.ts` — assertion re-keyed to `durationSeconds` + numeric `[4,8]` (RED-first).
- `apps/api/src/slices/models/domain/list-models.test.ts` — three ParamSpec fixtures re-keyed `duration`→`durationSeconds` (RED-first).
- `apps/api/src/slices/workflows/nodes/model-call-execution.test.ts` — added `VIDEO` fixture + `videoDescriptorWithDurations()` helper + 6 pre-flight tests.

## Tests added (name — behavior — criterion)
- `rejects an out-of-set video duration at pre-flight with UNSUPPORTED_DURATION, before the provider call` — an out-of-set duration on a discrete-set model errs with `reason: UNSUPPORTED_DURATION` and the provider (a `throwingProvider`) is never reached — criterion (a). RED verified (provider was reached before the fix).
- `accepts an in-set numeric video duration and runs the generation` — numeric `8` in a `[4,8]` set passes and streams — criterion (b), proves ruling B.
- `accepts any duration for a video model that declares no discrete duration set (escape hatch)` — a video descriptor with `parameters:{}` accepts `durationSeconds:5` — criterion (c), ruling 3.
- `does not gate a language call carrying generation params (the duration pre-flight is video-only)` — a text model with `{maxOutputTokens:100}` runs — criterion (d).
- `does not gate an image call carrying generation params (the duration pre-flight is video-only)` — an image model with `{aspectRatio:'1:1'}` runs — criterion (d).
- (classifier: structurally unaffected — smartModel routes through `streamModelCall`, never `runModelCall`; the untouched smart-model-execution suite stayed green.)
- list-models `projects a video descriptor ... capability lists` stays green asserting `supportedVideoDurationsSeconds` = `[4,6,8]` after the rename — criterion (e); the models `routes.integration.test.ts` end-to-end also passes.

## Self-gate
- `vitest run src/slices/models src/slices/workflows` (via with-env for the 6 integration files) — **pass**: 1032 unit + 70 integration + earlier scoped runs; `normalize.test.ts` 75/75, `list-models.test.ts` 21/21, `model-call-execution.test.ts` 59/59. (Raw `npx vitest` first reported 6 integration files failing at a `DATABASE_URL`/`UPSTASH` module-load env guard — an artifact of bypassing `with-env`/`ensure-stack`; all 6 pass through the wrapper. Full `test:api` OOMs in this sandbox per the plan's Phase-4 note, so scoped coverage-free runs were used.)
- ESLint (owned files, from `apps/api`, after the LAST edit) — **pass** (exit 0). Includes the engine-purity plugin, so the `compileParamSpec` node import is confirmed purity-clean. One prettier wrap was fixed and re-linted.
- Typecheck — `apps/api` `tsgo --noEmit` and `tsc --noEmit` both **0 errors**. The only repo typecheck error is the pre-existing `apps/api/src/middleware/pipeline-bindings.ts:59 TS2304 ExecutionContext`, surfaced by `@hushbox/admin`'s cross-package check of that untouched middleware file — attributed out per the coordinator (unrelated to R17; that file is not in this task).

## Acceptance criteria
1. Key reconcile + value-type — **met** (normalize.ts key `durationSeconds` + numeric enum; `normalize.test.ts:785` pins it; image/language ParamSpecs untouched).
2. Pre-flight wired carrying `UNSUPPORTED_DURATION` — **met** via `compileParamSpec` in `runModelCall` → `err({reason: UNSUPPORTED_DURATION})` (Path 1, ruling A; `compileWireParams` deliberately untouched).
3. Tests (out-of-set→refused, in-set→passes, valid video succeeds, escape hatch, image/language unaffected, `supportedVideoDurationsSeconds` still emitted) — **met**.

## Deviations (all ruled/authorized)
- Pre-flight uses `compileParamSpec` (the shared primitive `compileWireParams` wraps), not `compileWireParams` itself, because `compileWireParams` (models/domain) is unreachable from both the node (engine-node-purity) and the adapter (boundaries). Ruled: Path 1, ruling A.
- The duration-check helper is a targeted single-field validation, not full-param validation, keeping the change surgical to duration (resolution/aspectRatio still handled by the adapter as before).

## Concerns / limitations
- Two duration-refusal mechanisms now coexist and are complementary: this pre-flight (reads the catalog-derived `durationSeconds` ParamSpec) upstream, and the mock-provider's `assertSupportedVideoDuration` (reads the static `getSupportedVideoDurations` VEO table) inside the test double. Different capability sources; neither was changed by this task; no conflict.
- `compileWireParams`/`resolveMediaInputs` in `wire-params.ts` remain dead (untouched per ruling A) — flagged for the Phase-4 dead-code note, not this task.

## Confidence
High — every criterion has a RED-then-GREEN test verified this session; the rename's out-of-bounds reader (`list-models.ts`) and the client wire field (`supportedVideoDurationsSeconds`) are pinned green; typecheck/lint clean on all owned files.
