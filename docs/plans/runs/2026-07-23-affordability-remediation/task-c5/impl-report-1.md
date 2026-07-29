# C5 — impl report 1

## Objective

A trial turn on `auto` is classified like a paid one, priced with the classifier reserve
inside the 1¢ ceiling — never silently degraded to a reasoning-free turn.

## Order of work (the acceptance criterion that is about process, not code)

1. **Money pin written first, at the route.** `refuses a trial auto send whose classifier
   reserve overruns the 1¢ ceiling (402)` in `routes.integration.test.ts`, plus its premise
   companion `runs the classifier-reserve fixture without auto (201 — the answer alone fits)`.
2. **Watched red** (verbatim below). Nothing in `src/` had been touched at this point — the
   only edits in the tree were to `routes.integration.test.ts`.
3. Domain money pin + the storage/hooks pins written next in `smart-model-turn.test.ts`,
   watched red (4 failures, verbatim below).
4. Only then: `smart-model-turn.ts`, `routes.ts`, `turn-definition.ts`, `domain/index.ts`.
5. Re-ran, widened to the whole chat slice, took scoped coverage, `eslint --fix`, re-lint.

### The money pin's verbatim red, before the classifier was wired

```
 FAIL  |api| src/slices/chat/routes.integration.test.ts > chat route: POST /chat/trial > refuses a trial auto send whose classifier reserve overruns the 1¢ ceiling (402)
AssertionError: expected 201 to be 402 // Object.is equality

- Expected
+ Received

- 402
+ 201

 ❯ src/slices/chat/routes.integration.test.ts:4050:24
    4050|     expect(res.status).toBe(402);
```

The `201` is the defect itself: the trial send was accepted and compiled reasoning-free.
The premise companion ran green at that same moment (`Tests 1 passed | 195 skipped`), which
is what makes the `402` mean *the reserve*, and not the model gate refusing an over-cap
model.

### The domain pins' verbatim red

```
AssertionError: expected { kind: 'fallback' } to deeply equal { kind: 'unaffordable' }   (×2)
AssertionError: expected { admission: 'chat', …(1) } to deeply equal { admission: 'trial', …(1) }
AssertionError: expected { inputChars: 40, tier: 'free' } to be undefined
```

The last two are the handed-over hazard, reproduced: reused as-is, the paid compiler stamped
`{ inputChars: 40, tier: 'free' }` and the paid `chat` hooks onto a turn that never persists.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/chat/domain/smart-model-turn.ts` | `hooks` becomes a parameter of `compileAutoEffortTurn` / `buildAutoEffortTurnDefinition` (it reached both `buildSmartModelTurn` and `withStorageStamp`, which were hardcoding the chat policy); `AutoEffortTurnBuild` gains `unaffordable`, split out of `fallback`. |
| `apps/api/src/slices/chat/routes.ts` | Trial `auto` routes through the paid compiler under `TRIAL_TURN_HOOKS`; `unaffordable` ⇒ 402; the single-model tail extracted so the auto arm and the level arm share it, not duplicate it. Paid caller passes `CHAT_TURN_HOOKS` and keeps its current behaviour on `unaffordable`. |
| `apps/api/src/slices/chat/domain/turn-definition.ts` | The reasoning-free `auto` arm of `trialReasoningSelection` deleted; its parameter type now excludes `'auto'`, so the deletion cannot be reintroduced by a caller. |
| `apps/api/src/slices/chat/domain/index.ts` | Exports `compileAutoEffortTurn`, so the trial arm compiles from the catalog snapshot its eligibility gate already read (one read, no refresh straddle). |
| `apps/api/src/slices/chat/routes.integration.test.ts` | The money pin and its premise, the inversion pins, the fixture and the catalog helper they need. |
| `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` | Trial-arm domain tests; existing paid call sites take the new required argument. |
| `apps/api/src/slices/chat/domain/turn-definition.test.ts` | Three `auto` unit tests removed with the branch they covered (see *Tests inverted*). |

## Tests added

| Name | Behaviour | Criterion |
| --- | --- | --- |
| `refuses a trial auto send whose classifier reserve overruns the 1¢ ceiling (402)` | Route-level refusal when answer + reserve exceeds the ceiling | the money pin |
| `runs the classifier-reserve fixture without auto (201 — the answer alone fits)` | The premise: same model, same prompt, no auto ⇒ accepted | non-vacuity of the pin |
| `reports a model whose classifier reserve overruns the ceiling as unaffordable` | Domain-level form of the same refusal | the money pin |
| `admits the same rates once the classifier is not bought` | Reserve-free half of the pair, priced by the estimator | non-vacuity |
| `reports a budget that cannot fund the minimum classified turn as unaffordable` | The 1-nano budget case now reports the money outcome | the split variant |
| `classifies a trial auto send instead of running it reasoning-free` | Trial auto compiles a `smartModel` node with `classify: { model: false, effort: true }` | classified, not degraded |
| `leaves a classified trial definition unstamped and on the trial policy` | Route-level: no storage stamp, trial hooks | the hooks hazard |
| `carries the trial policy hooks onto the classified definition` | Domain-level hooks | the hooks hazard |
| `leaves the classified trial definition unstamped, so no storage is held` | Domain-level stamp absence | the hooks hazard |
| `opens the effort dimension on the single-candidate slot` | Node shape | classifier present |
| `prices the classifier reserve into the admission estimate` | Deactivating the one declared dimension moves the estimate by exactly the shared reserve | reserve in the estimate |
| `keeps a trial auto send on the regular turn for a non-reasoning model` | The deterministic arm still takes the regular compile | fallback preserved |

## Acceptance criteria

**Routes through the existing paid-path compiler, no new pricing logic — MET.**
`trialAutoDefinitionOrRefusal` calls `compileAutoEffortTurn`, the same function
`pinnedAutoDefinitionOrNull` calls for a paid send. The only arithmetic added anywhere in
this change is none: the fit is `fitAnswerCapToCeiling` against `payerSpendableNanoUsd(budget)`,
already there, and the reserve is `estimateSmartModelNode`'s existing
`classifierReserveNanoUsd`. Pinned by `prices the classifier reserve into the admission
estimate`, which measures the delta against `classifierReserveLineItems` + `reservationCeiling`
rather than against a number copied out of the estimator.

**Money test first, red before the classifier was wired — MET.** Above.

**The reasoning-free fallback is deleted, not bypassed — MET.**
`trialReasoningSelection`'s `auto` arm is gone from the source. It cannot be reached by a
caller either: the parameter is `Exclude<ReasoningEffortSelection, 'auto'>`, so a caller
passing `auto` fails typecheck. The two legitimate behaviours the old arm also carried
(sole-choice deterministic pick; a non-reasoning model runs reasoning-free) were duplicates
of `resolveTurnReasoning`'s `autoEntries`, which the fallback path now reaches — one
authority, pinned in `turn-reasoning.test.ts`.

Where no classifier can be built the send already fails with the typed
`CLASSIFIER_UNAVAILABLE` — `compileAutoEffortTurn`'s existing `err` arm, which the trial
route surfaces through `respondDomainError`. Unchanged, and now reachable from trial.

**Hooks are a parameter; a trial turn stamps no storage — MET.** `compileAutoEffortTurn`
takes `hooks: PolicyHooks` as a **required** parameter, deliberately not an optional with a
paid default: a default is exactly the shape that produced the hazard. Evidence: the
red above showed `{ inputChars: 40, tier: 'free' }` stamped; four tests (two domain, one
route, plus the hooks pins) now hold `storage` undefined and `hooks` = trial.

**Accepted costs recorded — acknowledged, unchanged.** ~0.05¢ absorbed per trial turn; 1–3
of ~190 trial-eligible models drop below the gate. The second is what the new 402 arm is.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch run apps/api/src/slices/chat` (37 files) | pass — 811/811, exit 0. Re-run after the final `eslint --fix`, same result. |
| `npx turbo typecheck --force --continue` (repo-wide, uncached) | pass — 16/16 |
| scoped coverage, `turn-definition.ts` over the chat slice | 99.58 / 97.57 / 100 / 100 |
| scoped coverage, `smart-model-turn.ts` over the chat slice | 100 / 98.64 / 100 / 100 |
| scoped coverage, `routes.ts` over the chat slice | 97.13 / 95.65 / 100 / 100 |
| `npx eslint <7 owned files>` from `apps/api`, after the last edit | exit 0, no output |

Each coverage run used **one** `--coverage.include` and its **own** `reportsDirectory`
under the scratchpad, so no two runs shared `apps/api/coverage/.tmp` and no run was measured
against a denominator its suites did not drive. `pnpm test:api` was **not** run — G8 owns it.

## Deviations

- **`compileAutoEffortTurn` exported from the chat domain barrel.** The alternative was to
  call `buildAutoEffortTurnDefinition`, which re-reads the catalog. The trial arm has a
  catalog snapshot in hand from its eligibility gate, and the premium percentile, the
  classifier-engine pick and the compile should not be able to straddle an hourly refresh.
  One added export.
- **The single-model trial compile extracted into `trialSingleTurnDefinition`.** The auto
  arm's fallback needs it as well as the level arm; extracting was the alternative to a
  second copy.

## Tests inverted or removed, named

Three unit tests in `turn-definition.test.ts` were **removed with the branch they covered**,
not rewritten:

- `resolves 'auto' reasoning-free when the model offers multiple choices (no static pick)`
  — this is the pinned defect. It asserted the behaviour C5 exists to delete.
- `resolves 'auto' on a non-reasoning model to no reasoning`
- `picks the sole real choice deterministically on a Min-only model ('auto' → 'off')`

The latter two describe behaviour that still exists, but not in this function — they were
duplicates of `resolveTurnReasoning`'s, which `turn-reasoning.test.ts` pins at
`resolves 'auto' on a non-reasoning model to no reasoning (no refusal, no entry)` and
`picks the sole choice deterministically on a Min-only model ('auto' → hard off)`. Keeping
them here would have been a second copy of one authority's contract. A comment in their
place records why the function no longer has an `auto` domain.

One test in `smart-model-turn.test.ts` was **inverted**:

- `falls back when no reasoning level leaves answer headroom under the budget` →
  `reports a budget that cannot fund the minimum classified turn as unaffordable`. Its
  fixture (a 1-nano free budget) always tripped the **funds** check, never the ladder check
  — the old name described the wrong cause. The ladder-check `fallback` arm keeps its own
  coverage through the Min-only, mandatory-single-level, capless and non-reasoning cases.

Six existing paid call sites in `smart-model-turn.test.ts` gained the required `hooks`
argument (`CHAT_TURN_HOOKS`). No assertion in them changed.

## Concerns and limitations

- **Paid and trial answer `unaffordable` differently, and that asymmetry is deliberate but
  worth a second reader.** A paid send treats it as `fallback` and lets admission speak —
  its existing behaviour, unchanged by this task. A trial send refuses. If the paid
  reasoning-free degrade is itself judged a §Effort 5 violation, that is a separate finding
  about a non-trial path, which this task was told to report rather than change.
- **`compileAutoEffortTurn` still returns `fallback` for an unpriceable model** (`pricings
  === undefined`), and on the trial path that reaches the regular compile, which resolves
  `auto` reasoning-free if the model has ≥ 2 choices. I believe it is unreachable from trial
  — `trialEligibility` refuses a model the money layer cannot project, ahead of the compile
  — but I did not construct a test for it, because I could not construct the state.
- Client-side reachability of the new 402 is not in this task's ownership: the trial
  composer will now be refused on the 1–3 models whose reserve does not fit, and whether the
  picker greys them ahead of the send is E-lane work.
- No E2E was run (Global Constraint 11); none was touched.

## Confidence

**High.** The money pin was red at the route for the exact defect and green after, with a
premise companion that makes the refusal attributable to the reserve; the hooks hazard
reproduced verbatim before the fix; the whole chat slice (811 tests) is green; repo-wide
typecheck is 16/16 uncached; every owned file clears 95 on all four coverage axes from a
run whose denominator I named.
