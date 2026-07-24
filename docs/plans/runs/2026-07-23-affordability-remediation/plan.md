# Plan — Affordability, Billing & Effort Remediation (Tier 2)

One run, end-to-end (human ruling). The specification is `docs/BILLING.md` as
rewritten 2026-07-23 — the doc describes the TARGET; this run makes code match it.
Research grounding: `research/*.md` in this run dir. Ruling history: `unknowns.md`,
`ledger.md`.

## Handoff — read this first (you know nothing about this run)

**Status:** plan content human-approved 2026-07-23 for implementation. You are the
orchestrator; execute via the `subagent-driven-dev` skill (invoke it — its rules
govern you): you write no production code; every task = implementer subagent →
auditor subagent(s) → your judgment; fix→re-audit loops; ledger every transition in
`ledger.md` (append-only, this dir). Re-confirm with the human ONLY if you must
deviate from this plan; deviations are plan amendments recorded here.

**What happened before you:** the human and a prior orchestrator investigated the
whole affordability/billing/effort system (8 research agents; findings in
`research/`), ratified a complete principle set through ~40 explicit rulings
(logged in `unknowns.md` + `ledger.md`), and rewrote `docs/BILLING.md` (+ touched
`ARCHITECTURE.md`, `CODE-RULES.md`, `apps/api/src/scheduled.ts` docstring) to the
TARGET design. **The docs are ahead of the code — that is intentional.** Your job
is to make code match `docs/BILLING.md`. Never "fix" the docs back; a doc/code
conflict you can't resolve from this plan = BLOCKED, ask the human.

**Non-negotiables (from the repo's CLAUDE.md chain, restated because they bite
here):** strict TDD (failing test first, watched red); 95% per-file coverage is
part of `pnpm test`; no git state mutations by you or any subagent; money is
nano-USD bigint, never Number-coerced; One Implementation Shared (no mirrored
logic/constants across client/server); new error codes need the shared constant +
`friendlyErrorMessage` entry; other agents may be working in this repo — attribute
unrelated failures, never fix or revert work that isn't this run's.

**Environment:** `pnpm test:api|web|shared|db|config` scope per package;
`pnpm test:watch <path>` for one file; `pnpm arch:check`, `pnpm lint`,
`pnpm typecheck`; `pnpm db:generate` writes the migration for schema edits (CI
fails on drift); local stack via `pnpm dev` / first command may boot Docker.
Read `e2e/CLAUDE.md` before any E2E work (Task 21).

**Key verified facts you'd otherwise rediscover** (citations in `research/`):

- Estimator/effort/Smart-Model math is ONE shared implementation in
  `packages/shared/src/estimate/` used by both sides; divergences are in the
  INPUTS, which this run fixes. `research/current-system.md` maps every file.
- Catalog: `model_catalog` = one opaque `descriptor` jsonb (`ModelDescriptor`,
  `packages/shared/src/model-descriptor.ts`); rates are PRE-fee today;
  `limits` holds only `contextLength`; hourly cron refresh recomputes canonical
  JSON and skips unchanged — so normalize changes rewrite all rows naturally.
- OpenRouter `/models` publishes `top_provider.max_completion_tokens`
  (integer|null, meaning of null undocumented) — we never fetch it today
  (`research/openrouter-max-output-*.md`).
- Admission = one atomic Lua script (`apps/api/src/slices/billing/domain/
  admission-scripts.ts`); holds are `"{amount}:{expiresAtMs}"` hash values parsed
  ONLY inside Lua — any TS re-parse is a banned sync contract; extract and share
  the Lua fragment (Task 07).
- Pinned-model auto-effort is ALREADY classifier-driven for paid/single-model/
  non-web-search/text turns (`compileAutoEffortTurn`,
  `apps/api/src/slices/chat/domain/smart-model-turn.ts:409-458`) via a
  single-candidate smartModel node — ratified; Tasks 13/14 extend it and delete
  the residual static paths.
- Chat history + custom instructions are CLIENT-SENT every turn (E2EE — server
  cannot rebuild from rows; client always loads full history). The preview/send
  divergence is exactly two parallel system-prompt builders + two char-count
  reduces (Task 10 collapses them).
- Multi-model turn = N independent sibling `modelCall` nodes (NOT engine fanOut);
  authoritative admission = Σ per-model ceilings; a separate summed-rate "guess"
  formula exists for sizing/preview and must die (Tasks 15/16).
  `research/multi-model-math.md` has the full map.
- Group billing: enforcement works (atomic scope checks, sender-keyed accrual);
  the gaps are attribution/lifecycle/parity (`research/group-billing.md`).
- The monthly OpenRouter reconcile NEVER existed; it is deleted from all docs —
  do not reintroduce it or retain raw provider cost anywhere.

**Cross-task interfaces (contracts between tasks; cite in briefs):**

- T01 → `descriptor.limits.maxOutputTokens?: number` (positive int or absent).
- T02 → ceil-markup helper in `packages/shared/src/money.ts` (name it
  `applyMarkupCeil` unless a better fit emerges); descriptor `version: '2'`.
- T03 → `NanoLineItem.kind: 'provider' | 'storage'` replaces `marksUp`;
  reducers' signatures otherwise stable.
- T07 → `GET /billing/spendable` response schema in
  `packages/shared/src/schemas/api/billing.ts`:
  `{ spendableNanoUsd: NanoUSD, heldNanoUsd: NanoUSD,
  concurrentRunsRemaining: number }`; shared Lua fragment exported from
  admission-scripts for T08.
- T11 → shared `turnEffortOptions(models): EffortOption[]` and
  `resolveEffortForModel(model, chosen): ResolvedEffort` — exact signatures fixed
  by T11's implementer, recorded here as an amendment for T12/T13/T14 briefs.
- T16 → shared per-turn affordability solver consumed by client preview and
  cited by T20's invariant test.

**Sequencing note:** the spine T01→T02→T03→T06→T04→T05 and T11→T13→T14/T15 is
ordered by shared-file ownership, not preference — do not parallelize tasks that
share files. {T07→T08→T09}, T10, T18(after T04), T19(after T09) are the parallel
lanes. Recompute readiness from the graph after every clean audit.

## Global Constraints

- `docs/BILLING.md` is the spec. Section references below (e.g. §Affordability 5)
  are normative acceptance criteria wherever cited.
- TDD per AGENT-RULES: failing test first, watch it fail, minimal green. 95%
  per-file coverage is part of `pnpm test`.
- Money is nano-USD `bigint` end-to-end; `NanoUSD` strings at JSON boundaries;
  never `Number()`-coerced. Client-side money math must be bigint; cents/dollars
  only at display formatting.
- One Implementation, Shared: any logic needed identically by client + server is
  written once in `packages/shared` and imported by both. No mirrored constants,
  no "keep in sync" comments.
- New error codes follow CODE-RULES: constant in `packages/shared/src/error-codes.ts`
  + `friendlyErrorMessage` entry.
- Estimates only over-reserve, never under (BILLING §Affordability 8). Rounding
  against the user (ceil) except the port's charge conversion (half-even).
- No git state mutations by anyone. No doc edits (docs already applied pre-run);
  if a task discovers a doc/code conflict, it reports BLOCKED — never edits the doc.
- Known pre-existing failure attribution: other agents may be working in this repo;
  attribute unrelated failures, don't fix them.
- ZERO existing users/data (human ruling): no data-migration or backfill scripts
  anywhere, no coexistence-window handling. Schema changes still ship their
  generated drizzle migration file (the CI drift gate requires it) — that is
  structure, not data migration.

## Related E2E (declared for the close phase)

- `e2e/chat/chat.spec.ts` (effort chip flow — touched by union menu + auto changes;
  verify its live-catalog model still offers ≥2 choices)
- `e2e/group/*` budget flows (budget validation + typed guest denial)
- NEW/EXTENDED: multi-model turn including Smart Model as one sibling (Task 21)
- Close phase runs only these plus suites the close findings implicate — never the
  full E2E suite.

## Dependency graph

```
T01 ─→ T02 ─→ T03 ─→ T06 ─→ T04 ─→ T05
                     T06 ─→ T13 (turn-definition chain)
T07 ─→ T08 ─→ T09 ─→ T12, T19
T10 (independent; before T13 lands routes.ts changes)
T03 ─→ T11 ─→ T12, T13
T13 ─→ T14 ─→ T17, T20
T13, T06 ─→ T15 ─→ T16, T17
T12, T15 ─→ T16 ─→ T20
T04 ─→ T18
T14, T16 ─→ T20 ; T17 ─→ T21
```

Sequential spine (shared-file overlap): T01→T02→T03→T06→T04→T05 and
T11→T13→T14/T15. Parallel lanes: {T07→T08→T09}, T10, T18 (after T04), T19
(after T09).

---

## Task 01 — Catalog max-output-tokens ingestion

**Objective:** ingest the provider's max completion tokens into
`descriptor.limits.maxOutputTokens` for language models.
**Design context:** BILLING §Affordability 5. `top_provider.max_completion_tokens`
is `integer|null` on `GET /models` and never fetched today
(`research/openrouter-max-output-code.md`, `-web.md`); null semantics undefined
upstream ⇒ absent/null → omit the key (consumers fall back to contextLength).
Image/video have no token-cap concept — language models only.
**Acceptance criteria:**
- `modelsEntrySchema` parses `top_provider.max_completion_tokens` (nullable,
  optional); normalize writes `limits.maxOutputTokens` only when a positive
  integer; fixtures cover populated, null, and absent.
- No behavior change for image/video normalize paths.
- Existing rows without the key remain valid (additive).
**Files:** `apps/api/src/slices/models/domain/gateway-metadata.ts`, `normalize.ts`,
`gateway-fixtures.ts`, colocated tests.
**Scoped checks:** `pnpm test:api`; `turbo typecheck lint --filter=@hushbox/api`.
**Sensitive:** no.

## Task 02 — Fee baking at ingestion + descriptor v2 + backfill

**Objective:** catalog stores billable rates; unbaked rows are unreadable.
**Design context:** BILLING §Fee Structure. Option A ratified (see ledger).
NO existing-data handling (human ruling 2026-07-23: zero users, everything brand
new — no backfill scripts, no rollout-window machinery). Skip-unchanged recomputes
canonical JSON, so every row re-bakes naturally on the next hourly refresh; local
dev may simply `pnpm db:reset`. The v1 fail-fast stays as cheap structural
enforcement, not migration tooling.
**Acceptance criteria:**
- Normalize applies ceil-rounded markup to every pricing rate (all shapes: flat +
  matrix), stamps descriptor `version: '2'`.
- Catalog read path fail-fasts on `version: '1'` with a clear error.
- A ceil-markup helper exists beside `applyMarkup` (shared money.ts) — half-even
  reserved for the port conversion (Task 04).
**Files:** `apps/api/src/slices/models/domain/normalize.ts`, catalog store read
path, `packages/shared/src/money.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; typecheck/lint both.
**Sensitive:** money — 2 independent auditors.

## Task 03 — Shared estimator: billable-only refactor

**Objective:** no fee logic in the estimator; `marksUp` becomes
`kind: 'provider' | 'storage'`.
**Design context:** BILLING §Fee Structure, §Affordability mechanics. The flag's
fee-selector role dies; the provider-vs-storage discriminator survives (non-
persisting turns drop storage items; Smart Model picks provider vs storage lines).
`reservationCeiling`/`affordability`/`candidateCost` become pure sums over billable
rates. Display formatters become pure renderers (wire pricing is billable).
Search-reservation constant is billable at definition. Re-pin estimator tests
under TDD (values shift ≤ nano-scale). The client/server Smart Model parity test
must keep passing unchanged in structure.
**Acceptance criteria:**
- Zero `applyMarkup` imports remain under `packages/shared/src/estimate/`.
- `NanoLineItem.marksUp` renamed `kind`; `evaluateManifest`'s selector renamed
  provider-only/all-in; behavior for storage-dropping paths unchanged (pinned).
- `format.ts` renders rates without fee math; docstrings say billable.
- Smart Model threshold/admission tests (incl. balance-sweep parity) green.
**Files:** `packages/shared/src/estimate/*` + tests; `packages/shared/src/pricing.ts`
(fix dead `pricingFromRawModel` comment while touching).
**Scoped checks:** `pnpm test:shared`; typecheck/lint shared.
**Sensitive:** money — 2 independent auditors.

## Task 04 — Port billable conversion + consumer deletion sweep

**Objective:** inline `usage.cost` converts to billable once at the port; every
remaining fee application outside the two seams is deleted.
**Design context:** BILLING §Billing Flow 3–4, §Fee Structure. Settlement totals
must be bit-identical pre/post for text/video (markup relocates, half-even
retained at the conversion). Sanity multiple compares billable-vs-billable.
The `smart-model.integration.test.ts` fee-rate reconstruction (a sync contract in
a test) is rewritten against the port helper.
**Acceptance criteria:**
- One conversion helper at the ModelProvider port boundary; `decideCost` receives
  billable; fallback path bills the billable estimate directly.
- `chargeWithinTx` and the settlement notification mirror take already-billable
  amounts; a cassette-replayed turn's charged total is bit-identical to
  pre-migration (pinned test).
- `applyMarkup` deleted from: charge.ts, settlement.ts mirror, turn-definition
  rate sums, estimate.ts (incl. WORST_CASE constant — now billable at definition),
  smart-model-candidates, trial-eligibility (accepting the ~15% trial-basis
  tightening — ruled), seed-billing-history, web use-budget-calculation,
  marketing calculate-cost.
- Trial-eligibility folds billable all-in; its tests re-pinned.
**Files:** `apps/api/src/slices/workflows/nodes/model-call-execution.ts`,
`apps/api/src/slices/billing/domain/charge.ts` + `money.ts`,
`apps/api/src/slices/chat/domain/settlement.ts`, `turn-definition.ts` (fee lines
only), `apps/api/src/slices/models/domain/estimate.ts`, `smart-model-candidates.ts`,
`trial-eligibility.ts`, `apps/api/src/platform/dev/seed-billing-history.ts`,
`apps/web/src/hooks/billing/use-budget-calculation.ts` (fee lines only),
`apps/marketing/src/lib/calculate-cost.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`; typecheck/lint api+web.
**Sensitive:** money/settlement — 2 independent auditors.

## Task 05 — Structural fee-seam enforcement

**Objective:** `applyMarkup`/ceil-markup importable only at the seams.
**Acceptance criteria:** arch (ts-morph) or vendored lint rule restricting imports
to money.ts, normalize, the port conversion, and the backfill script; rule has its
own test; `pnpm arch:check` green; README in `packages/config` updated per its
convention.
**Files:** `packages/config/arch/` or `eslint-extensions/` + tests.
**Scoped checks:** `pnpm test:config` (or config package's test entry), `pnpm arch:check`.
**Sensitive:** no.

## Task 06 — Thread maxOutputTokens through every ceiling

**Objective:** output ceilings become min(budget, maxOutputTokens, context
headroom) everywhere.
**Design context:** BILLING §Affordability 5. Consumers enumerated in
`research/openrouter-max-output-code.md` §8: `declaredOutputCeiling`/
`inputTokenCeiling` (estimate-run), `clampBudget` (reasoning-plan),
`answerHeadroomTokens`/`computeSafeMaxTokens` callers (turn-definition/budget.ts),
`candidateCapTokens` (smart-model-affordability), list-models wire, web hooks.
Absent key ⇒ contextLength fallback (strict tightening, never loosening).
**Acceptance criteria:**
- Each named consumer bounds by `limits.maxOutputTokens` when present; property:
  for any model with the key, no computed output ceiling/reasoning budget/answer
  cap exceeds it (pinned per consumer).
- Reservation for a capped model shrinks accordingly (pinned example test).
- Client sizing (via shared fns) inherits the bound with no client-local math.
**Files:** `packages/shared/src/estimate/reasoning-plan.ts`,
`smart-model-affordability.ts`, `budget.ts`;
`apps/api/src/slices/models/domain/estimate-run.ts`, `list-models.ts`;
`apps/api/src/slices/chat/domain/turn-definition.ts` (bound lines only); tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`; typecheck/lint both.
**Sensitive:** money — 2 independent auditors.

## Task 07 — `GET /billing/spendable`

**Objective:** serve `{spendableNanoUsd, heldNanoUsd, concurrentRunsRemaining}`,
hold- and cushion-aware, failing closed.
**Design context:** BILLING §Affordability 1–2. Extract the `activeHolds` Lua
fragment from `ADMISSION_SCRIPT` into a shared constant used by both scripts (the
expiry/format rule must have one implementation — TS re-parse is banned);
read-only script lazily prunes exactly like admission. Separate route from
`/billing/balance` (ledger truth / payment polling must survive Redis outage).
Route class `billing-token`. Redis down → the same `unavailable` mapping admission
uses (503). Cushion rides the served number via shared `spendableFundsNanoUsd`.
**Acceptance criteria:**
- Integration test: with an active hold, served spendable equals exactly the
  `effectiveSpendable − heldSum` the admission Lua would gate with (the pinning
  test from analyst C).
- Expired holds pruned on read; `concurrentRunsRemaining` = cap − active count.
- Redis down ⇒ 503 typed; `/billing/balance` unaffected (test).
- `ADMISSION_SCRIPT` refactor is behavior-identical (existing admission
  integration tests green, incl. concurrent-settlement pin).
**Files:** `apps/api/src/slices/billing/domain/admission-scripts.ts`, new
`spendable` domain read, `apps/api/src/slices/billing/routes.ts`, barrel;
`packages/shared/src/schemas/api/billing.ts`; tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; typecheck/lint both.
**Sensitive:** yes (billing surface) — 3-lens panel.

## Task 08 — Budgets endpoint hold-awareness

**Objective:** served `effectiveRemainingNanoUsd` subtracts active scope holds.
**Design context:** BILLING §Affordability 1. Same shared Lua fragment over
member/conversation scope hashes.
**Acceptance criteria:** integration test — remaining under an active scope hold
matches what admission would allow; M+1 reads bounded per request; Redis down ⇒
typed failure for the hold component (endpoint fails closed like Task 07 — the
budgets read is part of the affordability preview).
**Files:** `apps/api/src/slices/conversations/domain/budgets.ts`, billing barrel
export of the scope-hold reader, tests.
**Scoped checks:** `pnpm test:api`; typecheck/lint api.
**Sensitive:** money — 2 independent auditors.

## Task 09 — Client served-numbers + nano money cleanup

**Objective:** client consumes served spendable/budgets; client money math becomes
nano bigint end-to-end.
**Design context:** BILLING §Affordability 1–3; ruled T-add-2 (unknowns.md).
Deletions per analyst C (double-cushion hazard: the served number bakes the
cushion — every client re-add must go): client `getEffectiveBalanceNano` call for
authenticated users, cents-domain `resolveSelfAffordability` (incl. the 1e-6 float
tolerance), `useUserTierInfo` cents fields, `estimatedCostCents` naming. Keeps:
per-keystroke shared estimator math, trial/guest fixed-1¢ arm (client-side, no
endpoint), paid negative-balance hard block reading raw served balance
(complementary defense — do not collapse). Freshness: `run-started` invalidation
handler; reconnect catch-up adds spendable+budgets+balance keys; budgets
staleTime Infinity removed.
**Acceptance criteria:**
- New `useSpendable` hook is the only affordability balance input for
  authenticated users; `useBalance` remains for payment polling/settings only.
- No cents/float money math remains in hooks/shared client-billing (grep-clean:
  `balanceCents`, `estimatedCostCents`, float tolerance); display formatting is
  the only cents conversion.
- Paid preview with cushion: spendable already includes it exactly once (test
  pinning no double-cushion).
- WS: `run-started` and `run-finished` both invalidate spendable + budgets;
  ws-ready catch-up includes them (tests).
- All affected hook/component tests re-pinned; denial parity cases green.
**Files:** `apps/web/src/hooks/billing/*` (billing.ts, use-prompt-budget.ts,
use-budget-calculation.ts, use-user-tier-info.ts, use-conversation-budgets.ts,
use-resolve-billing.ts), `apps/web/src/hooks/realtime/use-realtime-sync.ts`,
`packages/shared/src/billing/client-billing.ts`, tests.
**Scoped checks:** `pnpm test:web`, `pnpm test:shared`; typecheck/lint both.
**Sensitive:** money — 2 independent auditors.

## Task 10 — One prompt builder, one char counter

**Objective:** preview and send measure the identical prompt through one shared
construction path.
**Design context:** BILLING §Affordability 3; `research` trace 2026-07-23: history
+ custom instructions are client-sent every turn (E2EE; client always loads full
history), so inputs already match — the divergence is TWO system-prompt builders
(`packages/shared/src/prompt/build-system-prompt.ts` preview-only vs
`system-prompt.ts` `buildTurnSystemPrompt` used by the language adapter; content
already differs) plus two hand-written char-count reduces
(`routes.ts promptCharacterCount` vs `use-authenticated-chat.ts:1415`).
**Acceptance criteria:**
- Exactly one system-prompt builder remains in `packages/shared/src/prompt/`,
  used by the language adapter (send) and the preview measurement; the "mirrors
  the API" copy is deleted. Content decision: the send-path output is the truth —
  preview measures what is actually sent (a preview-only capability block that
  the send omits is a bug; unify on send content).
- Exactly one shared `promptCharacterCount` used by api routes and the web hook.
- A parity test constructs a turn (system + instructions + history + input) and
  asserts preview measurement === the byte length of what the adapter sends.
**Files:** `packages/shared/src/prompt/*`,
`apps/api/src/slices/models/adapters/language-adapter.ts`,
`apps/api/src/slices/chat/routes.ts` (count call sites only),
`apps/web/src/hooks/chat/use-authenticated-chat.ts` (count lines only),
`apps/web/src/hooks/billing/use-prompt-budget.ts` (builder import only), tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`, `pnpm test:web`.
**Sensitive:** no.

## Task 11 — Shared effort options authority: union + Min

**Objective:** one shared function yields a turn's effort choice set.
**Design context:** BILLING §Effort 1–4, 8. Union across selected models'
`offeredLevels` + Min when any model can disable; per-model downgrade resolution
helper (nearest offered, downward only; mandatory-ladder-above → lowest rung);
hoist `offeredEffortLabels` from `apps/web/src/hooks/chat/use-reasoning-effort.ts`
into shared beside `offeredLevels`.
**Acceptance criteria:**
- `turnEffortOptions(models)` (union + Min) and `resolveEffortForModel(model,
  chosen)` (downgrade rule incl. both ruled edge cases (a)/(b) and Min semantics)
  exist in shared with exhaustive tests (heterogeneous ladders, mandatory
  models, single-choice, Smart-resolved model cases).
- Client hook re-exports/imports the shared authority (no web-local copy).
**Files:** `packages/shared/src/estimate/reasoning-plan.ts` (or sibling module),
`packages/shared/src/reasoning-effort.ts`, `apps/web/src/hooks/chat/
use-reasoning-effort.ts` (import swap), tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`.
**Sensitive:** no.

## Task 12 — Client effort & picker UX

**Objective:** union menu; grey-never-hide for every tier; auto always enabled;
model-picker affordability greying.
**Design context:** BILLING §Effort 3–5, §Affordability 4. Remove the trial-only
option filtering; auto's hardcoded always-enabled stays (correct per ruling —
its cost changes server-side); picker greys a model when the shared canSend floor
fails (premium lock unchanged, separate).
**Acceptance criteria:**
- Effort menu options = shared `turnEffortOptions`; disabled levels grey with
  reason tooltips for trial/guest too (filter deleted); Min labeled per shared
  labels; no `none` surfaced as a separate concept.
- Model picker: unaffordable-minimum models grey + tooltip via the same shared
  floor test feeding the composer; still selectable-blocked consistently with
  greying (grey = not selectable, tooltip explains).
- Component tests cover: union across heterogeneous selection, trial greying,
  picker greying, auto enabled with 1-choice model.
**Files:** `apps/web/src/components/chat/input/reasoning-effort-menu.tsx`,
`apps/web/src/components/chat/model-selector/*`, `apps/web/src/hooks/chat/
use-reasoning-effort.ts`, `use-prompt-budget.ts` (floor export), tests.
**Scoped checks:** `pnpm test:web`; typecheck/lint web.
**Sensitive:** no.

## Task 13 — Server effort resolution: downgrade + no static auto

**Objective:** server accepts the union choice set, resolves per model by the
shared downgrade rule, deletes every static auto path.
**Design context:** BILLING §Effort 4–5, 8. `levelEntries` unanimity-400 dies →
per-model `resolveEffortForModel`; `AUTO_REASONING_EFFORT_ORDER` deleted
entirely; single-choice turns pick deterministically (no classifier, no reserve);
classifier-unbuildable → new typed error code (shared constant +
friendlyErrorMessage); G3 for single-model explicit levels preserved.
**Acceptance criteria:**
- A pinned level any selected model lacks no longer 400s a multi-model build;
  each model resolves per the shared rule (integration tests: union pick,
  downgrade, mandatory-up, single-model explicit refusal preserved).
- `AUTO_REASONING_EFFORT_ORDER` and all callers deleted; grep-clean.
- Auto on a 1-choice model: no classifier node in the compiled definition, no
  classifier reserve in the estimate (pinned).
- Classifier-unbuildable → typed error surfaced with the new code; client copy
  exists.
**Files:** `apps/api/src/slices/chat/domain/turn-reasoning.ts`,
`turn-definition.ts`, `smart-model-turn.ts` (compile gate),
`apps/api/src/slices/chat/routes.ts` (validation),
`packages/shared/src/error-codes.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money-adjacent — 2 independent auditors.

## Task 14 — Classifier: one call, user-visible options, Min, everywhere

**Objective:** the classifier presents the turn's exact option set (union incl.
Min), one call per turn composing model+effort dimensions; runs on web-search and
trial turns.
**Design context:** BILLING §Effort 5–7. Fixed low/medium/high scale and
positional re-mapping die; the effort dimension enumerates the turn's options by
their user-visible labels; parser accepts Min. Web-search: the classifier itself
carries no tools; the answer sibling keeps the search tool — remove the
non-web-search route gate. Trial pinned-auto: remove the paid-only gate (math per
BILLING §Trial; the ~0.1¢ reserve fits the 1¢ cap). Reserve predicate
(`smartModelClassifierDimensions` authority) generalizes: reserve ⟺ any dimension.
**Acceptance criteria:**
- Effort dimension prompt lists exactly `turnEffortOptions` labels; classifier
  output resolves through the shared fuzzy matcher to one of them; Min result
  compiles a reasoning-off answer call (tests incl. cassettes as needed).
- Smart Model + auto in one turn = one classifier call with both dimensions
  (pinned on the compiled definition + execution).
- Web-search auto turn: classifier runs (no tools), answer model carries
  `web_search`; estimate holds classifier reserve + search reservation (pinned).
- Trial pinned-auto: classifier turn admitted within the 1¢ cap (integration
  test); trial Smart Model path unchanged.
- Reserve ⟺ classify: property test over definitions with/without dimensions.
**Files:** `packages/shared/src/smart-model/effort-dimension.ts`, `resolve.ts`
(if parser touched), `packages/shared/src/workflow.ts` (dimensions authority),
`apps/api/src/slices/workflows/nodes/smart-model-execution.ts`,
`apps/api/src/slices/chat/domain/smart-model-turn.ts`, `routes.ts` (gate
removal), `apps/api/src/slices/models/domain/estimate-run.ts` (reserve
predicate), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money-adjacent — 2 independent auditors.

## Task 15 — Multi-model per-model caps; kill the guess formula (server)

**Objective:** each sibling sized by its own model's bounds at its resolved
effort; summed-rate sizing path deleted.
**Design context:** BILLING §Multi-Model 2–3. `summedTurnPricing`/min-context
shared-H sizing (+ `fitAnswerCapToCeiling` reconciliation loop) replaced by
per-sibling derivation: own context, own maxOutputTokens, own resolved effort
budget, own answer headroom — admission stays Σ per-sibling worst cases (already
authoritative).
**Acceptance criteria:**
- Sibling wire params: per-model `maxTokens` = own Bᵢ + own Hᵢ (pinned on the
  compiled definition for a heterogeneous pair).
- A tight-context model no longer constrains a large-context sibling's cap
  (pinned).
- `summedTurnPricing` and the reconciliation binary search are deleted or reduced
  to per-model calls; the drift-risk comment block at `turn-definition.ts:391-405`
  becomes obsolete and is removed with the code it described.
- Admission estimate unchanged in shape (Σ per-model ceilings; existing
  estimate-run tests green).
**Files:** `apps/api/src/slices/chat/domain/turn-definition.ts`,
`packages/shared/src/budget.ts` (`computeSafeMaxTokens` callers), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

## Task 16 — Client authoritative multi-model preview

**Objective:** the client previews with the same per-model math the server
admits with.
**Design context:** BILLING §Multi-Model 2; §Affordability 1. Hoist a shared
per-turn affordability solver (per-model manifests, Σ worst cases, per-model
caps) and feed it served spendable; delete the client's summed-rate
`priceRequest` usage for multi-model affordability (capacity display may keep
min-context for the context meter only).
**Acceptance criteria:**
- One shared function answers "can this selection send, and at what per-model
  caps" for both the client preview and the server build (import-shared, pinned
  by a parity test across heterogeneous selections and balances).
- Client greying/denial for multi-model derives from it; no summed-rate
  affordability math remains client-side (grep-pinned).
**Files:** `packages/shared/src/estimate/` (new solver module),
`apps/web/src/hooks/billing/use-budget-calculation.ts`, `use-prompt-budget.ts`,
tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`.
**Sensitive:** money — 2 independent auditors.

## Task 17 — Smart Model as a multi-model sibling

**Objective:** Smart Model composes as one sibling among regular models.
**Design context:** BILLING §Multi-Model 1, §Smart Model 6. Client currently
forces effort undefined and (verify) excludes mixed selection; server compiles
Smart Model as a separate turn shape. Target: mixed selection builds N siblings
where one is the smart slot (classifier model-dimension resolves it), settlement
persists/bills it like any sibling.
**Acceptance criteria:**
- Client allows Smart Model + regular models (≤5 total); effort menu semantics
  per §Effort (union includes resolved-model fall-down at run time).
- Compiled definition: one classifier call (model dimension; + effort dimension
  when auto), smart sibling resolved before execution level; admission = Σ
  regular ceilings + smart slot ceiling (MAX over candidates) + classifier
  reserve (pinned).
- Settlement: smart sibling's charge keyed like any sibling under one runId;
  partial-failure semantics identical (integration test).
**Files:** `apps/api/src/slices/chat/domain/turn-definition.ts`,
`smart-model-turn.ts`, `apps/api/src/slices/models/domain/estimate-run.ts`,
`apps/web` selection components/hooks gating Smart Model exclusivity, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`.
**Sensitive:** money — 2 independent auditors.

## Task 18 — Sender on billed rows

**Objective:** `usage_records` records payer and sender independently.
**Design context:** BILLING §Group 3. Schema change human-approved (Q19). Sender
= the turn's sending user (senderId on the user message today); nullable-on-
deletion semantics must match the existing pseudonymization doctrine (`SET NULL`).
**Acceptance criteria:**
- Migration adds the sender reference (FK, indexed, `SET NULL` on user deletion)
  — generated via `pnpm db:generate`, ships with the schema change.
- Charge write path threads sender from settlement identity; owner-funded turn
  records payer=owner wallet, sender=member/guest principal (integration test);
  self-funded records both = self.
- db shape-test registry (money/columns) updated per `packages/db` conventions.
**Files:** `packages/db/src/schema/usage-records.ts` + migration,
`apps/api/src/slices/billing/domain/charge.ts`,
`apps/api/src/slices/chat/domain/settlement.ts` +
`apps/api/src/slices/workflows/engine/settlement.ts` (identity threading), tests.
**Scoped checks:** `pnpm test:db`, `pnpm test:api`.
**Sensitive:** yes (user data + money) — 3-lens panel.

## Task 19 — Group fixes: payer-tier pricing, typed guest denial, budget lifecycle

**Objective:** GB1/GB6 + budget-row lifecycle + edit validation.
**Design context:** BILLING §Group 1, 2, 4, 6. Client prices owner-funded turns
at the payer's tier (owner-funded ⇒ paid by construction); guest denial gets a
typed code + shared copy; member removal deletes its budget row; budget edits
below accrued spend are rejected with a typed code.
**Acceptance criteria:**
- Owner-funded preview uses paid-tier ratios/cushion inputs (client test pinning
  a free-tier member previewing an owner-funded turn identically to the server's
  sizing tier).
- New guest-denial error code (shared constant + friendlyErrorMessage); server
  returns it where the generic FORBIDDEN stood; client copy comes from shared.
- Member removal deletes `member_budgets` row in the same transaction
  (integration test). No orphan-cleanup script (zero users — no existing data).
- Budget edit below accrued spend → typed 4xx (integration + client handling).
**Files:** `apps/web/src/hooks/billing/use-prompt-budget.ts`/`use-resolve-billing`
(tier input), `packages/shared/src/billing/client-billing.ts`,
`packages/shared/src/error-codes.ts`,
`apps/api/src/slices/conversations/domain/*` (membership, budgets),
`apps/api/src/slices/chat/routes.ts` (denial mapping), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

## Task 20 — Smart Model equivalence invariant test

**Objective:** pin smart-pick ≡ direct-pick minus classifier cost.
**Design context:** BILLING §Smart Model 6. Property/integration test: for every
admitted candidate, its sizing under Smart Model equals its direct-pick sizing
given (balance − classifier reserve); covers the multi-model sibling case.
**Acceptance criteria:** the invariant test exists at the shared level (fast
property sweep) + one api integration case; failure messages name the diverging
component.
**Files:** `packages/shared/src/estimate/smart-model-affordability.test.ts` (or
sibling), one api integration test file.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`.
**Sensitive:** no (test-only).

## Task 21 — E2E: multi-model turn with a Smart Model sibling

**Objective:** guard the critical flow end-to-end.
**Design context:** ruled 2026-07-23; extend an existing suite (e2e/CLAUDE.md
conventions; read it first). Assert: mixed selection sends; smart sibling
resolves to a real model; N sibling assistant messages persist under one parent;
per-sibling billing visible where the UI exposes cost at `done`; cassette/live
policy per CI rules. Also verify the effort-chip spec's pinned model still
offers ≥2 choices post-union (adjust the spec's model if not).
**Files:** `e2e/` (one extended or new spec + page objects as needed).
**Scoped checks:** the targeted `pnpm e2e:<suite>` only.
**Sensitive:** no (test-only).

---

## Amendments (orchestrator, during execution)

### A1 — Known pre-existing failure (attribute around, all tasks)

2 failures in `apps/api/src/slices/chat/routes.integration.test.ts` (smart-model
cases) are pre-existing at baseline HEAD: the committed effort-feature basis
stamping (c6209b02+) made the fixture unsatisfiable — seeded `contextLength: 1000`
can never yield candidate `cap ≥ MINIMUM_OUTPUT_TOKENS` (1000) once ≥1 prompt token
is stamped (`turn-definition.ts:248`; eligibility at
`smart-model-affordability.ts:300,424-426`). Balance-independent. Repaired by
Task 22. Until it lands, these 2 failures are not attributable to any task.
Also pre-existing: `notifications/.../template-html.test.ts` snapshot flake;
`packages/shared/src/estimate/smart-model-affordability.ts` branch-coverage
shortfall (86.02%, T03/T06 lane will absorb).

### A2 — Task 22 (micro) — fixture repair + T10 mechanical follow-ups

**Objective:** make the pre-existing smart-model fixture satisfiable and finish the
count-unification tails T10 could not reach (out of its file bounds).
**Design context:** T10 audit 2026-07-23. Fixture fix is test-only and conservative:
raise seeded `contextLength` well above floor+prompt (e.g. 100000) so the seeded
models are eligible again; do NOT change eligibility semantics (the alternative —
re-basing remaining-context eligibility — is a product ruling reserved to the
human). Unification tails per One Implementation Shared: replace the two remaining
hand-rolled history char reduces with shared `historyCharacterCount`
(`apps/api/src/slices/models/domain/trial-eligibility.ts:191`,
`apps/web/src/components/chat/page/trial-chat-page.tsx:320-323`); remove now-dead
`PromptBudgetInput.capabilities` (`use-prompt-budget.ts:46`) and its feed from
`prompt-input.tsx`.
**Acceptance criteria:**
- The 2 smart-model cases in `chat/routes.integration.test.ts` pass; no eligibility
  semantics changed (no non-test file in the smart-model path edited).
- Zero hand-rolled history char reduces remain repo-wide (multiline-safe grep
  evidence); both call sites import the shared counter; behavior byte-identical
  (existing tests stay green, trial-eligibility tests re-pinned only if counts
  genuinely change — if they change, STOP and report, that is a divergence T10's
  parity work says should not exist).
- `capabilities` input gone from `PromptBudgetInput` and `prompt-input.tsx` feed;
  web typecheck/lint/tests green.
**Files:** `apps/api/src/slices/chat/routes.integration.test.ts` (fixture lines
only), `apps/api/src/slices/models/domain/trial-eligibility.ts` (count line only),
`apps/web/src/components/chat/page/trial-chat-page.tsx` (count lines only),
`apps/web/src/hooks/billing/use-prompt-budget.ts` (dead input only),
`apps/web/src/components/chat/input/prompt-input.tsx` (dead feed only), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`; typecheck/lint both.
**Sensitive:** no.

### A3 — Contract-change sweep rule (all remaining tasks)

Lesson from T02's fix cycle: scoped checks cover the task's named packages, but a
changed shared contract (type shape, schema, invariant like "catalog rates are
billable") can have producers/consumers OUTSIDE them — `scripts/` (seeds, dev
tooling), `e2e/`, `apps/marketing`. Any task that changes a shared type, Zod
schema, or cross-package invariant MUST (a) grep repo-wide for every
producer/consumer of the changed contract (type name, schema name, and semantic
producers — anything that constructs the shape by hand) and list them in the
report with a disposition each, and (b) run the repo-wide `pnpm typecheck` (not
only the scoped filters) before declaring done. Auditors verify both. Applies
with special force to T03 (NanoLineItem.kind), T04 (WORST_CASE + port helper),
T11 (effort options types), T15/T16 (solver signatures), T18 (db schema).

### A4 — No E2E execution this run (human ruling, 2026-07-23)

The close phase does NOT run any E2E suites — the plan's "Related E2E (declared
close phase)" execution step is removed. All E2E CODE changes remain in scope:
Task 21 still authors/extends the multi-model + Smart Model sibling spec per
e2e/CLAUDE.md, and any spec edits other tasks imply are still made. Specs are
delivered lint/typecheck-clean but unexecuted; running them is founder-owned,
after the run. T21's acceptance criteria are amended accordingly: authored spec +
static gates (lint/typecheck) replace green-run evidence; its auditor judges the
spec on conformance to e2e/CLAUDE.md conventions and assertion completeness, not
on a passing run.

### A5 — Rulings on the T07/T08 audit design questions (human, 2026-07-23)

- **`concurrentRunsRemaining` is DELETED** from `GET /billing/spendable` (human
  ruling; field had zero consumers in code or plan — the run cap stays fully
  enforced at admission with its typed refusal; the Lua script may keep computing
  the count internally, it just isn't served). T07's Handoff interface is amended
  to `{ spendableNanoUsd: NanoUSD, heldNanoUsd: NanoUSD }`; BILLING.md line
  updated (approved doc edit). T09 and all downstream consume the two-field shape.
  This also moots the free-vs-purchased-wallet run-count question.
- **Budgets endpoint owner-balance dimension stays RAW** (human ruling): the
  hold-aware member/conversation dimensions + raw clamped owner balance shipped by
  T08 are the final semantics; do not make the owner dimension hold-aware (privacy:
  members must not infer owner activity; divergence is hold-TTL-bounded per
  BILLING §Affordability 2).

### A1 addendum (2026-07-23, T02 fix cycle)

Additional pre-existing failure, attribute around: `scripts` suite collection
failure in `refresh-catalog-run.test.ts` + `seed-run.test.ts` — vitest 4.1.8
mangles the SSR-optimized `@hushbox/db` dep URL (`&v=` vs `?v=`) under
`vi.mock` + `importOriginal`; reproduces with all run edits reverted and after
cache wipes. Tests themselves pass when collected (1754/1754). Needs an owner
outside this run; surface at close.

### A1 addendum 2 (2026-07-23, T07 fix cycle)

Recurring environmental hazard, attribute around: an orphan `email=''` user row
intermittently appears in the shared dev DB (likely debris from a crashed test
mid-run) and breaks `identity/routes-email-verification` (`users_email_unique`)
for full `pnpm test:api` runs until cleared. Verified absent at orchestrator
check right after T07's fix cycle — it is transient, not a standing fixture. If a
full-suite run hits it: `DELETE FROM users WHERE email='';` on the local
`hushbox` DB and re-run; do not chase it as a product bug in this run.
Also note: DEVELOPMENT.md now documents a "pole" test gate (one file >50% of a
package's test-work and ≥15s fails the run) — implementers adding large
integration files must split rather than accrete.

### A6 — T03 landing notes (binding on T04/T05 briefs)

- **T05 seam allowlist:** `search-reservation.ts` now imports `applyMarkupCeil`
  to define its billable-at-definition constant. T05's arch rule must either
  allowlist this definition-time seam or hoist the constant into money.ts —
  T05's implementer decides with justification; silence is not an option.
- **Transitional under-reserve window (until T04):** holds are now billable
  while `chargeWithinTx` still applies markup — a hold can sit ~15% under the
  transitional settlement charge. Plan-mandated sequencing; T04 closes it. Do
  not "fix" admission for it.
- **`WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL`** survives as a transitional
  export solely for the api WORST_CASE wrapper; T04 deletes both.
- **Environment gotcha (all subsequent web/api tasks):** vite `optimizeDeps`
  pre-bundles @hushbox/shared — after shared-package changes, stale caches make
  api/web tests silently run OLD shared code. Clear `node_modules/.vite` at
  root/api/web before trusting test results against fresh shared edits.

### A7 — T06 landing notes (binding on T04/T09/T11/T12/T13/T14/T16 briefs)

- **B+H bounded JOINTLY** (T06 reading, recorded as the run's semantics): ceiling
  = min(reasoning budget headroom, context headroom, tightest output cap); H =
  ceiling − B; sub-floor caps keep floor-wins B=1024 with refusal via headroom.
- **Wire schema deviation (audit-pending):** packages/shared/src/schemas/api/
  models.ts gained an optional `maxOutputTokens` field — without it modelSchema
  strips the field and the list-models wire criterion is unimplementable.
- **T04 must add:** `toPoolCandidate` (smart-model-candidates.ts, already in
  T04's Files list) needs the one-line `limits['maxOutputTokens']` spread or the
  server Smart Model path never carries the bound end-to-end.
- **T13/T14 must add:** smart-model-turn.ts `answerMaxOutputTokens` hand-builds
  TurnModelPricing without the cap — thread it when those tasks rework the file.
- **T11/T12 must add:** client headroom min() in reasoning-effort-menu.tsx:70,93
  lacks the cap term — dies when shared turnEffortOptions replaces it (T12
  deletes the local math; T11's shared fn must carry the cap).
- **T09/T16 must add:** client SmartModelPoolCandidate construction
  (use-prompt-budget.ts) must copy the wire `maxOutputTokens` — belongs to
  whichever of T12/T16 first touches use-prompt-budget.ts (T09 is barred from
  that file); orchestrator assigns at dispatch.

### A8 — T11 interface amendment (BINDING for T12/T13/T14 briefs)

Shared effort authority (packages/shared/src/estimate/effort-options.ts):

- `turnEffortOptions(models: readonly ReasoningPlanModel[]): EffortOption[]`
  where `EffortOption = { choice: CanonicalReasoningEffort | 'none';
  maxReasoningBudgetTokens: number; completionCapTokens: number | undefined }`
  (the A7 cap term rides completionCapTokens).
- `resolveEffortForModel(model: ReasoningPlanModel, chosen: EffortChoice):
  ResolvedEffort` where `ResolvedEffort = { kind: 'level'; level: OfferedLevel }
  | { kind: 'off' } | { kind: 'default' }`. `default` = send NO reasoning wire
  (non-reasoning model, or mandatory single-level no-choice model) — a case
  BILLING's two ruled edges don't name; two real catalog shapes force it. T13's
  server resolution must map it to wire-silence, never to an error.
- `validCap` now exported from reasoning-plan.ts (estimate-internal reuse only;
  not on the root barrel).
- The new exports have zero production consumers until T12/T13 — a knip run
  before then may flag them; attribute, don't "fix".
- Web `EffortModel` still lacks a declared `maxOutputTokens` field — T12 MUST
  declare it when feeding turnEffortOptions (A7 hazard closure).
- Hoisted `offeredEffortLabels` deliberately keeps intersection semantics
  (behavior freeze); T12/T13 retire its consumers, then it dies.
