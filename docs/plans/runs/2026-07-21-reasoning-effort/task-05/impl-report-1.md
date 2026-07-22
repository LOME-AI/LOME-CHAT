# T5 — Turn definition + admission integration — impl report 1

## Objective

`POST /chat` accepts `reasoningEffort`; the turn prices and wires it via the shared reasoning
plan: `startTurnBodySchema` optional selection enum; 400 VALIDATION for unsupported level /
non-reasoning model / `none`-on-mandatory (G3); `turn-definition.ts` composes the D1 plan with
`fitAnswerCapToCeiling` (B constant term, H sized); admission estimate prices output as B+H;
explicit `max_tokens` on every reasoning call (G2); trial accepts only ceiling-fitting levels
(G9, computed); the `no_reasoning_endpoints` wire mapping in `model-call-execution.ts`;
settlement untouched.

## Files changed

- `apps/api/src/slices/chat/domain/turn-reasoning.ts` (new) — resolves the request's
  `ReasoningEffortSelection` against the turn's models through the ONE shared plan
  (`planReasoning` + `reasoningPlanModelFrom` — the binding `limits['contextLength']` mapping);
  produces per-model `{effort, wire, reasoningBudgetTokens}` entries; owns the auto placeholder
  order (T7 seam) and the mandatory-`none` / unsupported-level 400s.
- `apps/api/src/slices/chat/domain/turn-reasoning.test.ts` (new) — unit tests for the above.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `answerHeadroomTokens` (H = affordable
  total output tokens − B, context-bounded explicitly, minimum-answer gate counts B);
  `turnCostBasis` extraction shared with the untouched-in-behavior `turnMaxOutputTokens`;
  `answerNodeParams` (node params = `{maxOutputTokens: B+H, reasoning: wire}`, G2 fallback
  `B + MINIMUM_OUTPUT_TOKENS` when H underivable); `withAnswerCap`/`fitAnswerCapToCeiling` now
  size the ANSWER headroom and re-derive each node's constant B from its own `reasoning` param
  through the plan (B=0 for reasoning-free nodes ⇒ all existing callers, incl. Smart Model
  reconcile, byte-identical in behavior); `buildTurnDefinition`/`buildMultiModelTurnDefinition`
  gain `reasoningEffort` and were flattened into `compileSingleTurn`/`compileMultiModelTurn`
  (lint nesting limits); `trialReasoningSelection` (G9 acceptance via the same plan + headroom
  math). The documented sized-to-fit ⟹ ceiling ≤ funds coupling comment is preserved and
  extended with the B/H reasoning note.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — unit tests for all of the above.
- `apps/api/src/slices/chat/domain/turn-definition.integration.test.ts` — reasoning-model seed +
  two fail-fast pins (budget-less reasoning build 400s; unaffordable reasoning turn keeps the
  explicit `B + MINIMUM` cap so admission refuses).
- `apps/api/src/slices/chat/domain/index.ts` — barrel line for `trialReasoningSelection`.
- `apps/api/src/slices/chat/routes.ts` — `startTurnBodySchema`/`trialTurnBodySchema` gain
  optional `reasoningEffort` (shared enum, imported); both dedup body hashes scope it
  (omitted hashes identically — no spurious 409 for old clients); `engagedReasoningRefusal`
  (media/Smart-Model 400 for engaged selections, T7 seam); build-option threading; trial
  acceptance via `trialReasoningOrRefusal` (non-fitting level → 402 TRIAL_MESSAGE_TOO_EXPENSIVE).
- `apps/api/src/slices/chat/routes.integration.test.ts` — 11 new route tests (see below).
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts` — the one-line
  `no_reasoning_endpoints` → `ERROR_CODES.NO_REASONING_ENDPOINTS` wire mapping (T5-owned per
  the T2-audit interface note).
- `apps/api/src/slices/workflows/nodes/model-call-execution.test.ts` — pin for that mapping.

## Design notes (for the auditors)

- **B constant, H sized.** The plan's B (`reasoningBudgetTokens`) is resolved once at build and
  written into the node's `reasoning` wire + cap; `fitAnswerCapToCeiling` binary-searches H only,
  recomputing each node's B from its own wire through the SAME plan (`max_tokens` wire carries B
  verbatim; `effort` wire re-runs `planReasoning`, which is headroom-independent in B). The
  admission estimator reads the node's `maxOutputTokens = B+H` (`declaredOutputCeiling`), so the
  hold prices output at exactly B+H; the fit asserts `estimate(fitted) ≤ spendable` against the
  canonical `createEstimateRun` — the ONE numeric authority, no second formula.
- **G2 everywhere.** A reasoning node always carries `maxOutputTokens`: sized B+H normally;
  `B + MINIMUM_OUTPUT_TOKENS` when the payer's headroom is underivable (admission then refuses —
  the reasoning analogue of the omitted-cap full-context refusal); a model with no
  context-length/pricing basis fails the build closed with 400 (no capless reasoning call
  exists).
- **G3.** Explicit levels are exact-membership via the plan; every infeasibility is a 400, and
  the unaffordable case is refused by admission, never downgraded to a lower level.
- **G9/R3.** `trialReasoningSelection` computes fit as "B + the 1000-token minimum answer
  affordable within the 1¢ ceiling" via `answerHeadroomTokens` — the same math the build sizes
  with; nothing hardcoded. Non-fitting explicit level → 402 TRIAL_MESSAGE_TOO_EXPENSIVE;
  trial `auto` degrades to a fitting level or reasoning-free (auto is the server's choice).
- **`auto` at this layer (T7 seam, documented deviation).** `auto` on a reasoning-capable model
  resolves at build time to a deterministic placeholder level — `medium` (D3's unresolvable-
  output fallback), else the first feasible of `high`, `low` — planned/wired/admission-reserved
  exactly like an explicit level (so admission reserves that level's B+H). `auto` on a
  non-reasoning model is a no-op (no call, no charge, no reserve — D3/T7). What could NOT land
  here: the classifier line-item reserve for `effort=auto` on a pinned model. The admission
  estimator's classifier reserve rides only `smartModel` nodes and lives in
  `apps/api/src/slices/models/domain/estimate-run.ts` — outside T5's file ownership — and the
  run-time classifier itself is T7's. T7 replaces the placeholder pick with the classifier and
  extends the reserve condition to `SmartModel ∨ effort=auto`. Until then no classifier call is
  made for auto, so nothing unreserved executes (the placeholder's B+H is fully reserved).
- **Smart Model / media + engaged selection → 400** (T7 seam): refusing is the only G3-honest
  option pre-classifier; `none` stays a no-op on both (no behavior change from today). T7 lifts
  the Smart-Model refusal.
- **Regenerate** (`regenerateTurnBodySchema`) deliberately not extended — T5's criteria name
  `startTurnBodySchema` only; the shared `turnDefinitionOrRefusal` path is already
  reasoning-capable, so adding the field later is schema + hash lines only. Raised as follow-up.
- **`none` semantics:** no `reasoning` param is sent (the shared wire union has no "off" shape);
  a `defaultEnabled` model therefore still reasons at its upstream default under `none`. Same
  gap class as absent-selection; noted for T9/T10 UI copy and possibly a wire extension ruling.

## Tests added

Unit — `turn-reasoning.test.ts` (17): entry derivation (effort wire, budget-native `max_tokens`
wire, enumerated-membership, non-capable), selection resolution (absent/none/mandatory-none/
level/multi-model any-model-fails/unknown-model skip/auto placeholder + order + no-op cases).

Unit — `turn-definition.test.ts` (+16): `answerHeadroomTokens` exact-value math (H = T−B,
explicit context bound where `turnMaxOutputTokens` drops the cap, unaffordable-with-B undefined,
context-cannot-hold-B undefined, empty models); build params (wire + B+H cap, G2 minimum
fallback, per-sibling B_i+H with one shared H, mixed multi-model); fit (estimator ≤ spendable
with B preserved and wire intact, floor at B+1, budget-native B re-derivation, two defensive
B=0 refit pins); `trialReasoningSelection` (fit accept, over-ceiling refuse, auto→largest
fitting, auto non-reasoning no-op, `none` passthrough, infeasible level = 400-class error).

Integration — `routes.integration.test.ts` (+11): 400s (level on non-reasoning model, enum
outside selection set, `none` on mandatory, no-context-length reasoning model, Smart Model +
engaged selection, media + engaged selection); 201s with captured `RunStartBody` definitions
(effort wire + explicit B+H cap on the answer node, budget-native `max_tokens` wire,
per-sibling wires on multi-model); trial (non-fitting level → 402, fitting level → exact
`{maxOutputTokens: 8312, reasoning: {effort:'low'}}` — the pre-existing 1¢-cap fixture's 8312
total now split B=4096 + H=4216, non-reasoning trial model + level → 400).

Integration — `turn-definition.integration.test.ts` (+2): budget-less reasoning build → 400;
unaffordable reasoning turn → explicit `{maxOutputTokens: 5096 (=B+1000), reasoning wire}`.

Node mapping — `model-call-execution.test.ts` (+1): `no_reasoning_endpoints` InferenceError →
`ERROR_CODES.NO_REASONING_ENDPOINTS` run reason.

TDD: each new surface was written test-first and observed failing for the missing-feature
reason (module missing / export missing / schema stripping the field / mapping absent) before
implementation. Exception disclosed: the two "defensive B=0 refit" pins and the two
turn-definition integration fail-fast pins were added after their branches existed (coverage
pins of just-written defensive code, same session).

## Self-gate

- `npx tsc --noEmit` (apps/api) — pass.
- `npx eslint <all touched files>` from `apps/api` after the final edit — pass, 0 problems.
- `pnpm test:watch` scoped: turn-reasoning (17/17), turn-definition (86/86),
  model-call-execution (61/61), turn-definition.integration (4/4),
  routes.integration (169/169) — all pass.
- `pnpm test` (full apps/api with coverage, fresh run after the final edit):
  **431 test files passed | 3 skipped; 5948 tests passed | 4 skipped; 0 failed.**
  Coverage gate: every file this task touched is ≥95 on all four metrics —
  `chat/routes.ts` 96.85/95.20/100/99.63 · `turn-definition.ts` 98.55/95.89/100/99.43 ·
  `turn-reasoning.ts` 97.82/95.83/100/100 · `model-call-execution.ts` 100/98.65/100/100.
  The run exits non-zero on exactly ONE per-file coverage error:
  `src/slices/workflows/nodes/smart-model-execution.ts` branches 94.73% < 95% — the
  plan-recorded FOREIGN failure (brief: that file's coverage is foreign; do not touch;
  T7 owns it). This task made zero edits to that file (its worktree diff pre-dates this
  session's first edit per the session-start `git status` snapshot).
- `pnpm arch:check` — pass (11 rules / 1851 files). `pnpm lint:unused` (knip) — pass.

## Acceptance criteria

- `startTurnBodySchema` optional `reasoningEffort` (canonical enum + auto|none) — MET
  (schema line imports the shared `ReasoningEffortSelection`; enum-outside-set 400 pinned).
- 400 VALIDATION on unsupported level / non-reasoning model / `none` on mandatory — MET
  (unit + route pins; produced by `resolveTurnReasoning` via the plan, no downgrade path
  exists).
- `turn-definition.ts` composes the plan with `fitAnswerCapToCeiling`, B constant / H sized,
  documented coupling preserved — MET (fit tests; DURABLE COUPLING comment kept + extended).
- Admission estimate prices output as B+H — MET (node cap IS B+H; fit asserts against the
  canonical estimator; unaffordable path holds B+MINIMUM and admission refuses).
- Explicit `max_tokens` always on reasoning calls (G2) — MET (no code path builds a reasoning
  node without `maxOutputTokens`; trial 201 and unaffordable-path pins).
- Trial offers/accepts only ceiling-fitting levels (G9, computed) — MET on the accept side
  (402 for non-fitting; fit computed via plan + shared headroom math). The "offers" side is
  client work (T9) — `trialReasoningSelection` is the shared server authority it can query.
- `model-call-execution.ts` error mapping line — MET (pinned).
- Settlement untouched — MET (no billing/settlement file edited this task; settlement.ts's
  worktree diff pre-dates this task — foreign, per the session-start git snapshot).

## Deviations

- `auto` = build-time placeholder level; classifier line-item reserve for pinned+auto NOT
  extended (out of file ownership + needs T7's classifier). Documented above; raised.
- `resolveTurnReasoning` returns an empty map (not `undefined`) for "no reasoning" — interface
  choice forced by lint (`unicorn/no-useless-undefined`), settled before consumers landed.
- Smart Model / media + engaged selection → 400 (not in plan text; G3-derived; T7 lifts the
  Smart-Model case).

## Concerns and limitations

- The placeholder `auto` level (medium-first) is deliberately cheap-conservative; if T7 wants
  worst-case reserve semantics for auto before the classifier lands, only
  `AUTO_REASONING_EFFORT_ORDER` / `autoEntryFor` change.
- `REASONING_BUDGET_FLOOR_TOKENS` (1024) can exceed a tiny context window's headroom; the
  build then refuses via `answerHeadroomTokens` undefined → B+MINIMUM hold → admission refusal.
  No silent under-reserve, but a pathological tiny-context reasoning model is effectively
  unusable — believed correct (fail-closed).
- Foreign failures attributed per plan §Known-foreign-failures: `smart-model-execution.ts`
  coverage is foreign (file untouched by this task; T7 owns it); `pipeline-bindings.ts`
  ExecutionContext typecheck break affects `apps/web`, not `pnpm test:api`.

## Confidence

High — every criterion is pinned by a failing-first test at the layer that owns it; money math
is asserted against the canonical admission estimator (the ONE numeric authority); the full
suite is green with only the pre-recorded foreign coverage failure standing.
