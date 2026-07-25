# Task 13 — Server effort resolution: downgrade + no static auto — impl report 1

## Objective

The server accepts the turn's UNION effort choice set and resolves it per model
through the shared `resolveEffortForModel` downgrade rule; every static auto
path dies (`AUTO_REASONING_EFFORT_ORDER` deleted, and the residual fixed
`['high','medium','low']` reserve walk in `smart-model-turn.ts` with it);
classifier-unbuildable becomes a typed error. SERVER SCOPE ONLY — no web file
touched (A11 hard bar honoured).

## Files changed

- `packages/shared/src/error-codes.ts` — new `CLASSIFIER_UNAVAILABLE` code +
  its `ERROR_MESSAGES` copy (the map is `satisfies Record<ErrorCode, string>`,
  so `friendlyErrorMessage` is covered by construction).
- `packages/shared/src/error-codes.test.ts` — pins the code, its own copy, and
  that it is neither the generic fallback nor the plain `UNAVAILABLE` copy.
- `apps/api/src/slices/chat/domain/turn-reasoning.ts` — the task's core.
  `AUTO_REASONING_EFFORT_ORDER` + `autoEntryFor` + the unanimity `levelEntries`
  deleted; resolution now splits single-model (G3 preserved verbatim) from
  multi-model (union option set + per-model `resolveEffortForModel`), and
  `auto` is deterministic-or-silent.
- `apps/api/src/slices/chat/domain/turn-reasoning.test.ts` — union/downgrade/
  mandatory-up/Min-only/G3 unit pins; the static-order test deleted.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `trialReasoningSelection`'s
  auto arm now takes the SOLE real choice (or reasoning-free) instead of walking
  the deleted static order; import swap only otherwise.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — trial auto arm
  re-pinned (multi-choice → reasoning-free; Min-only → `'none'`).
- `apps/api/src/slices/chat/domain/turn-definition.integration.test.ts` — new
  `multi-model effort resolution` block (union pick, downgrade-to-off,
  mandatory-up, non-reasoning sibling silent, outside-the-set refusal, G3
  preserved, Min-only `auto`) + `seedVariantModel`/`openModel` helpers.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — (a) A7: the
  hand-built `TurnModelPricing` in `answerMaxOutputTokens` now threads the
  tightest candidate `maxOutputTokens` (extracted `tightestCompletionCap`),
  including the no-cap fallback branch; (b) `autoEffortAnswerCap` walks the
  model's OWN offered option budgets descending instead of the fixed
  `['high','medium','low']`; (c) `compileAutoEffortTurn` returns
  `Result<AutoEffortTurnBuild, DomainError>`: < 2 real choices ⇒ `fallback`,
  no priceable engine ⇒ typed `unavailable` carrying `CLASSIFIER_UNAVAILABLE`.
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — A7 cap pin,
  strongest-rung reserve pin, Min-only fallback, typed-refusal pin, and the
  mechanical `_unsafeUnwrap()` re-pins the Result signature forces.
- `apps/api/src/slices/chat/routes.integration.test.ts` — end-to-end 503
  `CLASSIFIER_UNAVAILABLE`, multi-model union send (201, per-sibling wires),
  and the two placeholder-wire assertions re-pinned to wire-silence.

`apps/api/src/slices/chat/routes.ts` was NOT edited: the union resolution is
entirely inside the build, and the new typed error rides the existing
`respondDomainError` → `domainWireCode` path (`unavailable` → 503). Recording
this as a deviation from the plan's Files list — see Deviations.

## Tests added (behavior — criterion)

Unit — `turn-reasoning.test.ts`:
- sibling lacking the union level → hard off, not a 400 (§Effort 8a) — *union
  pick / downgrade*.
- mandatory sibling below its ladder → its LOWEST rung (§Effort 8b) — *mandatory-up*.
- chosen level → nearest offered rung BELOW, never up — *downgrade*.
- non-reasoning sibling → wire-silent, no error ('default' = silence, A8) — *A8*.
- multi-model `none` → per-model (mandatory sibling runs lowest rung).
- choice outside the union option set → typed validation error.
- level with no reasoning sibling anywhere → refused; `none` there stays a no-op.
- all-unknown model list → empty map.
- `auto`: ≥2 choices → reasoning-free; Min-only → hard off (deterministic pick);
  single-level mandatory → silent; multi-model sole-union-choice applied per model.

Unit — `turn-definition.test.ts`: trial `auto` multi-choice → reasoning-free;
Min-only → `'none'` (deterministic single-choice pick, §Effort 5).

Unit — `smart-model-turn.test.ts`: tightest candidate completion cap bounds the
ceiling (A7); reserve covers the STRONGEST offered rung (> `max` budget, the
old fixed order under-reserved a Max-offering model); Min-only → fallback;
no priceable engine → `unavailable` + `CLASSIFIER_UNAVAILABLE`.

Integration — `turn-definition.integration.test.ts` (7 cases, real catalog):
union pick verbatim, downgrade-to-off, mandatory-up, non-reasoning silence,
outside-the-set refusal, **G3 single-model refusal preserved**, Min-only `auto`.

Integration — `routes.integration.test.ts`: 503 + `{code:'CLASSIFIER_UNAVAILABLE'}`
end-to-end; multi-model send at a level only one model offers → 201 with
`[{effort:'low'},{enabled:false}]` sibling wires.

## TDD evidence

- `error-codes.test.ts` written first → red (`ERROR_CODES.CLASSIFIER_UNAVAILABLE`
  undefined) → green.
- `turn-reasoning.test.ts` rewritten first → 9 failures for the right reasons
  (union cases returning validation errors / static medium picks) → implemented
  → 27/27 green.
- `turn-definition.test.ts` trial arm → red (`AUTO_REASONING_EFFORT_ORDER is not
  iterable` after the deletion, then wrong selection) → green.
- `smart-model-turn.test.ts` → 12 red (A7 cap `expected 3900 to be 1200`, Result
  signature, typed error) → green 39/39.
- Integration pins: red verified by temporarily restoring the old unanimity rule
  in `resolveTurnReasoning` — 3 of the new cases failed, the rest passed; the
  file was restored from a scratchpad copy and re-verified green (13/13). No
  temporary code remains (`grep -c TEMPORARY` → 0).

## Self-gate

- `pnpm test:api` (full package, coverage gate on) — **6260 passed, 10 failed,
  2 skipped (6272)**. No coverage-threshold error; every failure is outside
  this task's files:
  - `notifications/domain/templates/template-html.test.ts` (7) — the
    pre-existing snapshot flake named in A1; reproduces in isolation on files
    I never touched (`git status` shows the notifications/push lane mid-edit).
  - `adapters/push-notify.test.ts` (2) + `notifications/adapters/
    push-sender-factory.test.ts` (1) — the out-of-run push lane (A1 addendum 3).
  - `adapters/billing-bindings.integration.test.ts`,
    `adapters/presign-readers.integration.test.ts`,
    `lib/idempotency/by-external-pre-claim.integration.test.ts` collection
    errors (`Cannot find module .vite/vitest/…/deps_ssr/@hushbox_db.js`) —
    environmental vite dep-cache race with a concurrent run; all three pass on
    a scoped re-run (3 files / 24 tests green).
  - An earlier full run aborted on the known coverage-`.tmp` ENOENT instability
    (concurrent vitest processes); the reported numbers are from the clean
    re-run.
- `vitest run apps/api src/slices/chat src/slices/models` — 1507 passed;
  `chat/routes.integration.test.ts` 187/187 green (including the two A1
  smart-model cases, now repaired by Task 22).
- `vitest run packages/shared` — 2375 passed; 4 failures in `env.config.test.ts`
  + 1 collection failure in `test-polyfills.test.ts`, both OUT-OF-RUN lanes
  (A1 addendum 3 push/sandbox lane; the polyfills failure is a jsdom
  setup-module resolution error — `scripts/lib/vitest-setup.ts` exists and I
  touched no script/config file; survives a vite-cache wipe per A6).
- `npx tsc --noEmit` in `apps/api` — exit 0 (the A1-addendum-3 notifications
  typecheck noise is no longer reproducing in this tree).
- `eslint` on every owned file, run from each package dir AFTER the final edit
  — `apps/api` exit 0, `packages/shared` exit 0. (First pass flagged three real
  issues, all fixed: prettier formatting, `answerMaxOutputTokens` complexity 13
  → extracted `tightestCompletionCap`, and an unnecessary type-narrowing
  condition in the new integration helper.)

## Acceptance criteria

1. **A pinned level any selected model lacks no longer 400s a multi-model
   build; each model resolves per the shared rule.** MET — `unionEntries` runs
   `resolveEffortForModel` per known descriptor; integration pins cover union
   pick, downgrade-to-off, mandatory-up, and the route-level 201 with
   per-sibling wires.
2. **G3 single-model explicit refusal preserved exactly.** MET —
   `resolveTurnReasoning` routes a single-model explicit level to
   `singleLevelEntries` → `requiredReasoningEntryFor` (unchanged code path);
   pinned at unit and integration level (400/validation).
3. **`AUTO_REASONING_EFFORT_ORDER` and all callers deleted; no static auto path
   anywhere.** MET — repo-wide grep for the symbol returns nothing; the only
   remaining `['high','medium','low']` literals are provider-vocabulary
   fixtures (`supportedEfforts`), not preference orders. The residual fixed
   order inside `autoEffortAnswerCap` was deleted too (it was both a static
   order AND an under-reserve bug for Max-offering models).
4. **Single-choice turns pick deterministically (no classifier, no reserve),
   including the Min-only degenerate set.** MET — `autoEntries` applies the
   sole option; `compileAutoEffortTurn` returns `fallback` when the option set
   has < 2 entries, so no classifier node and no reserve are compiled;
   `trialReasoningSelection` mirrors it. Pinned at unit + integration level.
5. **`levelEntries`' unanimity-400 dies, replaced by per-model resolution;
   'default' = wire silence, never an error.** MET — `levelEntries` deleted;
   `resolvedEntryFor` maps `{kind:'default'}` to no entry (pinned by the
   non-reasoning-sibling case).
6. **Classifier-unbuildable → new typed error code returned where the build
   fell back.** MET — shared constant + `ERROR_MESSAGES` + `friendlyErrorMessage`
   (map-derived); domain returns `unavailableError(..., CLASSIFIER_UNAVAILABLE)`;
   route returns 503 `{code:'CLASSIFIER_UNAVAILABLE'}` (integration-pinned).
7. **A7: per-candidate `maxOutputTokens` threaded into `answerMaxOutputTokens`'s
   hand-built `TurnModelPricing`.** MET — tightest declared cap threaded into
   both the priced path and the context-headroom fallback; pinned (1200 wins
   over a 3900 context headroom).

## Deviations

- **`routes.ts` untouched** (plan lists it under Files for "validation of the
  union choice set"). No route-level validation change was needed: the union
  set is enforced inside `resolveTurnReasoning`, and the typed classifier error
  reaches the wire through the existing `respondDomainError`/`domainWireCode`
  seam. Editing the route would have duplicated the domain's option-set
  authority. Route-level behavior IS pinned by two new integration tests.
- **`compileAutoEffortTurn` signature changed** to
  `Result<AutoEffortTurnBuild, DomainError>` (was a bare union). This is what
  lets the typed refusal reuse the route's error mapping instead of a
  route-local status guess (CODE-RULES: domain returns `Result`, routes map).
  `buildAutoEffortTurnDefinition` switched `.map` → `.andThen`; its
  `ResultAsync<AutoEffortTurnBuild, DomainError>` public shape is unchanged.
- **`autoEffortAnswerCap` reworked beyond a pure deletion.** The fixed
  `['high','medium','low']` walk was a static preference order (criterion 3) and
  under-reserved any model offering Max — the classifier is presented the
  turn's real options, so the reserve must cover the strongest one. Now walks
  `turnEffortOptions(...)` budgets descending; Min (B=0) is skipped because a
  level's cap already covers it and a Min-only reserve could not cover a
  classified rung.
- **Two pre-existing route assertions re-pinned** (web-search + auto, and
  multi-model + auto): they asserted the static `medium` placeholder wire. With
  no static order and no classifier stage on those paths yet, both now send no
  reasoning wire. This is the interim state T14 closes (see Concerns).

## Concerns and limitations

- **Interim reasoning-free auto on classifier-less paths (T14's boundary).**
  Multi-model, web-search, and trial `auto` turns with ≥ 2 real choices now run
  reasoning-free instead of a static `medium`. §Effort 5 wants a classifier on
  those paths; T14 owns extending the classifier there. Deleting the static
  order without T14 leaves this honest-degradation window — I did NOT extend
  the classifier (explicit brief boundary). Flagging so the orchestrator can
  confirm T14 covers all three paths.
- **`CLASSIFIER_UNAVAILABLE` is raised only on the pinned-model auto path**
  (the only path that builds a classifier today). When T14 adds classifier
  stages to the multi-model/web-search/trial paths, the same typed refusal must
  be wired there — otherwise those paths silently degrade.
- `reasoningEntryFor` now has no production consumer outside its own module
  (its test imports it). A knip run may flag the export; it is the natural
  seam for `requiredReasoningEntryFor` and I left it exported rather than
  churn the module's shape.
- Out-of-run failures observed and attributed, not touched: `packages/shared`
  `env.config.test.ts` (4, push/sandbox lane per A1 addendum 3),
  `packages/shared/src/test-polyfills.test.ts` (jsdom setup-module resolution),
  `apps/api` `language-adapter.test.ts` cassette-baseline hash pin (prompt lane,
  A1 addendum 4).

## A3 contract sweep

- **New error code** (`CLASSIFIER_UNAVAILABLE`): `ERROR_MESSAGES` is
  `satisfies Record<ErrorCode, string>` so every consumer of the closed set is
  compiler-checked; `friendlyErrorMessage` is map-driven (no switch to extend).
  `RUN_REFUSAL_STATUS` in `chat/routes.ts` is a `Partial<Record<ErrorCode,…>>`
  — no change required. No `e2e/`, `scripts/`, or `apps/marketing` producer of
  the code set exists (grep: only `error-codes.ts`, its test, and the api route
  reference the set exhaustively).
- **`compileAutoEffortTurn` signature**: single consumer
  (`buildAutoEffortTurnDefinition`, same file) + its test; updated.
- **`AutoEffortTurnBuild`**: consumed only via `buildAutoEffortTurnDefinition`
  in `chat/routes.ts`, whose `isErr` branch already existed.
- **Deleted export `AUTO_REASONING_EFFORT_ORDER`**: repo-wide grep clean.
- No shared type shape changed (the shared authority was T11's; I only consume
  it), so no cross-package structural ripple beyond the error code.

## Confidence

High for the resolution rewrite and the typed error (dense unit + integration
pins, red verified for each behavior, route-level end-to-end green). Medium on
the `autoEffortAnswerCap` rework only in the sense that it is a deliberate
scope judgment (deleting a static order that was also under-reserving) rather
than a literal criterion — the money direction is strictly more conservative
(reserves the strongest rung, never less).
