# Ledger — canonical cost estimator

- 2026-07-20 Phase 1 complete. Research: 4 estimation-domain reports (this session) + consumer-map.md +
  contracts.md + design-analysis.md. Decisions locked: hybrid semantics; shared-package core; delete float
  outright; pricing wire = named nano WireModelPricing (option a). plan.md written (Tier 2, T1–T11). Awaiting approval.
- 2026-07-20 Storage-in-hold ruled: INCLUDE (matches legacy). Plan APPROVED by founder. Phase 3 begins.
- 2026-07-20 T1 → implementing (dispatch 1).
- 2026-07-20 T1 → CLEAN. 2 auditors (correctness + conventions) both PASS, no findings; verified byte-identical
  move, jscpd 0 clones (one impl), drift guard intact, arch:check green. Note: nano storage rates
  (STORAGE_COST_PER_CHARACTER_NANO=300n, MEDIA_STORAGE_COST_PER_BYTE_NANO=18n) still in api money.ts — T2/T3 need
  shared nano storage rate (single-source + drift-guard vs shared float); T11 dedupes api copy.
- 2026-07-20 T2 (core) + T5 (wire) → implementing in parallel (both dep=T1 clean; no file overlap).
  Ownership: T2 owns packages/shared/src/estimate/* AND the estimate export line in shared root index.ts;
  T5 owns schemas/api/models.ts + list-models.ts + models barrels, must NOT edit shared root index.ts.
- 2026-07-20 T2 → DONE_WITH_CONCERNS. Own files green (2273 tests, estimate/* 100% cov, jscpd 0 clones, eslint clean).
  Package typecheck RED = 100% attributable to T5's concurrent float-field deletion (eligible-models.ts +
  capabilities test read deleted pricePer*). NOT a T2 defect. Seam: priceRequest→EstimateResult<Manifest> (local
  discriminated union, NOT neverthrow — shared has no dep; T7/T9 map at boundary — RATIFIED); reservationCeiling;
  affordability; pre-adapters re-homed; STORAGE_COST_PER_CHARACTER_NANO=300n in shared.
  Rulings: (1) local EstimateResult union OK. (2) root barrel explicit-named (avoids TS2308 vs budget.ts's still-live
  pre-adapters) — T11 must broaden when deleting budget.ts. (3) reservationCeiling incl storage — founder-ruled, correct.
  FOR AUDIT: scrutinize markup-order (impl does markup-then-integer-scale; verify "markup once", storage NOT marked up,
  no double-round, no bigint overflow, fail-closed on bad input); confirm zero typecheck errors ORIGINATE in estimate/*.
- 2026-07-20 PLAN AMENDMENT: T6 rescoped to own the FULL float-field-deletion blast radius (web display/sort + marketing
  + shared eligible-models.ts float functions + capabilities test) so packages/shared+web+marketing COMPILE again after
  T6. Preserve CLASSIFIER_OUTPUT_TOKEN_CAP (single home). Downstream shared-touching tasks (T3) attribute the
  eligible-models/capabilities RED as out-of-scope (T6-owned) until T6 lands. Full green enforced at Phase-4 close.
- 2026-07-20 T5 → DONE_WITH_CONCERNS. Owned gates green (test:shared exit 0; models-slice api green; eslint/jscpd clean).
  Package typecheck RED = eligible-models.ts + its test + capabilities test (T6-owned, as amended). Rulings: wire nano is
  BASE/pre-markup (T6 must markup before display; consistent w/ T2 core marking up downstream) — RATIFIED; WireModelPricing
  fields are z.string() NanoUSD (bigint not JSON-serializable) — correct per money doctrine. Report at task-05/task-05/impl-report-1.md.
- 2026-07-20 T2 audit → 3-lens panel dispatched. T5 audit → 2 auditors dispatched. (Both implementers done; shared settled.)
- 2026-07-20 T2 audit results: lens A (arithmetic) PASS, lens B (robustness) PASS, lens C (design-fit) FAIL — 1 Critical.
  VALIDATED (self-verified via git diff + grep): T2's index.ts edit DELETED `export * from './pre-inference/index.js'`
  when adding the estimate block → removes StageId/StageDonePayload/stageLabel/etc. re-export; 5 apps/web files
  import them from the barrel → cross-package compile break. Fix = restore the line. Undisclosed in impl report.
  PROCESS LESSON: a task editing packages/shared ROOT BARREL must typecheck apps/web + apps/api in its self-gate
  (shared-only gate is blind to cross-package barrel breaks). Carry to T6/T9/T11 briefs.
- 2026-07-20 T2 → fixing (dispatch 2, impl-report-2.md): restore pre-inference barrel export.
- 2026-07-20 T2 fix DONE: pre-inference line restored (grep-proven all 5 web importers + 7 symbols resolved, no TS2308,
  shared tests green). Residual RED = T6/T9-owned float blast radius (incl. use-prompt-budget.ts nano-shape → T9). Re-audit dispatched.
- 2026-07-20 T5 audit B (type-safety) PASS. Awaiting T5 audit A (money/correctness) for T5-clean.
- 2026-07-20 T5 → CLEAN. Both auditors PASS (money/correctness + type-safety); verified BASE-nano projection verbatim,
  named WireModelPricing (not loose record), fail-closed drops intact, no float, AppType preserved. I agree.
  Confirmed T6 scope: eligible-models.ts:81/95/96 + test fixtures read deleted pricePerInputToken.
- 2026-07-20 Blocked on T2 fix re-audit (a50b7cf) before dispatching T3 (dep T2) + T6 (dep T2+T5).
- 2026-07-20 T2 fix re-audit PASS → T2 CLEAN (A/B/C-after-fix all pass; I agree). T5 also clean.
- 2026-07-20 SEQUENCING: T3 and T6 both edit estimate/* + root index.ts named block → SHARE FILES → cannot run
  concurrent. Run T3 FIRST (solo). After T3 clean: T6 (shared+web+marketing) ∥ T7 (api) — disjoint files. Then
  T9 after T6+T3; T8 after T7; T10 after T7+T9; T11 last. Added T3 as file-ownership predecessor of T6 in plan.
- 2026-07-20 T3 → implementing (dispatch 1). Media size gate (ValueStore) reassigned to T7 (server concern), not T3.
- 2026-07-20 T3 → DONE. estimate/* 100% cov (2313 tests), legacy formulas cross-checked to exact nano, jscpd 0,
  index.ts barrel diff 0 lines removed. Seam added: buildMediaLineItems, webSearchLineItem, classifierLineItems,
  MEDIA_STORAGE_COST_PER_BYTE_NANO(+guard); types MediaBillable/MediaRateKey/ClassifierStage; priceRequest dispatches modality.
  RULINGS: (a) classifier reserve INCLUDES storage (T3 reproduced legacy computeClassifierWorstCaseCents WITH storage) —
  this is CORRECT per storage-in-hold ruling; T7/T8 adopt T3's core, NOT api's storage-less classifierWorstCaseBaseNanoUsd.
  NOT an open question. (b) BillableRequest.modality OPTIONAL default-text (avoids T2 text-path regression) — RATIFIED;
  T7/T9 build against it. (c) ModelRatesNano.perSecond? added for audio — additive, OK.
- 2026-07-20 T3 audit → 3-lens panel dispatched (arithmetic/parity, robustness, design-fit+barrel-integrity).
- 2026-07-20 T3 → CLEAN. All 3 lenses PASS (parity verified with worked nano examples for image/video/audio/search/classifier;
  fail-closed + prototype-pollution hardening; barrel diff 40 add/0 remove — T2 lesson held). I agree. T2+T3+T5 all clean.
- 2026-07-20 T6 (shared+web-display+marketing) ∥ T7 (api server rebuild) → implementing. Disjoint files.
  T6 greens SHARED+MARKETING + its web display files; web NOT fully green until T9 (billing hooks). T6 keeps
  CLASSIFIER_OUTPUT_TOKEN_CAP at current path. T7 adopts storage-in-ceiling + classifier-WITH-storage (T3 core), keeps
  media-size-gate + DAG walker, maps EstimateResult→neverthrow at boundary, recomputes changed api estimate test numbers.
- 2026-07-20 T7 → NEEDS_CONTEXT (no edits made — correctly refused to guess money math). BLOCKER (money+architecture):
  storage-in-hold needs chars+tier; workflow Node carries only token counts; chars+tier live at turn level (TurnBudget,
  T8). Per-node DAG storage is impossible without a shared Node-schema change (out of scope). Rest of T7 clean.
  ESCALATED to founder: (1) turn-level chat admission via core [recommend], (2) thread turn chars+tier into DAG estimator,
  (3) storage affordability/display-only, hold token-only. T7 paused pending ruling. T6 continues (independent).
- 2026-07-20 T6 died on TRANSIENT api auth error ("Not logged in") mid-edit — NOT a code failure. Needs restart-from-transcript.
- 2026-07-20 FOUNDER RULINGS (design discussion): (1) storage charsPerToken in hold = TIER-EXACT (turn-level). (2) fold
  rule-compliance fixes into this run: storage rate DERIVED-not-guarded (new CODE-RULE "One Implementation, Shared" bans
  mirrored-constant+drift-guard); drop T10 golden cross-check → replace w/ arch check both sides import the one core.
  (3) subWorkflow: LEAVE inert-but-declared. (4) multi-fanOut connection cap: FIX (global semaphore) — but ENGINE scope,
  SEPARATE follow-up run, not this estimator run.
- 2026-07-20 NEW CODE-RULE landed mid-run (founder): "One Implementation, Shared" — bans mirrored constants, keep-in-sync
  comments, golden cross-check tests; only fix is one shared impl. Impacts: our storage drift-guards (remove→derive),
  T10 (drop), engine's 20MB VALUE_STORE constant (hoist — engine follow-up).
- 2026-07-20 ENGINE QUALITY (analyst, cited): grade high for what ships (single-fanOut chat/smart-model), NOT-yet-prod as
  general engine. Top risks: untyped params bag (unknown-typed maxOutputTokens/resolution/n), mirrored 20MB constant,
  multi-fanOut ~36-conn bound > 6-cap. subWorkflow inert-but-shipped. Findings → engine-hardening follow-up (not this run).
- 2026-07-20 STORAGE MECHANISM (orchestrator decision, honoring tier-exact/turn-level): inject turn-level storageContext
  {inputChars, tier} into the estimator factory (createEstimateRun); estimate-run adds MAIN modelCall input-storage-once
  (definition-level) + output-storage-per-node via the core; classifier+media storage already STRUCTURAL (constant chars);
  general workflows pass NO storageContext → no storage. Resolves T7 blocker (chars/tier injected, not from Node schema).
  Awaiting founder confirm of reshaped T7/T8 before re-dispatch.
- 2026-07-20 FOUNDER: "execute with that" + content-free-estimator line is removable → Option A CONFIRMED. Plan amended:
  T7 (injected storageContext design, unblocked), T8 (inject storageContext from TurnBudget), T10 DROPPED (rule), T11
  (+storage-rate dedupe/de-guard), Global Constraints (+One-Implementation-Shared, +estimator-may-see-content). Resuming.
- 2026-07-20 T6 → re-dispatch (restart after transient auth death; reconcile working-tree). T7 → re-dispatch (prior run
  made NO edits; fresh with settled storage design). Disjoint files, parallel.
- 2026-07-20 T7 (2nd) → NEEDS_CONTEXT again (no edits — good). Prior storage blocker RESOLVED by storageContext design.
  Two narrow money rulings (orchestrator-ruled from existing principles, NOT founder-escalated):
  DECISION A (media storage): INCLUDE it (legacy computeImage/VideoExactCents included storage); basis =
  ESTIMATED_IMAGE_BYTES (image) / durationSeconds×ESTIMATED_VIDEO_BYTES_PER_SECOND (video) ×modelCount → core
  buildMediaLineItems storageBytes; structural, tier-independent. Overrode implementer's provider-only lean (would diverge).
  DECISION B (classifier-with-storage): apply EVERYWHERE incl. trial 1¢ gate (shared classifierWorstCaseBaseNanoUsd, one
  impl; legacy calculateTrialBudget included storage); recompute the 2 trial-*.test.ts. All storage gated on storageContext
  presence; classifier output-storage uses storageContext.tier. Plan §T7 updated. Re-dispatch T7 (3rd) with both rulings.
- 2026-07-21 T6 (restart) → DONE_WITH_CONCERNS. Core deliverable met: shared+marketing typecheck/lint GREEN, test:shared
  GREEN (2306), barrel 0-removed, jscpd 0.64%. Applied new rule (derived expensive-threshold from EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  removed a mirror). CAUGHT+FIXED a real money bug: ts-morph getLiteralValue misparsed 0.000_000_1→1 (would've shipped wrong
  display values) — fixed via raw-text parse, pinned by test. HANDOFFS: (a) modality-config-panel.tsx(+test) + generation-config-sheet
  video tests couple to useMediaCostEstimate (a T9 hook) → deferred to T9 (legit — can't migrate until T9 rewrites the hook).
  (b) PRE-EXISTING/not-ours: test:web platform-enum ZodError breaks untouched retry/auth/ws-client modules; apps/api
  pipeline-bindings.ts ExecutionContext error via web — both Phase-4 attribution, do NOT fix. Plan §T9 expanded. T6 audit → 2 auditors.
- 2026-07-21 T6 audit B (scope/deletion/barrel) → FAIL. Barrel intact (0 removed), CLASSIFIER_OUTPUT_TOKEN_CAP preserved,
  deletion complete, rule-compliance strong, media deferral legit. VALIDATED findings: (1) IMPORTANT marketing
  calculate-cost.ts:58-59 `?? '0'` branches untested → 83.33% < 95% coverage gate (T6-introduced; scoped check ran
  typecheck/lint only, missed coverage). (2) MINOR prompts.ts:80 stale comment refs deleted buildEligibleModels.
  Both valid. Batching with T6 audit A (money-values) before one fixer. LESSON: T6-class display tasks scoped check must
  run marketing/web TEST+coverage, not just typecheck/lint.
- 2026-07-21 T6 audit A (money-display) → FAIL, but MONEY VALUES ALL VERIFIED CORRECT by hand (markup once, no magnitude
  errors; ts-morph separator bug did NOT leak — misparsed fixtures are inert placeholders, never asserted/rendered).
  Converges with B on the SAME single defect: marketing coverage 83.33%<95%. Net T6 validated findings: (1) IMPORTANT
  marketing calculate-cost.ts coverage; (2) MINOR prompts.ts:80 stale comment. → one T6 fixer (dispatch 2).
- 2026-07-21 T7 (3rd) → DONE. All scoped gates green (191 tests, tsgo pass, eslint, jscpd 0 clones, coverage ≥95%×5 files,
  arch:check). One price source (grep-clean, settlement=admission via core). storageContext design implemented; media+classifier
  storage included; both trial tests recomputed. Residual web RED = exactly T9 (modality-config-panel/use-prompt-budget) +
  pre-existing pipeline-bindings.ts (confirmed via proactive expansion). Handoffs: T8 injects storageContext (StorageContext
  exported); Decision B tightens trial max prompt ~12k chars (verified non-breaking); model-resolver.ts unchanged (settlement
  shares core). T7 audit → 3-lens panel (parity of recomputed numbers, robustness, design-fit/one-impl).
- 2026-07-21 T7 3-lens ALL PASS. A(parity): hand-verified all recomputed numbers vs legacy (text input×1/output×N; image
  190M, video 814.48M w/ storage; trial+classifier w/ storage); one price source confirmed. B(robustness) + C(design-fit):
  PASS. Core deliverable confirmed: NO duplicated cost formula in models slice; settlement=admission one price source.
  TWO MINOR findings: (M1, robustness) estimate-run.ts:491 classifier-reserve calls reservationCeiling WITHOUT the
  safe-integer ceilingInput guard → crafted loop{maxIterations:2^53} enclosing smartModel → uncaught RangeError vs graceful
  Result (fails CLOSED either way, no money exposure, unreachable via current 3-node turns). → FIX in T7 cycle.
  (M2, one-impl) estimate.ts:190-199 + trial-eligibility.ts:181-189 twin manifest-fold — collapse into one shared
  evaluateManifest helper. Passes jscpd; auditor calls it a T11 dedupe question. → ASSIGNED TO T11.
  NOTE FOR T8: settlement-side media storage — legacy charged media byte-storage at settlement; T8 confirm charge.ts adds it.
  Pre-existing mirrored 20MB VALUE_STORE constant still in estimate-run.ts = engine-hardening follow-up, NOT T7.
- 2026-07-21 T7 → fixing (dispatch: M1 safe-integer guard on classifier-reserve enclosure). T8 waits for T7 clean.
- 2026-07-21 T6 fix DONE: calculate-cost.ts branch 83.33%→100% (2 tests), prompts.ts comment fixed; shared+marketing green.
  ACCEPTED edge: `?? '0'` understates a model missing a rate — pathological (OpenRouter text models always carry both;
  both-missing filtered as free), marketing display, low stakes — leave as-is. T6 fix → focused re-audit (1 auditor).
- 2026-07-21 T7 fix DONE. Guard `enclosureMultiplierError` mirrors ceilingInput verbatim, applied in classifierReserveNanoUsd
  before reservationCeiling → graceful validationError not RangeError. IMPLEMENTER CORRECTED MY FINDING: single loop{2^53}
  is NOT schema-valid (Zod v4 .int() rejects unsafe ints); REAL bug = NESTED same-axis enclosure product overflow
  (enclosureFor accumulates 1e8×1e8=1e16 in Number space). Fix unchanged, example corrected; test uses nested repro. Gates
  green (estimate-run 63/63, models 96/96, cov 100/97.59, typecheck/lint 0, jscpd 0). T7 fix → focused re-audit (1 auditor).
- 2026-07-21 T6 fix re-audit → PASS. calculate-cost 100% branch, comment fixed, money untouched. T6 → CLEAN. (7 failing
  marketing newsletter tests = pre-existing, unrelated, Phase-4 attribution.) T6+T2+T3+T5 clean → T9 READY.
- 2026-07-21 T9 (client hooks + deferred media-display) → implementing. Disjoint from T7-fix-reaudit and future T8. T8 still
  waits on T7 fix re-audit (a2c6a51d) to clear.
- 2026-07-21 T7 fix re-audit → PASS. Guard mirrors ceilingInput; nested-enclosure overflow confirmed reachable
  (enclosureFor Number-space product; reservationCeiling internal product is bigint so per-dimension guard suffices);
  numbers unchanged; gates green. T7 → CLEAN. Proactive-expansion confirms residual web RED = exactly T9 (modality-config-panel,
  use-prompt-budget) + pre-existing pipeline-bindings.ts. T7 clean → T8 READY.
- 2026-07-21 T8 (chat/billing wiring: inject storageContext from TurnBudget, settlement media-storage parity, admission
  confirm) → implementing. Disjoint from T9 (web) → parallel. T8 sensitive money/settlement → 2 auditors at audit.
- 2026-07-21 T8 → NEEDS_CONTEXT (no edits). Criteria 2-5 ALREADY satisfied (no change): settlement media byte-storage
  charged once in withStorageFees settlement.ts:1119; pathological fallback not duplicated; admission.ts unchanged;
  fail-closed intact; stamps produced. BLOCKER (criterion 1): tier (route-time funding decision) does NOT ride the run
  transport to the DO where estimateRun runs (createEstimateRun built once/DO from env, runtime.ts:326). inputChars
  DO-recoverable; tier missing. Recovering tier at DO = re-implement route funding = money defect. Only the tier-dependent
  storage charsPerToken (output + classifier, 2 vs 4) is affected; token cost already tier-exact via stamps. ESCALATED to
  founder: (1) conservative tier=free for hold storage [in-bounds, over-reserves, client display stays tier-exact];
  (2) stamp tier into the definition at turn-definition→DO reads per-run [strict tier-exact, touches turn-definition+estimate-run];
  (3) thread tier via run transport routes→RunStartBody→RunContext [strict, biggest scope, realtime]. T8 paused; T9 continues.
- 2026-07-21 FOUNDER RULED: option 2 — STAMP TIER INTO THE DEFINITION (strict tier-exact). Design: turn-definition (has
  both promptCharacterCount+tier) stamps {inputChars, tier} into the chat definition; estimate-run reads it per-run and
  builds storageContext (replacing the per-DO factory param). Expands T8 bounds to include models/domain/estimate-run.ts
  (+test) [re-open clean T7 file for the sourcing change] and, IF a typed field is cleaner than the untyped params bag,
  a minimal optional field in packages/shared/src/workflow.ts (authorized). Prefer params-bag (consistent w/ maxOutputTokens,
  no schema change) unless typed field is clearly cleaner. Re-dispatch T8.
- 2026-07-21 T9 → DONE_WITH_CONCERNS. All scoped gates green (billing+media hooks 381 pass w/ 1 pre-existing platform-enum
  suite; shared 2298; coverage ≥95%; typecheck clean except pre-existing pipeline-bindings; lint 0; jscpd 0 clones =
  no mirrored pricing; premium-check parity vs legacy numerically verified). Client==server by construction (both call core).
  ACCEPTED: audio wire has no provider rate (audio DEFERRED) → client audio cost storage-only (non-issue, audio not shipped).
  Hook return shapes preserved; inputs→BASE nano; worstCaseSearchCost→webSearch(bool). T9 audit → 2 auditors.
- 2026-07-21 T9 → CLEAN. Both auditors PASS. A(money/parity): text/media/web-search/premium hand-verified vs legacy to
  sub-nano; parity by construction (both call core); premium-check parity confirmed; no client re-implementation (jscpd 0).
  B(scope/conventions): hook return shapes preserved field-for-field; deleted-float imports gone; coverage ≥95%; 4 dropped
  intermediate fields have no consumers. I agree. CLEAN: T1,T2,T3,T5,T6,T7,T9. Remaining: T8 (implementing), then T11.
  (storage-rate drift guards confirmed still present → T11 owns their removal.)
- 2026-07-21 T8 (stamp-tier, 2nd) → DONE_WITH_CONCERNS. Tier-exact hold pinned (paid=2/free=4 charsPerToken, exact nano);
  criteria 2-5 verified untouched; all owned gates green (jscpd 0.79%, arch:check OK, grep no dup). GOOD design call:
  used OPTIONAL typed WorkflowDefinition.storage field NOT the params bag (params is forwarded to provider per
  model-call-execution.ts:163 → tier/chars would leak; typed field is admission-only, rides RunStartBody.definition
  re-validation, no transport change — runtime.ts needed NO edit, T7 blocker dissolved). CONCERN: media-turn admission
  holds carry no text-prompt char-storage (buildMediaTurnDefinition gets no TurnBudget; needs chat/routes.ts, out of bounds).
  RULING: MATCHES LEGACY (computeImageExactCents charged NO text char-storage for media — media = provider+byte-storage only),
  so NOT a gap for parity; media byte-storage IS in the hold (T7 structural). Close-phase completeness critic verifies
  settlement doesn't charge text char-storage for media prompts (would mismatch). T8 audit → 2 auditors (money + design).
- 2026-07-21 T8 audit A (money/settlement) → PASS on T8 criteria (tier-exact text storage correct paid=2/free=4 hand-verified;
  criteria 2-5 intact; typed-field validated). BUT surfaced+quantified a REAL money gap (orchestrator was WRONG earlier):
  MEDIA-TURN ADMISSION UNDER-RESERVES. buildMediaTurnDefinition (turn-definition.ts:527 ← routes.ts:580) gets no TurnBudget
  → no storage stamp → media admission reserves NEITHER media byte-storage NOR prompt char-storage, while settlement
  withStorageFees (settlement.ts:1110/1114/1119) charges BOTH (promptChars×300n + mediaBytes×18n). Image w/ 500-char prompt
  = ~$0.144 under-reserved. LEGACY computeImageExactCents RESERVED media byte-storage → this is a legacy-parity REGRESSION
  (contra my earlier ruling). PRE-EXISTING (new-system media admission never reserved byte-storage; matches "image unbillable"
  regression-audit finding), NOT a T8 acceptance-criterion failure. Investigating legacy media storage (admission+settlement)
  to determine exact target, then founder decision on fix-now-vs-follow-up. Awaiting T8 audit B.
- 2026-07-21 T8 audit B (design/boundary) → PASS on criteria. WorkflowDefinition.storage confirmed optional+typed+admission-only+
  never-provider-forwarded; per-run sourcing fully replaces T7 factory param; transport unchanged. 2 MINORS: (m-i) estimate-run.ts:66
  local StorageContext dup of shared StorageStamp → import shared type (fold to T11, rule-compliance). (m-ii) workflow.ts:171
  StorageStamp.tier Zod enum mirrors UserTier union (first Zod rep; derive-fix needs tiers.ts refactor → FOLLOW-UP, out of scope).
  Also: admission.ts/runtime.ts working-tree edits = ANOTHER agent's concurrent work (AdmissionRefusalReason plumbing), NOT T8 —
  ignore per rules. T8 PASSES ITS CRITERIA (tier-exact text storage correct). Media-storage gap = separate open item (founder decision
  pending legacy facts). StorageContext-twin → T11. tier-enum-derive → follow-up.
- 2026-07-21 LEGACY MEDIA FACTS (definitive, cited): media turn bills media BYTE-storage + provider ONLY, NO prompt
  char-storage, at BOTH admission (computeImageExactCents incl ESTIMATED_IMAGE_BYTES×rate, stream-pipeline.ts:1014) AND
  settlement (calculateMediaGenerationCost at actual R2 size, media-pipeline.ts:517; chargeForMediaGeneration NOT
  chargeForUsage — no STORAGE_COST_PER_CHARACTER). NEW diverges twice (pre-existing): (1) media admission reserves NO
  byte-storage (legacy did) → under-reserve ~$0.144/image; (2) settlement withStorageFees charges prompt char-storage
  (~$0.00015) legacy never billed. Both fixes IN-BOUNDS (estimate-run: media byte-storage unconditional structural on
  answer-producing media nodes; settlement: skip prompt-char term for media turns). Escalated to founder.
- 2026-07-21 FOUNDER RULED: option 2 — RESERVE WHATEVER SETTLEMENT CHARGES. Keep settlement as-is (media byte-storage +
  prompt char-storage + provider); make ADMISSION reserve all three (eliminate mismatch; reserve≥charge over strict legacy).
  FIX (simpler than feared): estimate-run ALREADY includes media byte-storage + input char-storage WHEN A STAMP IS PRESENT →
  core fix = STAMP MEDIA TURNS (buildMediaTurnDefinition stamps {inputChars:promptChars, tier}; needs promptChars threaded
  from chat/routes.ts). Settlement UNCHANGED. Verify stamped media turn gets byte-storage + input-char-storage but NOT
  spurious text-output-char-storage (media has no text output). T8 → media-reserve fix (dispatch 3), expanded bounds +chat/routes.ts.
- 2026-07-21 FOUNDER confirmed option 2 + PRINCIPLE: "if we charge it, we attempt a best-guess reservation" (reserve≥charge,
  now a spec-wide Global Constraint). Dispatching T8 media-reserve fix: stamp media turns {inputChars:promptChars, tier};
  thread promptChars via chat/routes.ts; estimate-run verify stamped-media = byte-storage + input-char-storage, no text-output-char;
  settlement UNCHANGED; recompute media hold test numbers.
- 2026-07-21 T8 media-reserve fix DONE. estimate-run needed NO change (already prices stamped media right: byte-storage fixed
  item, 0 output ceiling ⇒ no spurious text-output char, input-char once). Fix = stamp media turns (buildMediaTurn via
  withStorageStamp; promptChars threaded from routes.ts; buildMediaTurnDefinition 4th arg → {params,budget} for max-params).
  Image/video money pinned to settlement rates, RED(delta 0n)→GREEN. Concurrent-agent files untouched. Gates green
  (turn-def 63, estimate-run/estimate 63/51, typecheck, eslint, jscpd 0.88%, arch:check). routes wiring integration-only-covered.
  → focused money re-audit (1 auditor).
- 2026-07-21 WEEKLY API LIMIT HIT (resets 5pm America/New_York). T8 media-fix re-audit (aab498ba) killed by it — NOT a code
  problem. Resumed from transcript via SendMessage; awaiting completion (will re-fail if limit still active → paused till reset).
  RUN STATE: CLEAN = T1,T2,T3,T5,T6,T7,T9. T8 = done incl. media-reserve fix, awaiting ONLY its final re-audit. REMAINING after
  T8-clean: T11 (delete legacy float budget.ts/pricing.ts + media-cents; storage-rate dedupe/de-guard; manifest-fold collapse
  estimate.ts+trial-eligibility → shared evaluateManifest; StorageContext-twin import shared StorageStamp; confirm one pricing
  impl) + Phase-4 close (full unscoped gates, related E2E, completeness critic — MUST verify media settlement/admission parity
  end-to-end, doc proposals). FOLLOW-UPS (separate runs): engine-hardening (params-bag typing, subWorkflow inert, multi-fanOut
  ~36-conn>6-cap semaphore, hoist 20MB VALUE_STORE to shared); tier-enum derive from tiers.ts const tuple. Nothing committed.
- 2026-07-21 Limit reset (resume completed). T8 media-fix re-audit → PASS (image 144,030,000n / video 360,030,000n + provider
  match settlement at legacy rates; no spurious text-output char; settlement.ts diff empty; routes change extends stamp to
  regenerate-media = bonus). T8 → CLEAN. ALL IMPL TASKS T1-T9 CLEAN. Only T11 + Phase-4 close remain.
  NOTE: working tree also contains a CONCURRENT e2e-green run (another agent) — docs/plans/runs/2026-07-20-e2e-green/, ~205
  files total incl. admission.ts/runtime.ts/conversation-room.ts. Phase-4 close MUST attribute failures carefully (fix only
  what OUR estimator run caused). T11 → implementing.
- 2026-07-21 T11 → DONE_WITH_CONCERNS. Deletions grep-proven dead; one-impl proven knip/jscpd/grep; 6 suites green; deleted
  4 extra dead float symbols (getModelCostPer1k/isExpensiveModel/ModelPricingResult/parseTokenPrice); fixed T9-debt
  use-prompt-budget.test.ts. RESIDUAL: float STORAGE_COST_PER_CHARACTER left unguarded in constants.ts (display-only;
  deriving-from-nano risks circular import) → minor, follow-up. GIT: concurrent e2e-green agent COMMITTED tree as 92785bc4;
  our work is IN that commit + a few uncommitted T11 edits (trial-eligibility/use-prompt-budget.test/budget.test). I did NOT commit.
- 2026-07-21 ONE api test FAILS: smart-model-turn.integration "fits DAILY_ALLOWANCE_NANO_USD for a free-tier default turn"
  (test:171 expects ceiling ≤ DAILY_ALLOWANCE; now ceiling >). Implementer attributed to e2e-green via a probe that only tested
  T11's fold — NOT the T3/T7/T8 storage additions. LIKELY OURS: storage-in-hold + classifier-with-storage grow the free-tier
  ceiling (free = pessimistic chars/tok); infra-gated test so T7 never recomputed it. Dispatching analyst to diagnose (correct
  growth needing test/behavior update vs over-reservation) + compare legacy free-tier smart-model. T11 deletion audit in parallel.
- 2026-07-21 DIAGNOSIS (analyst, computed): REAL OVER-RESERVATION BUG in OUR run (not e2e-green, not product change).
  ROOT CAUSE = One-Implementation-Shared violation: turn worst-case computed TWICE with drift — (1) answer-sizing
  (smart-model-turn.ts answerMaxOutputTokens / turn-definition.ts turnMaxOutputTokens) deducts STORAGE-EXCLUDED classifier
  reserve (~12,248n) + marks up PER-RATE (rounds away at int nano); (2) admission estimator (estimate-run.ts) adds
  STORAGE-INCLUSIVE reserve (~3,821,648n) + subtotal markup → free ceiling 53,827,517 > allowance 50,000,000. IMPACT: free
  users can't run default Smart. Legacy fit by construction (classifier reserve no storage + pruned eligible set). FIX: unify
  answer-sizing with the estimator (storage-inclusive reserve + subtotal markup; ideally route through estimator = one impl);
  KEEP test assertion; check paid multi-cand path. → smart-model-ceiling fix dispatched (chat/domain).
- 2026-07-21 T11 audit → PASS, no findings. Deletions grep-dead; ONE IMPL confirmed (knip 0, jscpd 1.06%, client+server both
  import priceRequest/affordability/reservationCeiling/evaluateManifest from @hushbox/shared); storage single-sourced (guards+
  mirrored literals gone; residual float STORAGE_COST_PER_CHARACTER = marketing/UI display only, no money path reads it);
  T11 changed ZERO numbers (188 api + 2085 shared green). Benign: estimateCallNanoUsd barrel+test-only (knip OK, published surface).
  T11 → CLEAN. STATE: T1-T9 + T11 all clean. Remaining: smart-model-ceiling fix (in flight) + audit → Phase-4 close.
- 2026-07-21 smart-model fix DONE. Routed answer-sizing THROUGH createEstimateRun (One-Implementation — estimator is sole
  numeric authority; kept answerMaxOutputTokens as a search upper bound only). Reconciled free ceiling 49,999,640n ≤ 50,000,000n
  (thin 360n margin BY DESIGN — answer sized to fill allowance; integration assertion guards regression). RED→GREEN; estimator
  numbers untouched; paid multi-cand + group paths share the fix; trial/budget-less untouched. WATCH: jscpd tripped 2.03%>2% on
  the 2 changed files (5-line structural buildWorkflow().map().mapErr() clone smart-model-turn.ts↔turn-definition.ts) — implementer
  says pre-existing; whole-repo jscpd was 1.06% (real CI gate green, denominator inflation on 2-file scope). Auditor to settle
  pre-existing-vs-introduced + whether to collapse. → thorough money re-audit (1 auditor).
- 2026-07-21 smart-model fix audit → PASS. Ceiling 49,999,640n ≤ 50M via createEstimateRun (one impl, not a fudge); paid path
  fixed; payerSpendableNanoUsd single-sources probe+gate; cost duplication REMOVED; jscpd 2.03% = pre-existing structural
  Result-chain clone on 2-file denominator, whole-repo gate GREEN 1.06%; estimator numbers untouched. CLEAN.
- 2026-07-21 ===== PHASE 3 COMPLETE. ALL TASKS CLEAN: T1,T2,T3,T5,T6,T7,T8,T9,T11,smart-model-fix (T10 dropped). =====
  PHASE 4 CLOSE begins. Dispatched: (1) full-gate+attribution pass (typecheck/lint/lint:unused/lint:duplication + test:shared/api/web;
  attribute ours vs concurrent e2e-green vs pre-existing pipeline-bindings); (2) completeness critic (verify media + smart-model
  parity end-to-end + one-impl; flag doc gaps). E2E is human-gated + entangled with the concurrent e2e-green run → report to founder,
  don't auto-run. Do NOT commit (tree is the human's; concurrent agent already committed once).
- 2026-07-21 Completeness critic report: core clean (one-sourced; client+server route through core). GAPS:
  (1) IMPORTANT — REGULAR chat turn answer-sizing (turn-definition.ts summedTurnPricing/turnMaxOutputTokens) STILL re-derives
     cost (per-rate markup + inverse-solve) — a SURVIVING 2nd cost computation (smart-model was fixed, regular path was not).
     NOT money-unsafe (per-rate markup ≥ subtotal → conservative-small cap; admission re-prices authoritatively → never under-reserve).
     But violates the headline one-impl goal. FOUNDER DECISION: fix now (route through estimator like smart-model's fitAnswerCapToCeiling)
     vs fast-follow. Orchestrator LEANS fix-now (finish the goal).
  (2) MINOR follow-up: marketing calculate-cost.ts re-implements message-cost formula (display-only, flat 4-char tokens).
  (3) MINOR rule-compliance: money.ts assertMarkupMatchesSharedRate drift-guard + MARKUP_BASIS_POINTS vs TOTAL_FEE_RATE mirror
     (T1 pre-rule); float STORAGE_COST_PER_CHARACTER vs nano 300n un-derived (circular-import). → derive+drop guard (follow-up).
  (4) VERIFY micro: text response-storage reserve(ceiling×tierchars) vs charge(actual chars) — pinned by unit/parity only.
  (5) E2E + live media admission↔settlement parity = infra/human-gated → surface to founder, not marked done.
  DOC PROPOSALS (need founder approval): BILLING.md:100-101/116-117 stale (pricing.ts→money.ts+estimate/; storage rates→storage-rate.ts);
     BILLING.md:70-79 admission-now-includes-storage; new reserve≥charge line; ARCHITECTURE.md:123-125 name the one shared estimator.
     ("One Implementation, Shared" rule already in CODE-RULES:60 — not a gap.)
- 2026-07-21 Full-gate + attribution pass DONE. typecheck/lint/knip/jscpd GREEN modulo pre-existing pipeline-bindings.ts;
  test:shared + test:marketing fully green; NO estimator-run test failures. ONLY 2 [ESTIMATOR-RUN] failures = branch-coverage
  shortfalls on T6 web files: model-info-panel.tsx (94.64%) + model-selector-helpers.ts (93.9%) — T6 deferred web-coverage;
  first full run now. Uncovered = minNano/priceSortKey/compareBigint ?? '0' fallbacks + values.length>0 ternary + a<b/a>b.
  Attributed away: [E2E-GREEN] use-resolve-default-model coverage + vitest.config heap-flag regression (causes ALL coverage
  OOM/ENOENT — api coverage unmeasurable, but T7/T8 audits already verified api ≥95%); [PRE-EXISTING] pipeline-bindings;
  [INFRA-GATED] Docker-down integration failures + Redis contention. → coverage fixer dispatched (2 web files, test-only).
- 2026-07-21 Coverage fix DONE (test-only): model-info-panel.tsx 92.85->100%, model-selector-helpers.ts 92.68->98.78% (>=95%,
  real assertions, eslint clean). Accepted on scoped-coverage gate evidence (Gap-1 auditor to glance).
- 2026-07-21 FOUNDER DECISIONS: (1) Gap 1 = FIX NOW (route regular single/multi-model answer-sizing through estimator, like
  smart-model fitAnswerCapToCeiling; minor rule-compliance follow-ups NOT in scope). (2) Doc updates = APPROVE ALL (BILLING.md
  + ARCHITECTURE.md). Gap-1 fix + doc-update dispatched in parallel (disjoint: turn-definition.ts vs .md).
- 2026-07-21 Doc-update DONE + ACCEPTED (each of 5 updates verified against a specific code line; docs-only, diff confined to
  BILLING.md +29/-7 + ARCHITECTURE.md +5; no collision w/ concurrent run). Awaiting Gap-1 fix (regular-turn unification) + its audit.
