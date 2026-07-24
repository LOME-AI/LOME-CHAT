# Ledger — 2026-07-23 affordability-remediation

- 2026-07-23: Run opened, Tier 2. Phase 1. Wrote research/current-system.md (distilled
  from this session's 3-agent investigation). Target design:
  docs/plans/affordability-principles.md. Dispatched: analyst A (fee baking), analyst B
  (auto smart node), analyst C (input divergence), explorer D (OpenRouter max-output in
  code/fixtures), web-researcher E (OpenRouter max-output docs).
- 2026-07-23: Scope grew (human): fold in group billing + multi-model math; final doc
  = one combined doc merged into docs/BILLING.md (H4 resolved). Human re-affirmed: no
  implementation until explicit approval. Dispatched: explorer F (group billing),
  explorer G (multi-model math), explorer H (does reconcile auditor exist).
- 2026-07-23: All 26 questions ruled + follow-ups (union effort, downgrade-only w/
  mandatory-up exception, one classifier call/turn w/ user-visible options incl. Min,
  no static auto anywhere, classifier on web-search+trial+multi-model, build-fallback
  = typed error, Smart-Model-as-sibling in scope + e2e, lifetime budgets, one run).
- 2026-07-23: DOC CHANGES APPLIED (human approved "execute all changes"): BILLING.md
  fully restructured (lossless principles: affordability, effort+classifier, smart
  model, multi-model, group funding; fixed wrong month-keyed budgets, owner-can-use-
  model clause, trial "reserved at admission"+wrong constant name, stale
  resolve-billing.ts path). ARCHITECTURE.md: reconcile deleted, spendable/budget-scope
  wording, lifetime budgets pointer, multi-model fanOut/reducer claim fixed, billable
  catalog + maxOutputTokens mentions. CODE-RULES.md: fee-seam + budget bullets.
  scheduled.ts docstring reconcile mention deleted. affordability-principles.md →
  docs/history/. NOTE: docs now describe target state ahead of code (user-chosen
  ordering); implementation run closes the gap.
- 2026-07-23: Verified at apply: funding decision lives in packages/shared/src/
  billing/funding-decision.ts (resolve-billing.ts does not exist); trial global cap
  is TRIAL_DAILY_SPEND_CAP_NANO_USD $50/day read-and-compare, no reservation
  (trial-spend.ts:13-28).
- 2026-07-23: Prompt-construction trace resolved (history/instructions client-sent
  every turn, full history always loaded; divergence = two system-prompt builders +
  two char-count reduces — becomes Task 10). plan.md drafted: 21 tasks, Tier 2.
  Presented for human iteration. NOT approved yet; nothing dispatched.
- 2026-07-23: Human ruled: zero users — no backfill/data-migration anywhere (plan
  amended: T02 backfill + T19 cleanup script removed; global constraint added).
  T18 kept after buy/fix discussion. Plan approved for implementation and amended
  with a full handoff prelude (orchestration rules, verified facts, cross-task
  interfaces) — a fresh orchestrator can execute from plan.md alone.
- 2026-07-23: Execution start re-approved by human (new session; orchestrator read
  full run dir + BILLING.md, presented plan). Dispatch: T01, T07, T10 → implementing
  (initial ready set; disjoint files).
- 2026-07-23: T01 implementer DONE (impl-report-1.md; models slice green 754 tests,
  coverage ≥95 both files; attributes test:api red to T07/T10 in-flight + pre-existing
  flakes). → auditing (1 auditor).
- 2026-07-23: T07 implementer DONE (impl-report-1.md; ACTIVE_HOLDS_LUA shared fragment,
  resolveEffectiveSpendable extracted from admitRun, parity + Redis-down 503 pinned,
  577 billing tests green). Flagged: out-of-list app.ts wiring (concurrentRunCap from
  chat constant — avoids barrel cycle); serves purchased wallet only (free allowance
  rides T08 budgets). → auditing (2 independent auditors).
- 2026-07-23: T01 audit PASS, zero findings (verdict verified: implementer's
  failure attribution holds; coverage independently reproduced; TDD ledger credible).
  T01 CLEAN. → T02 dispatched (T02 files disjoint from in-flight T10).
- 2026-07-23: T07 auditor B: PASS. Verified Lua refactor behavior-identical (git
  diff), no TS hold-parse, served===gate boundary pin, fail-closed, app.ts wiring
  legitimate (composition-root rule). ONE Minor finding (design question, not task
  failure): free-wallet-funded users' concurrentRunsRemaining reads the purchased
  wallet's hash — free-wallet run-cap state invisible on any endpoint; spec silence
  to surface to human (candidate T08/T09 fold-in). Awaiting auditor A before clean.
- 2026-07-23: T07 auditor A: PASS. Independently converged on the same Minor
  (free-wallet run-cap count invisible in preview; served count reads purchased
  hash) and judged it spec-conformant, preview-only, server stays authoritative.
  Both auditors PASS ⇒ T07 CLEAN. Finding recorded as OPEN QUESTION for human
  (rules T09 scope; T08 criteria unaffected). → T08 dispatched.
- 2026-07-23: T10 implementer DONE (impl-report-1.md; buildTurnSystemPrompt survives,
  preview-only builder deleted, shared promptCharacterCount, parity test =
  UTF-16 code-unit equality [named ambiguity: strict UTF-8 byte parity impossible,
  preamble has multi-byte chars]). Flagged follow-ups: third history reduce in
  trial-eligibility.ts:191; PromptBudgetInput.capabilities dead input. ATTRIBUTION
  DISPUTE on 2 chat smart-model integration failures (T01 impl says T10; T10 impl
  says T01; T01 audit proved not-T01) → T10 auditor briefed to settle it.
  → T10 auditing (1 auditor).
- 2026-07-23: T10 audit PASS ⇒ T10 CLEAN. Code-unit parity judged criterion-satisfying
  (all downstream math consumes chars, not bytes; byte parity unattainable + wrong
  unit). Send path verified unchanged (adapter diff empty). One Minor finding routed
  as follow-up (4th hand reduce, trial-chat-page.tsx:320-323 — out of T10 bounds).
  DISPUTE RESOLVED: the 2 chat smart-model failures are PRE-EXISTING at baseline
  (effort-feature stamping c6209b02+ made fixture contextLength:1000 unsatisfiable vs
  MINIMUM_OUTPUT_TOKENS=1000 + ≥1 stamped prompt token; balance-independent; every
  file on failing path has zero working-tree diff). Not T01/T07/T10.
- 2026-07-23: Plan amended: Task 22 (micro) added — repair stale fixture (test-only,
  conservative: does NOT change eligibility semantics; the alternative product-level
  ruling on remaining-context basis stays open for human) + the 3 mechanical T10
  follow-ups (2 remaining hand reduces, dead capabilities input). → T22 dispatched.
- 2026-07-23: T02 implementer DONE_WITH_CONCERNS (impl-report-1.md). Raised: forced
  refresh.ts edits (version rides DescriptorContent → skip-unchanged fix; else hourly
  rewrite storm); fail-fast in listDescriptors not readLatestDescriptorRows (refresh
  must read v1 to re-bake; admin read serves identity never pricing); estimator
  double-markup until T03 (over-reserve only, plan-sequenced); 4 version bumps in
  chat/routes.integration.test.ts = same file T22 edits concurrently (different
  lines; auditors to verify integrity). → auditing (2 independent auditors).
- 2026-07-23: T22 implementer DONE (impl-report-1.md; chat routes.integration
  185/185 — A1 undercounted: 7 cases not 2, same root cause, one fixture fix; both
  reduce swaps textually identical to shared body, zero re-pins; dead input removed).
  Raised: test-oracle reduces deliberately kept (would be tautological); test-file
  bounds deviation (typecheck-forced); template-html flake blocks test:api exit-0
  run-wide (pre-existing at HEAD, stays A1-attributed — not ours per AGENT-RULES
  other-agents clause; surface at close). → auditing (1 auditor).
- 2026-07-23: T08 implementer DONE_WITH_CONCERNS (impl-report-1.md; behavioral pin:
  served remaining +1n refuses budget-exceeded, exact amount admits, via production
  resolveBudgetScopes + real admitRun). Raised: out-of-list billing edits
  (spendable.ts reader + budget-resolution.ts scope-id builders — avoids mirrored
  scope-id strings = banned drift); conversations/routes.ts wiring; owner-balance
  dimension stays raw (reading ambiguity — plan scopes T08 to member/conversation
  hashes; owner number is T07's endpoint); coverage-merge ENOENT flake under
  sibling contention. → auditing (2 independent auditors).
- 2026-07-23: T02 auditor B: PASS. Verified: bakeFees exactly-once all shapes/merge/
  fallback; all pricing reads route via listDescriptors (admin reads carry no pricing
  field); refresh.ts deviation forced+correct (else hourly rewrite storm); ceil
  helper genuinely ceil, half-even untouched; concurrent-edit file coherent; T22 fix
  confirmed landed (A1 smart-model failures gone). ONE Minor (interim, plan-
  sequenced): until T04, IMAGE CHARGES (not just estimates) double-marked ~+32%
  (charge.ts:76 applyMarkup over billable catalog estimate) — over-charge direction
  only; T04 load-bearing before ship. Corrected implementer claims: "estimates only"
  wrong for image; full-run coverage claim not evidenceable (auditor verified
  scoped, all ≥95). Awaiting auditor A before clean.
- 2026-07-23: T02 auditor A: FAIL. VALIDATED Critical (A found, B missed — B never
  typechecked scripts/): scripts/lib/e2e-seeded-image-model.ts lacks version (tsgo
  TS2741 at 41,5; repo typecheck red), carries pre-fee '40000000' vs billable
  '46000000', upsertCatalog parse throws at runtime → db:seed + image E2E broken.
  Implementer's "seeds don't embed descriptors" claim contradicted by evidence.
  Minor (both auditors converged): interim image-charge double-markup, plan-
  sequenced; T04 is a HARD RELEASE BLOCKER. All other T02 properties verified by
  both. → fix dispatched (fix cycle 1); re-audit to follow.
- 2026-07-23: HUMAN RULING: no E2E execution this run (close-phase E2E run step
  removed; all E2E code changes stay in scope, delivered lint/typecheck-clean but
  unexecuted; running is founder-owned post-run). Plan amended (A4); T21 criteria
  amended: authored spec + static gates replace green-run evidence.
- 2026-07-23: Usage-limit kill wiped all 4 in-flight agents (T08 auditors A+B, T22
  auditor, T02 fixer). All 4 resumed from their own transcripts (not respawned);
  T02 fixer was already green 8/8 pre-kill, self-gate remaining.
- 2026-07-23: T22 audit PASS, zero findings ⇒ T22 CLEAN. Verified: prompts.ts:157 is
  classifier-template overhead, NOT a 4th history copy (production-zero reading
  correct); T02/T22 concurrent edits to routes.integration.test.ts coherent, nothing
  clobbered; byte-identity of reduce swaps verified textually; test-oracle
  exclusions legitimate.
- 2026-07-23: T08 auditor B: PASS, zero findings. Verified: behavioral pin via
  production resolveBudgetScopes + real admitRun (exact admits, +1n refuses);
  Lua-only parse; one script exec per request (counting-seam pin both layers);
  fail-closed 503; scope-id format single-sourced in budget-resolution.ts;
  admission diff vs T07 report byte-identical. Design observation (not a defect):
  owner-balance dimension of effectiveRemaining stays raw purchased balance —
  correct plan reading (matches turn-context who-pays input; negative clamped);
  divergence bounded by hold TTL. Joins the T07 free-wallet item as the same
  human scope question. Awaiting auditor A before clean.
- 2026-07-23: T08 auditor A: PASS with 1 VALIDATED Minor (test pin, not suspected
  bug): positional holds↔memberRows pairing never pinned with distinguishable
  per-scope amounts — index-off (member A shown B's held sum) would pass current
  suite. Fix = one test: two members, two runs, different estimates/scopes, assert
  distinct served remainings. A also converged on owner-balance-raw = correct plan
  reading (residual: owner WALLET hold invisible in served number when owner
  dimension binds — privacy+scope decision for human; joins open-questions list).
  → T08 fix cycle 1 dispatched.
- 2026-07-23: T08 fix DONE (impl-report-2.md; discriminating pairing test, observed
  red under deliberate transposition, production net-unchanged). → re-audit
  dispatched.
- 2026-07-23: HUMAN RULINGS (A5): Q1 = DELETE concurrentRunsRemaining from
  /billing/spendable (zero consumers; run cap enforcement unchanged at admission);
  BILLING.md line edited with approval; Handoff interface now 2-field. Q2 = owner
  dimension stays RAW (privacy + spec-conformant). Also clarified: no message-count
  limit exists for free users (the 5 was the per-wallet CONCURRENT run cap).
  → T07 fix cycle (field deletion) dispatched.
- 2026-07-23: T08 fix re-audit PASS, zero findings ⇒ T08 CLEAN (discrimination
  verified structurally: 3 pairwise-distinct held sums, memberId-keyed exact
  assertions; production pairing net-unchanged). T09 dispatch deliberately held
  until T07's field-deletion fix re-audits clean (stable 2-field interface per A5).
- 2026-07-23: T02 fix DONE_WITH_CONCERNS (impl-report-2.md; all 3 finding defects
  red-first→green; scripts+api typecheck green — prior budgets.* errors gone).
  Raised: 3 apps/api barrel lines exporting DESCRIPTOR_VERSION (brief authorized a
  shared barrel line; implementer used api barrels — re-auditor to judge); NEW
  pre-existing scripts-suite collection failure (vitest 4.1.8 dep-URL mangle) →
  A1 addendum. → T02 fix re-audit dispatched.
- 2026-07-23: T02 fix re-audit PASS, zero findings ⇒ T02 CLEAN. Barrel placement
  judged correct (scripts→@hushbox/api/dev-seed is the existing convention;
  narrowest chain, no speculative shared hoist). Parse test mirrors production
  upsertCatalog shape byte-for-byte. Residual typecheck errors attribute to the
  in-flight T07 field-deletion lane (expected, transient). → T03 dispatched.
- 2026-07-23: T07 fix re-audit PASS, zero findings ⇒ T07 CLEAN (2-field shape;
  exact-keys pins at wire+domain; admission behavior identity via 29 pins +
  fragment-embedding tests — git byte-diff impossible while uncommitted, accepted).
  T09 DELIBERATELY HELD despite T07+T08 clean: T03's A3 repo-wide marksUp→kind
  mechanical renames may touch web billing hooks (T09's files) — no file-sharing
  with in-flight tasks. T09 dispatches when T03's implementer lands.
- 2026-07-23: T03 implementer DONE_WITH_CONCERNS (impl-report-1.md; marksUp→kind
  everywhere, fee logic out of estimate/, smart-model-affordability branch cov
  86→100, repo-wide typecheck 15/15 green, shared 2264/2264). Raised → A6:
  T05 allowlist (search-reservation applyMarkupCeil), transitional under-reserve
  window until T04, transitional WEB_SEARCH export, vite optimizeDeps stale-cache
  gotcha. Out-of-list: shared index.ts export line + sanctioned mechanical renames
  + 10 test-file re-pins (turn-definition fit-tests re-pinned to ceiling≤funds
  invariant — auditors to scrutinize). T09 HELD until T03 CLEAN (shared web-hook
  files). → T03 auditing (2 independent auditors).
- 2026-07-23: T03 auditor B: PASS, zero findings. Verified: markup applied ZERO
  times in estimator (deleted not relocated); search-reservation constant
  definition-time only, 57.5M exact; sweep table matched independent grep
  row-for-row; re-pins hand-computed not copied; fit-test re-pin judged no
  coverage loss (over-funds shrink still exercised by adjacent test); T04 list
  fully intact incl. correction that trial-eligibility never had applyMarkup
  (fee via all-in fold); A6 under-reserve direction confirmed. Awaiting auditor A.
- 2026-07-23: T03 auditor A: PASS, zero findings (independent grep matched sweep;
  108M pin = 124.2M/1.15 exact; residual test applyMarkups pin T04's transitional
  production paths — correct not misses; fit-test re-pin judged strengthens intent).
  Both PASS ⇒ T03 CLEAN. → dispatched T06 + T09 (disjoint; T09 explicitly barred
  from packages/shared/src/budget.ts — T06 owns it). T11 HELD behind T06
  (both touch reasoning-plan.ts).
- 2026-07-23: T06 implementer DONE_WITH_CONCERNS (impl-report-1.md; all consumers
  red-first pinned + 2 property sweeps + shrink examples; shared 2290/2290; api
  green except A1 flake). Raised → A7: wire-schema deviation (models.ts optional
  field, audit-pending), toPoolCandidate spread → T04, smart-model-turn cap →
  T13/T14, client menu cap → T11/T12, pool-candidate copy → T12/T16; B+H joint
  bounding reading recorded. → T06 auditing (2 independent auditors).
- 2026-07-23: T06 auditor A: PASS. Strict tightening verified byte-for-byte vs HEAD
  (absent-key path identical); joint B+H reading judged CORRECT vs BILLING §Aff 5 +
  upstream shared-pool semantics; over-reserve invariant holds all branches; wire-
  schema deviation judged model deviation handling. 2 Minors, both = A7 routing
  confirmations (smart-model-turn pricing drop → T13/T14; deferred propagation
  legitimate sequencing, safe direction interim). Awaiting auditor B.
- 2026-07-23: T09 implementer DONE_WITH_CONCERNS (impl-report-1.md; useSpendable,
  deletions grep-clean, no-double-cushion pinned shared+hook, repo typecheck 15/15).
  Raised: free-tier affordability = served allowance.remainingNanoUsd from /balance
  (served-not-derived but NOT hold-aware; BILLING §Aff 2 tension) — auditors to
  judge point-6, escalate if criterion miss; tiers.ts deviation (One Impl Shared);
  redundant balance invalidation kept per brief-literal. → T09 auditing
  (2 independent auditors).
- 2026-07-23: T06 auditor B: PASS (all consumers verified from research §3 — brief's
  "§8" was a bad pointer, B corrected it; toPoolCandidate scope judgment: NOT a T06
  gap, T04-sequenced; EffortModel structural-passthrough hazard noted → already
  A7-routed to T11/T12). Both PASS ⇒ T06 CLEAN. → T11 dispatched. T04 HELD until
  T09 clean (shared file: use-budget-calculation.ts fee lines).
- 2026-07-23: 2nd session-limit kill (T11 impl mid-web-hook; T09 auditors A mid-
  reconcile / B mid-web-runs). All 3 resumed from transcripts; A told to re-run
  unobserved background checks rather than assume.
- 2026-07-24: T09 auditor A: PASS. Point-6 judged CORRECT (allowance-via-/balance is
  the only served non-re-derived option; §Aff 2's "not an affordability input" reads
  against the purchased ledger balance; recommends close-phase doc tightening +
  human ruling on whether a hold-aware allowance figure is ever wanted). 1 Minor
  VALIDATED: stale nano-usd.ts:90-97 doc comment (names deleted symbols) — queue for
  fix with B's findings. Design question for close: tier→funds mapping duplicated
  in use-budget-calculation.effectiveBalanceFor vs client-billing.resolveSelfFunding
  (both pinned; collapse = architecture call). Full-suite web coverage gate
  unobservable (ENOENT class, A1) — arbitrated: accepted on isolation evidence.
  Awaiting auditor B.
- 2026-07-24: T09 auditor B: FAIL. 1 VALIDATED Important: ws-ready catch-up test
  (use-realtime-sync.test.ts:147) asserts only chat+member keys — no test pins the
  3 money keys on catch-up; impl report CLAIMED a test by name that does not exist
  (contradicted claim — A's freshness cites were the run-frame tests, B's read is
  precise). Point-6: B converged with A — reading CORRECT, close-phase human items:
  §Aff 2 wording + hold-aware allowance question. Redundant balance invalidation:
  both judged harmless-keep. → T09 fix cycle 1 dispatched (B's Important + A's
  nano-usd.ts:90-97 stale-comment Minor).
- 2026-07-24: T11 implementer DONE (impl-report-1.md; union+Min authority,
  downgrade rule + 'default' variant [wire-silence for non-reasoning/mandatory-
  single], cap term carried, bounded-exhaustive property tests, shared 2322/2322,
  repo typecheck green). Interfaces recorded as A8 (BINDING for T12/T13/T14).
  → T11 auditing (1 auditor).
- 2026-07-24: T09 fix DONE (impl-report-2.md; catch-up money-key pin watched
  discriminate red; comment reworded; phantom test name attributed to a dropped
  edit — Inferred, recorded). → T09 fix re-audit dispatched.
- 2026-07-24: T09 fix re-audit PASS, zero findings ⇒ T09 CLEAN (exact-key matchers
  verified discriminating; comment diff comment-only; phantom-test explanation
  consistent with file state). NEW possible pre-existing: apps/web direct tsc
  error model-list-body.test.tsx:41 getPinnedLabel prop (file unmodified vs HEAD;
  turbo typecheck runs green — tool-config divergence; close phase attributes).
  → T04 dispatched (release blocker; was held on T09).
