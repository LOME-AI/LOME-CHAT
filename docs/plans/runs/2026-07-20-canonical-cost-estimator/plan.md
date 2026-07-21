# Plan — Canonical nano-USD cost estimator

**Tier: 2** (large, money-critical, client+server+shared+wire-contract).

## Goal
One canonical nano-USD-bigint cost estimator in `packages/shared/src/estimate/` that BOTH client and
server call. Reproduce legacy reservation SEMANTICS with new nano-USD/DAG mechanics. Delete the legacy
float estimator math outright. Founder decisions locked: hybrid semantics; shared-package location;
delete old code completely; pricing wire = named nano `WireModelPricing`, float fields removed.

**Success criterion (reframed):** NOT "client display == server hold" (those legitimately differ). The
guarantee is **one estimator, input-driven — identical inputs → identical nano output**, proven by a
primitive-level cross-parity test, plus a legacy-semantics parity suite over the affordability path.

## Global Constraints (part of every task's criteria)
- **Money doctrine:** nano-USD `bigint` only; never `Number()`-coerce money; serialize as `NanoUSD`
  strings at JSON boundaries. No float in any money path. Markup = `roundHalfEvenDiv(base×11500n,10000n)`
  applied **once** per marked-up subtotal (model cost + web-search mark up; storage does NOT).
- **One implementation:** no cost math may exist in two places. Server `estimate.ts`/`estimate-run.ts`
  and client hooks REBUILD on the shared core — never clone its formulas. Any duplicated formula is a defect.
- **"One Implementation, Shared" (new CODE-RULE, mid-run):** mirrored constants, `keep in sync` comments, and golden
  cross-check tests are BANNED — the only fix is one shared value/impl (derive alternate representations from it). This
  retroactively bans the storage-rate drift guards T2/T3 introduced; they are known-interim, OWNED by T11 (do not add
  NEW ones). New tasks: use the one canonical nano rate; derive, never mirror-and-guard.
- **The estimator is NOT required to be content-free** (founder-approved): `estimate-run` may take a turn-level
  `storageContext` (chars/tier) to price storage. The old "DAG estimator never sees content" line is removed.
- **char→token stays a client-only pre-adapter** (`estimateTokensForTier`, 2 chars/tok free/trial/guest,
  4 paid; output storage inverted). The core is input-driven: it receives token counts, never chars→tokens.
- **Storage IS a manifest line item** (fixed input-chars + variable output-chars/token tier-inverted).
- **Reservation hold INCLUDES storage** — matches legacy (legacy `worstCaseCents` included storage).
  [CONFIRM AT APPROVAL — see §Open decision.]
- **Reserve ≥ charge (founder principle): if a term is billed at settlement, admission reserves a best-guess for it.**
  Applies notably to MEDIA turns: settlement charges media byte-storage + prompt char-storage + provider, so admission
  must reserve all three (media byte-storage estimated + input char-storage from a stamp + provider). This is a deliberate,
  tiny divergence from legacy (which billed media prompt char-storage on neither side) — chosen for reserve/charge
  consistency. Rates are legacy-identical: char = 300n/char ($3e-7), media byte = 18n/byte.
- **Fail-closed:** any unpriceable node/model → `Result` error → admission refuses; never a low estimate.
  `subWorkflow` stays fail-closed (out of scope).
- **Constants (single-sourced in `packages/shared/src/constants.ts`):** TOTAL_FEE_RATE 0.15,
  STORAGE_COST_PER_CHARACTER $3e-7, MINIMUM_OUTPUT_TOKENS 1000, CHARS_PER_TOKEN 2/4, MAX_SEARCH_TOOL_CALLS
  10, SEARCH_COST_PER_CALL $0.005, MAX_ALLOWED_NEGATIVE_BALANCE_CENTS 50, MAX_TRIAL_MESSAGE_COST_CENTS 1,
  ESTIMATED_IMAGE_BYTES 8MB, ESTIMATED_VIDEO_BYTES_PER_SECOND 5MB, MAX_SELECTED_MODELS 5.
- **Boundaries:** slice/arch rules hold; only adapters import infra; domain returns `Result`; no barrel widening
  that erases AppType. Every changed file's scoped check must pass after the LAST edit (see §Scoped checks).
- No git state mutation. Tests colocated, TDD, no skipped tests, coverage maintained (95% per-file).

## Interfaces (the canonical core — exact seam all tasks build to)
Defined by T2/T3; consumers cite these.
```
// packages/shared/src/estimate/
type NanoLineItem = { label: string; fixedNano?: bigint; variableOutputRateNano?: bigint; marksUp: boolean };
interface Manifest { items: NanoLineItem[]; }               // fixed + variable-output-rate line items, pre-markup
interface BillableRequest {                                  // input-driven; NO chars, NO tier heuristic inside core
  models: { pricing: WireModelPricing }[];                  // ≥1; nano rates
  inputTokens: bigint; inputChars: number;                  // caller (client pre-adapter OR server stamp) supplies tokens
  modality: 'text' | 'image' | 'video' | 'audio';
  media?: { rateKey: string; dimensionKey?: string; units: number; storageBytes: number };
  webSearch?: boolean;
  classifierStage?: { pricing: WireModelPricing; inputTokens: bigint; inputChars: number };  // Smart Model
}
priceRequest(req: BillableRequest): Result<Manifest, DomainError>          // builds nano line items, NO markup
reservationCeiling(m: Manifest, c: { outputTokenCeiling: bigint; fanOutWidth: number; maxSteps: number; maxIterations: number }): NanoUSD
affordability(m: Manifest, effectiveBalanceNano: bigint): { canSend: boolean; maxOutputTokens: bigint; minCostNano: bigint; denialReason?: string }
// Pre-adapters (client-facing, shared): estimateTokensForTier, outputCharsPerTokenForTier, getEffectiveBalanceNano,
//   spendableFundsNanoUsd, getCushionNano; media nano pricers; classifier line-item builder.
```
Exact field names/types are T2/T3's to finalize; later tasks READ them from `packages/shared/src/estimate/index.ts`.

## Related E2E
No new E2E required (billing reservation/affordability is exercised at integration level; streaming/settlement
E2E already exist). Existing E2E to run at close: the chat-send / billing-gate specs and any smart-model spec —
enumerate in Phase 4 from `e2e/`. New E2E only if the completeness critic finds a user-flow gap.

---

## Tasks

### T1 — Hoist nano money primitives into shared  [foundation]
**Objective:** `applyMarkup`, `MARKUP_BASIS_POINTS`, `roundHalfEvenDiv`, `usdToNanoUsd` live in `packages/shared`;
apps/api `money.ts` re-exports them (keep the `assertMarkupMatchesSharedRate` drift guard against TOTAL_FEE_RATE).
**Acceptance:** functions moved to `packages/shared/src/money.ts` (new), identical behavior (half-even, BASIS 10000n,
MARKUP 1500n); `apps/api/.../billing/domain/money.ts` re-exports from shared; all existing callers + tests green;
no float introduced. Barrels updated.
**Files:** `packages/shared/src/money.ts` (new), `packages/shared/src/index.ts`, `apps/api/src/slices/billing/domain/money.ts`, `apps/api/src/slices/billing/{domain/,}index.ts`.
**Scoped checks:** test:shared + test:api; typecheck+lint shared & api. **Sensitive?** YES (money).
**Depends:** none.

### T2 — Canonical core: types + text manifest + reducers  [heart]
**Objective:** `packages/shared/src/estimate/` with `NanoLineItem`/`Manifest`/`BillableRequest`, `priceRequest`
(text/token path: per-model input+output nano rate summed, input-storage fixed, output-storage variable
tier-inverted-via-caller), `reservationCeiling`, `affordability`. Re-home tier/token/cushion pre-adapters
(`estimateTokensForTier`, `outputCharsPerTokenForTier`, cushion/spendable/effective-balance nano helpers) here.
**Acceptance:** TDD; markup applied once in reducers per `marksUp`; affordability inverse-solve matches
`floor((balance−fixed)/variableRate)` with MINIMUM_OUTPUT_TOKENS min-cost gate and cushion; storage included; no
float; pure (no I/O). Unit tests for each reducer + edge cases (zero inputs, multi-model sum, cushion boundary).
**Files:** `packages/shared/src/estimate/*` (new).  **Scoped:** test:shared; typecheck+lint shared. **Sensitive?** YES.
**Depends:** T1.
**Produces:** the §Interfaces seam.

### T3 — Core: media + web-search + classifier line items
**Objective:** extend the core with deterministic image/video pricing, worst-case audio (maxDuration), web-search
worst-case reservation (`applyMarkup(MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL)`), and the Smart-Model classifier
line item (bounded worst case: truncated context + prompt overhead + output cap), all nano, on the same Manifest.
**Acceptance:** TDD; media matches legacy component formulas (price×units + storage×modelCount) in nano; search
marks up, storage does not; classifier is a fixed pre-reserve line item; image/video deterministic (exact), audio
worst-case. Media size gate (min-output-bytes vs ValueStore budget) preserved as a fail-closed check.
**Files:** `packages/shared/src/estimate/*` (media/search/classifier modules). **Scoped:** test:shared. **Sensitive?** YES.
**Depends:** T2.

### T4 — Legacy-semantics parity suite (affordability)
**Objective:** port `legacy/apps/api/src/legacy/routes/chat.billing-scenarios.md` matrix as executable tests against
`affordability`/`priceRequest`: F1–F6 (free), P1–P6 (paid cushion), M1–M5 (min-output boundary), TE1–TE3 (tier token
estimation), multi-model sum, and Smart-Model (classifier reserve + worst-of-eligible). Pins "legacy semantics."
**Acceptance:** every scenario's PASS/DENY + error class + maxOutputTokens/minCost reproduced by the core (nano). A
failing scenario is a real semantic gap, fixed in T2/T3 (route back through orchestrator).
**Files:** `packages/shared/src/estimate/parity.test.ts` (new). **Scoped:** test:shared. **Sensitive?** YES. **Depends:** T2, T3.

### T5 — Wire contract: nano `WireModelPricing`, delete float fields
**Objective:** add named `WireModelPricing` (nano `NanoUSD` fields) to the wire `Model` schema; delete float
`pricePer*`/`minPricePer*`/`maxPricePer*`; `list-models.ts` projects nano (no `feeInclusiveUsd` float collapse).
**Acceptance:** `Model` carries typed nano pricing (not loose `z.record`); Smart-Model min/max range expressed in nano;
client receives nano over the wire; typed-client `AppType` intact; api tests green.
**Files:** `packages/shared/src/schemas/api/models.ts`, `apps/api/src/slices/models/domain/list-models.ts`, related model barrels.
**Scoped:** test:shared + test:api; typecheck+lint shared & api. **Sensitive?** YES. **Depends:** T1.

### T6 — Migrate ALL float-pricing-field consumers (restore compile) [AMENDED — owns T5's full blast radius]
**Objective:** own every reader of the float `pricePer*`/`minPricePer*`/`maxPricePer*` fields T5 deleted, so
`packages/shared`, `apps/web`, and `apps/marketing` all COMPILE again after this task. Two parts:
(a) shared nano→display formatters (`nanoPricePer1k`, nano `isExpensiveModel`, nano range formatter) + migrate
`model-info-panel.tsx`, `model-selector-helpers.ts`, `formatPriceRange`, marketing `calculate-cost.ts`;
(b) shared consumers broken by the deletion: `smart-model/eligible-models.ts` (delete its float-pricing functions —
`combinedPrice`/`filterAndSortCandidates`/`buildEligibleModels`/`computeMaxClassifierOverhead` are superseded by the
T2/T3 core; **preserve `CLASSIFIER_OUTPUT_TOKEN_CAP` in a single stable home**) and `capabilities/model-capabilities.test.ts`.
**Acceptance:** all price displays/sorts render from nano (display formatters apply markup to the BASE nano wire, since wire is pre-markup);
no reference to deleted float fields in the files T6 owns; `CLASSIFIER_OUTPUT_TOKEN_CAP` stays at its CURRENT export path (do NOT move it —
keep T3's + api's importers resolving); **packages/shared + apps/marketing typecheck/lint GREEN**; apps/web display files green — but
web is NOT fully green until T9 (the client billing hooks use-prompt-budget/use-budget-calculation/use-media-cost-estimate/use-resolve-billing
still consume deleted float math and are T9-owned; attribute those remaining web errors to T9, do not fix them here).
**Files:** `packages/shared/src/estimate/format.ts` (or shared format), `packages/shared/src/smart-model/eligible-models.ts` (+ its test), `packages/shared/src/capabilities/model-capabilities.test.ts`, `apps/web/.../model-info-panel.tsx`, `apps/web/.../model-selector-helpers.ts`, `apps/marketing/src/lib/calculate-cost.ts`, `apps/web/src/lib/format.ts`/`tokens.ts` as needed.
**Scoped:** test:web + test:shared (+ marketing typecheck/lint); typecheck+lint shared & web. **Sensitive?** no (display/deletion). **Depends:** T5, T2, **T3** (file-ownership: T3 and T6 both edit estimate/ + root index.ts named block — must not run concurrently; T3 runs first).
**Note:** between T5-clean and T6-clean, `packages/shared` typecheck is EXPECTED RED (eligible-models/capabilities read deleted fields); downstream shared tasks attribute it out-of-scope until T6.

### T7 — Server: rebuild estimate.ts / estimate-run.ts / smart-model-candidates on the core  [UNBLOCKED — storage design settled]
**Objective:** the models-slice estimators call the shared core; delete their duplicate per-call/media/classifier math.
`estimate-run.ts` stays the DAG walker (enclosure, smartModel max-over-candidates, subWorkflow refuse) but prices each
node via the shared reducer. `model-resolver.ts`/trial paths follow.
**STORAGE (tier-exact, founder-ruled — Option A "injected storageContext"):** widen `createEstimateRun` to accept an
OPTIONAL turn-level `storageContext = { inputChars: number; tier: UserTier }` (backward-compatible; T8 injects it from
TurnBudget, general workflows pass none → zero storage). When present, `estimate-run` adds, via the shared core's storage
line items: **input-storage ONCE at the definition level** (`inputChars × nano-rate`), and **output-storage per
answer-producing node** (each `modelCall`/`smartModel` node's `outputCeiling × outputCharsPerToken(tier) × nano-rate`).
Classifier storage is STRUCTURAL (constant chars) but tier-dependent on its output leg — use `storageContext.tier`.
**Media storage IS included** (legacy `computeImage/VideoExactCents` included it): estimate-run supplies `storageBytes`
to the core's `buildMediaLineItems` = `ESTIMATED_IMAGE_BYTES` (image) or `durationSeconds × ESTIMATED_VIDEO_BYTES_PER_SECOND`
(video), ×modelCount — structural, tier-independent (bytes-based). This reproduces legacy's manifest (input once, output
×modelCount, classifier own, media incl. storage). All storage is gated on `storageContext` presence (persisting turns);
absent → zero storage. **Trial:** estimate includes storage too (legacy `calculateTrialBudget` did), and the
classifier-with-storage correction applies to the trial 1¢ gate as well (shared `classifierWorstCaseBaseNanoUsd`); recompute
the two `trial-*.test.ts` files. The estimator is no longer purely
structural — that is intentional and approved (the content-free-estimator line is removed). RULE-COMPLIANCE: use the ONE
canonical nano storage rate; do NOT add a mirrored constant or drift guard (the `assertStorageRatesMatchSharedFloats`
pattern is banned — see §Global Constraints; storage-rate dedupe lands in T11).
**Acceptance:** no cost formula duplicated between server and shared; `createEstimateRun` output unchanged for existing
node cases (pinned by existing estimate-run tests, updated only where the number legitimately changes per storage/markup
unification); fail-closed behavior preserved; api tests green.
**Files:** `apps/api/src/slices/models/domain/{estimate.ts,estimate-run.ts,smart-model-candidates.ts,trial-eligibility.ts,trial-smart-model-candidates.ts}`, `apps/api/src/slices/workflows/engine/model-resolver.ts`, models barrels.
**Scoped:** test:api; typecheck+lint api. **Sensitive?** YES (money). **Depends:** T2, T3.

### T8 — Server: turn-definition / runtime / settlement / admission wiring
**Objective:** wire chat/billing to the rebuilt estimator. Criteria 2–5 (settlement media byte-storage via `withStorageFees`,
pathological fallback not duplicated, `admission.ts` estimateNanoUsd unchanged, fail-closed) were already satisfied in the tree.
The remaining work is criterion 1 — the tier-exact storage.
**STAMP-TIER-INTO-DEFINITION (founder-ruled — tier can't ride the run transport to the DO):** `turn-definition.ts` (which has
both `promptCharacterCount` and tier) stamps `{ inputChars, tier }` into the CHAT definition; `estimate-run.ts` reads it
**per-run from the definition** and builds the `storageContext` there (replacing T7's per-DO factory `storageContext` param).
General/non-chat definitions carry no stamp → zero storage. `runtime.ts` wiring follows. Prefer stamping into the existing
node `params` (consistent with how `maxOutputTokens` is carried — no schema change); a minimal OPTIONAL typed field in
`packages/shared/src/workflow.ts` is authorized only if clearly cleaner. Reservation hold includes tier-exact storage this way.
**Expanded files:** the chat/domain + billing/domain files below PLUS `apps/api/src/slices/models/domain/estimate-run.ts`
(+test) [re-open clean T7 file for the per-run sourcing change] and OPTIONALLY `packages/shared/src/workflow.ts` (minimal field).
**Acceptance:** admission hold = reservationCeiling(core) incl. storage; settlement charge unchanged (actual gateway
cost + storage); cost-circuit base intact; smart-model turn + trial paths green; integration tests green.
**Files:** `apps/api/src/slices/chat/domain/{turn-definition.ts,runtime.ts,smart-model-turn.ts,settlement.ts}`, `apps/api/src/slices/billing/domain/{admission.ts,charge.ts,public-usage-stats.ts}`.
**Scoped:** test:api; typecheck+lint api. **Sensitive?** YES (money/settlement → 2 auditors). **Depends:** T7.

### T9 — Client: hooks rewire onto the core
**Objective:** `use-budget-calculation`, `use-prompt-budget`, `use-media-cost-estimate`, `use-resolve-billing` call
the shared core (client pre-adapter builds `BillableRequest` from tier+chars; core returns manifest → affordability +
breakdown for display). Keep `generateNotifications` + who-pays core (`resolveClientBilling`/`resolveFundingDecision`).
**Acceptance:** hooks keep their public return shapes; client estimate & gate derive solely from the core + nano wire
pricing; no import of deleted float math; web tests green.
**Files:** `apps/web/src/hooks/billing/{use-budget-calculation,use-prompt-budget,use-media-cost-estimate,use-resolve-billing}.ts`, `packages/shared/src/models/premium-check.ts`, `packages/shared/src/billing/client-billing.ts`, **plus the media-display components coupled to `useMediaCostEstimate` (handed off from T6): `apps/web/.../media/modality-config-panel.tsx` (+test) and the `generation-config-sheet` video tests** — they can only migrate once this task rewrites the media hook's interface.
**Acceptance additions:** after T9, apps/web typecheck/lint is GREEN except the pre-existing non-pricing breakages (platform-enum ZodError in retry/auth/ws-client; `pipeline-bindings.ts` ExecutionContext) — those are Phase-4 attribution, not T9's to fix.
**Scoped:** test:web + test:shared; typecheck+lint web & shared. **Sensitive?** YES. **Depends:** T2, T3, T5, T6.

### T10 — DROPPED (violates the new "One Implementation, Shared" rule)
A golden cross-check test proving two implementations agree is exactly the banned pattern ("delete one and share the
other"). In this design there is ONE shared core both sides call, so parity is by construction — nothing to cross-check.
Replaced by a structural guarantee: T11 confirms (grep/knip/jscpd) that no second pricing implementation exists and that
client + server both import `packages/shared/src/estimate`. No separate task.

### T11 — Delete legacy float math + barrel/dead-code cleanup
**Objective:** delete `packages/shared/src/budget.ts` float manifest math (`buildCostManifest`,
`calculateBudgetFromManifest`, `canAffordModel`, dead types) and `pricing.ts` media-cents + dead float helpers
(`computeImage/Video/AudioWorstCaseCents`, `estimateVideoWorstCaseCents`, `mediaStorageCost`,
`effectiveOutputCostPerToken`, `estimateMessageCostDevelopment`, `calculateMessageCostFromActual`,
`calculateTokenCost`), `smart-model/eligible-models.ts` dead exports, and any now-unused `applyFees`. Relocate
`generateNotifications` + `estimateTokenCount` to their surviving homes. Clean all barrels. Delete orphaned tests.
Also (rule-compliance, founder-directed): **storage-rate dedupe** — make the nano storage rates the ONE canonical source
(money-doctrine truth); DERIVE any float/dollar rep from nano (or delete the now-unused float `STORAGE_COST_PER_CHARACTER`);
DELETE the drift guards `assertStorageRatesMatchSharedFloats` / `assertMediaStorageByteRateMatchesSharedFloat` and the
mirrored api-side literals — api re-exports the nano rates from `@hushbox/shared` (T1 pattern). And the **T10 replacement**:
grep/knip/jscpd-confirm no second pricing impl exists and client+server both import `packages/shared/src/estimate`.
Also (from T7 audit M2): collapse the twin manifest-fold in `apps/api/.../models/domain/estimate.ts` (`providerBaseFromManifest`)
and `trial-eligibility.ts` (`rawManifestCostNano`) into ONE shared `evaluateManifest(m, tokens, {marksUpOnly})` helper
exposed by `packages/shared/src/estimate` (both are `Σ fixed + tokens × Σ variable` over the core Manifest, differing only
by the marksUp filter) — one implementation of the manifest evaluation.
**Acceptance:** `knip` (unused) clean for the touched area; no dangling imports; nothing references deleted symbols; NO
mirrored-constant/drift-guard/keep-in-sync pattern remains in the estimator surface; whole-repo typecheck/lint/test green.
**Files:** `packages/shared/src/{budget.ts,pricing.ts,billing/client-billing.ts,smart-model/eligible-models.ts,estimate/storage-rate.ts,index.ts}` + tests, barrels; `apps/api/src/slices/billing/domain/money.ts` (drop mirrored storage literals + assert, re-export from shared).
**Scoped:** test:shared + test:web + test:api; lint:unused. **Sensitive?** YES. **Depends:** T6, T8, T9.

## Dependency graph
```
T1 ─┬─ T2 ── T3 ── T4
    │        └────────────┐
    └─ T5 ── T6           │
T2,T3 ───────── T7 ── T8  │
T2,T3,T5,T6 ──── T9       │
T7,T9 ── T10              │
T6,T8,T9 ── T11 ──────────┘
```
Parallel lanes after T1: {T2→T3→T4} (core) ∥ {T5→T6} (wire/display). Then T7→T8 (server) after core;
T9 after core+wire+display. T10 after server+client. T11 last.

## Open decision (confirm at approval)
**Reservation hold includes storage?** Plan assumes YES (matches legacy semantics; tiny conservative bump; closes the
admission-under-reserves-vs-settlement gap). If NO, T8 reservationCeiling excludes storage (storage stays affordability/
display-only) and T4/T10 adjust. This is the one behavior change the unification surfaces.
