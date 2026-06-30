# Spec family: smart-model

**v2 owner:** `chat` slice (the Smart Model classifier-routing flow), consumed as a
`workflows` definition per BACKEND-REDESIGN §11.7. Billing rows land via `billing`.

This file is both the family behavior list (from the test suites) and the **real
semantics** capture required by T0.0. All code facts below are **Verified** (read from
source this session) with file:line citations.

---

## Part 1 — The four named semantics (from current code)

### 1. Classifier-failure fallback

When the classifier stream **throws**, the stage falls back to the cheapest eligible
model (`config.classifierModelId`) with `billing: null` (nothing to bill — there is no
generationId), logs the cause, and resolves the slot instead of aborting it:
`apps/api/src/lib/pre-inference/smart-model-stage.ts:115-131`.

When the classifier **returns garbage** (output resolves to no eligible id),
`resolveClassifierOutput` returns `null` and the stage falls back to the same cheapest
eligible model, but **keeps the billing breadcrumb** if a generationId was returned — the
call cost something whether or not the output was usable:
`smart-model-stage.ts:133-155` (comment at :133-134), with the matcher cascade
(exact → case-insensitive → bidirectional substring → Levenshtein ≤ 0.15×len) in
`packages/shared/src/smart-model/resolve.ts:58-73`.

Both fallback paths emit `fallbackOccurred: true` in the `stage-done` SSE payload
(`smart-model-stage.ts:167-178`). A failed-but-ran stage still counts toward
`stagesRun`, which (not `billings`) drives `derivedIsSmartModel` downstream:
`apps/api/src/lib/pre-inference/executor.ts:22-29,64`.

### 2. Billed-on-completion

The classifier is never charged at classification time. The stage only records a
**billing breadcrumb** (`PreInferenceBilling` with stageId/modelId/generationId/contents)
when the stream produced a generationId (`smart-model-stage.ts:135-144`). The breadcrumb
travels with the slot and is settled at persist time together with the main inference:
`buildStagedPersistInput` computes per-stage cost via `calculateMessageCostWithStages`
and writes the main usage row **plus one row per stage**
(`apps/api/src/lib/stream-pipeline.ts:1200-1235`). Consequence encoded in e2e: a Smart
Model send persists **two** `llm_completions` rows (classifier + inference); a classifier
throw (no generationId) bills zero for the classifier.

### 3. Single-eligible short-circuit with zero classifier bill

When exactly one model is eligible, the classifier call is skipped entirely — the slot
resolves directly to that id with `billing: null` (`smart-model-stage.ts:98-110`;
intent comment at :30-33). No SSE classifier delay, no charge, no gateway call.

### 4. Cheapest-eligible selection

Candidates are tier-filtered (premium excluded for non-paid payers), then sorted
ascending by `pricePerInputToken + pricePerOutputToken`; the **classifier model is
`candidates[0]`** — the cheapest affordable model
(`packages/shared/src/smart-model/eligible-models.ts:84-104,187`). The eligible inference
set is every candidate whose worst-case inference cost **plus** the classifier worst-case
(reserved up front, `eligible-models.ts:119-137,139-169`) fits the payer's effective
balance. `buildEligibleModels` returns `null` when nothing is affordable after classifier
overhead — the send is blocked (`eligible-models.ts:183-208`). The classifier-failure
fallback target is this same cheapest model (`smart-model-stage.ts:113`).

Reservation interplay: `classifierWorstCaseCents` is deducted from balance **before**
sizing the inference budget so reservation + inference can never exceed balance
(`packages/shared/src/budget.ts:629-635`, `preReservedCents`).

---

## Part 2 — Behaviors encoded by the test suites

### e2e — `e2e/chat/smart-model.spec.ts` (titles Verified)

| Behavior | Test title | v2 slice |
| --- | --- | --- |
| Selecting Smart Model streams a response with cost and a "Smart" chip on the message | `selects Smart Model, sends prompt, renders response with cost and Smart chip` | chat |
| Regenerate re-runs classification (fresh classifier call, fresh response) | `regenerate re-runs classification and records a fresh response` | chat |
| Classifier resolution is honored: picked model's nametag renders (driven by `x-mock-classifier-resolution`) | `classifier picks claude-opus-4.6 → response nametag shows Opus`; `classifier picks claude-sonnet-4.6 → response nametag shows Sonnet` | chat |
| Classifier failure falls back to a value model and still renders a response (driven by `x-mock-classifier-failure`) | `classifier failure falls back to a value model and still renders a response` | chat |
| A Smart Model send persists two `llm_completions` rows: classifier + inference | `a Smart Model send persists two llm_completions rows (classifier + inference)` | chat + billing |
| Insufficient balance blocks the send with the budget error (classifier reservation included) | `insufficient balance blocks send and surfaces the budget error` | chat + billing |
| A "Choosing the best model" loading state shows during classification, then clears (driven by `x-mock-classifier-delay-ms`) | `Smart Model shows "Choosing the best model" loading state then clears it` | chat (SSE stage events) |

### Integration/unit (apps/api, packages/shared)

| Behavior | Source | v2 slice |
| --- | --- | --- |
| Stage executor merges transformations, accumulates billings, records `stagesRun` even for unbilled fallbacks; first `ok:false` stops the chain (siblings unaffected) | `apps/api/src/lib/pre-inference/executor.test.ts` | workflows |
| Stage semantics 1–4 above at unit level | `apps/api/src/lib/pre-inference/smart-model-stage.test.ts` | chat |
| Stage resolver wiring (which requests get a smart-model stage) | `apps/api/src/lib/pre-inference/stage-resolver.test.ts` | chat |
| Eligible-set construction, affordability filtering, worst-case math | `packages/shared/src/smart-model/eligible-models.test.ts` | chat (shared) |
| Output→id matching cascade incl. tolerance bounds | `packages/shared/src/smart-model/resolve.test.ts` | chat (shared) |
| Classifier prompt construction and exact prompt-overhead computation | `packages/shared/src/smart-model/prompts.test.ts` | chat (shared) |
| Context truncation to 4000-char budget | `packages/shared/src/smart-model/truncate.test.ts` | chat (shared) |

### Constants this family pins

See `constants.md` — `SMART_MODEL_ID`, `CLASSIFIER_OUTPUT_TOKEN_CAP` (2048),
`LEVENSHTEIN_TOLERANCE` (0.15), `MAX_CLASSIFIER_CONTEXT_CHARS` (4000).
