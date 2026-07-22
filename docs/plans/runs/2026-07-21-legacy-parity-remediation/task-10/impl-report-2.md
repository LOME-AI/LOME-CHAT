# T10 (R18) — impl report 2 (audit-fix round)

Two validated audit findings fixed, both confined to
`apps/api/src/slices/workflows/nodes/smart-model-execution.ts` (+ its colocated test).
T09's settlement-conflict regions untouched (10 markers verified present; settlement.ts not
edited this round).

## FINDING 1 [parity] — single-candidate short-circuit now badges

**Fix.** The single-candidate short-circuit (`runSmartModel`, was line ~85) now threads
`smartModelRan: true` into its `answerCall`, so the chip badges — strict legacy parity (the
single-eligible short-circuit returns `resolveOk` → `stagesRun` includes `'smart-model'` →
`derivedIsSmartModel` is true). The short-circuit still runs NO classifier and emits no
classifier charge; only the display signal changed.

**RED→GREEN.** Updated the test that pinned the wrong behavior:
`smart-model-execution.test.ts` — renamed "does NOT badge the single-candidate short-circuit"
→ "badges the single-candidate short-circuit — the Smart pipeline still ran (legacy parity)",
now asserting `smartModelRan === true`.
- RED (before fix): `AssertionError: expected undefined to be true`.
- GREEN (after fix): passes.

## FINDING 2 [observability / CODE-RULES] — degrade breadcrumb, still no Sentry

**Fix.** The widened classifier catch no longer swallows silently. It now emits a non-Sentry
structured breadcrumb through the typed logger before degrading:

```
deps.telemetry?.warn('smartModel classifier failed; falling back to cheapest candidate', {
  modelName: node.classifierModelId,
});
return {};
```

- `msg` is a compile-time string literal.
- The only field is `modelName` (an allowlisted `SafeLogFields` key) carrying the classifier
  model id — NEVER the caught error, prompt, output, content, or PII. The thrown error is not
  bound (`catch {`) and never reaches the logger.
- `.warn` is a structured Workers-Logs line, NOT `.captureError` — no Sentry event fires. This
  preserves legacy's observability intent (legacy `console.error`'d the failure "so it isn't
  silently swallowed") within the SafeLogFields doctrine, while keeping the expected-degrade
  (not-a-defect) no-Sentry behavior. The `eslint-disable catch-swallow/no-silent-catch` stays
  (justification updated: expected degrade + breadcrumb, no Sentry) — the rule still flags any
  catch that neither rethrows nor calls captureError, which is exactly the deliberate choice
  here.

**RED→GREEN.** Extended the thrown-classifier degrade test to inject a `fakeTelemetry()` spy
and assert:
- `telemetry.warn` called with `(expect.any(String), { modelName: CHEAP })`,
- `telemetry.captureError` NOT called,
- fallback answer still returned (`value === 'cheap answer'`, no charge, `smartModelRan` true).
- RED (before fix): `AssertionError: expected "vi.fn()" to be called with arguments …`
  (warn never called).
- GREEN (after fix): passes.

## Files changed (this round)
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — thread `smartModelRan: true`
  on the single-candidate short-circuit; emit the non-Sentry `warn` breadcrumb in the classifier
  degrade catch (comments updated).
- `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts` — `Telemetry` import +
  `fakeTelemetry()` spy; single-candidate test flipped to assert `true`; degrade test extended
  with breadcrumb + no-Sentry assertions.

## Self-gate
- `smart-model-execution.test.ts` — **pass** (25/25).
- Touched suites, coverage-free — `apps/api/src/slices/workflows/engine` +
  `apps/api/src/slices/chat/domain` — **pass** (655 passed, 2 skipped [the
  by-design-skipped `smart-model.integration.test.ts`]).
- `npx eslint <all T10-owned files>` from `apps/api` after the last edit — **exit 0**.
- `pnpm typecheck` (api + shared, isolated `--force`) — **pass**.

## Foreign failure attributed out (RAISE)
Running the wider route/models smartModel suites surfaced ONE failure, foreign to T10:
`conversations/routes.integration.test.ts > refuses a removal without a strictly higher
privilege` — `expected { code: 'PRIVILEGE_INSUFFICIENT' } to deeply equal { code: 'FORBIDDEN' }`.
That is T05's objective (R14: member-removal refusal returns `PRIVILEGE_INSUFFICIENT`) landed
in `conversations/domain/members.ts` with a stale route-integration assertion still expecting
`FORBIDDEN`. It is in the conversations slice, unrelated to smartModel, and outside T10's file
bounds — not caused by, and not fixable within, this task. (The run's working tree carries all
concurrent implementers' changes, so `git diff` is not a per-task signal; the failure's subject
— member-removal privilege — pins it to T05.)

## Confidence
high — both findings fixed with observed RED→GREEN; breadcrumb proven content/PII-free and
Sentry-free; single-candidate now badges; all touched suites green; T09 regions intact; the
one wider-suite failure attributed to concurrent T05 work with evidence.
