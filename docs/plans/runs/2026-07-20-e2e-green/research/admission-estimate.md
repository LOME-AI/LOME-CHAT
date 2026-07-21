# Admission-estimate ceiling — corrected-formula proposal (run 2026-07-20-e2e-green)

Founder ruling (2026-07-20): a Smart-Model chat turn MUST fit inside the 5¢ free daily
allowance; the E2E test is correct; Smart Model needs NO special handling; the admission
estimate equation is WRONG. This doc traces the wrong terms, cites the deployed legacy
baseline it regressed against, computes today-vs-corrected nano-USD, and names the fix.

Constants (verified):
- `DAILY_ALLOWANCE_NANO_USD` = `FREE_ALLOWANCE_CENTS_VALUE(5)` × `NANO_USD_PER_CENT(10_000_000)`
  = **50,000,000 nano-USD ($0.05)** — billing/domain/constants.ts:21, shared/nano-usd.ts:40, shared/tiers.ts:12.
- markup ×1.15 (`MARKUP_BASIS_POINTS=1500n`, billing/domain/money.ts:22,89-93).
- `MAX_CLASSIFIER_CONTEXT_CHARS`=4000 (shared/smart-model/truncate.ts:5),
  `CLASSIFIER_OUTPUT_TOKEN_CAP`=2048 (shared/smart-model/eligible-models.ts:21),
  `CHARS_PER_TOKEN_CONSERVATIVE`=2, `MINIMUM_OUTPUT_TOKENS`=1000 (shared/constants.ts:177,164).

---

## 1. How the ceiling is computed today

### (b) Plain single-model turn
`createEstimateRun` → `estimateModelNode` → `modelCeiling` (estimate-run.ts:262-307).
For a language model the usage is built at **estimate-run.ts:301-305**:
```
inputTokens  = descriptor.limits.contextLength          // FULL context window — always
outputTokens = declaredOutputCeiling(params, contextLength)  // maxOutputTokens if declared, else FULL context
```
Then `estimateRunCeilingNanoUsd(pricing, usage, {maxFanOutWidth, maxSteps, maxIterations})`
(estimate.ts:296-310) = `applyMarkup((inTok·inRate + outTok·outRate) × fanOut × maxSteps × maxIterations)`.
Multipliers for a plain non-search chat turn are all **1** (fanOut=1, loop=1; the modelCall's
`maxSteps` default=1 — `maxSteps: MAX_SEARCH_TOOL_CALLS(=10)` is applied ONLY to a
web-search turn via `WEB_SEARCH_TOOLING`, turn-definition.ts:43-46). So the inflation is
**purely the per-leg full-context token pricing of the input leg** (and the output leg
whenever no `maxOutputTokens` is declared).

### (a) Smart-Model turn
`estimateSmartModelNode` (estimate-run.ts:356-386) = classifierCeiling + MAX over candidate
ceilings (one candidate answers). Both go through the same `modelCeiling`:
- **Classifier** (estimate-run.ts:364-368): called with `params: {}`, `maxSteps: 1`. Empty
  params ⇒ `declaredOutputCeiling` falls back to contextLength (estimate-run.ts:321) ⇒
  classifier is priced **full context on BOTH legs** — it is never bounded at admission.
- **Candidates** (estimate-run.ts:372-378): called with `node.params` (which carries the
  build path's derived `answerMaxOutputTokens`), `maxSteps: 1`. So the candidate OUTPUT leg
  can honor `maxOutputTokens`, but the candidate **INPUT leg is still full context**
  (estimate-run.ts:303 is unconditional).

### Wrong terms that inflate it > 5¢
1. **estimate-run.ts:303 `inputTokens: contextLength`** — the input leg is ALWAYS the full
   context window, never the actual prompt. Dominant term for every language node.
2. **estimate-run.ts:304 + declaredOutputCeiling:321** — output falls back to full context
   whenever `maxOutputTokens` is absent; for the classifier (`params:{}`) it ALWAYS is.
3. **estimate-run.ts:364-368 classifier basis** — the classifier is priced as a generic
   full-context modelCall instead of its real bounded reserve (truncated
   `MAX_CLASSIFIER_CONTEXT_CHARS` input + `CLASSIFIER_OUTPUT_TOKEN_CAP` output) that the
   candidate filter already computes in `classifierWorstCaseBaseNanoUsd`
   (smart-model-candidates.ts:113-133). This mismatch is exactly why a turn passes the
   affordability filter yet 402s at admission (candidates.ts:36-39 documents the coarser
   admission basis; RC-6/chat-misc.md is this failure).

Secondary: a **web-search** turn multiplies the full-context token ceiling by
`maxSteps=10` AND adds the flat `WORST_CASE_SEARCH_RESERVATION_NANO_USD` — the 10× on the
token leg is an extra over-count on top of the two above.

---

## 2. Legacy deployed baseline — did NOT price full context both legs

Deployed monolith held admission via `reserveBudget`/`reserveGroupBudget` over a
`worstCaseCents` computed upstream by **`computeWorstCaseCents`**
(legacy/apps/api/src/legacy/lib/stream-pipeline.ts:205-211):
```
worstCaseCents = (estimatedInputCost + effectiveMaxOutputTokens × outputCostPerToken) × 100
```
Fed by `computeBudgetAndWorstCase` (stream-pipeline.ts:762-798):
- input leg = `budgetResult.estimatedInputCost` — the **actual prompt** (char-count→tokens
  via `calculateBudget`), NOT the context window.
- output leg = `effectiveMaxOutputTokens = safeMaxTokens ?? (minContextLength − estimatedInputTokens)`
  — a **budget-derived bounded max-output cap**, only falling back to remaining context.
- Smart Model = the bounded classifier `stageReservationCents` pre-deducted inside
  `calculateBudget` then added back (stream-pipeline.ts:757-760,776,797); the classifier was
  the truncated-context + `CLASSIFIER_OUTPUT_TOKEN_CAP` reserve, never full context.

So the deployed baseline priced **actual-prompt input + bounded max-output**, per model.
The rewrite regressed by switching the input leg (and the classifier's both legs) to the
full context window.

---

## 3. Today-ceiling vs corrected (nano-USD)

Catalog is LIVE (e2e-models.ts) — the E2E text set is `anthropic/claude-opus-4.6`,
`anthropic/claude-sonnet-4.6` (e2e-model-ids.ts:21); the classifier is the cheapest exposed
text model. Using the standard Anthropic price points these ids map to (200K context;
Sonnet $3/M in, $15/M out = 3,000 / 15,000 nano-USD/token; Opus $15/M, $75/M = 15,000 /
75,000):

TODAY (full context = 200,000 both legs, ×1.15):
- Plain Sonnet turn: (200_000·3_000 + 200_000·15_000)·1.15 = **4,140,000,000 nano ($4.14)** — 83× the allowance.
- Plain Opus turn: (200_000·15_000 + 200_000·75_000)·1.15 = **20,700,000,000 nano ($20.70)** — 414×.
- Smart-Model (Sonnet classifier full-ctx + Opus candidate full-ctx): 4.14 + 20.70 =
  **24,840,000,000 nano ($24.84)** — ~497× the $0.05 allowance.

CORRECTED (actual prompt input + bounded maxOutputTokens output, classifier at bounded reserve):
- Classifier bounded reserve, Sonnet rates: input ≈ `MAX_CLASSIFIER_CONTEXT_CHARS/2`≈2000 tok,
  output `CLASSIFIER_OUTPUT_TOKEN_CAP`=2048 tok → (2000·3_000 + 2048·15_000)·1.15 ≈
  **42,228,000 nano ($0.042)** (and far less for the actually-cheapest text classifier).
- Answer leg: `answerMaxOutputTokens` is already sized by `turnMaxOutputTokens`
  (turn-definition.ts:165-194) against `allowance − classifierReserve`, over the actual
  prompt input — so classifier + answer ≤ $0.05 **by construction**; a model whose
  `MINIMUM_OUTPUT_TOKENS(1000)` floor cannot fit is filtered out (buildable:false / not a
  candidate) rather than admitted. Invariant holds.

The build path (`buildSmartModelTurn`→`answerMaxOutputTokens`, smart-model-turn.ts:71-139)
ALREADY derives the bounded cap and stamps `params.maxOutputTokens`; the estimator simply
ignores it on the input leg and never applies a bounded basis to the classifier.

---

## 4. Corrected estimate formula

Per language node, replace estimate-run.ts:301-305 with:
```
inputTokens  = actualPromptTokens        // the turn's real prompt (char→token estimate),
                                          // bounded by contextLength — NOT the context window
outputTokens = declaredOutputCeiling(params, contextLength)   // unchanged; maxOutputTokens is authoritative
```
For the smartModel classifier (estimate-run.ts:364-368): price the **bounded classifier
reserve** — `MAX_CLASSIFIER_CONTEXT_CHARS/CHARS_PER_TOKEN_CONSERVATIVE (+overhead)` input,
`CLASSIFIER_OUTPUT_TOKEN_CAP` output — reusing `classifierWorstCaseBaseNanoUsd`
(smart-model-candidates.ts:113-133) so admission and the affordability filter share ONE
basis and can never disagree.

- Output basis: the **bounded `maxOutputTokens`** the build path already computes
  (`turnMaxOutputTokens`), fallback to context only when genuinely undeclared.
- Input basis: the **actual prompt token count**, not the context window. (Admission has the
  prompt at build time; it is the same figure `turnMaxOutputTokens` already uses as
  `estimatedInputTokens`.) This is the single dominant fix.

Invariant to pin: **"free-tier default-model (Smart Model) worst-case admission ceiling ≤
`DAILY_ALLOWANCE_NANO_USD`"**. Enforcement-rung contract test: the one named in
research/billing.md §RC-B ("free-tier default-model worst-case admission ceiling ≤ daily
allowance") and RC-6/chat-misc.md ("default/Smart turn worst-case admission reserve ≤ funded
test balance") — Rung 3 contract test over the estimator, single class-killer.

### Separate finding — swallowed error at runtime.ts:612
`withPostCommitSnapshotRefresh` (runtime.ts:604-616+) swallows the post-commit Redis
snapshot-refresh failure by design (comment 604-611). Consequence for a shared E2E wallet:
the NEXT admission gates on a stale balance snapshot (healed only by the 30s snapshot TTL,
SNAPSHOT_TTL_SECONDS=30), so outstanding-hold bleed across serial specs can deterministically
push available balance below a (correctly-sized) reserve. Independent of the estimate fix;
flag as its own item (telemetry the swallow; per-test wallet isolation is the RC-6 sibling).

---

## 5. Client preflight (RC-4 / Task-10) — needs its OWN change

The corrected estimator fixes the SERVER admission ceiling only. The client preflight gap is
independent: `apps/web/src/hooks/models/models.ts:66` filters `SMART_MODEL_ID` out of the
pricing candidate set and `getModelCostPer1k(SMART_MODEL_ID)` is undefined
(chat-misc.md RC-4), so `use-prompt-budget`/`budget-messages` cannot compute an unaffordable
state for the sentinel. The corrected server basis does not give the client a price for the
virtual id. RC-4 needs its own change (a client-side Smart-Model pricing basis — e.g. the
cheapest-candidate worst-case, or a dedicated preflight query). **Task-10 does NOT fold into
the estimate fix; keep it separate.**
