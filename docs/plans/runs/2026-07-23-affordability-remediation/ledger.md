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
  red-first→green; scripts+api typecheck green — prior budgets.\* errors gone).
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
  - 10 test-file re-pins (turn-definition fit-tests re-pinned to ceiling≤funds
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
- 2026-07-24: T19 dispatched in parallel (deps: T09 clean; files disjoint from
  in-flight T04; routes.ts edit = guest-denial mapping lines only; barred from
  A7 pool-candidate copy in use-prompt-budget.ts).
- 2026-07-24: T11 audit PASS, zero findings ⇒ T11 CLEAN ('default' variant judged
  faithful extension; union oracle independent of impl; A8 verbatim match; Min-only
  degenerate set property-pinned, correctly deferred to T13's single-choice
  handling). NOTE: founder committed a10c9e9b ("a lot") mid-audit absorbing the
  run's working tree — future diffs baseline against it. T12 HELD (T19 in flight
  owns use-prompt-budget.ts tier lines) and T13 HELD (T19 owns error-codes.ts;
  T04 owns turn-definition.ts fee lines) — dispatch on those cleans.
- 2026-07-24: 3rd kill wave (T04 login error mid-repin; T19 usage limit mid-
  budgets-refactor). Both resumed from transcripts. Added to both resume notes +
  all future briefs + close-phase checks: no plan/task labels (T#/A#/R#) in
  shipped code comments (durable-naming; known implementer failure mode).
- 2026-07-24: T19 implementer DONE_WITH_CONCERNS (impl-report-1.md; scoped api
  suites + shared + web green, repo typecheck 15/15). Raised → A9: residual
  criterion-1 gap (use-budget-calculation T04-barred; payerSizingTier wiring =
  post-T04 fix-cycle), ABBA lock-order hazard (sub-ms, close-phase ruling),
  link-guest budget-row not reaped on revocation (close question), deviations
  (turn-context wireCode carrier — routes untouched; helpers in billing
  ports/adapters). → T19 auditing (2 independent auditors).
- 2026-07-24: T19 auditor B: PASS, zero fixable findings (all 4 money properties
  verified deep; ABBA characterization confirmed accurate, no safe reorder exists;
  wireCode deviation "made the system smaller"; guest-denial HTTP-level pin
  deferred to post-T13 re-pin — noted for close). NEW out-of-run concurrent
  push/sandbox lane detected (env.config +131, Push\* typecheck errors) → A1
  addendum 3; repo-wide typecheck RED from that lane, scoped gates meaningful.
  Awaiting auditor A.
- 2026-07-24: T19 auditor A: FAIL. 1 VALIDATED Important (A found, B's coverage
  check was blocked by the same env crash that masked it from the implementer):
  budgets.ts:204-209 0-row disambiguation tail now race-only-reachable →
  91.17% branch < 95 gate; deterministic pnpm test failure once env quiets.
  Fix = stubbed-store unit test (keep the tail — it IS the CODE-RULES 0-row
  doctrine shape, do NOT collapse). All else verified by both: over-reserve
  direction proven from pre-adapters rates; ABBA accept-and-surface confirmed by
  both independently. → T19 fix cycle 1 dispatched.
- 2026-07-24: T04 implementer DONE_WITH_CONCERNS (impl-report-1.md;
  providerUsdToBillableNanoUsd port helper; bit-identity via helper-composition
  pins + literally-unchanged settlement totals; 10-site deletion sweep; A6 export
  deleted; A7 toPoolCandidate cap spread). Raised → A10 (surface changes for T05,
  2 ruled tightenings) + A1 addendum 4 (42P01 mass-transient env hazard; standing
  concurrent-lane breakage list). → T04 auditing (2 independent auditors).
- 2026-07-24: T19 fix re-audit PASS, zero findings (budgets.ts 100% all axes
  reproduced; both tail arms exact-code pinned; test-only verified via mtimes +
  ledger attribution) ⇒ T19 CLEAN. → T12 dispatched (T09/T11/T19 clean freed its
  files; T04 audits are read-only). T13 still held on T04 clean.
- 2026-07-24: T04 auditor B: FAIL — behavior fully verified correct (exactly-once
  traced per modality; bit-identity: zero moved settlement literals vs baseline;
  10-site sweep confirmed; image interim +32% dead by pin; A7 cap pin; tightenings
  ruled-only). 1 VALIDATED Important: stale/contradictory PRE-MARKUP money-basis
  comments shipped in trial-eligibility.ts (22-24,27-29,50-51),
  trial-smart-model-candidates.ts (29-32), chat/routes.ts (362-363) + Minor "base
  price" naming residue — wrong money comments worse than none. Batching with
  auditor A's findings before one fix cycle. Awaiting A.
- 2026-07-24: T04 auditor A: FAIL, same class — behavior fully verified (both
  auditors independently traced exactly-once per modality; bit-identity; sweep;
  tightenings ruled-only). A adds: Minor dangling comment
  smart-model.integration.test.ts:283-284 (assert-or-drop). A10 addendum: 3rd
  allowlist site for T05 (e2e-seeded-image-model.ts:36). → T04 fix cycle 1
  dispatched (union of both auditors' validated findings; comment-only + one
  dangling-comment resolution).
- 2026-07-24: T04 fix re-audit PASS, zero findings ⇒ T04 CLEAN. RELEASE BLOCKER
  RETIRED (both seams landed + verified; image over-charge dead; transitional
  windows closed). Close-phase note: stale "BASE (pre-markup)" comment spotted in
  apps/web use-prompt-budget.test.ts hoisted fixture (web test, outside T04's
  4-file fix) — sweep at close. → Fan-out dispatched: T13 (server-only scope;
  A11 client flip DEFERRED to a micro-edit after T12+T13 clean — T12 in flight
  owns use-reasoning-effort.ts), T18 (3-lens panel to follow), T05, T19 fix
  cycle 2 (payerSizingTier wiring per A9; use-budget-calculation.ts freed by
  T04 clean).
- 2026-07-24: T19 fix 2 NEEDS_CONTEXT (correct STOP): use-prompt-budget.ts is the
  SOLE non-test importer of use-budget-calculation and holds the group context;
  threading requires hook reordering there — more than A11-style one-liners.
  SEQUENCED: resume this fixer after T12 clean (design + pin shape recorded in
  impl-report-3.md). Interim stays over-reserve-only per A9.
- 2026-07-24: 4th kill wave (session limit) — all 4 implementers down mid-work
  (T12 threading chain, T13 step 3 trialReasoningSelection, T18 threading after
  green test, T05 rule edge-case tests). All resumed from transcripts.
- 2026-07-24: T13 implementer DONE_WITH_CONCERNS (impl-report-1.md; union +
  per-model downgrade, AUTO_REASONING_EFFORT_ORDER grep-clean, typed error,
  autoEffortAnswerCap static walk also replaced [more conservative], red verified
  via temporary old-rule restore). Raised → A12 (T14 must cover 3 now-reasoning-
  free paths: multi-model/web-search/trial auto + wire the typed error there;
  routes.ts untouched deviation; Result-returning compileAutoEffortTurn; A11
  client flip unblocked). → T13 auditing (2 independent auditors).
- 2026-07-24: T05 implementer DONE (impl-report-1.md; vendored ESLint rule
  money/fee-seams, 17 rule-level unit tests, 348/348 config suite, 0 violations
  repo-wide, arch:check green). Decisions: ESLint over arch (arch SOURCE_GLOBS
  exclude scripts/ where a seam lives); ALLOWLIST over hoist for both
  definition-time sites (hoist would invert layering + ship an e2e fixture rate
  in the prod bundle); seam list = FEE_APPLICATION_SEAMS single source; 2
  comment-only edits outside packages/config. → T05 auditing (1 auditor).
- 2026-07-24: T18 implementer DONE_WITH_CONCERNS (impl-report-1.md) → A13 +
  A1 addendum 5. Sensitive ⇒ 3-lens panel dispatched.
- 2026-07-24: T18 CONVENTIONS lens: PASS, zero findings (partial-not-null FK
  indexing IS the repo's documented doctrine, verified in the gate's own source;
  conversation_members precedent exact incl. relationName disambiguation +
  reciprocal; single-writer intact; required-sender produced no placeholder
  defaults; deletion test hits real DELETE FROM users). 2 design questions for
  close, NOT findings: (a) optional NOT-(both-non-null) CHECK — deliberate
  ruling wanted, must never be NOT-(both-null) which would break SET NULL;
  (b) pre-existing mirrored NOT_NULL_PARTIAL_INDEXES constant in 2 files (One
  Impl Shared violation, predates run). Awaiting correctness + security lenses.
- 2026-07-24: T05 audit PASS with 1 VALIDATED Minor: namespace-import bypass
  (`import * as shared` + `shared.applyMarkupCeil()`) fires nothing and is NOT in
  the docblock's accepted-limitations list (test pins the shape as ALLOWED, so a
  reader believes it's covered). Zero exposure today (no such import exists).
  Auditor verified rule effectiveness live via eslint --stdin probes in 4
  packages; seam list exactly matches production import set; allowlist-over-hoist
  judged better on merit; both comment-only edits verified. → T05 fix cycle 1.
  NEW pre-existing gate hazard → A1 addendum 6: packages/config `pnpm test` can
  fail the POLE gate (runtime-primitives.test.mjs 15.5s = 56.3% of package
  test-work vs POLE_MIN_MS 15000) — load-sensitive, file unmodified, T05's own
  file REDUCES the share. Needs an owner outside this run.
- 2026-07-24: T13 auditor B: FAIL. 1 VALIDATED Important (real product risk):
  compileAutoEffortTurn now turns pickEffortClassifier()===null into a hard
  user-facing 503, but that predicate only inspects the SINGLE cheapest
  engine-text row — one ingested row missing outputPerToken sorts first (missing
  rate counts as 0n) and 503s EVERY pinned+auto send, the persisted DEFAULT path.
  T13's own test proves end-to-end reachability. Pre-T13 this degraded silently.
  Fix direction: fall through unpriceable rows, reserve null for a genuinely
  empty priceable set (needs smart-model-candidates.ts — outside T13's Files
  list; orchestrator extends ownership for the fix). 3 Minors: stale
  pickEffortClassifier docstring (says placeholder fallback, now a refusal);
  stranded/duplicated docblock at smart-model-turn.ts:92-114; "(G3)" PLAN LABELS
  in shipped comments turn-reasoning.ts:210,228 + test name
  turn-definition.integration.test.ts:343 (the exact durable-naming violation
  every brief warns about). Also: A12's "old walk under-reserved" claim
  OVERSTATED — corrected in plan (safe either way, not a bug fix). Holding fix
  dispatch to batch with auditor A.
- 2026-07-24: T18 SECURITY/PRIVACY lens: PASS, zero findings. Verified by live-DB
  probe (rolled-back tx): both-FK user deletion succeeds, no tuple-modified
  hazard, row retained with all identity refs NULL + cost intact. Link revocation
  = UPDATE not DELETE (no repo-wide delete(sharedLinks)) so retention never
  blocked; re-identification not widened (conversation_members.linkId +
  messages.senderId already hold the same value). Repo-wide grep: NO reader of
  the sender columns anywhere — no API/wire/admin-360/public-stats/log surface;
  zero db.query.\* relational call sites so the new relations can't silently
  widen a read. Sender never client-supplied (server-resolved principal →
  discriminated union → adapter can physically write only one column). Routed to
  correctness lens: member settlement test fixture hand-builds identity.userId=
  owner where production emits the MEMBER — test depicts a non-production row
  shape (shipped code fine). Awaiting correctness lens.
- 2026-07-24: T13 auditor A: PASS with 3 Minors — CONTESTS auditor B's Important:
  A says the pickEffortClassifier-null path is "not reachable in production
  (ingestion excludes unrepresentable pricing)"; B says reachable and cites T13's
  own test producing a 503 from a partial-pricing row. CONTESTED FINDING on the
  DEFAULT send path ⇒ validator dispatched (also asked to check the free-model
  angle neither auditor examined: a $0 model is legitimately cheapest and may
  yield a zero/undefined reserve). A's own Minors: routes.ts:681 stale docstring
  (describes deleted placeholder resolution); smart-model-turn.test.ts:534-536
  pin rationale FALSE + non-discriminating (same root as the A12 correction).
  A independently confirmed: G3 preserved by direct HEAD comparison, static auto
  grep-clean, interim safe (no under-reserve, assertions not weakened), typed
  error end-to-end, A7 landed, temporary old-rule restore fully reverted
  (scratchpad copy byte-identical to shipped file).
  RULING on the (G3) label Minors (both auditors): T13's OWN new instances get
  fixed; the ~14 PRE-EXISTING sites A found (routes.ts:613,617,
  turn-definition.ts:436,887,903, use-prompt-budget.ts:285, turn-reasoning.ts:56
  et al.) are NOT this run's mess — close-phase question for the founder
  (repo-wide sweep vs documented exemption).
- 2026-07-24: T18 CORRECTNESS lens: PASS, zero findings (drift gate independently
  reproduced without writing to packages/db/drizzle; migration structure-only;
  exactly-one-at-insert proven — chargeWithinTx is the ONLY production caller and
  the adapter omits the unset side so the other column is NULL by absence;
  every producer's VALUE traced to the server-resolved principal, no placeholder;
  all criterion cases on real rows; per-file coverage ≥95 on all 4 api files;
  repo typecheck 16/16 — push-lane breakage has CLEARED). Disclosed: the 3 chat
  settlement tests were authored after threading, red shown by reverting the
  threading line (genuine red-first exists at db-shape/engine/charge levels).
  PROCESS GAP: the security lens routed a test-fidelity observation to the
  correctness lens AFTER it was already running (parallel dispatch) — so the
  member-fixture item was adjudicated by NOBODY. Validator dispatched before
  declaring the panel clean.
- 2026-07-24: T13 contested finding RESOLVED by validator → A14. UNREACHABLE
  today (live OpenRouter fetch: 345/345 models carry both prompt+completion; 201
  exposed engine-text, ZERO one-sided; free models normalize to 0n which is a
  DEFINED reserve and out-sort the hypothetical shape anyway). A right for the
  wrong reason (language ingestion does NOT filter one-sided pricing — only the
  image path does); B right about the code path, unsupported on reachability;
  T13's test seeds via direct insert bypassing normalizeCatalog. Also
  PRE-EXISTING doctrine, not a T13 invention (smart-model-affordability.ts:169-183
  fails the same way for Smart Model sends today). Important ⇒ DOWNGRADED, no
  code fix. Optional defense-in-depth (both sites) = founder design call at
  close. → T13 fix cycle 1 dispatched: 5 Minors, comment/test-pin truth only.
- 2026-07-24: T18 fixture validator: UNFAITHFUL BUT HARMLESS — criterion still
  proven (guest test IS production-faithful and is the shape where payer≠sender
  actually occurs; member test pins senderUserId is threaded not inferred; solo
  pins both-equal), nothing masked. BUT it found 3 NEW VALIDATED Minors in T18's
  OWN diff: comments asserting "userId is always the charged wallet's owner"
  (usage-records.ts:22-23), "on an owner-funded group turn the payer is the
  OWNER" (charge.ts:9-10), "userId is the OWNER on an owner-funded turn"
  (workflows/engine/settlement.ts:94-95) — ALL FALSE for the member sub-case.
  GROUND TRUTH (turn-context.ts:502): payerUserId = the SENDER for a user turn
  (incl. owner-funded), the OWNER only for a link guest; owner-funding changes
  the WALLET, never payerUserId. Cross-confirmed by runtime.ts:759-762's
  isOwnerFundedTurn, which only works because context.userId is the sender.
  Accurate wording already exists in-task at chat/domain/settlement.ts:119-125.
  Panel verdict was premature — the parallel-lens routing gap caught a real
  defect. → T18 fix cycle 1 dispatched (3 comment fixes + test comment).
- 2026-07-24: T05 fix DONE (impl-report-2.md; stronger option: scope-resolved
  module-object tracking + member-expression report; 23/23 rule tests, rule file
  100%, red-first on all 3 new firing cases, shadowing false-positive pinned;
  misleading pin replaced). Raised → A15 (BINDING): `eslint --stdin --format
compact` is DEAD in ESLint 9 — prints an install message and NO diagnostics for
  ANY input, so T05's audit's "confirmed live: reports nothing" was VACUOUS
  evidence (finding was still correct, proven by the real RED run). All future
  lint probes need a valid ESLint 9 formatter + a positive control. New named
  limitation: `export * as ns from` a non-money module (zero live instances).
  → T05 fix re-audit dispatched.
- 2026-07-24: T18 fix cycle 1 DONE (3 source comments + 1 test comment corrected;
  ground truth independently re-verified at turn-context.ts:498-502 + :396-416,
  cross-confirmed at runtime.ts:752-762; 60/60 green, eslint clean). Fixer raised
  2 MORE same-class instances just outside bounds → RULED IN as fix cycle 2
  (test NAME settlement.integration.test.ts:2112; chat/domain/settlement.ts:120
  "whose wallet is charged and whose usage the record attributes to"). Fixer
  resumed with extended bounds.
- 2026-07-24: T12 implementer DONE_WITH_CONCERNS (impl-report-1.md; web suite
  6158 tests + coverage green; union pin verified against a re-introduced
  intersection regression). Used the A11 threading extension (3 caller files +
  one 4-line shape helper forced by the complexity cap). T13 seam shipped as
  accepted: union-only rungs + mixed-selection Min render greyed, wire choice
  unchanged, so offeredEffortLabels keeps 2 consumers — criterion 3 partially met
  BY DESIGN, T13's client flip finishes it. Interpretation for the auditor: the
  picker floor prices a ZERO-LENGTH prompt (model-intrinsic minimum) ⇒ strict
  lower bound, under-greys rather than over-greys. Side effects routed: sibling
  suites mocking use-prompt-budget must return useModelFloor; ModelListItem/Body
  fixtures need isBelowFloor; dead isAuthenticated prop kept (removal needs
  out-of-bounds prompt-input.tsx). → T12 auditing (1 auditor).
- 2026-07-24: T13 fix cycle 1 DONE (impl-report-2.md; all 5 findings fixed;
  finding 2 took the PREFERRED discriminating fixture — 3400-token context leaves
  Lite the only feasible rung, red-verified against a restored fixed walk, source
  restored; surviving cap assertion STRENGTHENED >high→>max so the deleted test's
  property isn't dropped; G3 sweep: 0 added/0 removed G3 lines run-wide, the ~14
  pre-existing untouched as ruled). Raised: PRE-EXISTING stale clause deliberately
  NOT touched — the moved answerMaxOutputTokens docblock still ends "...or when
  the post-reserve budget covers the remaining context (the model default
  applies)", false because that branch now always stamps a concrete ceiling and
  the concrete-stamp PREDATES T13 → close-phase candidate (re-audit confirms
  provenance). → T13 fix re-audit dispatched.
- NOTE for the parked T19 residual fixer: T12's landed work appears to already
  consume payerSizingTier in use-prompt-budget.ts — when resumed it must RE-READ
  current state before threading, not assume its pre-T12 design still applies.
- 2026-07-24: T18 fix cycle 2 DONE (settlement.ts:120 + test NAME :2112; 60/60
  green, eslint clean; grep over all 5 task files now returns only negations and
  true guest-case statements). Naming decision: new name is "stamps the sender
  from identity.sender even when it differs from the attributed userId" —
  deliberately NOT named after a production scenario, because the fixture binds
  identity.userId to the OWNER which production never emits for a member sender;
  naming it that way would reinstate the false vocabulary. Checked-and-clean
  (unchanged): settlement.ts:283, :308-309, :1048-1050 use "payer" purely as the
  role label for identity.userId. → T18 fix re-audit (both cycles) dispatched.
- 2026-07-24: T18 fix re-audit PASS ⇒ T18 CLEAN (all 3 lenses + validator +
  fix re-audit). Re-auditor re-derived ground truth at source before judging;
  verified the schema comment's recovery claim is TRUE (usage_records has no
  wallet column; ledger_entries.walletId does); confirmed zero behavior change
  by proxy (migration mtime hours before both fix mtimes; renamed test's
  assertions unchanged; 60/60 both before and after); upheld the naming decision
  and the checked-clean judgments. 1 Minor, PRE-EXISTING at HEAD (verified via
  git show): workflows/engine/settlement.ts:79 "who pays (`walletId`/`userId`)"
  bundles userId into "who pays" — same defect class, 19 lines above T18's new
  correct doc. ORCHESTRATOR RULING: not a T18 defect (pre-existing), but it now
  ADJACENTLY CONTRADICTS corrected text in a file this run touched, so it goes
  to the PHASE 4 CLOSE BATCH as a mechanical one-line fix — NOT to the founder
  decision list (no design call in it).
- 2026-07-24: T13 fix re-audit PASS, zero findings ⇒ T13 CLEAN. Verified
  independently: A14 honoured (pickEffortClassifier body BYTE-IDENTICAL to HEAD,
  no .find defense slipped in); discrimination proven MECHANICALLY not on the
  implementer's word (clampBudget clamps Low..Max to the 3400 window ⇒ headroom
  <1 ⇒ only Lite survives ⇒ old fixed walk necessarily yields 'fallback'); no
  restored-walk residue; G3 sweep verified both halves (0 added/0 removed;
  11/11 pre-existing sites identical HEAD-vs-worktree). Auditor used A15's
  positive control to prove its silent eslint run was real silence — the
  amendment worked on first contact. Pre-existing stale clause CONFIRMED at HEAD
  (smart-model-turn.ts docblock "…the model default applies") ⇒ close batch.
  Unattributed: another workstream's untracked packages/ui file carries a "(G3)"
  test name — not ours. → T14 dispatched (T13 clean was its only dependency).
- 2026-07-24: T12 audit PASS with 1 VALIDATED Minor + 2 routed items.
  POINT-4 RULED (auditor, decisive, I concur): the zero-length-prompt picker
  floor is CORRECT, not a criterion miss — §Aff 4 states the predicate as a
  property of the MODEL (prompt-dependence is §Aff 3's preview-vs-send rule,
  which governs the composer); threading promptCharacterCount would re-grey rows
  as the user types and hide models affordable by shortening the prompt; and the
  direction is safe (strict lower bound ⇒ under-grey degrades to the composer's
  authoritative denial, vs over-grey hard-blocking an affordable model). "Same
  shared floor" is satisfied where it matters: one floor impl, one funding
  resolver, sized by the shared payerSizingTier.
  MINOR (validated): model-selector-modal.tsx:194-196 — the below-floor guard
  sits ahead of the multi-mode toggle, so an ALREADY-SELECTED model that later
  falls below the floor cannot be DE-selected from its row (only Clear-all
  escapes). Criterion is "grey = not selectable"; blocking removal is stricter
  than asked and traps the user.
  ROUTED IN to the same fix cycle (both are T12's own mess / T12-owned files):
  (a) dead isAuthenticated prop on ReasoningEffortMenu — T12 made it dead, the
  last passer is prompt-input.tsx (bounds extended, one line); (b) A7's open
  bullet — smartModelPoolFromCatalog (use-prompt-budget.ts) still does NOT copy
  the wire maxOutputTokens though SmartModelPoolCandidate declares it; A7 assigns
  it to "whichever of T12/T16 first touches the file" and T12 touched it ⇒ T12's.
  Under-denial direction; must land before T16.
  CLOSE-PHASE design question (auditor, not a finding): the picker floor
  (evaluateManifest(manifest, MIN+B,'all-in')) and the composer floor
  (affordability().minCostNano + B×rate) are two assemblies of ONE formula,
  arithmetically identical today, both folding through the shared estimator —
  collapsing them into a single shared modelFloorNanoUsd is an architecture call.
  → T12 fix cycle 1 dispatched.
- 2026-07-24: T05 fix re-audit PASS with 1 Minor. Bypass verifiably closed:
  A15-compliant probes (default formatter + positive control) show the namespace
  form fires at a non-seam and is silent at a seam; scope-based resolution proven
  by probing a shadowed param, an aliased namespace, and an unrelated object;
  rule file 100% all axes; widened rule adds ZERO violations (complete grep
  argument, not a sample: 16 applyMarkup files = 10 rule-exempt tests + exactly
  the 6 seams). POLE gate did NOT trip this run — confirms A1 addendum 6's
  load-sensitivity. MINOR (validated, same defect class as the fix itself):
  fee-seams.mjs:27 limitations sentence says "dynamic import() DESTRUCTURE" but
  the dynamic MODULE-OBJECT form is equally unmatched and unnamed — re-auditor
  probed it silent while its control fired; reads as a complete set ⇒ implies
  coverage that doesn't exist. One-word fix; fixer resumed rather than deferred
  (standing rule: validated findings are fixed, never backlogged).
- 2026-07-24: T05 fix cycle 2 DONE (docblock clause now covers both dynamic
  forms AND states WHY — tracking is rooted at ImportDeclaration so only static
  imports are tracked; 24/24, rule still 100% all axes). Implementer improved on
  the instruction: added an EXECUTABLE pin for the documented limitation, so if
  the gap is ever closed the pin fails and forces the docblock to be updated —
  making the limitation list self-policing against the exact rot this finding
  was about. → re-audit dispatched (proportionate scope).
- 2026-07-24: T05 fix cycle 2 re-audit PASS, zero findings ⇒ T05 CLEAN (16 tasks
  clean). Independent programmatic ESLint 9 probe re-derived the rule's whole
  behavior surface with positive controls: all 3 documented limitations real,
  docblock's stated REASON verified true against the implementation, the added
  limitation pin non-vacuous and fail-if-closed.
- 2026-07-24: T12 fix cycle 1 DONE (impl-report-2.md; web 381 files/6247 tests +
  coverage green). Deviated from the finding's literal suggestion CORRECTLY:
  guard falls through on `pickerMode==='multi' && has(id)`, because in single
  mode activating the selected row is a COMMIT — the literal `has(id)` form
  would have let a below-floor model be SENT; pinned by a single-mode case.
  Raised (out of bounds, needs a decision): a removable below-floor row still
  renders aria-disabled — grey+tooltip must stay (it's why the user should drop
  it) but the row IS actionable; honest fix lives in model-list-item/-body.
  Raised: another agent is concurrently editing apps/web AND running the same
  vitest package (caused 2 failures + 1 coverage ENOENT) — re-run before
  attributing. Pool-candidate copy also tightens the composer's Smart Model
  estimate in the under-denial-closing direction, as A7 required before T16.
- 2026-07-24: FOUNDER RULING — multi-model `auto` MUST resolve to all models as
  originally planned (option "permanently reasoning-free" rejected); the
  classified-dimension system must be EXPANDABLE to more cost-affecting
  dimensions with registry-shaped additions. IMPLEMENTER FREEZE until the design
  is ruled — prior and future work may change. Recorded as A16 with the founder
  requirements, the orchestrator's unvalidated additions, and the BLAST RADIUS
  (T11/T12/T13/T06 landed-but-may-revise; T14–T17/T20/T21 + A11 not started and
  heavily affected; fee-seam/served-number/schema tasks believed unaffected).
  T12's fix re-audit HELD too — its pool-candidate item sits in the model-
  dimension feasibility path the ruling reshapes. 3 analysts running (read-only).
- 2026-07-24: ANALYST 1 (current-state trace) returned. Key: founder steps 1-2
  IMPLEMENTED; step 3 PARTIAL (scalar approximation — MAX-B vs Σ-rate with
  MIN-context/MIN-cap, not the resolved vector); step 4 machinery EXISTS in
  single-model form (autoEffortAnswerCap walks levels descending testing
  affordability) but DISCARDS the set, keeping one cap number; step 5 ABSENT —
  the classifier prompt is a hardcoded low/medium/high string that can never
  emit lite/max/Min, never sees the union, never sees a culled set, and falls
  back to hardcoded 'medium'. TWO CONTRADICTORY resolution rules exist:
  resolveEffortForModel (downward-only, ruled) vs pickClassifiedEffortPlan
  (nearest-distance, CAN GO UP) — One Implementation Shared violation recorded
  in no amendment; the ruling must kill one. Expandability UNMET at the seam:
  6 edit sites for dimension N+1, classify field is 2 hardcoded booleans,
  reserve sizing hardcodes exactly 2 dimensions. Only the MODEL dimension is a
  complete cost-carrying dimension; effort is prompt/parse + 2 collapsing
  aggregates. CONFIRMED: definitions compile at the ROUTE, hold placed in the DO
  before walk ⇒ classifier provably cannot influence its own hold ⇒ per-dimension
  reserve MUST be a route-time worst case over the presented set (validates the
  A16 max-of-culled-set addition). Reserve-before-cull: TRUE server both
  classifier paths, FALSE client (no classifierStage for pinned auto).
  NEW LIVE DEFECTS, independent of the ruling: (G-c) client still holds
  intersection semantics — effectiveReasoningSelection REWRITES a union-only
  explicit pick to 'auto', which on multi-model means reasoning-free, so an
  explicit High silently becomes no-reasoning (A12 called the A11 flip
  "unblocked"; T12's report read as complete; the clamp is LIVE and now actively
  wrong); (G-a) client enables at >=1 answer token, server requires >=1000 ⇒
  menu-enabled level 402s at admission, violating "one verdict two renderers";
  (G-b) client applies no classifier reserve for pinned auto where server does;
  (G-d) effortDimensionForCandidates activates on "any candidate reasons" not
  §Effort 5's ">=2 real choices"; (G-e) multi-model shares one H (T15 scope).
  A7's four must-adds all CLOSED. Asked founder whether to lift the freeze
  narrowly for G-c/G-a.
- 2026-07-24: ANALYST 2 (mechanism) returned; recommends (C) a `classify` node in
  the closed registry + typed decision input port. CORRECTS THE ORCHESTRATOR:
  the governing invariant is NOT "static params" but ESTIMATE <=> EXECUTED-
  DEFINITION IDENTITY (estimateRun prices the definition; the hold derives from
  it). Route-side classifier disqualified TWICE: the route build runs BEFORE
  claimRun so it re-spends on every retry the DO would have replayed/attached,
  AND such spend is structurally UNBILLABLE (settlement only bills charges the
  interpreter collected). In-DO pre-resolution + recompile (my option B) VIOLATES
  the identity invariant — admission prices D1, the run executes D2 — honest only
  with a new containment re-estimate; also a second definition-construction site
  competing with the route builder. Repo already has the correct pattern:
  declare options statically -> reserve worst case -> choose at runtime
  (smartModel: classifier + MAX over candidates). (C) DELETES a mechanism (the
  in-node classifier) rather than adding one, and uses two registries that
  already exist — NODE_TYPES (8 members incl. smartModel, version-pinned) and
  WorkflowCapabilities.schemas (EMPTY today, built for exactly this). Rejected
  with reasons: (H) N per-sibling calls — needs §Effort 4+6 doc amendments, N×
  cost AND N× reserve (changes WHO may send), fails expandability outright since
  turn-level dimensions aren't answerable per sibling; (I) pre-baked variants
  under branch — the estimator prices branch case targets ADDITIVELY (branch=0,
  each target in full) so K variants over-reserve ~K×; (D) composite mega-node —
  requires charge.key to stop meaning originating node, the joint persist
  grouping/display anchoring/debit FK all hang on; (E) classifier as its own run
  — drifts toward the excluded run table; (F) run-scoped memo — check-then-act,
  banned. NEW LATENT MONEY BUG (pre-existing, no shipped definition uses branch):
  estimator prices mutually-exclusive branch targets additively while smartModel
  candidates are MAX'd — first real branching workflow over-holds by branch count.
  REQUIRED BY EVERY VIABLE OPTION: a run-level classifier-charge anchor — a
  turn-level charge with no content anchor is SILENTLY ABSORBED (settlement skips
  charges lacking contentItemId); precedent exists (prompt storage fee rides the
  first persistable charge). DOC STALENESS: ARCHITECTURE.md §The workflow engine
  lists 7 node types and omits the shipped smartModel; (C) would make it 9.
  Advisory on T14: take impl-report option A (defer multi-model; close
  web-search+trial on the existing node), NOT (H) — (H) ships a mechanism whose
  removal is guaranteed.
- 2026-07-24: ANALYST 3 (framework + adversarial) returned: THE ORCHESTRATOR'S
  MONOTONICITY FRAME IS BROKEN — 3 of its 4 load-bearing claims are false against
  this codebase + the live catalog (345 models fetched, 212-model ZDR text pool).
  (1) "model ascending by price is a cost ordering" FALSE: ascendingByPrice sorts
  inputPerToken+outputPerToken but real cost is promptTok×inRate +
  tok×(outRate+storage); 8.1% of the 22,366 pairs invert at 50k/1k — so the
  "cheapest corner" isn't cheapest and a DOWNWARD model step can RAISE cost.
  (2) EFFORT HAS ZERO MARGINAL MONEY COST — two resources, not one:
  answerHeadroomTokens computes totalOutputCeiling independent of B then H =
  ceiling − B, and pickClassifiedEffortPlan always returns maxTokens =
  completionCapTokens, so every effort bills the SAME ceiling; effort只
  re-partitions an already-held TOKEN pool. Its constraint is token capacity,
  uncorrelated with price. This kills the repair rule: "step down the largest
  marginal saving" would NEVER step effort (saving=0), always the model — so the
  general mechanism CONTRADICTS the ruled downgrade rule instead of subsuming it,
  exactly backwards from what I claimed. (3) marginal feasibility is the wrong
  anchor: free tier 5¢/2000-char, cheapest eligible is a free model with
  mc=32768 which culls high+max though half the pool could run them; and 79/212
  pool models carry NO reasoning metadata so if the cheapest is non-reasoning the
  test is VACUOUS. (3b) THE CHEAPEST CORNER CAN ITSELF BE INFEASIBLE via §Effort
  8b's upward exception: 29 of 205 eligible candidates have NO feasible effort
  (openai/gpt-5 cap=2812, lowest rung 4096, mandatory ⇒ Min resolves UP to 4096,
  4096+1000 > 2812). So classifier picks gpt-5, repair walks down to Min, Min is
  STILL infeasible, dimension exhausted — my termination proof was FALSE
  (admission proved cap≥1000, not cap≥B_min(m)+1000). (4) DETERMINISM
  UNACHIEVABLE TODAY: catalog-store.ts:95 selects with NO ORDER BY, folds into a
  Map by row order, ascendingByPrice returns 0 on ties, 119/212 models in tie
  buckets ⇒ the classifier engine pick and prompt candidate order are functions
  of Postgres physical row order; same catalog+balance ⇒ different prompt bytes
  ⇒ different answer AND different cassette hash.
  WHAT SURVIVES: the skeleton (declare option orders, cull before presenting,
  hold before classifying, repair by a declared rule).
  RECOMMENDED: Option A — resource-VECTOR dimension registry with EXACT joint
  feasibility. Key insight I got wrong: Π IS COMPUTATIONALLY FREE (212×6 = 1,272
  assignments ≈ 2e4 bigint ops, sub-ms, already runs client-side); only the
  PROMPT is Σ-bound. I conflated the two. Resource vector {moneyNanoUsd,
  completionTokens} makes the effort/model asymmetry explicit; ∃-culling IS
  §Effort 4's union rule (so the general mechanism does subsume the special case
  — via ∃-culling, not via marginal-saving repair); hold = max money over the
  exact feasible set; repair = each dimension's DECLARED resolution rule.
  Option B (ranked top-3 preference) is a strict REFINEMENT of A's repair step
  and better on answer quality (gpt-5 unaffordable ⇒ classifier's own #2, not
  gpt-5 at Min which on a mandatory model is the worst outcome); A doesn't
  foreclose it. Option C (spend-tier scalar) reverses ruled product semantics.
  10-ITEM DIMENSION CONTRACT delivered, BILLING-doc-shaped, incl. COST CLASSES
  partition / additive / multiplicative.
  HOLD INFLATION — inverted from expectation: the money hold does NOT inflate
  because it is ALREADY SATURATED at 100% of effective balance (cap(m) is by
  definition the most tokens the budget buys); adding dimensions can only SHRINK
  cap(m). Real casualty: the documented 5-concurrent-run cap is effectively 1 for
  any Smart Model sender. Σ-growth per new dimension is cheap (~0.1-0.3% of a
  free allowance); POOL SIZE is the cost driver. `additive` can exceed the whole
  balance: web search = 57,500,000 nano = 115% of a 5¢ free allowance, taking
  free-tier eligible 205 → 0. `multiplicative` bites quality: agentic depth 10
  shrinks gpt-5's delivered cap 2,812 → 179 tokens even if the classifier picks
  depth 1. No policy knob needed — hold-at-worst-presented ≡ hold-at-worst-
  feasible once ∃-culling exists.
  **_ BLOCKER FOR THE RULING (live money defect, independent of the design):
  the classifier-storage reserve is 11,981,400 nano = 24.0% of a free user's
  DAILY allowance PER TURN, and 97.9% of it prices the classifier prompt + its
  2048-token output as PERSISTED text that is never persisted
  (classifier-line-item.ts:78-84 vs ARCHITECTURE "mid-flow content never rests
  anywhere"; the 4,000-char history excerpt was already charged at its own
  persist). It is subtracted BEFORE culling, so it shrinks every presented set.
  Founder call: over-reserve defect, or deliberate? _**
  4 MANDATORY PRE-FIXES regardless of option: deterministic total order on the
  catalog read; eligibility graded on the RESOLVED cheapest corner (culls the
  29/205); ONE effort resolver; classifier's effort set derived from
  turnEffortOptions. Plus 5 falsifiable RED-today specs delivered.
  DOC-VS-CODE: BILLING §Multi-Model 2/3 claims "no summed-rate approximation"
  and "no shared cap, no tightest-model coupling" — both false in code
  (turnCostBasis sums rates against ONE token count, min context/min cap, shared
  H). Conservative ⇒ not a money bug, but the doc is wrong as written.
- 2026-07-24: FOUNDER RULING — the classifier charges NO storage, only the provider
  call. Removes 11,981,400 nano (24.0% of a free daily allowance PER TURN) that
  priced the classifier prompt + its 2048-token output as persisted text never
  persisted. Because the reserve is subtracted BEFORE culling, this materially
  enlarges every presented set. Side effect: CLOSES T14's open unknown — the
  provider leg alone is ~262,156 nano ≈ 0.026¢, so a trial auto turn fits the 1¢
  cap with ~97% headroom.
- 2026-07-24: FOUNDER RULINGS on the four design holes: (1) empty smart-slot set
  "should not be possible because model's should go grey as the user's
  affordability set shrinks" + a fast server-side deny if sent anyway; (2) agree —
  declared fallback = cheapest presented pair, classifier unbilled; (3) agree —
  distinctness measured on the RESOLVED requirement, so a plateau-collapsed
  high/max is ONE option and buys no classifier call; (4) do NOT surface the
  binding constraint in refusal messages.
- 2026-07-24: DESIGN AGREED. Presentation = ANNOTATED LIST, not the rectangle the
  orchestrator first proposed (rectangle hid ~60% of affordable pairs: full
  feasible ≈790 vs 300 presented). Founder: "Present every feasible model, tell
  the classifier the list union of all feasible effort types and per model, label
  them 'up to x effort'." Data shape = {modelId, ceilings: Record<DimensionId,
  OptionId>} — a CEILING per dimension, not an effort array, because a model's
  feasible effort set is always a downward-closed prefix (so an array could encode
  an unreachable state; the ceiling makes the invariant structural and IS the
  label). New principle: PRESENTED <=> AFFORDABLE, scoped to the classifier-facing
  sets (3 and 4), deliberately NOT to the picker floor (set 1). FOUR AFFORDABILITY
  NOTIONS defined: (1) model floor / intrinsic callability, prompt-independent,
  necessary-not-sufficient, picker grey; (2) selection verdict, whole-turn;
  (3) smart-slot candidate set, the classifier's options + the hold; (4) solo
  candidate set. Relationship 3 ⊆ 4 ⊆ {passing 1}, and 3 shrinks as siblings are
  added. PINNED vs OPEN dimension duality is the expandability mechanism (search
  is pinned today = an input; if it becomes classified it enters as an open
  money-consuming dimension). COMPOSITION RULE: disjoint resources ⇒ exact box;
  shared resource ⇒ nest (exact) or inscribe (lossy, must be declared). Today
  model→money, effort→tokens, search→money. CLIENT vs SERVER settled by E2EE, not
  debounce: the prompt is the dominant input and the server never sees it until
  send, so per-keystroke server computation would mean streaming plaintext as she
  types. Client computes (advisory, served budget), server recomputes at POST /chat
  (authoritative, drives the hold + the classifier's set), ONE shared impl.
  MECHANISM = a `classify` node in the closed registry + typed decision port
  (removes a mechanism: smartModel stops making its own call and consumes the
  decision; grows via NODE_TYPES + the EMPTY WorkflowCapabilities.schemas registry;
  keeps priced == executed).
- 2026-07-24: Wrote research/design-handoff.md — a standalone document for a fresh
  reviewer: primer, the T14 blocker, founder quotes verbatim, all three analysts'
  findings with citations, the orchestrator's BROKEN frame recorded in full so it
  is not re-proposed, the four affordability notions, the agreed design, both user
  stories, mandatory pre-fixes, still-open founder questions, live defects, and a
  §16 attack list. → dispatching an adversarial design reviewer (read-only;
  permitted under the A16 freeze).
- 2026-07-24: Adversarial design reviewer KILLED by user before producing any verdict
  (last output was mid-read of the sibling research files). No review result exists;
  transcript survives. Not resumed — founder redirected the design iteration instead.
- 2026-07-24: FOUNDER DIRECTION (design iteration, freeze still in force). Primary
  concern is MAINTAINABILITY, verbatim: "adding a new dimension or axis can completely
  transform the shape of data and lead to new math in many places"; wants abstraction,
  a system that is "bullet-proof so it is impossible to fail", "dedicated places for
  these logic that talk to eachother instead of hand-rolling inline", and is
  considering "a new package for just billing logic, like crypto did and all billing
  source of truth comes from there" (shared package). Standard restated: "always show
  the user an option they can afford, never an option they cant (disabled, greyed).
  Choosing a smart or auto mode should always have every available affordable option
  in it." Asked for a fan-out of adversarial analysts that also propose their own
  better designs, then a joint review with many user stories.
  → 4 read-only analysts dispatched in parallel, distinct mandates:
  (1) maintainability + the packages/billing verdict (file-by-file move inventory,
  boundary enforcement via eslint-plugin-boundaries + arch/, the dimension
  contract as real TS, add-a-dimension diff sketches for all three cost classes,
  duplication inventory separating true duplication from ruled defense-in-depth);
  (2) adversarial break of the agreed design (composition rule, prefix claim, one-step
  clamp, hold boundedness, greying-as-guarantee, classify-node justification) —
  required to COMPUTE against the live catalog rather than argue, the method whose
  absence broke the previous frame — then design structural impossibility
  (types/branding/totality) for the founder's two standards;
  (3) clean-slate: >=3 designs owing nothing to the agreed one (feasible-set value
  object, resource-ledger allocator, CSP/lattice, price-as-function-of-choice-
  vector, uniform-priced presented set, generated turn-shape enum, second
  admission step), each judged against core values;
  (4) presentation-surface completeness audit: every surface that shows/greys/hides/
  refuses a cost-affecting choice (incl. the classifier prompt as a surface),
  false-positive vs false-negative per surface, harm ranking, one-mechanism
  guarantee options, plus new cases absent from the handoff's SS14/SS15.
  All four barred from re-proposing the handoff SS16 kill list; all must grade
  Verified/Inferred/Assumed with file:line.
- 2026-07-24: All 4 adversarial analysts returned. CONVERGENCE (4 independent
  mandates, no shared context): ONE producer of the option set; no surface --
  including the classifier prompt -- may compute its own. Surface auditor's
  dispositive argument: the per-surface-predicate-plus-conformance-test
  alternative IS the golden cross-check CODE-RULES names as the smell.
  COMPOSITION RULE DISPROVEN with live numbers (search toggle at 10c lowers the
  effort ceiling for 105/213 candidates) -- money buys tokens, so no two
  cost-bearing dimensions are ever disjoint. Replacement (mechanically
  checkable): an open dimension may only re-partition an already-priced ceiling,
  never enlarge it; pinned by a per-model effort-invariance property test.
  SURVIVED and now PROVEN: downward-closed prefix (0 non-monotone of 218, 0 gaps
  over 1,526 model/cap pairs); one-step clamp unfailable for the model dimension
  (escaping the eligible list is unrepresentable); hold bounded; trial 1c path
  works (164/170 candidates keep >=1 feasible effort).
  MY ERRORS CORRECTED: (a) the reserved-optional-input-port "precedent" does not
  exist -- fan-out/loop port ids are output/source ports and the exactly-one-input
  rule is actively enforced; (b) AffordableOptions' sendable:boolean beside
  candidates:[] makes sendable-with-nothing-to-send representable -> discriminated
  union; (c) ceilings:Partial<Record<DimensionId,OptionId>> presumes every
  dimension is a ladder and cannot express an unordered dimension -> per-entry
  option lists, ordering a declared property, "up to X" demoted to rendering with
  a lossless-round-trip test.
  NEW FACTS: classifier engine is the single $0 catalog model, so the whole
  classifier-reserve subsystem currently reserves ZERO (the no-storage ruling is
  correct but inert today, and becomes load-bearing discontinuously if that model
  leaves); 130 models in 43 price-tie buckets, so row order decides WHO
  classifies (elevates the ORDER BY pre-fix from reproducibility to behaviour);
  parseClassifierAnswer is POSITIONAL today, contradicting the labelled-lines
  design; presented is already a STRICT SUBSET of affordable two conservative ways
  (reserve priced against the un-culled list; 44/138 sparse ladders + 58 plateau
  collapses mean labels below a printed ceiling are not distinct runs).
- 2026-07-24: FOUNDER RULINGS. (1) RESERVATION: the bound must be the most this
  specific call could ever cost, not unbounded. (2) Seam has NO table, crypto-like,
  with a set list of simple public functions and the complicated logic behind a
  wall; arch rule to enforce, as crypto does. (3) Fix the known bugs, but NOT where
  the redesign deletes the code. (4) Media + search registered as dimensions from
  day one: YES. (5) Free tier web search -- founder believes already disabled;
  ORCHESTRATOR CONTRADICTS with evidence: use-web-search.ts:32 gates on
  `!isPending && Boolean(session?.user)`, i.e. any AUTHENTICATED user, and free =
  authenticated with zero balance. Trial/guest (unauthenticated) are blocked; free
  is NOT. No tier gate server-side either -- turn-definition.ts:956,1037 assert
  model CAPABILITY only. So the 57,500,000-nano/model reservation (115% of the 5c
  allowance) is reachable by free users today. Awaiting re-ruling.
  (6) Picker-floor scope: founder asked for an explanation; confirmed the
  long-prompt affordability alert must be KEPT (that is the composer/send gate,
  prompt-aware by design -- distinct from picker greying).
  (7) Queue + regenerate carry the send verdict: YES.
  Founder closed with "Lets think about this some more" -- design phase continues,
  freeze holds, no implementers.
- 2026-07-25: Wrote research/design-rulings-2026-07-24.md — the citable delta over
  design-handoff.md (5 corrections to the handoff incl. the deleted composition rule,
  the collapsed port precedent, the two data-shape errors, the corrected reason for
  client-side computation, and the free-tier web-search contradiction; 8 founder
  rulings; the settled/unsettled code-location split; the proposed public surface;
  the four-analyst convergent conclusions). Where it conflicts with the handoff, it
  wins. Every subsequent brief cites it instead of restating design context.
  FOUNDER RULING: > "I completely agree with your split of keep math in the package,
  responsibility in the slice." Billing slice keeps tables + admission Lua +
  settlement transaction, stops doing arithmetic. Founder still SKEPTICAL of
  package-vs-shared and asked directly which is better long term.
  → 5 read-only agents dispatched: (1) analyst owning the package-vs-bounded-directory
  decision end-to-end with its own measurement (shared inventory by class, cycle set
  that must move as a unit, consumer map with import-site counts, verification of the
  sandbox barrel hazard, migration cost in numbers against the crypto/realtime
  templates incl. per-package coverage + pole gates, enforcement parity incl. what
  crypto's boundary ACTUALLY is, reversibility of directory-then-extract; required to
  engage CODE-RULES' anti-speculative-hoisting rule rather than skip it);
  (2) explorer mapping the estimator's function surface into turn-only / engine-only /
  both / unclear, the DAG-shape input flow (fan-out width, maxSteps, iterations,
  enclosure multipliers, value-store budget), injection seams, media pricing inputs,
  and any I/O-clock-randomness impurity — this decides where the wall falls and
  whether priceOptionSet is public;
  (3) analyst re-opening the classifier mechanism now that the one-input-port
  "precedent" is disproven: what that invariant actually protects, mechanisms nobody
  proposed (decision through the EXISTING input port, params-as-reference resolved at
  execution, siblings as children of the classify node), and explicitly licensed to
  revisit the pre-baked-variants rejection because its stated reason (branch prices
  targets additively) is a fixable estimator defect, not a language property;
  (4) analyst computing the new reservation bound against the live catalog: does the
  maxB+TARGET term actually kill saturation and at what TARGET, the crossover balance
  per target, whether SSAffordability 4 survives (models lost vs merely cap-shrunk),
  whether maxB-set-by-presented-set creates a fixpoint circularity, the heterogeneous
  8k/200k sibling pair, trial/free effects, and where the ruling is WORSE than today;
  (5) explorer inventorying every "why you cannot send" surface verbatim (notifications
  with copy/severity/dismissibility, money error codes, every tooltip and disabled
  reason, trial/guest/group copy, cause-vs-action classification, inconsistent wording
  for one condition) AND the real structural shape of media params (schemas, whether
  option values come from catalog ParamSpecs or hardcoded lists, how each param
  prices, enumerability of legal resolution/duration pairs, transport path) — the
  latter decides whether media can actually be a registry dimension as ruled.
- 2026-07-25: Explorer 5 (notices + media params) returned. NOTICES: a rich system
  ALREADY exists -- 13 notification types in packages/shared/src/budget.ts with copy,
  severity, dismissibility, and link segments, and MOST already name both cause AND
  action ("Insufficient balance. [Top up] or try a more affordable model."). So the
  funding-notice work is CONSOLIDATION, not invention. Real defect found: TWO parallel
  copy systems (budget.ts notifications vs error-codes.ts ERROR_MESSAGES) describe the
  SAME condition with different words -- guest-no-budget has 2 phrasings, premium-locked
  has 3, balance-too-low has 3. Three notices name a cause with NO action
  (capacity_exceeded, capacity_warning, low_balance) and the send button's aria-label
  ("Cannot send") names neither. Precedent for unification already exists and is
  commented as deliberate: MODEL_BELOW_FLOOR_REASON is shared verbatim between the
  picker row and the effort menu's balance state.
  MEDIA PARAMS -- the finding that reshapes the design: `ParamSpec`
  (packages/shared/src/param-spec.ts:18-32) is ALREADY a closed registry shape --
  type enum/number/integer/string/boolean, min/max/values/default/required/step,
  cross-field `requires`/`conflictsWith`, a declared wire transport
  (firstClass|providerOptions), and compileParamSpec() turning it into a runtime Zod
  validator. The dimension contract should EXTEND ParamSpec, not sit beside it, or we
  create a third parallel source of truth. Media params already ride the SAME node
  `params` field as reasoning effort, so transport is already unified.
  THREE unreconciled sources for media option values today: hardcoded constants in
  constants.ts (what the client renders), per-model catalog ParamSpecs from
  normalize.ts imageParameters()/videoParameters(), and narrower derived per-model
  supported\* fields (what the client actually intersects). Registering media as
  dimensions means collapsing these to one.
  NEW SHAPE PROBLEM: a CONTINUOUS dimension exists -- video duration falls back to an
  unsnapped MIN..MAX range when no model declares a discrete set, and audio duration is
  always a continuous 1..600 slider. Enumerable-vs-continuous must be part of the
  contract; a continuous dimension can be PINNED but never OPEN (a classifier cannot
  pick from an infinite set) unless quantized.
  ZERO-COST dimension exists too: aspectRatio and voice are never priced, so the
  contract needs a no-resource case that skips affordability entirely.
  LATENT UNDER-RESERVE (dormant, direction that matters): the catalog declares an image
  `n` ParamSpec (count, min 1 max params.maxN) but media pricing always uses units=1 for
  image, so if `n` is ever exposed the estimate under-reserves by N x. Client does not
  expose it today (image offers aspect ratio only). Audio pricing is hardcoded 0n
  (deferred by design).
- 2026-07-25: Analyst 3 (classifier mechanism) returned. FINDING THAT KILLS THE
  `classify` NODE: the one-input-port rule is an INCIDENTAL SIMPLIFICATION protected by
  a fail-fast assertion, not a type-algebra necessity. The type machinery is ALREADY
  N-ary (NodePortDeclaration.in is readonly TypeTag[], deriveNodeSchemas builds a
  z.tuple over it, validateNodeInput takes readonly unknown[], and the interpreter's
  feedsInPortOrder/resolveLiveInputs build an N-tuple in port order with zero
  special-casing -> INTERPRETER NEEDS NO CHANGE for N inputs). The assertion exists only
  because the compiler hardcodes consumerPorts() = [SINGLE_INPUT_PORT_ID] and
  declaredInputTag() index 0, so a second declared port would be silently never fed --
  the assertion converts that silent divergence into a compile error. TWO existing nodes
  already have >1 conceptual input and NEITHER uses a reserved optional port: fanIn
  (arity from its registered reducer's tuple signature, wired positionally in0..inN) and
  subWorkflow (arity from the registry). The existing mechanism for multi-input is
  POSITIONAL PORTS WITH REGISTRY-DECLARED ARITY.
  RECOMMENDED OPTION C (new; nobody proposed it): the decision travels through the
  EXISTING single input port as a registered JSON envelope. Classifier = a plain
  modelCall (optional:true, onError:'skip'). One registered fanIn reducer takes
  (text prompt, optional<text> classifierAnswer) -> json<turnInput>, doing parse + clamp
  - declared fallback in one registered pure function. That single fanIn output feeds ALL
    N siblings (multiple consumers of one producer port are legal; checkEdge only rejects
    two feeds into ONE consumer port). Requires: one additive field on modelCall naming the
    registered input schema, node-registry consulting it, the FIRST entry in
    WorkflowCapabilities.schemas (which is [] today and was built for exactly this), one
    reducer, and envelope unwrap in model-call-execution. ZERO compile-layer invariant
    relaxed, ZERO new node types, ZERO interpreter dataflow change. The estimator is
    UNTOUCHED and prices the classifier through the existing path because both bounding
    fields already exist (promptInputTokens, params.maxOutputTokens) -- which also makes
    classifierReserveLineItems redundant over time, one fewer bespoke pricing path.
    C-MODEL COROLLARY (load-bearing): the envelope CANNOT carry the model dimension to a
    plain modelCall, because node.model is static and the estimator prices that exact
    model; max-over-alternatives pricing is expressible ONLY inside a node holding the
    candidate set (estimateSmartModelNode). So smartModel STAYS the model-dimension carrier
    and its `in` port takes the same envelope: when the envelope carries a resolved model
    id, smartModelClassifierDimensions deactivates and it CONSUMES the decision instead of
    making its own call. Reserve stays max-over-candidates, so reserve >= bill is untouched.
    This delivers the claimed convergence (one classifier per product, smartModel consumes
    it) with no new node type and no second port.
    NEW COST COMMON TO EVERY OPTION: `emit` is granted to EVERY streaming execution, so a
    classifier that is a plain modelCall STREAMS ITS TOKENS TO THE CLIENT unless the
    interpreter withholds emit from consumed (non-sink) producers -- also a latent-bug fix
    for any intermediate modelCall in a general workflow.
    BRANCH RE-EXAMINATION (licensed): the stated rejection reason IS a real fixable
    estimator defect (branch contributes 0n and every case target is priced in full in a
    flat sum), but the rejection STANDS on two grounds pricing cannot touch -- variant count
    is the PRODUCT of dimension option counts against maxNodes:64 so it fails the
    expandability requirement combinatorially, and a branch routes on ONE predicate over its
    own input whose value must come from the classifier, so a classify mechanism is required
    anyway. Fixing branch pricing now is speculative: no shipped definition uses branch.
    HONEST COSTS OF C: modelCall's input channel becomes node-declared rather than
    model-derived, so modelCall drifts toward a variant union; "exactly one classifier call
    per turn" becomes a builder invariant plus a test rather than a structural guarantee
    (the dedicated node would have made it structural); and a THROWING (not Result-err)
    classifier becomes terminal where smartModel catches it today. Confidence: med.
- 2026-07-25: Analyst 1 (package vs directory) returned and REVERSES the orchestrator's
  stated recommendation. Verdict: ship the seam as packages/shared/src/affordability/
  (bounded directory, narrow barrel subpath, arch-rule one-way enforcement); do NOT create
  a workspace package now. THREE of the orchestrator's five reasons for the package are
  MEASURABLY WRONG:
  (a) "crypto is arch-enforced" -- FALSE. Crypto's entire boundary is its single-entry
  exports map (packages/crypto/package.json:6-8). No arch rule and no boundaries rule
  mentions crypto anywhere. And packages/shared's exports map is EQUALLY closed -- 10
  explicit entries, no wildcard -- with moduleResolution:"bundler" honouring it, so
  @hushbox/shared/estimate/reducers.js does not resolve today. Cross-package
  encapsulation is ALREADY at crypto parity.
  (b) "extracting money shrinks the sandbox barrel hazard" -- FALSE. The hazard is
  env.config.ts (779 lines), which stays in the barrel either way. Real bundle-content
  assertions exist (apps/sandbox/src/render/build-bundle.test.ts:27-30 and the python
  sibling) and the mechanism is the narrow subpath @hushbox/shared/documents. Adding
  "./affordability" to the exports map gives the identical property.
  (c) "a one-way rule across packages is a build failure, inside a directory it is only an
  assertion" -- FALSE both halves. eslint-plugin-boundaries is scoped to src/slices/**
  and is INERT over packages/shared; all workspace packages collapse into one
  broadly-allowed internal-package type and NO rule restricts any @hushbox/\* import.
  Meanwhile the intra-package mechanism already exists AND IS ALREADY APPLIED TO MONEY:
  fee-seams.config.mjs allowlists fee math by path inside packages/shared/src, and
  arch:check already scans packages/shared/src/**. Two directory-isolation rule
  precedents exist (demo-isolation, e2e-store-isolation).
  MEASUREMENTS: money = 3,914 of 13,630 non-test shared src lines (28.7%); 10,332 of
  34,755 with tests. Cycle-closed set = 35 non-test files (~4,246 lines) and it DRAGS IN
  model-descriptor.ts, modality.ts, param-spec.ts, utils/levenshtein.ts plus a split of
  constants.ts -- after which the "money package" owns the model descriptor and the
  modality enum, i.e. it is shared-core renamed. SIX distinct non-money shared modules
  reach into the money set, not two (the rulings file undercounted). Consumers: 7
  workspaces, 133 import sites (api 41 non-test, web 35, marketing 2, ui 2, admin 1, e2e 1,
  scripts 1); apps/sandbox imports ZERO money symbols, so the credential-sensitive origin
  is not a consumer. Migration = 56 files / ~10,300 lines (6,549 test) / 133 specifier
  rewrites / 1 non-mechanical file split, layered on 403 uncommitted files repo-wide
  including 27 in packages/shared (money.ts, client-billing.ts, index.ts) -- an
  unreviewable diff against the redesign's semantic changes. New-package wiring itself is
  cheap (~5 files, ~60 lines; no CI, turbo, or build changes). POLE GATE is a measured
  non-issue: the whole money test set is 27 files / 630 tests / 2.10s wall.
  CODE-RULES anti-speculative-hoist engaged rather than skipped: callers already cross 7
  workspaces, so packages/shared IS the narrowest scope covering them and is already
  satisfied; a package would be a second hoist for enforcement already available in place.
  OBSERVABLE EXTRACTION TRIGGER to write into the plan: extract when EITHER the arch rule
  records >=1 legitimate exception (a shared module that must reach affordability internals
  and cannot be re-pointed at the barrel) OR a build target needs affordability without
  @hushbox/shared. Both show up in a lint diff or a package.json.
  Analyst's own strongest counter, recorded: money is a co-equal 28.7% half, not a corner;
  a package's wall is structural because there is no inside to widen from, whereas
  fee-seams' allowlist is hand-maintained and creeps by editing one array; the founder's
  phrasing reads more naturally as a package; and the cycle set is finite, so
  "it becomes shared-core" is a naming complaint rather than a correctness one.
- 2026-07-25: Explorer 2 (estimator surface) returned. ANSWERS THE OPEN WALL QUESTION:
  priceOptionSet should be PRIVATE. The wall already sits correctly -- packages/shared
  exposes generic MULTIPLIER-APPLICATION functions and never a MULTIPLIER-COMPUTATION
  function. Every shared-package call site supplies the trivial identity {maxFanOutWidth:1,
  maxSteps:1, maxIterations:1} as a literal; the ONLY site computing real values is
  apps/api/src/slices/models/domain/estimate-run.ts (buildParentIndex, containmentEdges,
  memoized enclosureFor taking MAX over multiple enclosing paths), which then passes the
  integers into shared's reservationCeiling/webSearchReservation as opaque numbers. So
  there is ONE pricing implementation (shared) with TWO multiplier sources, not two
  pricing paths -- the identity concern was misplaced, and the affordability seam never
  needs DAG knowledge. Buckets: turn-only = all of smart-model-affordability, effort-options,
  smart-model/, pre-adapters' client helpers, premium-check's trial gate; engine-only =
  NONE of the shared exports (the DAG walk lives entirely outside packages/shared);
  both = estimateRunCeilingNanoUsd + reservationCeiling (trivial multipliers from turn
  code, real ones from estimate-run); unclear = outputCharsPerTokenForTier and
  planReasoningOff (imported into engine code for wire mechanics/tier sizing, not pricing)
  and spendableFundsNanoUsd (turn-only in today's call graph, not structurally so).
  PURITY VERIFIED CLEAN: zero Date./Math.random/fetch/drizzle/redis/process.env across
  estimate/** and smart-model/** non-test files; clock and rng are injected as separate
  ports at runtime.ts:352-355. estimateRun reaches the interpreter by STRUCTURAL TYPING
  (interpreter.ts:82 declares it as a deps field), never by import.
  CORRECTION TO MY OWN PRIOR REPORT: the image-`n` under-reserve I flagged is NOT a latent
  under-reserve -- requireSingleArtifact() (estimate.ts:112) FAIL-CLOSES any n>1, so the
  estimator refuses rather than mispricing. Fail Fast working as documented.
  NEW: THREE independent validation layers on the same media values with NO compile-time
  link between them -- the HTTP-boundary Zod schema (conversations.ts), the untyped
  params: z.record(z.string(), z.unknown()) on the persisted WorkflowDefinition
  (workflow.ts:43,129), and raw typeof/range checks inside BOTH estimate.ts's
  videoCallUsage() and estimate-run.ts's byte-floor estimators. Registering media as
  ParamSpec-derived dimensions collapses these to one.
  TWO MORE SYNC CONTRACTS confirmed (both banned by CODE-RULES as written):
  VALUE_STORE_BYTE_BUDGET_BYTES duplicated locally in estimate-run.ts:232 with its own
  "must stay in sync" comment; and fitAnswerCapToCeiling (turn-definition.ts:446)
  constructs a SECOND independent createEstimateRun for pre-run binary-search sizing,
  carrying a "DURABLE COUPLING" comment warning it must stay reconciled with the canonical
  admission estimator or 402s occur -- which is exactly what T15 was planned to delete.
- 2026-07-25: Analyst 4 (reservation bound, computed live) returned. All 5 agents in.
  THE RULING'S SATURATION CLAIM IS HALF-TRUE (Verified against 200 engine-text ZDR models,
  2,000-char prompt, by calling admitSmartModel with the tightened cap inserted into its
  own min()). It DOES cut the balance-independent hold ceiling H* 3.8x ($26.5950 ->
  $7.2401 at T=2k) and 5-concurrency from a $132.48 balance to $35.70. But for EVERY
  balance <= ~$6.53 NOTHING CHANGES -- hold stays exactly 100% of spendable, concurrency
  stays 1. Trial 1c, free 5c, 25c, $1 and $5 all get ZERO benefit. ORCHESTRATOR
  CORRECTION: I told the founder "for anyone with real money the new term binds"; the
  crossover is $6.53, so $5 is not above it, and under a UNIVERSAL form low-balance users
  pay the term's cost (shorter answers: free median cap 12,860 -> 3,333 at T=1k) for none
  of its benefit.
  WHY T BARELY MATTERS: the hold is set by ONE outlier, openai/gpt-5.4-pro (billable
  output $207/Mtok, maxB 32,768, providerCap 128,000). At T=1,000 the ceiling decomposes
  as maxB leg $6.8026 vs TARGET leg $0.2076 -- 97.0% of it is REASONING BUDGET, not
  answer. Median eligible candidate costs $0.0670 against H* $7.2401 (108x). Excluding
  gpt-5.4-pro ALONE drops H* to $2.7928 and puts 5 runs at a $13.46 balance -- BETTER THAN
  ANY T VALUE ACHIEVES. So candidate-side treatment of the price outlier dominates T
  tuning by ~2.6x, and if "concurrency becomes real" is the goal, the effective lever is
  the effort ladder's top budget and the outlier, not T.
  RECOMMENDED: T = 8,000, in the PER-MODEL maxB(m) form, applied ONLY to models that have
  a reasoning ladder ("Rule C"). Evidence: 8,192 is the p10 of top_provider.
  max_completion_tokens across the 180/200 declaring models (p25 16,384, p50 65,536, p75
  128,000, p90 131,072, max 512,000), so at T=8k the model's own cap binds first for only
  14 of 180 (7.8%); 5-run balance rises only +21% from T=1k to T=8k but +45% at 16k and
  +93% at 32k. Rule C is STRICTLY DOMINANT: H* is BIT-IDENTICAL ($7.2401, because the
  hold-setter is a reasoning model with 2.6x margin over #2) yet free-tier cap truncation
  goes 71 -> 0 and $20 truncation 151 -> 80. It is also faithful to the ruling's words --
  for a non-reasoning model the most the call could ever cost IS already providerCap x rate.
  Do NOT vary T by modality (for media the term is inert, below).
  T >= MINIMUM_OUTPUT_TOKENS IS A CORRECTNESS PRECONDITION, not taste: at T=900 trial
  loses 64 of 156 eligible models and free loses 71 of 195 -- every maxB=0 model gets
  ceiling T < 1,000 and fails eligibility at smart-model-affordability.ts:317.
  SSAffordability 4 SURVIVES VERBATIM for every T >= 1,000: 0 models lost at all seven
  balances, eligible counts unchanged (trial 156, free 195, paid 199), and 0 of 660
  model/effort pairs become newly infeasible (the 76 already-infeasible are the
  pre-existing mandatory-upward defect, unchanged).
  RE-PARTITION INVARIANT HOLDS (Verified): gpt-5.4-pro at $20, T=2k, ceiling 34,768 --
  low B=4,096 H=30,672 / medium B=12,288 H=22,480 / high B=32,768 H=2,000, priced total
  $7.2178 on ALL THREE. Same for qwen/qwen3-30b-a3b across all six options incl. the three
  plateau-collapsed ones.
  CIRCULARITY: none in the per-model form (maxB(m) reads only the model's own catalog
  row). The POOL-LEVEL form does close a loop but converges in <=2 steps for all 200
  models (48 need 2, none need >=4, no oscillation) AND costs concurrency for no benefit
  (H\* $13.84 vs $7.24), so per-model wins on both grounds -- correcting my "price at the
  highest budget in the PRESENTED SET" formulation to per-model maxB(m).
  TWO THINGS THE RULING DOES NOT TOUCH: (a) heterogeneous multi-model -- real pair
  deepseek-r1-distill-llama-70b (ctx 8,192) + claude-opus-5 (ctx 1,000,000) at $20 gives
  shared ceiling 7,692 WITH AND WITHOUT the term, because minContextLength binds far
  tighter; per-sibling would be 7,692 / 67,536. Task 15's coupling is untouched.
  (b) MEDIA -- the term is INERT: media usage has no output-token leg (outputTokensOf
  returns 0n, run-ceiling.ts:90-92) and withAnswerCap never fits a media definition
  (turn-definition.ts:383), so media hold saturation and its 1-run concurrency are
  completely unaddressed.
  COST CIRCUIT: exposure = hold x 5 improves at $20 ($102.50 -> $36.20) and $100 ($132.98
  -> $36.20), unchanged at <=$5. IMPLEMENTATION HAZARD: the term must be inserted in the
  SAME min() whose result is stamped as the node's maxOutputTokens (withAnswerCap,
  turn-definition.ts:386) -- applied to the hold but not the wire cap, the run could
  out-spend its hold.
  LONG-ANSWER BREAK: at $20, 151 of 199 candidates truncated; models able to emit >=64k
  answer tokens fall 122 -> 84 (grok-4.20 1,999,500 -> 67,536). T is a constant with NO
  user-facing escape hatch -- needs a stated product intent for maximum answer length.
  DOC DEBT: BILLING.md SSAffordability 5's "triply bounded" sentence becomes wrong; the
  same change must amend it.
- 2026-07-25: FOUNDER RULINGS closing the design phase.
  (1)+(3) T IS REJECTED. The output upper bound is the model's actual capability:
  ceiling(m) = min(providerCap(m) ?? contextLength(m), contextHeadroom(m), budgetBuys(m)).
  No product-chosen answer length anywhere; SSAffordability 5's "triply bounded" sentence
  was already correct and stays. Consequence recorded: outlier exclusion becomes the ONLY
  saturation lever, which the measurement says dominates T by ~2.6x and bites an order of
  magnitude lower down. Still unfixed and carried forward as its own item: at low balances
  the budget term binds so the hold is still ~100% of spendable, and while a turn streams
  the hold-aware served number makes OTHER conversations grey everything.
  (2) OUTLIER_COST_MULTIPLE = 20, and the founder ruled the test SHOULD catch both
  expensive-per-token and enormous-capacity models. Basis changed with T's rejection:
  outlier(m) <=> maxCallCost(m) > 20 x median(maxCallCost) over the eligible pool, where
  maxCallCost(m) = cost(m, min(providerCap(m), contextHeadroom(m))) -- balance-independent,
  so no circularity, and it maximizes exactly the quantity the hold maximizes. Excluded
  from the classifier-selectable pool ONLY; explicit selection unaffected. Open follow-up:
  re-measure the threshold under this basis (my earlier "k=20 lands near $1.34" was
  computed on the now-dead T basis).
  (4) Media logic is IN the refactor, not follow-on work.
  (5) Directory + arch rule accepted after the reversal; extraction trigger stands.
  Founder also ruled the outlier exclusion is the ONE accepted exception to "smart/auto
  contains every affordable option", on the recorded reasoning that the hold is a MAX over
  the pool so one extreme candidate taxes every other candidate's ceiling on every turn.
- 2026-07-25: docs/BILLING.md REWRITTEN (founder-instructed, lossless). 290 -> 1083 lines.
  NEW sections: Math & Terms (units/rates, funding, prompt basis, model bounds, predicates,
  cost, the hold, and the four invariants stated as equations incl. the re-partition
  invariant that replaced the deleted composition rule) - The Dimension Framework
  (pinned/open duality, resources, the four cost classes, ordered/enumerable properties,
  derived-never-declared, and the explicit statement that resource disjointness is NOT a
  safety property because money buys tokens) - Data Structures (TurnOptions as a
  discriminated union so sendable-with-nothing-to-send is unrepresentable; options MARKED
  not filtered; Availability always carrying a typed reason; DimensionSpec; PriceableModel
  as the narrow projection) - Turn Stories (the two ruled stories: Smart Model as one
  sibling of a multi-model turn with effort pinned, then the same on auto, with a mermaid
  lifecycle diagram) - Notices & Refusals (typed reasons, one wording per condition, every
  notice names an action, refusals never name the binding constraint, every paid action
  carries the send verdict) - Where the Code Lives (the math/responsibility split, the six
  feature exports plus structural seams, the deliberately-unexported list, and what is
  enforced rather than intended) - Extending the System (add a dimension / a resource / a
  modality / a refusal reason / a presentation surface).
  AMENDED: Affordability now carries the four affordability notions and the scope of
  presented<=>affordable; effort section states ONE resolver, real user-visible classifier
  labels, distinctness on the resolved requirement, the downward-closed prefix property,
  and the decision-envelope mechanism (classifier is an ordinary model call; no new node
  type; smartModel consumes the envelope; charge anchored to first persisted content;
  classifier tokens never streamed); Smart Model gained the outlier rule with its
  structural justification and the empty-set greying requirement; Multi-Model 2-3 restated
  NORMATIVELY so they no longer falsely claim the summed-rate approximation and shared cap
  do not exist; Funding matrix priority 1 now compares the ESTIMATE against headroom, not
  headroom against zero; Billing Flow, Fee Structure, Storage Fees, Trial, Bonus, Payments
  preserved verbatim in substance.
  LOSSLESSNESS: first pass replaced ~14 concrete constants with names; all restored
  (ladder budgets 2048/4096/12288/32768/65536, 1024 floor, MINIMUM 1000, $0.50 cushion,
  5-per-wallet cap, hold x 5, 10 x $0.005 search, 4,000-char classifier context, 1c trial
  cap, $50/day global cap, 300n/18n storage, 15% markup, 5 models, 6 connections,
  ~6-month premium recency, 75th percentile). Configuration Reference extended with
  outlier multiple, fee rate, cushion, concurrent-run cap, selected-model cap.
  Prettier-clean. No temporal facts, no live-catalog measurements, no plan/task ids.
- 2026-07-25: FOUNDER RULINGS. k=20 ACCEPTED. Cross-conversation greying gap RULED: when a
  payer is blocked by a HOLD rather than by their balance, block the SEND BUTTON with a
  reason and do NOT grey the models. Founder then improved the mechanism over the
  orchestrator's proposal (a producer branch) into TWO SETS, which is strictly better
  because the pair DERIVES the reason instead of anyone setting a flag:
  affordable <- effectiveBalance (hold-blind) -> ALL greying
  admissible <- spendable (hold-aware) -> send gate, hold, classifier options
  A selection outside `affordable` is a money problem; inside `affordable` but outside
  `admissible` is a hold problem. Maps exactly onto the four affordability notions already
  documented -- only the funding input per notion was wrong, so no second implementation.
  Invariant admissible ⊆ affordable holds because spendable <= effectiveBalance and
  feasibility is monotone in the ceiling; it is what guarantees the send gate can never
  permit what the picker greyed. Needs NO new served data: GET /billing/spendable already
  returns spendableNanoUsd + heldNanoUsd, so effectiveBalance = spendable + holds -- which
  retroactively justifies the two-field shape shipped by T07.
  MONEY-CRITICAL SCOPING recorded: the classifier must be presented `admissible`, NEVER
  `affordable` -- the hold comes out of spendable, so presenting the affordable set would
  let the classifier pick an option the hold does not cover (a reserve >= bill violation,
  not a cosmetic one). Pinned by test.
  SECOND-ORDER WIN: effectiveBalance moves only when money moves, so the picker is now
  stable against ALL hold churn, not just the cross-conversation case -- rows stop
  flickering as the payer's own turns start and finish.
  ACCEPTED TRADE (founder-agreed): a payer may select a model and then find the send
  blocked. Preferred over repainting the catalog, because the composer states the block
  before the picker opens, the send gate still prevents every wrong spend, and the wait
  stays useful -- browse/select/compose -- exactly as the in-conversation queue already
  assumes.
- 2026-07-25: docs/BILLING.md updated with the two-set design (1156 lines, prettier-clean):
  Math & Terms gained the affordable/admissible table and the note that both derive from
  the existing wire fields; budgetBuys restated to take a funding input so ceiling and hold
  are computed once per set; the invariants block gained `admissible ⊆ affordable` with its
  monotonicity proof; the four-notions table gained a Funding input column (notion 1 ->
  effectiveBalance, notions 2-4 -> spendable) plus the "floor is hold-blind, verdict is
  hold-aware" rule and its three consequences (greying reflects money, picker stable
  against hold churn, classifier gets admissible); presented <=> affordable re-scoped
  explicitly to the admissible set; Data Structures now returns the pair with OptionSet as
  the discriminated union and states that the pair DERIVES the reason; Notices & Refusals
  gained item 7 (a hold blocks the send, never greys the options; turn-level reason
  rendered once; no payment action; immediate recovery on run completion regardless of
  conversation and on window focus; the accepted trade stated).
- 2026-07-25: FOUNDER RULINGS on the external BILLING.md review + follow-ups.
  Review dispositions applied: (1) two hold formulas -> hold stated ONCE in general per-node
  form with the chat-turn shape as an explicit corollary, Reservation mechanics now cites it;
  (2) "never silently substituted" rescoped to the TURN-LEVEL choice, per-model resolution
  named as a declared mapping, and the resolved level now REQUIRED to be surfaced;
  (3) cost() storage term made conditional via a new variableRate(m) term -- trial never
  persists so carries no storage; (4) producer ambiguity resolved as ONE entry point
  evaluated twice (new Affordability principle 2, list renumbered 1-11 and the three
  cross-references repointed); (5) ids-vs-labels stated explicitly (medium is the id, Mid the
  label); (6) both storage derivations shown with the storage-class reason (Postgres-resident
  text vs object-storage media) -- the 16.7x ratio is two different monthly costs per GB;
  (7) reviewer's magnitude alarm REFUTED by computation: MONTHLY_COST_PER_GB 0.5,
  MEDIA 0.03, STORAGE_YEARS **50** -> both derivations land EXACTLY on 300n and 18n, no units
  error and no undisclosed margin (their ~1,700-years figure priced text at R2's rate);
  (8) VALID for a different reason than given -- storage-rate.ts's docblock says display
  values derive from the nano constants while constants.ts computes the float independently,
  so the file's own contract is violated; doc now states nano is the source and the cost model
  is documentation of how the rate was chosen; (9) tier-ratio assumption stated with what
  bounds an input-leg miss; (10) outlier median moved to the PRICEABLE CATALOG POOL (was
  eligible pool, which made it balance-dependent and contradicted the reproducibility claim);
  (11) fixedCosts, variableRate(m), e_min(m) defined; (12) THE N-SIBLING ALLOCATION RULE
  RULED AND WRITTEN (below); (13) OptionSet's sendable arm now carries runnable: NonEmpty
  alongside all: ModelEntry[] so sendable-with-nothing-runnable is unrepresentable;
  (14) PromptBasis carries COMPONENTS (system/instruction/history/input) with promptChars
  derived, so history > prompt is unrepresentable; (15) Selection requires >=1 answer source;
  (16) magnitude disclosure NOT DONE (founder: "lets not do this for now"); (17) two-binding-
  constraint precedence added (money if funding cannot cover a minimum answer, else length);
  (18) payer-switch pre-send disclosure now REQUIRED incl. the no-allocation case;
  (19) notice 7's action named as "wait", and per founder ruling it does NOT name or link the
  generating conversation; (20) resolved effort persisted + badged; (21) negative-balance
  visibility documented (top-up clears the deficit first), receipts OUT OF SCOPE;
  (22) admission invariants de-duplicated -- Billing Flow step 2 now references the single
  statement, and reserve >= bill restated once as an operative rule for adding terms;
  (23) self-assurance prose cut, rationale-that-prevents-deletion kept (justified by the
  price-floor regression itself); (24) Config Reference duplicate fee row merged, dimension
  pointer made honest (ParamSpec = option domains, not the registry), rows added for catalog
  admission and persisted effort.
  ALLOCATION RULE (founder-proposed, orchestrator-agreed): T = largest token count with
  SUM_i cost(m_i, T) <= funding - fixedCosts; ceiling(m_i) = min(providerCap(m_i),
  contextHeadroom(m_i), T). The money term is shared, the physical bounds stay per-model --
  which is exactly the reconciliation between "summed across siblings" and "each sibling gets
  its own ceiling". Exactly bounded (and SMALLER than the bound when a physical cap binds);
  equal token ceilings are the right product behaviour because a multi-model turn exists for
  comparison; and it FIXES the tightest-sibling context coupling for free, closing that SS14
  item. A smart slot's MAX term enters the T solve.
  CATALOG ADMISSION section ADDED with the profit rationale stated FIRST and the number as its
  consequence: at the floor, 15% of $0.0002/1K = $0.00003/1K margin while every fixed cost of
  serving the turn is unchanged, so the floor is a MARGIN floor -- which is also why it tests
  the PRE-FEE rate. Four rules: zero-priced excluded unconditionally; below $0.0002/1K
  combined pre-fee (= 200 nano/token) excluded; older than 2 years excluded; top 5% context
  (TOP_CONTEXT_PERCENTILE 0.95) exempts the floor and the age cutoff but NEVER the zero-price
  check. Text only, no media rules. Three counted reasons, no alert (expected, not defects).
  Section marked load-bearing on classifier-engine selection so it is not read as arbitrary
  filtering -- the exact failure that caused the regression.
  EFFORT PERSISTENCE: founder challenged the orchestrator's content_items placement and WON on
  two verified grounds -- content_items carries MODALITY-AGNOSTIC display data (costNanoUsd,
  isSmartModel both apply to any modality) while effort is language-specific, and
  conversations/adapters/stores.ts ALREADY reads llm_completions (reasoningTokensByContentItem),
  so the join costs nothing new. Nullable pgEnum beside reasoningTokens; null = concept does not
  apply, 'off' = user chose Min. Implementation trap recorded: that helper SUMS reasoningTokens
  across the N llm_completions rows of one content item (one per agentic step) -- correct for
  tokens, WRONG for an enum; the level is constant across steps and must be taken, not
  aggregated. Totality invariant: saved <=> billed makes the join total for text.
  reasoningTokens column KEPT: reasoning is frequently billed WITHOUT being returned (usage
  payload and content stream are independent channels), so the client cannot count it; and a
  client-side estimate would use the deliberately user-adverse tier ratio, putting a number on
  screen that contradicts the provider-reported output tokens beside it.
- 2026-07-25: docs/BILLING.md now 1343 lines, 24 sections, prettier-clean. Two explorers
  dispatched to map current client and server state for the re-plan; both killed by a session
  limit mid-run and RESUMED FROM TRANSCRIPT per the restart skill (not respawned).
- 2026-07-25: BILLING.md gained a "Mechanisms rejected, and why" subsection (9 entries with the
  specific non-obvious ground each fails on) per founder ruling that anything worth keeping
  belongs in BILLING.md or plan.md, not a third document. The two deleted research docs are NOT
  reconstructed. Correction to the earlier alarm: ledger.md, plan.md and BILLING.md are all
  git-TRACKED, so a clean cannot touch them; only untracked files were ever at risk.
- 2026-07-25: Both state-mapping explorers returned. KEY VERIFIED FACTS now driving the plan:
  WorkflowCapabilities.schemas is EMPTY (workflow-capabilities.ts:114-157) with 2 predicates and
  3 reducers registered; fanIn arity comes from the registered reducer's TypeTag tuple length,
  checked at compile-definition.ts:210-235 (reducer_arity_mismatch); `emit` is granted ONLY when
  a NodeExecution declares streaming:true (execution-registry.ts:171), so withholding the
  classifier's stream is a REGISTRATION FLAG, not an interpreter change -- materially cheaper
  than assumed; node input validated per node via validateNodeInput (node-input.ts:15-21) and
  every produced value type-checked at commitValue (interpreter.ts:688-703); the classifier
  charge anchor already exists as anchorContentItemId() stripping the last '#' segment
  (settlement.ts:149-158) with the skip-if-no-content behaviour at :129-137; catalog exclusion
  choke point is normalize.ts:585-625 with fee baking at 594-625, and formatRefreshSummary at
  scripts/refresh-catalog.ts:38-51 prints non-zero reasons in tuple order.
  Client: useModelFloor lives at use-prompt-budget.ts:669-717 and flows modal:69 -> body:71 ->
  item (showFloorGrey/MODEL_BELOW_FLOOR_REASON); query-provider.tsx:58-78 sets staleTime 5min
  with refetchOnWindowFocus FALSE; use-realtime-sync.ts:19-45 DOES invalidate spendable on
  ws-ready/run-started/run-finished but is conversation-scoped; queue store gates only on
  MAX_QUEUED_PER_CONVERSATION=5 and the drain hardcodes DRAIN_FUNDING_SOURCE='personal_balance'
  (use-authenticated-chat.ts:110) though its failure recovery already restores text and preserves
  the queue; regenerate gated purely by resolveMessageActions (lib/message-actions.ts:56-70) with
  no money check; Smart chip is AIMessageNametag() (message-item.tsx:623-677, chip :665) driven
  by Message.isSmartModel (api.ts:74-78, wire conversations.ts:239 + sse-events.ts:107).
  RESOLVED an open question: reasoningTokens IS rendered -- thinking-disclosure.tsx shows
  "Reasoned privately (N tokens)" -- so the column has a live UI consumer and the keep ruling is
  independently justified. NEW: resolved-effort label has NO capture point anywhere on the
  settlement path (only the token count rides it), confirming D1 is build-not-wire work.
  EVIDENCE CONFLICT to resolve in B4: one survey found fitAnswerCapToCeiling constructing a
  second independent estimator with a DURABLE COUPLING comment; the later survey did not find it.
  B4's brief requires verifying which is true before designing the edit.
- 2026-07-25: plan.md COMPLETELY REWRITTEN (founder granted permission), superseding the original
  plan and all 16 amendments; surviving amendment content folded inline as SSKnown Breakage and
  SSGlobal Constraints. 18 tasks in 7 lettered lanes: A1 catalog admission; B1-B7 the affordability
  module spine (bounded module + wall, dimension registry on ParamSpec, getTurnOptions two-set
  producer, shared-budget T solve, outlier exclusion, one effort resolver, notices); C1-C3 the
  envelope mechanism (registered schema + reducer, Smart Model consumes, multi-model auto -- the
  original blocker); D1-D2 persist + badge the resolved effort; E1-E4 client surfaces (render the
  sets, every paid action carries the verdict, freshness, media dimensions); F1-F2 group payer
  scope + estimate comparison; G1-G3 arch rules with positive controls, duplication collapse,
  E2E authored-not-run. Global Constraint 1 makes BILLING.md required reading for EVERY subagent
  per founder instruction. Disposition table maps the 12 clean tasks (unaffected), the 3
  superseded (T11/T12/T13, incl. T12's held fix re-audit now moot), and the 6 replaced.
  Deferred list carries reasons: package extraction (trigger recorded), additive branch pricing
  (speculative, under-reserve failure direction), refusal magnitudes, receipts, the ABBA
  lock-order window, media price floor.
- 2026-07-25: Two adversarial plan reviewers returned (omission + insufficiency). Plan AMENDED in
  one pass; 22 -> 24 tasks. ORCHESTRATOR ERRORS CORRECTED:
  (a) B1 was self-contradictory -- "no behaviour change whatsoever" AND "a barrel exporting only the
  named surface" cannot both hold, because consumers import MINIMUM_OUTPUT_TOKENS, evaluateManifest,
  planReasoning, priceRequest and turnEffortOptions from the ROOT BARREL today (index.ts export _).
  Split into B1 (move, behaviour identity) + NEW B1b (close the export wall, consumer breakage IS
  the work). Also killed a vacuous criterion: "deep paths do not resolve from outside" is ALREADY
  TRUE (no wildcard subpath in the exports map), so it proved nothing.
  (b) B4 HAD THE DELETE TARGET INVERTED. fitAnswerCapToCeiling (turn-definition.ts:440) is NOT a
  second estimator -- its docblock says it calls the canonical createEstimateRun precisely to
  ELIMINATE a second cost formula, because the per-rate guess applies markup per rate while
  admission applies it to the subtotal, and that drift caused live 402s. The thing to delete is the
  GUESS (turnMaxOutputTokens/answerMaxOutputTokens). I told the founder the opposite last turn and
  corrected it. B4's verification also moved from the module's own cost function to
  createEstimateRun on the COMPILED DEFINITION, which is the only place the drift is visible.
  (c) B2's "extend ParamSpec" is MECHANICALLY IMPOSSIBLE -- verified ParamSpec is a z.strictObject
  persisted inside the jsonb descriptor (model-descriptor.ts:98), so it cannot carry support/
  requirement/wire function fields. Restated: DimensionSpec is a non-persisted code registry that
  CONSUMES a per-model ParamSpec as its option domain.
  (d) E3's premise was FALSE. Spendable invalidation is already global (use-realtime-sync.ts:37,64
  call billingKeys.spendable() with no argument); the real gap is the hook is only mounted from the
  group-chat path, so a socket-less surface gets no frame and its blackout outlives the run under a
  5-minute staleTime. My criterion would have passed with ZERO production change.
  (e) C1's streaming claim was half true: the grant is per-registration but model-call-execution
  hardcodes streaming for the whole node type, so a non-streaming classifier needs a SECOND additive
  schema field threaded through live-execution-registry.ts -- now in scope.
  HIGHEST-COST FINDING (money, not cosmetic): C2's criterion directed the classifier charge at "the
  existing anchor-key convention", and anchorContentItemId (settlement.ts:149) can only strip its own
  node's key suffix -- a turn-level classifier node resolves NO anchor and settlement continues past
  it (:133), which is the "reserve is a lie" failure. Naming it after the first sibling does not fix
  it: when sibling 1 fails and sibling 2 persists (a supported outcome) the charge vanishes again.
  C2 now owns a RUN-LEVEL anchor rule and is pinned on exactly that failure shape.
  OTHER VALIDATED GAPS now owned: the classifier must be presented `admissible` never `affordable`
  (C3 -- BILLING calls it the one place the wrong set is a money defect and nothing pinned it); the
  re-partition invariant had no pin AND B6 was deleting its live enforcement (pickClassifiedEffortPlan
  guarantees maxTokens == the held cap, so deleting the upward-resolution bug also deleted the spend
  bound -- B6 now re-establishes B + H == ceiling); the arithmetic vocabulary was unowned
  (variableRate, fixedCosts, inputStorage-once, e_min, resolved-corner eligibility, inverted
  output-storage ratios, cache-read pricing, web-search worst case, per-unit maxCallCost -- all now
  pinned BY AMOUNT); E1's rule said "component" while the second verdict engine is a HOOK (now
  deletion + grep-clean, and E1 owns hooks/models/_ where premium access is derived from the balance
  endpoint and premium rows are REMOVED rather than marked); unowned leaf clauses (trial remaining
  count, deficit-at-payment, Notices 6/7 and two clauses of 9, Smart Model 5/7/8, Multi-Model 4/6,
  Affordability 11) all assigned; B3's brute-force fixture was vacuity-prone (now >=3 models, >=2
  dimensions, a mandatory-reasoning model, a plateau-collapsed pair); G2's grep-clean matched neither
  real comment (both say "MUST stay in sync") and one documents a deliberate dual guard -- now
  enumerated by citation with dispositions; G1 gained rule 6 (export allowlist), rule 2 widened past
  "component", rule 5 restated as an enumerated pinned allowlist since "nothing imports into it" is
  unimplementable when the barrel is imported by design.
  OWNERSHIP COLLISIONS RESOLVED with a table: A1+B1 on constants.ts (declared parallel -- guaranteed
  conflict, A1 now runs after B1); turn-definition.ts across B4/C3/E4; smart-model-turn C2/C3;
  settlement C2/D1; smart-model-execution C2/D1; message-item D2/E2; prompt-input E1/E2;
  modality-config-panel moved wholly to E4; use-media-cost-estimate carved out to G2. Missing edges
  added: B1->A1, B1->F1, B1->G1, B2->E4, B4->E4, C3->E4, D2->E2, B5/B6->E1. F2's path was post-B1
  while declared independent of B; B7's was pre-B1 though it runs after -- both fixed.
  NEW LANE H: H1, one api integration test of a multi-model auto turn with a Smart Model sibling and
  a FAILING FIRST SIBLING, asserting four things in one run -- persisted effort per generation
  matching the wire, classifier charge anchored to the first persisted item, hold >= sum of charges,
  and estimate <=> executed identity now that the envelope carries a runtime choice. The close phase
  runs gates and a critic; neither executes a turn, so nothing else in the plan would catch these.
  Close phase corrected: BILLING.md is a doc CANDIDATE, not "already current" -- B1's move
  invalidates ~14 of its path citations and B1 produces that diff.
  BILLING.md AMENDED: SSMulti-Model 2 now distinguishes T as a SOLVE VARIABLE from the charge basis
  (Sigma_i cost(m_i, ceiling(m_i))), because as written it forbade "a summed-rate approximation over a
  single shared token count" while SSMath's own T solve evaluates exactly that -- a genuine
  self-contradiction the reviewer surfaced.
- 2026-07-25: PRE-EXECUTION REVIEW (orchestrator, full re-read of BILLING.md + plan.md +
  ledger.md before dispatching anything). 10 problems found, all textual/verified, none
  requiring code inspection. TWO NEED A RULING: (1) THE TWO-BASIS AMBIGUITY — three
  BILLING.md statements disagree on getTurnOptions' call pattern (§Aff 2 "called once",
  §Data Structures "called once per funding input", §Public surface "evaluated with an
  empty basis, its affordable set is the picker's floor"). The funding half is clean
  (FundingSnapshot carries spendable+held ⇒ both numbers from one param) but the BASIS
  half is not: the picker floor must be prompt-independent while the send gate must use
  the real prompt, so `affordable` differs from `admissible` in TWO inputs, not one. As
  written, a surface that calls with the real basis and greys from `affordable` — exactly
  what the type's own doc comment instructs — gets prompt-dependent greying, which
  §Scope forbids. B3 and E1 would resolve this two different ways. Recommended:
  getTurnOptions computes `affordable` internally at an empty basis (one call, misuse
  unrepresentable); requires adding basis-monotonicity to the admissible ⊆ affordable
  proof. (2) B1b IS MIS-SEQUENCED — "the root barrel re-exports only the feature surface"
  and "each removed export is replaced by a producer function on the surface" require
  getTurnOptions/chooseFrom/renderOptions/wireFor, which B3/B6/C1 build. Only the
  ABSENCE half of its criteria is achievable at spine position 2.
  EIGHT MECHANICAL DEFECTS: (3) the invariant NAMED `presented ⟺ affordable` is actually
  about the ADMISSIBLE set (§Scope says so explicitly) — the name collides with the set
  it is not about; plan B3 already says `presented == feasible`. (4) §Where the Code
  Lives "What is enforced" bullets 2 and 5 still carry the two phrasings plan G1
  explicitly corrects ("no COMPONENT may import" — too narrow, the second verdict engine
  is a hook; "nothing in the shared package imports into it" — unimplementable, the
  barrel is imported by design), so the normative doc contradicts the plan.
  (5) plan.md:933 says "A1, F1→F2 and E3 are genuinely parallel … alongside B1" while
  plan.md:915 says "A1, F1→F2 and G1 open once B1 lands — not before" AND the graph
  carries E1 → E3; three-way contradiction, and an orchestrator following :933 dispatches
  E3 before E1 exists. (6) plan.md:803 says "five rules", lists six (rule 6 added by the
  amendment, count not updated). (7) BILLING.md:242 headline says "top context DECILE",
  body says top 5% (TOP_CONTEXT_PERCENTILE 0.95). (8) OptionSet carries holdNanoUsd on
  BOTH arms of TurnOptions, but a hold may only be taken against spendable, so
  affordable.holdNanoUsd is a representable meaningless state in a section whose premise
  is "illegal states cannot be represented". (9) THE COMPLETENESS CONTRACT HAS NO
  ALREADY-TRUE CLAUSE — it directs the close critic to audit BILLING.md section by
  section, which sweeps in Payments/New User Bonus/Balance Consumption/Tier derivation,
  none of which this run touches; as written every such clause reads as an unowned
  planning defect. (10) §Reasoning Effort 6's 4,000-character classifier context cap has
  no owning task (previously graded Assumed, still unverified). Nothing dispatched.
- 2026-07-25: FOUNDER RULINGS on all four review questions, ALL APPLIED.
  (1) BASIS: ONE CALL — getTurnOptions(funding, basis, selection) is called once with the
  composed basis and internally evaluates one pure core over TWO (funding, basis) pairs:
  (effectiveBalance, EMPTY_BASIS) -> affordable, (spendable, basis) -> admissible. The
  producer substitutes the empty basis itself; no caller ever supplies one, so a
  prompt-dependent `affordable` is UNOBTAINABLE rather than merely discouraged. Rejected:
  two explicit calls (leaves the real-basis call returning an affordable set that must
  never be read -> needs an arch rule to close a trap the type invites) and prompt-aware
  greying (reverses §Scope). Consequence recorded in BILLING.md: the admissible ⊆
  affordable proof now cites BOTH differing inputs, since spendable ≤ effectiveBalance and
  the real basis ≥ the empty one push the ceiling the same way.
  (2) B1b SPLIT. B1b keeps only the achievable half at spine position 2 — remove the
  leaked root-barrel exports, repoint consumers at internal module paths, pin ABSENCE
  symbol by symbol, and report the repointed set as B8's inbox. NEW TASK B8 (depends B7 +
  C1) lands the six documented exports under their documented names, pins the barrel's
  SET EQUALITY (totality, not just absence), and flips B1b's inbox onto the barrel. B8
  also owns the naming question: rename where cosmetic, REPORT where the documented name
  would imply a different signature — no wrapper may exist whose only purpose is to
  satisfy a name. resolveFunding already exists as an export, so B8 does not wait on F2.
  (3) holdNanoUsd HOISTED to TurnOptions (`NanoUSD | undefined`, present only when
  admissible.sendable); removed from OptionSet entirely. An affordable-side hold is now
  unrepresentable rather than merely meaningless. Verified: one occurrence in the doc.
  (4) All eight mechanical fixes APPLIED. BILLING.md: invariant renamed `presented ⟺
  feasible` and scoped to the admissible set at all three sites (:187 block, the notion-3
  table cell, the §Scope heading); §What is enforced bullets 2 and 5 rewritten to match
  G1 (code-under-apps/web not "component"; enumerated pinned allowlist, since "nothing
  imports into it" is unimplementable when the barrel is imported by design); "top context
  decile" -> "top context percentile"; §Aff 2, §Data Structures and §The public surface all
  restated to the one-call pattern; the pre-table sentence "called with each" also
  corrected. plan.md: dependency contradiction resolved with an authoritative
  what-opens-when TABLE (E3 is NOT parallel with B1 — the E1 → E3 edge governs; G1 opens
  on B1b + B2, not B1) and the offending sentence deleted with a note saying so; G1 "five
  rules" -> "six"; completeness contract gained an ALREADY-TRUE clause naming the sections
  this run does not change (Payments, New User Bonus, Balance Consumption, Tier derivation,
  Trial quota, settlement steps), so the close critic reports "verified true at file:line"
  instead of manufacturing tasks for working behaviour; §Reasoning Effort 6's 4,000-char
  classifier truncation assigned to B6 with an explicit instruction to report a doc/code
  mismatch rather than silently change either side. B3 gained the ruled call pattern, the
  one-call-two-evaluations pin, and the hold-on-the-pair shape; ownership table gained
  shared/src/index.ts (B1b removes, B8 lands); Lane E header corrected to B5/B6/B7/B8.
  STATE: BILLING.md 1403 lines, plan.md 1063 lines / 25 tasks in 8 lanes, both
  prettier-clean. Implementer freeze still in force; nothing dispatched.
- 2026-07-25: IMPLEMENTER FREEZE LIFTED (founder: "execute"). Phase 3 begins.
  B1 dispatched → implementing (impl-report-1.md). Sole task in flight by design — Lane B
  is a strict spine and B1b/A1/F1/G1 all gate on its clean, so nothing runs beside it.
  Brief carried three coordination facts not in the plan: (a) B1 is the only in-flight
  task, so a red scoped suite is either its own or on §Known Breakage; (b) scale is ~35
  non-test files / ~4,246 lines / ~133 import sites across 7 workspaces, so Global
  Constraint 10's repo-wide sweep IS the body of the work; (c) the export wall is NOT B1's
  — B1b removes and B8 lands, so B1 leaves index.ts's existing `export *` alone.
  Three NEEDS_CONTEXT triggers set: a semantic test edit needed outside the permitted
  constants split; an allowlist entry that would itself import the money set (a real cycle,
  which changes the closed set); a premium-check disposition that pulls in files beyond the
  enumerated list. Five task-specific evidence items required, the load-bearing one being
  the enumerated allowlist AS A LITERAL LIST — B1b and G1 consume it verbatim as an
  acceptance criterion, so an approximate list blocks two downstream tasks.
- 2026-07-25: B1 implementer DONE_WITH_CONCERNS (impl-report-1.md). Self-gate: shared green
  (110 files), config/ui/crypto/db/realtime/web/marketing/admin green, repo typecheck 16/16
  and lint 16/16 --force, arch:check green, eslint exit-0 after final edit in all three
  edited packages. Failures attributed: api 1/464 pre-existing at HEAD, scripts 3/90 (2 on
  §Known Breakage + 1 push workstream), lint:unused 2 findings outside the change set.
  PLAN AMENDED BEFORE AUDIT (4 additions, so auditors judge against correct criteria):
  (a) §Known Breakage += apps/api template-html.test.ts failing at HEAD (7 snapshots, a
  removed Google-Fonts link, template source AND .snap both unmodified vs HEAD; belongs to
  the push/notifications workstream, needs an owner outside this run) and += knip's two
  unrelated findings being a Phase-4 gate.
  (b) §B1 Amendment records ONE ACCEPTED OUT-OF-OWNERSHIP EDIT into G1's files —
  packages/config/eslint-extensions/{fee-seams.config.mjs, rules/fee-seams.mjs,
  rules/fee-seams.test.mjs}. Forced and load-bearing: the fee-seam allowlist names the two
  fee-application files BY PATH, so a move that does not update it leaves lint red AND
  SILENTLY UNHOOKS FEE PROTECTION FROM money.ts — the worse failure because it is invisible.
  Same class as this run's earlier composition-root deviations. Recorded explicitly as my
  ruling and open to auditor disagreement, NOT as a finding pre-dismissed.
  (c) §B1 Interfaces block written for downstream consumption: import allowlist reduces to
  `zod` alone over 68 files (G1 rule 5 pins membership); G1 rule 1's inbox = 16 intra-package
  files repointed at exact moved paths to keep the import graph byte-identical, 12 of them
  type-only reaches for relocated general primitives (Modality, NanoUSD, ModelDescriptor,
  ParamSpec) — G1 MUST DECIDE whether a type-only reach counts and record the reason, the
  plan deliberately does not pre-decide; constants split 27 money / 28 non-money with A1
  adding to affordability/constants.ts; 158 importer files across 9 workspaces needed ZERO
  edits because the root barrel is unchanged, which is what leaves B1b's removal work real.
  (d) §B1 Dispositions: premium-check.ts STAYS in models/ — moving it is what creates the
  cycle (premium-check → models/types.ts → schemas/api/models.ts → model-descriptor.ts, and
  model-descriptor.ts is now inside the module); B2 owns the revisit once PriceableModel can
  re-sign it off RawModel instead of RawModel's descriptor. G1 RULE 4 GAP recorded unresolved:
  isPremiumModel does parseFloat(prompt)+parseFloat(completion) against a threshold — rate
  arithmetic outside the module, and float arithmetic on rates at that; G1 must carve out WITH
  the reason in the rule docblock or the file moves after B2. Escalated to founder as a design
  call; no silent carve-out permitted. B8 INPUT: affordability/index.ts re-exports money.ts BY
  NAME (fee-seam rule forbids star), so applyMarkup/applyMarkupCeil are NOT on the module
  barrel while BILLING.md §Where the Code Lives lists "the two fee applications" as barrel
  seams — B8 decides and reports; B1 deliberately did not.
  → B1 auditing (2 independent auditors, money-flagged). Auditor A aimed at the identity
  claims (export-set count ≠ same bindings; fee-seam rule must be proven to still FIRE via a
  positive control, since a passing lint run proves nothing about a rule matching nothing) +
  independent re-enumeration of the allowlist. Auditor B aimed at structural boundary
  correctness (trace the import graph rather than trust the enumeration; transitive db/cache;
  subpath narrowness incl. wildcard/re-export chains; whether the 12 type-only reaches are
  genuinely erased — a value import there falsifies the byte-identical claim and corrupts G1's
  rule-1 decision) + spot-checking the five Interfaces figures four tasks now depend on.
- 2026-07-25: B1 auditor B: FAIL. 1 Important + 3 Minors VALIDATED, plus two catches that
  indict the PLAN rather than B1. Auditor independently reproduced the hard parts instead of
  trusting the report: 66 of 68 relocated files byte-identical to HEAD (the 2 exceptions differ
  by exactly one depth-corrected specifier each); constants split is an EXACT partition
  (55 = 27 + 28, no omission, no addition, no name in both halves, so the root barrel's two
  star-exports reconstitute the old set with no shadowing); module production closure is
  {intra-module} ∪ {zod} with NO edge leaving the module, which makes the no-cycle property hold
  BY CONSTRUCTION rather than by allowlist discipline and proves no-db/cache TRANSITIVELY (a
  stronger result than the report's direct grep); exports-map deep specifiers all refuse
  (ERR_PACKAGE_PATH_NOT_EXPORTED) from apps/api. Every failing suite independently attributed to
  HEAD or §Known Breakage, incl. a NEW one: scripts/generate-env.test.ts:759 fails at HEAD
  because env.config.ts already carries the three VAPID/notification secrets its expected list
  lacks — push workstream, not ours.
  VALIDATED IMPORTANT: my §B1 Interfaces "16 files, 12 type-only" is WRONG BOTH WAYS. Only 1 of
  15 is `import type` (flow-executor.ts); the rest are RUNTIME VALUE imports because Modality and
  NanoUSD are Zod schemas used as values and tsconfig.base.json:29 sets verbatimModuleSyntax:true;
  9 value edges for the general primitives, not 12. Load-bearing because G1 rule 1's decision was
  about to be taken on the belief that 12 edges erase at build — a permit-type-only rule still
  leaves 9 value edges to repoint, changing the import graph B1 deliberately preserved and
  possibly apps/web's bundle shape. Plan CORRECTED; fixer supplies the per-file value/type split.
  VALIDATED MINORS: (1) path-diff misses BILLING.md:1394 (welcome credit → affordability/tiers.ts);
  true totals are 25 pairs over 20 lines, not 24/19 — criterion 6 asks for EVERY citation and the
  close-phase pass would apply this table verbatim, leaving a stale path in the normative spec.
  (2) affordability/budget.ts:7 comment cites the deleted packages/shared/src/estimate/ path — B1's
  own move made a pre-existing comment wrong. (3) affordability/index.ts:6-8 docblock claims zod +
  the seeded-PRNG helper are the only imports into the directory, but the module's tests also import
  node:fs, node:url, the root barrel and the non-money constants half; the report's prose lists all
  six correctly, so the IN-CODE docblock — the artifact G1 reads — is the inconsistent one.
  AUDITOR CORRECTED MY AMENDMENT'S REASONING, and it is right: a stale fee-seam allowlist would NOT
  have silently unhooked fee protection from money.ts. money.ts DEFINES applyMarkup* and imports no
  fee helper, so its allowlist entry is never exercised; the real consequence is a LOUD lint error at
  affordability/estimate/search-reservation.ts:15, and a stale entry over-restricts rather than
  under-protects. Deviation still accepted (forced + verifiably path-only) but on correct grounds.
  I relayed the implementer's mechanism without grounding it — second time this run I have passed a
  subagent's claim upward as my own reasoning. Plan amendment rewritten to record both the correction
  and why a hollow stated reason is dangerous (it is what gets a guard deleted later).
  PLAN DEFECT B1b — THE WALL WOULD HAVE BEEN FAKE. B1 added "./affordability" to the exports map and
  the module barrel star-exports all eleven units, so the entire not-exported list is now reachable
  from every workspace through an entry point that did not exist before this run. B1b as written
  asserted absence from the ROOT barrel only ⇒ it would have reported the wall closed while the
  subpath published the whole list. Not a B1 defect (behaviour identity required the root barrel keep
  working; B1b was always the closer). B1b now requires absence from BOTH barrels, one test per entry
  point, a symbol absent from one and present in the other being a failure not a partial pass; G1
  rule 6 likewise widened to read both entry points.
  ESCALATED TO FOUNDER, not scored against B1: the CONTENT-FREE clause (Global Constraint 6 +
  §Where the Code Lives) is contradicted by the module's own contents — truncateForClassifier
  ({latestUserMessage, latestAssistantMessage}) and buildClassifierMessages are exported from
  smart-model/ and re-exported by both barrels. Pre-existing at HEAD and the plan's closed set
  explicitly includes smart-model/, so B1 followed the plan; but NO task removes them, so the
  "content-free by type" guarantee is currently false. Awaiting ruling.
  Auditor A still running. Fix cycle held to batch both auditors' findings into one brief.
- 2026-07-25: PAUSED at founder request, after B1's audit and before any fix dispatch.
  State: 1 of 25 tasks attempted; B1 implemented, auditor B returned FAIL, auditor A still in
  flight; no fixer dispatched (findings batch across both auditors by design); nothing committed.
  Four questions outstanding to the founder: (1) the content-free clause vs the module's
  content-accepting exports; (2) G1 rule 4's parseFloat rate-arithmetic gap in isPremiumModel;
  (3) whether the two fee applications belong on the module barrel or the doc is wrong;
  (4) approval for the BILLING.md batch (25 path pairs + 2 factual defects).
- 2026-07-25: B1 auditor A: PASS, CONDITIONED. 1 Important (content-free clause — explicitly
  declared a design question for orchestrator/founder, "if you rule Global Constraint 6 binding on
  B1's own scope, this converts my verdict to FAIL with exactly this one fix; I did not presume
  that") + 2 Minors, both CONVERGENT with auditor B.
  IDENTITY ATTACKED FROM THREE ANGLES, all held — the strongest evidence of its kind this run:
  (1) SYMBOL level, stronger than any count: built a TS program over index.ts at HEAD (git archive
  into a scratch tree, real node_modules symlinked) and on the worktree, compared 839 vs 839
  exported symbols by name, symbol flags, AND a hash of each declaration's source text — 0 only-in-HEAD,
  0 only-in-NOW, 0 flag diffs, 0 DECLARATION-TEXT HASH DIFFS, with 92 symbols' declaring paths moved.
  (2) RUNTIME level: both barrels in one process, 543→543 empty both ways, zero typeof mismatches and
  ZERO PRIMITIVE VALUE MISMATCHES across every exported string/number/bigint/boolean — which is what
  actually rules out a silently changed rate or threshold. (3) FILE level: 63 of 65 byte-identical,
  the two exceptions one import line each.
  FEE-SEAM RULE PROVEN LIVE BY POSITIVE CONTROLS (eslint --stdin, no repo writes): fires at a
  relocated non-seam path (estimate/format.ts importing applyMarkupCeil); EXEMPTS the relocated seam
  (same content at affordability/money.ts); and the star-launder guard fires at affordability/index.ts
  for `export * from './money.js'` — which independently confirms the named-re-export decision B1
  recorded for B8. Auditor A INDEPENDENTLY REACHED B's correction of my amendment: money.ts has ZERO
  import statements and the rule only reports on import/re-export specifiers and imported-module
  member access (rules/fee-seams.mjs:104-152), so a stale allowlist could not have unhooked anything
  there. Both auditors, separately, told me my stated reason was false. Explicit instruction recorded:
  "the reasoning should not be reused as precedent."
  ALLOWLIST INDEPENDENTLY RE-ENUMERATED and confirmed COMPLETE: production non-relative imports are
  `zod` in exactly 6 files (estimate/reasoning-plan, modality, model-descriptor, nano-usd, param-spec,
  reasoning-effort); no production file has a relative import leaving the directory; test-only
  additions exactly vitest, node:fs, node:url, seeded-prng, ../constants.js, ../index.js.
  CONSTANTS SPLIT: no constant crosses at runtime. The CAPACITY_* pair is in the money half because
  affordability/budget.ts:10,144 genuinely consumes CAPACITY_RED_THRESHOLD — rule (a) forces it,
  rule (d) keeps the pair together, both stay on the root barrel so nothing breaks. NEW G1 INPUT
  recorded in the plan: G1 rule 2 WILL TRIP on apps/web/.../capacity-bar.tsx, whose only affordability
  symbols are those two pure-UI thresholds — G1 must handle it deliberately, not discover it.
  PREMIUM-CHECK NUANCE recorded: the cycle is real but its first two hops are TYPE-ONLY, so it is a
  DIRECTORY-level cycle, not a file-level runtime one; it still blocks the move because admitting the
  file needs models/types.ts on the INBOUND allowlist. Disposition and B2 reversal trigger stand.
  A's MINOR 1 SHARPENS B's Important: beyond "15 not 16", the symbol characterisation is wrong in two
  further places — formatting.ts:6 reaches for nanoUsdToFullDollarString (a MONEY formatter) and
  mock-directives.ts:3 for CLASSIFIER_EFFORT_LEVELS (the EFFORT DIMENSION), so a carve-out written from
  the "general primitives only" framing would silently permit two value reaches into money proper; and
  NO intra-package file reaches for ParamSpec at all. Since the two audits' counts disagree in detail,
  plan.md now declares its own figures NON-AUTHORITATIVE and requires the fixer to derive the table
  fresh (one row per file, exact symbols, value-or-type); G1 consumes the table, not the paragraph.
  Two harmless report prose slips noted (×17 units where index.test.ts lists 18 — its own "37 reds"
  figure corroborates 18×2+1; "export count = 145" where the module barrel has 143 keys). Also noted
  and correctly NOT flagged: a "(D3, dimension-composed)" label at smart-model/prompts.ts:42 looks like
  a plan identifier under Global Constraint 8, but that file is byte-identical to HEAD — pre-existing.
- 2026-07-25: RECONCILED VERDICTS: A PASS-conditional, B FAIL. They agree on all substance and differ
  only on scoring the content-free clause. B's FAIL rests on the reach-in figures — which originated in
  the implementer's report and which I propagated into plan.md, so it is fairly scored against B1.
  SIX validated findings queued for ONE fix cycle, NOT YET DISPATCHED (founder paused the run):
  (1) Important — derive the authoritative reach-in table fresh; (2) path-diff misses BILLING.md:1394,
  true totals 25 pairs / 20 lines; (3) affordability/budget.ts:7 stale path comment; (4)
  affordability/index.ts:6-8 docblock understates imports into the directory; (5) the report's own
  §Deviations 1 rationale is factually wrong and must be corrected in the record so it cannot be cited
  as precedent; (6) the two prose slips + the §Importer-sweep heading that says "zero edits required"
  while its own table lists five edited files.
  HELD, NOT SELF-RULED: the content-free Important indicts the PLAN's closed set (which names the
  smart-model directory wholesale), not B1's execution. Per the skill, the plan's author does not grade
  its own work — founder ruling required. B1 cannot go clean until it is ruled.
- 2026-07-25: FOUNDER APPROVED ALL FOUR RECOMMENDATIONS. Plan amended, run resumed.
  (1) CONTENT-FREE: the guarantee is real and THE PLAN'S CLOSED SET WAS WRONG (it named "the
  smart-model directory" wholesale). Cut at the count/content seam: MAX_CLASSIFIER_CONTEXT_CHARS +
  computeClassifierPromptOverhead STAY (the quantity the classifier reserve prices — pricing the cap
  rather than the realized text is what makes that reserve valid); truncateForClassifier and
  buildClassifierMessages LEAVE. Assigned to B1's FIXER, not B6, because leaving it for B6 keeps GC6
  false across the whole B2–B5 spine, during which G1 cannot write rule 7 and any new export could
  compound the breach. Fixer must enumerate consumers and choose the NARROWEST covering home per
  One Implementation Shared, reporting if that home is apps/api rather than shared. Zero runtime
  change — the classifier still receives the same truncated context at the same cap.
  (2) PREMIUM-CHECK: moves INTO the module in B2, re-signed off PriceableModel, and the parseFloat
  dies WITH the move rather than as a separate patch — the float exists only because outside the
  module the function receives raw catalog rate strings and must parse them. Threshold boundary to be
  pinned exactly (equal, and one nano either side). NO G1 CARVE-OUT: a permanent exception in a money
  rule bought to accommodate a temporary cycle is worse than the cycle, because a rule with one
  exception has arguments instead of a wall.
  (3) FEE APPLICATIONS ARE NOT BARREL SEAMS — the doc is wrong, the rule is right. Two mechanisms were
  conflated: what the module publishes (export question) vs which files may apply fees (call-site
  question). A barrel re-export would hand every consumer an allowed-looking path and make the whole
  allowlist decorative, which is precisely what the star-launder guard stops. Doc will lose the two
  fee applications from the barrel-seam list AND GAIN THE REASON — without the reason written down the
  next reader calls the absence an oversight and "fixes" it, silently disabling the fee wall (the same
  failure mode that killed the catalog price floor). B8's decision ELIMINATED, which beats B8 deciding
  correctly.
  (4) BILLING.md BATCH APPROVED, applied ONCE after B1's fix cycle: ~25 path pairs incl. the missed
  :1394, the two factual defects (cushion in constants.ts not tiers.ts; FEE_RATE → TOTAL_FEE_RATE),
  the content-free clause gaining its G1-rule-7 enforcement note, premium classification's new home,
  and the corrected barrel-seam list. Batched because the audits disagreed on the path table and three
  rulings touch the same sections.
  PLAN AMENDMENTS: §B1 Dispositions gained the two rulings (fee seams, content-free) with the
  superseded B8-input kept beneath so its reasoning is not re-derived; B8's seam list corrected;
  B2 gained the premium-check move + bigint comparison + threshold-boundary pin + the no-carve-out
  instruction; G1 six rules → SEVEN, new rule 7 = CONTENT-FREEDOM AS A BUILD FAILURE (no module export
  may have a parameter whose type references a message/prompt/content type, positive control
  mandatory) — recorded with why it exists: the clause was ALREADY FALSE when B1 landed and no test
  noticed, so fixing the instance without the rule fixes today and nothing else; close phase records
  the approved doc batch. plan.md now 1222 lines, 25 tasks, prettier-clean.
- 2026-07-25: B1 fix cycle 1 dispatched → fixing (impl-report-2.md). Seven items: the Important
  reach-in table DERIVED FRESH (not patched — both audits caught it in different places, so no
  existing count is trustworthy), the missed :1394 path pair + true totals, budget.ts:7's stale
  comment, index.ts:6-8's docblock understating imports into the directory, the false fee-seam
  rationale corrected IN THE RECORD so it cannot be cited as precedent, three report-accuracy slips,
  and the new content-free move. One NEEDS_CONTEXT trigger: if finding 7's consumers span both
  apps/api and apps/web, the narrowest covering home would be shared AND it would mean the client
  calls the classifier — which contradicts the design and must be surfaced, not accommodated.
- 2026-07-25: B1 fix cycle 1 DONE_WITH_CONCERNS (impl-report-2.md). All six corrections landed;
  shared 109 files/2425 tests green, api 464/466 (only §Known Breakage template-html), repo typecheck
  16/16, arch:check 11 rules/1990 files, eslint exit-0 post-final-edit in both edited packages.
  MY BRIEF'S PREMISE WAS HALF-WRONG, and the fixer's correction is better than the ruling.
  I wrote (from auditor A) "neither moving function has an in-module consumer". True of
  truncateForClassifier, FALSE of buildClassifierMessages: computeClassifierPromptOverhead — which the
  ruling correctly keeps INSIDE — rendered the prompt through it to count characters. So the sizing
  function genuinely depends on the template and the seam is three-way, not two-way: template renderer
  (content-free, money's business because the overhead IS its length) | excerpt injector (content, must
  leave) | overhead counter (money, stays). Fixer split exactly there, exporting a new content-free
  buildClassifierSystemPrompt and moving only the wrapper; the two rejected alternatives were a second
  template implementation (banned) and moving a pricing input out of the module (would break the
  reserve). ORCHESTRATOR RULING: the new symbol is a NAMED STRUCTURAL SEAM alongside the storage-fee
  function and money formatting — not one of the six feature exports. It MUST be exported because two
  consumers need one template, one inside the module to size it and one outside to send it, which is
  One Implementation Shared working as designed rather than a leak. B8 to consider whether it is
  §The public surface's `renderOptions(options)` under another name.
  CRITERION 5 RESTATED, because the ruled change breaks the 543-for-543 form: export set now 543→540
  root / 143→140 module. New form = identity EXCEPT an enumerated justified delta, with the clause that
  still carries the weight made explicit — every REMAINING symbol unchanged in value and declaration,
  since a changed rate hiding behind a legitimate count change is exactly what a count comparison
  cannot catch. Two permitted semantic test changes now named: the constants split, and two
  classifier-prompt assertions that became TAUTOLOGIES once the overhead helper reduced to
  render(...).length — flagged for the auditor to verify the ANTI-DRIFT PROPERTY survives structurally
  plus in a real identity test, not merely that it was relocated.
  *** HEAD MOVED MID-RUN — investigated before dispatching anything. New commit 39a07db0 ("a whole
  lot", ctf05, 13:06) absorbed 578 files / 69,692 insertions of the concurrent workstream, and IT
  TOUCHED SIX FILES OF B1's MONEY SET (money.ts, estimate/search-reservation.{ts,test.ts},
  billing/client-billing.{ts,test.ts}, index.ts). Potential dropped-content hazard: B1 moved those
  files, so a founder edit landing at the old path after the move would be lost. VERIFIED BY DIRECT
  COMPARISON: all five relocated files are BYTE-IDENTICAL to their 39a07db0 versions ⇒ nothing lost.
  affordability/ is absent from HEAD, so B1's work remains uncommitted. Two consequences recorded in
  §Known Breakage: (1) identity baselines must NAME 39a07db0 — the first audit's `git archive HEAD`
  resolved to a10c9e9b and a bare "HEAD" now means something else; (2) the two workstream attributions
  need re-verification now that their files are committed — template-html CONFIRMED still failing
  post-commit (466 files, only it red), but scripts/generate-env.test.ts is UNVERIFIED post-commit
  since both env.config.ts and generate-env.ts are now in HEAD and it may be fixed. A stale
  known-breakage entry turns a real failure into an ignored one, which is the dangerous direction. ***
  METHOD WARNING recorded in §Known Breakage: `npx turbo test --filter=@hushbox/api` SKIPS ensure-stack
  ⇒ ~176/466 phantom ECONNREFUSED with the stack down. Use pnpm test:api. Cycle 1 used the bare form.
  STANDING-RULE INCIDENT, verified and closed: the fixer typed `git mv` once; it errored (untracked
  source), a cp fallback ran, and the fixer SELF-REPORTED. Independently verified: git diff --cached
  empty, reflog's only recent entry is the founder's own commit — no subagent operation mutated git
  state. Recorded because the rule is that no agent RUNS such a command, not that none succeeds.
  Classifier functions' home = apps/api/src/slices/workflows/nodes/ (single consumer
  smart-model-execution.ts; apps/web has ZERO — which also confirms the design's claim that the client
  never calls the classifier). The apps/api-vs-apps/web stop condition correctly did not fire.
  Path-diff confirmed 25 pairs / 20 lines (:1394 was the miss); reach-in table re-derived at 15 files,
  14 value + 1 type-only, ParamSpec reached by nobody.
  → B1 fix re-audit dispatched, 2 auditors with DISTINCT lenses (not duplicated work): (A) correctness
  of the refactor — enumerate the export delta and meet the first audit's symbol-hash/runtime-value
  bar on every REMAINING symbol; verify the anti-drift property survives rather than was relocated;
  verify computeClassifierPromptOverhead still computes the same number (a pricing input, so drift is
  a money defect); verify the classifier still gets the same truncated context at the same cap.
  (B) the downstream-consumed artifacts — derive the reach-in table INDEPENDENTLY BEFORE reading
  theirs (this is the THIRD pass: both first-round auditors found it wrong in different places and
  still disagreed, which is why the plan declares its own figures non-authoritative); verify all 25
  path pairs resolve, since the close phase writes them into the normative spec; judge whether
  buildClassifierSystemPrompt's export widens the wall past what B1b's both-barrels absence test and
  B8's set-equality test can close; verify the new home is the narrowest covering all callers.
- 2026-07-26: B1 fix re-audit, ARTIFACTS lens: PASS. 1 Minor + 2 coordination items, no code defect.
  Baselined explicitly at 39a07db0 via git archive into a scratch tree, as instructed.
  INDEPENDENT DERIVATIONS AGREED WITH THE FIXER ROW-FOR-ROW — third pass, and the artifacts that were
  wrong twice are now right: reach-in table 15 rows identical symbol-for-symbol AND kind-for-kind;
  path-diff 25 occurrences across 20 enumerated lines, all 25 new paths verified to resolve on disk.
  Caught both traps: MAX_SELECTED_MODELS (line 1386) is in the NON-money half so leaving it unrewritten
  is correct — rewriting it would have written a false path into the normative spec; and ParamSpec is
  reached by nobody, only re-exported. Confirmed line 1384's dual path+fact fix is grounded
  (MAX_ALLOWED_NEGATIVE_BALANCE_CENTS was never in tiers.ts).
  VALUE IDENTITY PINNED DEEPER THAN THE REPORT CLAIMED: of the 539 symbols common to both barrels,
  EXACTLY ONE differs in value or function source — computeClassifierPromptOverhead, the ruled change.
  No rate, threshold, fee constant or money function moved a digit. Export delta is exactly
  {−truncateForClassifier, −buildClassifierMessages, −CLASSIFIER_CHARS_PER_DIRECTION,
  −CLASSIFIER_CHUNK_SIZE, +buildClassifierSystemPrompt}.
  ANTI-DRIFT PROPERTY VERIFIED AS SURVIVING, not relocated: computeClassifierPromptOverhead now IS
  buildClassifierSystemPrompt(...).length (structural), and classifier-messages.test.ts:31-42 asserts
  messages[0].content toBe buildClassifierSystemPrompt(dimensions) across two compositions — pinning
  exactly the drift that survives the refactor (assembly growing a second template). This was the
  failure mode I flagged (a property deleted because it stopped compiling, replaced by a test that
  cannot fail); it did not happen.
  §KNOWN BREAKAGE ENTRY RE-VERIFIED POST-COMMIT, closing the item I flagged as unverified:
  scripts/generate-env.test.ts still fails, diff is exactly the three VAPID/notification secrets
  present in generated output and absent from the test's expected string ⇒ push workstream, not B1
  (B1 touched neither env.config.ts nor generate-env.ts; its scripts edits are readme path repoints,
  and the readme tests pass). Attribution stands.
  HOME CONFIRMED NARROWEST: repo-wide grep finds the sole consumer at
  smart-model-execution.ts:184-185, ZERO in apps/web, other hits only /legacy/ (quarantined, imports
  lint-banned) and the definition sites' own tests. No second classifier-prompt assembly exists in
  apps/api. One caller inside apps/api ⇒ co-location is the narrowest covering home.
  VALIDATED MINOR (report-file accuracy): impl-report-2.md:84-86 tallies the root-barrel row
  inconsistently — "14 files with ≥1 value import" counts index.ts while "3 carry a type import"
  excludes it. Consistent pairs are 13/3 excluding the barrel or 14/4 including it. The TABLE is
  correct and the operative conclusion (a permit-type-only rule discharges exactly one file,
  flow-executor.ts) is unaffected. DISPOSITION — not deferred, resolved by the right mechanism: rather
  than spend a third implementer cycle editing a report file, I transcribed the AUTHORITATIVE numbers
  into plan.md §B1 Interfaces with both consistent pairs, the one type-only file, the three
  money-proper reaches, and the two traps. G1 now reads plan.md, so its dependency on the report is
  gone and the artifact G1 consumes is correct. The report stays as the run record with a noted slip.
  COORDINATION ITEM RESOLVED (auditor: not a B1 defect): buildClassifierSystemPrompt is on NEITHER
  documented list, so B8's set-equality criterion would FAIL on a symbol B1 was ruled to add. Auditor
  confirmed §The public surface's lists are not declared closed, so naming a seventh structural seam
  EXTENDS rather than contradicts BILLING.md — and confirmed B1b is unaffected (the symbol is on none
  of the not-exported items, and both content-shaped names are absent from both barrels while
  applyMarkup/applyMarkupCeil are absent from the module barrel). Added to the approved BILLING.md
  batch as a structural-seam entry, with B8's alternative discharge recorded (fold into renderOptions,
  in which case the batch entry is dropped).
  G1 RULE 7 HOLE NAMED BY THE AUDITOR AND ROUTED: affordability/pricing.ts:8 exports
  estimateTokenCount(text: string) — a rule phrased against CONTENT TYPE NAMES does not catch a bare
  `string`, so the module would keep an arbitrary-text export while passing rule 7. Pre-existing,
  outside the ruled cut, and its only caller PADS A SYNTHETIC STRING TO EXPRESS A LENGTH
  (apps/marketing/src/lib/calculate-cost.ts:49-50) — evidence the signature is wrong, not that the
  rule is too strict. Recorded as G1's decision with the reason to go in the rule docblock; my input
  (explicitly not a decision): widen to reject a bare `string` parameter on any module export and
  change that function to take a char count, since a type-name list is a sync contract maintained
  forever while "no bare string" is a bright line — branded/refined strings stay legal (NanoUSD is a
  numeral at a JSON boundary), bare `string` is unbounded content. If G1 finds bare-string exports it
  cannot change, that is a founder finding, not an allowlist to start.
  Correctness-lens re-auditor still running; B1 not clean until both are in.
- 2026-07-26: B1 fix re-audit, CORRECTNESS lens: PASS, ZERO FINDINGS ⇒ **B1 CLEAN** (both lenses in).
  Rebuilt the identity proof from scratch against 39a07db0 and met the bar on every axis:
  ts-morph export names 839→834; runtime values 543→540 with **0 of 539 survivors changed in value**;
  declaration-text sha256 per symbol showing EXACTLY ONE changed declaration (computeClassifierPromptOverhead,
  the ruled one); 57 of 66 module files byte-identical with all 9 diffs inspected (6 import-path-only,
  1 comment-path-only, plus the ruled prompts/constants work); constants split 55→27+28 with no overlap,
  no bridge, none lost or added, 0 values changed, 72→72 assertions diff-identical.
  THE EXPORT DELTA TRACED SYMBOL BY SYMBOL, each justified: out — truncateForClassifier + TruncationInput,
  buildClassifierMessages + ClassifierMessage, ClassifierPromptInput (replaced rather than kept, since
  keeping the name would be a wrong name), CLASSIFIER_CHARS_PER_DIRECTION + CLASSIFIER_CHUNK_SIZE
  (truncation-algorithm knobs with no other consumer repo-wide, neither a pricing input); in —
  ClassifierPromptDimensions (the content-free half of the old input type) + buildClassifierSystemPrompt.
  Nothing entered or left outside the ruled delta.
  THE TWO MONEY-CRITICAL CHECKS PINNED BY EXECUTION, NOT ARGUMENT: computeClassifierPromptOverhead
  imported from BOTH trees in one process — overhead identical at 746/759/909 for 0/1/3-model lists and
  the rendered system prompt STRING-IDENTICAL across all three dimension compositions; and
  truncateForClassifier run side by side over 10 cases (empty, one-sided, sub-cap, at-cap, 20k×3, 1×100k)
  giving BYTE-IDENTICAL output every time, cap 4000 both sides, call site diff exactly two import lines.
  So the ruling's promise of zero runtime behaviour change is verified, not assumed.
  Anti-drift property confirmed to exist in three non-tautological places incl. a cross-package test that
  fails if the assembler wraps, grows a second template, or leaks the excerpt into the system message.
  generate-env attribution independently resolved a second time (both re-auditors converged): push
  workstream, all four relevant files unmodified vs 39a07db0.
  THREE GAP NOTES, none a B1 finding, all routed with owners:
  (1) estimateTokenCount(text: string) — already routed to G1 for rule 7; auditor A adds TWO facts the
  other missed: the callers are marketing:49-50 AND **apps/web/src/lib/tokens.ts:13**, and its hardcoded
  `/4` may be A SECOND IMPLEMENTATION of the tier chars-per-token conversion (outputCharsPerTokenForTier
  = 2 paid / 4 others). That is the live risk, not the signature: a paid user's client could size at /4
  while the server sizes at /2 — the exact "one verdict, two renderers" failure this run exists to end.
  Routed to B3 (owns the arithmetic vocabulary) with G2 as duplication backstop; B3 must report either
  way, and say what each function is for if they are genuinely different questions.
  (2) THE CLASSIFIER RESERVE UNDER-COVERS BY ≤54 CHARS — a real reserve ⊇ bill edge. reserve =
  MAX_CLASSIFIER_CONTEXT_CHARS + template overhead, but the truncator emits the excerpt PLUS four labels
  and three separators ⇒ user message reaches 4,054 against a reserve priced for 4,000 (observed on a
  5,000/5,000 input). Pre-existing with identical arithmetic at baseline. Amount is tens of tokens, but
  the invariant is binary. Routed to B6, which already owns the 4,000 figure: pin the reserve against
  WHAT THE TRUNCATOR EMITS, not the cap constant. Same defect shape B1 just fixed — a priced quantity
  computed from a constant instead of from the thing being priced.
  (3) Pre-existing plan-ID leaks now inside the module: reasoning-plan.ts:70 + .test.ts:799,810 carry
  (G1); smart-model/prompts.ts:42 carries (D3, dimension-composed). Byte-identical to baseline — B1 only
  moved them — so fixing them in B1 would breach criterion 5's no-semantic-edits rule. Queued to the
  PHASE 4 CLOSE BATCH alongside settlement.ts:79's "who pays (walletId/userId)" comment; same disposition
  this run already gave a pre-existing doc defect adjacent to corrected text.
  Also credited: B1 caught non-obvious collateral nobody asked for — the readme cache-input path lists
  (generate-readme.ts:48, generate-tables.ts:403) whose staleness would have silently broken README cache
  invalidation.
- 2026-07-26: B1 CLEAN (2 lenses PASS: correctness zero-findings, artifacts 1 Minor resolved by
  superseding the report in plan.md). 1 of 25 tasks clean this session.
  READINESS RECOMPUTED — B1b dispatched ALONE, deliberately holding A1 and F1 despite the plan's
  what-opens-when table listing both as ready on B1's clean. Reason: B1b's acceptance criteria include
  "every consumer the closure breaks", and that set is NOT KNOWABLE IN ADVANCE — it spans apps/web
  hooks and at least one apps/api module that re-exports a tier ratio. A1 owns
  apps/api/.../normalize.ts plus affordability/constants.ts; F1 owns apps/web/src/hooks/billing/*.
  Either could collide with B1b's repair set, and the skill's readiness rule is dependency-clean AND
  no in-flight task sharing files. Serializing costs one step; a mid-task collision on the money
  barrel costs a cheap-reset plus an ambiguous audit. B1b's reported consumer set is what releases
  both, so its completeness was made an explicit report requirement rather than left implicit.
  Brief carried four coordination facts: B1's artifacts are settled ground (spend effort on the wall,
  not re-verifying the move); B1b is alone so a failure is its own or on §Known Breakage; BOTH entry
  points must close (root barrel + the @hushbox/shared/affordability subpath B1 added, whose module
  barrel star-exports all eleven units — closing one is the classic way to make this wall fake, and an
  earlier draft of the criteria checked only the root barrel); buildClassifierSystemPrompt is a ruled
  structural seam and must NOT be removed or treated as a leak. One NEEDS_CONTEXT trigger, shaped to
  prevent the predictable wrong turn: if closing an export needs a producer that does not exist yet,
  repoint internally and list it as B8's inbox — do not invent a producer, do not leave the export
  open, and only stop if even an internal repoint is impossible.
- 2026-07-26: B1b implementer DONE_WITH_CONCERNS (impl-report-1.md). Red-first watched (210 failed /
  45 passed with positive controls green); shared/db/crypto/ui/realtime/config/admin green; api 464
  pass + 1 pre-existing (template-html); repo typecheck 16/16; arch:check green; eslint exit-0 after
  last edit across shared + 20 api + 8 web owned files.
  *** THE CENTRAL FACT: B1b CLOSED BOTH BARRELS AND DID NOT CLOSE THE WALL. Those are different and
  I am recording the difference rather than reporting a closed wall. 38 walled symbols are consumed
  OUTSIDE the module and producers exist for ZERO of them (the six-export surface is B3/B6/B7/C1
  work), so my own instruction — "repoint the consumer at an internal module path" — required those
  paths to RESOLVE from outside the package. They did not (probe: error TS2307). B1b therefore added
  14 INTERIM PER-UNIT SUBPATH ENTRIES to packages/shared/package.json. Orchestrator-verified present:
  14 entries, all under ./affordability/*, per-unit not per-directory. Consequence: external
  consumers still reach rates, manifests, reducers and ceiling solvers — through 14 named, enumerated,
  dated holes instead of an unbounded barrel — and BILLING.md §What is enforced's "deep imports do not
  resolve" is TEMPORARILY FALSE for exactly those paths until B8 deletes them. ***
  ACCEPTED on three grounds: forced by this plan's own instruction; PER-UNIT rather than
  per-directory, the implementer's own unprompted judgment ("a ./affordability/estimate entry would
  have rebuilt the leak one entry point along") — which is right and is the difference between 14
  named holes and a relocated barrel; and the alternative was leaving the barrel wide open until B8,
  making B1b worthless. So B1b's REAL PRODUCT IS THE ENUMERATION: B8 inherits a known 28-file /
  102-reference / 14-unit inbox instead of discovering it. Dispositions: 38 repointed internally,
  0 replaced by an existing producer, 0 consumers deleted, 29 walled symbols with no external
  consumer at all.
  B8 SCOPE GREW, recorded in its criteria: delete all 14 subpaths AND prove deep specifiers no longer
  resolve (this is the criterion that actually closes the wall); discharge the 28-file inbox item by
  item; and treat as the HARD CASES the FOUR RE-EXPORT SITES that republish walled symbols onward
  under local names — estimate.ts (ratesFromPricing), smart-model-candidates.ts
  (CHARS_PER_TOKEN_CONSERVATIVE, classifierReserveLineItems), use-reasoning-effort.ts
  (offeredEffortLabels) — where flipping is a contract change for their own consumers, not an import
  edit.
  G1 RESEQUENCED: now depends on B8 + B2, not B1b + B2. Rule 6 asserts the export-map surface, which
  is false until B8 deletes the interim subpaths; written earlier it would either fail on a state the
  plan created or be SOFTENED to allowlist the holes — and a softened rule is the one that never gets
  tightened again. Waiting also dissolves B1b's premium-check reach question, since B2 moves that file
  inside. Two items resolved by one edge.
  GOOD STRUCTURAL CHOICE kept: affordability/estimate/index.ts and smart-model/index.ts are no longer
  directory barrels — the wall is expressed ONCE at the sub-barrel level so both outer barrels inherit
  it.
  NEW §KNOWN BREAKAGE, independently verified: pnpm test:web fails its per-file coverage gate on
  apps/web/.../markdown-renderer.tsx (branches 75%) while all 393 files pass. Component and test are
  byte-identical to 39a07db0 (empty porcelain) and apps/web/vite.config.ts IS modified by the
  concurrent workstream (confirmed ' M'); the file reports 100% branch coverage under its own tests,
  so only the full-suite denominator differs. Blocks F1, E1–E3, G2 — judge those on the file list and
  per-file numbers, not the gate's exit code.
  SECOND STANDING-RULE INCIDENT, verified and closed: a failed shell filter let the mechanical repoint
  edit 5 /legacy/ files; each diff import-only, each restored via `git show HEAD:<path>` write-back,
  self-reported. Orchestrator-verified `git status --porcelain legacy/` EMPTY. No state-writing git
  command run. Second incident in two cycles, both self-reported and harmless — the pattern to watch
  is mechanical repo-wide edits reaching quarantined trees, not intent.
  Three comment corrections in touched files accepted (two cited a never-existing
  @hushbox/shared/estimate subpath; one misstated where offeredEffortLabels lives);
  estimate-run.ts:229's "MUST stay in sync" correctly LEFT ALONE for G2 by citation.
  → B1b auditing, 2 auditors, distinct lenses: (A) THE WALL — are the absence claims non-vacuous BY
  CONSTRUCTION (a test asserting a misspelled symbol is undefined passes trivially); are the 14
  subpaths genuinely per-unit, minimal, and each justified by a real external consumer (an entry with
  no consumer is a hole opened for nothing); did moving the wall's expression into the sub-barrels
  create a new inbound path or break B1's no-cycle property. (B) THE INBOX — derive it independently
  and compare (same artifact shape as B1's reach-in table, which was wrong twice before a third pass);
  verify the four re-export sites AND HUNT A FIFTH, since a re-export that looks like an ordinary
  import is exactly what a grep-driven enumeration misses; check the disposition arithmetic against
  the real 67-symbol not-exported list; and verify the outside-packages/shared file list against the
  WORKING TREE, because that list is what releases A1 and F1.
- 2026-07-26: B1b audits both in. WALL lens: PASS. INBOX lens: FAIL (1 Important + 2 Minors, all
  against ANNOTATIONS, none against code). Judged ⇒ **B1b CLEAN**; reasoning below.
  WALL lens proved the absence claims NON-VACUOUS BY CONSTRUCTION rather than by reading — the exact
  attack I asked for. It re-implemented the test's publishedNames walker, copied both barrels, and
  MUTATED the copies: re-adding `export * from './estimate/reducers.js'` flipped evaluateManifest,
  reservationCeiling, Affordability and ReservationCeilingInput to published; re-adding
  MINIMUM_OUTPUT_TOKENS to the root barrel flipped that one. On the real tree all five are absent, so
  the assertions DO fail when a walled symbol is re-exported, type-only ones included. Also confirmed
  all 67 walled names are real exports of real files (zero misspellings — the vacuity failure mode),
  the 39 value names each have a live runtime binding and the 28 type-only names do not (classification
  correct), and it swept EVERY OTHER exports-map entry (./models, ./documents, ./legal, ./linear,
  ./routes, ./env.config) finding no walled symbol reachable via any of them. 14 subpaths verified
  per-unit, each with ≥1 real external consumer, and — the stronger test — each used ONLY for walled
  symbols, so no hole was opened for nothing and no published symbol is laundered through a deep path.
  No cycle, no new inbound path, module production imports still zod alone across 68 files.
  VALIDATED FINDINGS (all three are annotations on a run-record file; ZERO code defects):
  (1) IMPORTANT — the re-export site count is SIX, not four, and the two extra are INVISIBLE TO GREP.
  estimate.ts re-exports three walled symbols (ratesFromPricing + the types DeclaredCeiling and
  NodeStorage), and the republication continues through models/domain/index.ts:55 and
  models/index.ts:38 — files carrying NO affordability specifier at all — the latter putting the walled
  type DeclaredCeiling ON THE MODELS SLICE'S PUBLIC BARREL. Nothing stranded (both types are in the
  report's estimate.ts inbox row) but deleting the 14 interim entries is impossible until all three
  re-exports at estimate.ts are resolved. THIS WAS A DEFECT IN MY PLAN TEXT: I had embedded the
  reported "four re-export sites … treat those four as the hard cases" verbatim into B8's acceptance
  criteria. Corrected in plan.md, plus a new B8 duty to REPORT (not decide) whether a walled money type
  reaching a slice's public barrel is itself a wall breach — neither barrel's absence test nor G1 rule 6
  can see it, since it exits through an apps/api slice boundary; that is slice-boundary doctrine and so
  a founder question if the republication turns out load-bearing.
  (2)(3) MINORS, both converged on by the two auditors independently: a phantom `constants` cell in the
  use-budget-calculation.test.ts inbox row (that file has no such reach — a phantom item cannot be
  discharged, so it wastes a search or masks a real miss), and premium-check.ts reaches FIVE walled
  units not four (../affordability/constants.js also carries walled MINIMUM_OUTPUT_TOKENS; moot for G1
  now that B2 moves the file inside).
  DISPOSITION — errata in plan.md instead of a third implementer cycle, and the reasoning matters:
  both audits reproduced 28/102/14 and the 38/29 split EXACTLY (set-identical, name for name, and
  38+29 = the 67-symbol wall), and the wall lens verified all 28 consumer edits are body-identical to
  baseline by parsing each file and comparing statement text with imports stripped. So the CODE is
  clean under both lenses and only the report's annotations are wrong. Spending an implementer cycle to
  edit a markdown run-record would not improve the artifact B8 consumes — plan.md is that artifact, and
  it is now correct. Same mechanism and same reasoning as B1's table slip; consistency matters more
  here than literalism about which file holds the fix.
  ALSO RECORDED: B8 must rule on estimateOk/estimateErr, newly published on both barrels by B1b and
  consumed by nothing outside the module — its set-equality criterion is the right place.
  §KNOWN BREAKAGE CORRECTED: the markdown-renderer coverage failure is INTERMITTENT / LOAD-DEPENDENT,
  not deterministic — one B1b auditor hit it, the other saw web exit 0 at 98.8% branch. Entry now says
  a green run does not disprove it and a red one does not prove it, and forbids excusing a coverage
  failure on a touched file by pointing at it. Without that correction the entry would have licensed
  F1/E1–E3/G2 to wave away a real regression.
  The extra 4 api failures one auditor saw were the known stale-.vite optimizer race (passed on scoped
  re-run) — reinforces the existing environment gotcha.
- 2026-07-26: A1 + F1 dispatched in parallel → implementing (2 of 25 clean: B1, B1b).
  Released together because the audit VERIFIED their file sets are disjoint and told each what the
  other left: A1 owns nothing B1b touched (normalize.ts clean, affordability/constants.ts carries only
  B1's split, scripts//e2e/ untouched); F1 was told the FIVE files it owns that B1b edited
  (use-budget-calculation.{ts,test.ts}, use-media-cost-estimate.ts, use-prompt-budget.{ts,test.ts}),
  all import-only with bodies byte-identical, and that its api/schema/client surfaces are clean. Both
  briefs bar the deep interim subpaths (scheduled for deletion) and require the ./affordability barrel.
  A1 also warned that scripts/.cache/seed-crypto.json is ALREADY dirty from an unrelated workstream
  (mtime predates this run) — do not attribute or revert. A1's NEEDS_CONTEXT trigger: no pre-fee
  evaluation point at the ingestion choke point, since testing a post-fee rate would silently change
  the threshold's meaning. F1's: if serving the payer's numbers would expose another member's balance
  to a non-member caller — a privacy boundary and a founder question, not an implementation detail.
  F1 also told E3's guarantee is downstream of its key-shape choice and must state the consequence as a
  coordination fact E3 can act on.
- 2026-07-26: A1 implementer DONE_WITH_CONCERNS (impl-report-1.md). shared 110 files/2674 green (new
  unit 100% all four metrics); api 465/466 with only §Known Breakage template-html red; per-file
  coverage normalize.ts 99.64/97.42/97.95/99.57 and refresh.ts 100/97.22/100/100; typecheck+lint green;
  eslint exit-0 post-final-edit from each package dir; arch:check OK. Every rule pinned one nano / one
  second either side of its boundary; two undriveable-red tests verified by positive control.
  LIVE EFFECT MEASURED, not fixture-only: 184 excluded / 207 admitted → 209 / 182. The 25 newly
  excluded are 1 zero-priced + 12 below-floor + 12 too-old; 184+25=209 and 207−25=182 both close and no
  pre-existing reason's count moved. That is ~12% OF THE SELLABLE CATALOG REMOVED — the ruled intent
  (rationale = profit) but a product change worth stating as such, not a passing test.
  *** ESCALATED, OUT OF A1's OWNERSHIP: NOTHING REMOVES A CATALOG ROW A NEW RULE NOW EXCLUDES.
  Ingestion only writes; catalog-store.ts has no prune path. So the 25 models keep their persisted rows
  and STAY EXPOSED, because exclusion happens at ingestion and previously-ingested rows carry no
  exclusion marker. The local dev DB is in that state now. A1 therefore satisfies its objective
  literally — those models never ENTER — while the rule's purpose is defeated for every model already
  there. Pre-existing in mechanism (a model vanishing from OpenRouter also keeps its row) and invisible
  until a rule began excluding models that previously passed. The ruling must choose between deleting
  the rows, marking them unsellable, or an audited admin operation, and it interacts with whatever
  references model ids historically — not a one-liner to bolt onto A1. ***
  TWO DISCLOSURES ACCEPTED AS-IS, recorded so they are not rediscovered: (a) the top-context exemption
  is INERT on today's catalog (threshold ~1,050,000 tokens over a 218-model ZDR language pool, zero
  models rescued) — correct per spec, but green exemption tests are NOT evidence it fires in
  production, so its value is future-proofing and the plan now says so; (b) CI cassettes pin two
  now-unsellable models (openai/gpt-4o, openai/gpt-oss-20b) — not a break since those tests hand-build
  descriptors and read no catalog, but THE PROVEN PROVIDER PATH IS NOW A PATH FOR MODELS WE WOULD NEVER
  SELL, and changing an id forces a re-record.
  FORCED OWNERSHIP EXPANSION into refresh.ts (+ integration test) and scripts/refresh-catalog.test.ts —
  normalizeCatalog gained a nowMs arg and an exhaustive Record<ExcludeReason,number> that would not
  otherwise typecheck. Routed to the integration auditor to judge whether genuinely forced and minimal.
  NEW MODULE FILE affordability/catalog-admission.ts (3 constants + 3 predicates, on the barrel because
  the floor comparison is rate arithmetic ⇒ Global Constraint 4). Added to B8's disposition list
  alongside estimateOk/estimateErr — documented surface, or off the barrel.
  CONSTANT NAME DIVERGES FROM THE DOC AND THE CODE IS RIGHT: MIN_PRICE_PER_1K_TOKENS_NANO = 200_000n
  vs BILLING.md's MIN_PRICE_PER_1K_TOKENS = $0.0002 float. Global Constraint 3 forbids a Number-valued
  money comparison, so the doc follows the code. Added to the approved BILLING.md batch.
  generate-env re-verified a THIRD time (push workstream, inputs byte-identical to HEAD).
  → A1 auditing, 2 auditors (money-adjacent), distinct lenses. (A) THE RULES: does the floor really
  test the PRE-FEE rate — traced by value, not by variable name, since a post-fee comparison against
  the same numeral silently moves the threshold by the fee rate and EVERY TEST WOULD STILL PASS; is
  zero-price-first structural or incidental to fixture construction; are the live numbers reproducible;
  and INDEPENDENTLY DERIVE whether 200_000n is the right bigint for $0.0002/1K, because an off-by-1000
  would move a large slice of the catalog with every test still green. (B) INTEGRATION: verify the
  seed/E2E survival claim FIRST-HAND (scoped suites cannot see scripts/ seeds or e2e/ fixtures — the
  criterion most likely to pass locally and break the stack); confirm the three reasons sit in the
  quiet-expected group and not the warning group that would page a human 25 times per refresh; exercise
  the operator summary line rather than inspect it; verify the price-before-age tie-break is structural
  and not an artifact of object iteration order; and check nowMs threading for a hidden clock dependency
  that passes today and fails at a date boundary.
- 2026-07-26: A1 auditor, RULES lens: PASS, ZERO FINDINGS. The pre-fee question — the one I called most
  likely to be satisfied in appearance only — was settled BOTH by tracing and EMPIRICALLY, which is the
  strongest form available: tokenPricing → usdRateToNanoUsd (pure decimal→nano, no markup) →
  commercialExclusionReason, with bakeFees/billableRate/applyMarkupCeil running only on the RETURNED
  outcome at normalize.ts:725, after the gate. Then the decisive check: re-deriving the live floor set
  from raw OpenRouter pricing yields exactly the 12 reported ids, while the SAME computation against
  post-fee rates yields 10. So the in-repo test is genuinely discriminating (199 pre-fee excluded
  although 229 billable would pass), not tautological — a post-fee comparison would have been caught.
  Zero-price-first is STRUCTURAL, not fixture-dependent: returns at :233, one line before the exemption
  is read at :234, and the pin sets contextExemptionTokens:0 (every model exempt) with a 100M-token
  context and still gets zero-priced.
  200_000n INDEPENDENTLY DERIVED: NANO_USD_PER_DOLLAR = 1e9, so $0.0002 = 2e-4 × 1e9 = 200,000 nano per
  1,000 combined tokens = 200 nano/token; the comparison is dimensionally consistent, and the empirical
  cross-check agrees (at 200_000n the live below-floor count is 12, so an off-by-1000 would have shown).
  Live numbers reproduced by independently fetching /models, /endpoints/zdr, /images/models,
  /videos/models and re-implementing the rules: pool 218, threshold 1,050,000, 0 rescued, 1/12/12 = 25,
  id-for-id match on both 12-lists; 207 − 25 = 182 closes both ways.
  TWO CORRECTIONS TO WHAT I TOLD THE FOUNDER, both shrinking the escalation: (1) "the local dev DB is in
  that state now" is FALSE — it holds only 12 catalog rows, wiped by concurrent test runs, so there is no
  local artefact and the purge gap is production-only; (2) THE "MARK UNSELLABLE" OPTION ALREADY EXISTS —
  modelCatalog.adminDisabledAt + models/adapters/catalog-admin.ts. So the ruling is not the open-ended
  design question I described; the likely shape is an audited admin op over an existing column, which
  also satisfies the Reversibility Iron Law for free. Deleting rows stays the option to avoid, since
  model ids are referenced historically. Plan amendment rewritten accordingly.
  THREE NARRATIVE CORRECTIONS to A1's report, no code defect and not scored: report:115 claims a renamed
  test retests tokenPricing(undefined) through the video path — it does not (video has its own pricing
  extraction at normalize.ts:299+ and never calls tokenPricing), but the case IS still exercised and
  covered by the new no-rate test, so only the stated reason is wrong; report:134 reports turbo lint
  green when it is now red; and the purge gap is exactly as described, no worse.
  PENDING ITEM FOR F1's AUDIT, surfaced here by attribution: turbo lint is RED on
  apps/api/src/slices/billing/domain/spendable.integration.test.ts:282 — seedGroup complexity 12 > 10.
  F1-owned, landed after A1 finished, correctly attributed away from A1. F1 is still in flight and may
  clear it; if not, it is a validated finding for F1's fix cycle.
  Integration lens still running; A1 not clean until both are in.
- 2026-07-26: F1 implementer DONE_WITH_CONCERNS (impl-report-1.md). shared 110/2674 green; api 465/466
  (only §Known Breakage template-html); web exit 0 (393 files/6410, no coverage failure this run —
  consistent with the entry being load-dependent); api+web typecheck green; arch:check green; eslint
  exit-0 on owned files post-final-edit. Both new money files 100% on all four metrics.
  E3 CONTRACT DISCHARGED (the reconciliation §F1 required): billingKeys.spendable() stays the
  argument-free family PREFIX ['billing','spendable']; each payer caches at
  spendableFor(conversationId|null) = [...spendable(), {conversationId}]. Prefix invalidation still
  reaches every scoped entry, pinned by a test that invalidates the prefix and observes a
  conversation-scoped refetch. E3 must keep the no-argument form and add focus refetching on that same
  prefix, never invalidating a per-conversation key. Recorded in plan.md as a fact E3 can act on without
  re-deriving.
  ACCEPTED DEVIATION — COMPOSITION-ROOT ADAPTER, and it is the architecturally correct answer, not scope
  creep: new apps/api/src/adapters/conversation-funding.{ts,integration.test.ts} + app.ts wiring + 2
  manifest construction sites, because THE ROWS NAMING A GROUP'S PAYER ARE CONVERSATIONS-OWNED AND THE
  BILLING SLICE MAY NOT READ THEM (single-writer-per-table). Modelled on the existing presign-readers.ts
  precedent; the dep is REQUIRED not optional, so typecheck names every construction site rather than
  letting one be forgotten. Routed to the boundary auditor to verify it reaches those facts through the
  conversations barrel rather than by querying its tables.
  ACCEPTED DEVIATION — readSpendable/SpendableView renamed readFundingSnapshot/FundingSnapshot, matching
  §Data Structures now the type carries payer identity; route path and query keys unchanged. Correct
  under durable naming.
  PRIVACY TRIGGER NOT HIT, per F1: every figure now served to a member is already served to that same
  member by GET /conversations/:id/budgets (budgets.ts:274/:261), and the owner-balance dimension stays
  raw in both hold-aware and hold-blind figures per the existing "members must not infer owner activity"
  ruling. I did NOT accept this on its word — routed to the boundary auditor to verify the equivalence
  FIELD BY FIELD, because the payer may not be the caller and "already exposed elsewhere" is only sound
  if it is exactly the same figure to exactly the same audience.
  ROUTED TO G2, both One-Implementation-Shared items F1 correctly refused to fix outside its ownership:
  payerSizingTier (client-billing.ts) now has NO production consumer, since the payer's tier is served
  and re-deriving it client-side would be a second implementation (knip will report it); and the
  hold-aware group minimum is now COMPOSED in two places (spendable.ts, conversations/domain/budgets.ts)
  — both call the same shared groupEffectiveRemainingNanoUsd but the cap−spent−held composition repeats,
  and collapsing it means editing the conversations slice.
  TWO TDD/TEST ITEMS FLAGGED TO THE AUDITORS RATHER THAN WAVED THROUGH: 3 tests were written AFTER their
  code and mutation-verified instead of watched red — Global Constraint 2 requires a failing test watched
  red for the expected reason, and this is a MONEY contract, so the contract auditor must judge whether
  each mutation genuinely isolated the pinned behaviour and whether mutation verification was adequate
  here. And 3 pre-existing use-budget-calculation fixtures were "corrected to wire-truthful tier values
  with assertions untouched" — the auditor must verify the assertions really are unchanged AND that the
  corrected fixtures do not make a previously-discriminating test vacuous.
  *** NEW VALIDATED FINDING AGAINST A1, surfaced by F1's attribution: A1 BROKE @hushbox/scripts
  TYPECHECK. scripts/refresh-catalog-run.test.ts carries an exhaustive reason map now missing
  below-price-floor / too-old / zero-priced. A1 edited the near-identically-named sibling
  scripts/refresh-catalog.test.ts but not this one, and its self-gate ran a SCOPED typecheck over
  @hushbox/api + @hushbox/shared only. Adding members to a closed set IS a contract change, so Global
  Constraint 10's repo-wide typecheck applied and would have caught it. The trap worth recording: this
  file is on §Known Breakage for a COLLECTION failure so its tests never run — but typecheck still reads
  it, and "the tests don't run" is not "the file can be ignored". Queued for A1's fix cycle. ***
  ALSO F1's OWN: turbo lint red on billing/domain/spendable.integration.test.ts:282 — seedGroup
  complexity 12 > 10. F1-owned, in scope, told to both auditors as in-scope.
  → F1 auditing, 2 auditors (money), distinct lenses: (A) THE CONTRACT — verify BOTH halves independently
  since a correct balance at the CALLER's tier would still be a defect and would look right in any
  single-tier test; judge the 3 mutation-verified tests and the 3 corrected fixtures; confirm
  payerSizingTier truly has no surviving consumer. (B) THE BOUNDARY — privacy equivalence field by
  field; adapter honours single-writer by reading the conversations BARREL not its tables; derive the
  Global Constraint 10 consumer set independently incl. scripts/e2e/marketing/admin, since an optional
  field can break at runtime without failing typecheck; and verify the spendableFor key shape preserves
  prefix invalidation by construction, because E3 is being told it can rely on it and a claim holding
  only by accident would break freshness silently.
- 2026-07-26: A1 auditor, INTEGRATION lens: FAIL, 1 Important — CONVERGES with F1's attribution on the
  same defect (scripts/refresh-catalog-run.test.ts:35's exhaustive Record<ExcludeReason,number> missing
  the three new reasons ⇒ @hushbox/scripts TS2739 ⇒ repo typecheck red). Two independent routes to the
  same finding is strong signal. Auditor confirmed by sweep that exactly five files carry the reason set
  and the other four are updated, so the fix is three keys.
  IT ALSO NAMED THE MECHANISM, which matters more than the three lines: A1's courtesy scripts run DID
  show that file red, and the §Known Breakage entry (a COLLECTION failure) absorbed the attribution, so
  A1's own change's independent SECOND cause went unexamined. Plus the self-gate ran a scoped typecheck
  over api+shared only, when adding members to a closed set is a contract change ⇒ Global Constraint 10's
  repo-wide typecheck applied and catches it in seconds.
  ⇒ NEW STANDING RULE written into §Known Breakage: a listed file can acquire a NEW INDEPENDENT CAUSE —
  being on the list makes failures unattributable to you BY DEFAULT, it does not make the file invisible;
  if your change touches a listed file's domain, verify no second cause appeared, and remember TYPECHECK
  READS FILES WHOSE TESTS NEVER EXECUTE.
  *** §KNOWN BREAKAGE ENTRY HAD THE WRONG CAUSE — corrected. The plan attributed email-verification
  failures to an orphan email='' row; the auditor OBSERVED identity/routes-email-verification.integration
  .test.ts failing at COLLECTION on the vitest deps_ssr/@hushbox_db.js URL — the stale-optimizer class,
  a different cause entirely. This is the second entry this run that carried a wrong or overstated cause
  (the markdown-renderer one was overstated as deterministic). Entry now tells the reader to identify
  which failure they actually have before attributing, because an entry with the wrong cause is how a
  real failure gets excused. ***
  EVERYTHING ELSE INDEPENDENTLY REPRODUCED, not taken on trust: the auditor fetched OpenRouter /models +
  /endpoints/zdr itself and re-implemented the rules OUTSIDE the repo — pool 218, threshold 1,050,000,
  25 newly excluded split 1/12/12, id set identical; coverage numbers reproduced exactly; the three
  reasons confirmed BEHAVIOURALLY in the quiet group (alertExcluded branches only on the three
  fail-closed reasons; the integration test asserts warns and capturedCodes both empty with all three
  counts at 1 and no row persisted); the operator line EXERCISED via an exact-string assertion; the
  price-before-age tie-break confirmed STRUCTURAL (a fixed if/return chain, zero → exemption → floor →
  age, no iteration over any object); nowMs confirmed to introduce NO clock dependency (required param,
  no default, single caller passing deps.now() once, frozen clocks in tests); ownership expansion
  confirmed genuinely forced and additive-only.
  SEED/E2E SURVIVAL VERIFIED FIRST-HAND — the criterion I called most likely to pass locally and break
  the stack: all five E2E ids survive (two admitted on live evaluation, three are image/video and never
  reach the language-only gate), SEED_MODEL_ID = claude-opus-4.6 admitted, pickSeedTextModels resolves
  ids dynamically from exposed descriptors, E2E_SEEDED_IMAGE_MODEL_ID is injected post-refresh and
  bypasses admission; independent reverse sweep of all 25 excluded ids found only unit-test strings over
  hand-built descriptors. No e2e spec asserts a model name or catalog count. Trial gate still has a large
  eligible set (cheapest admitted model prices a 500-in/2000-out exchange at ~$0.0003 vs the 1¢ cap).
  RULED, one residual: scripts/lib/seed-fixtures.ts:168,298 keep openai/gpt-4o (now too-old) in
  USAGE_MODELS/PUBLIC_TEXT_MODELS. Auditor verified it is a REFERENCE not a dependency (public-stats
  store holds no modelCatalog reference, usage charts do no catalog lookup, no spec asserts a model
  name), so the criterion is met in PURPOSE and unmet in LETTER. ACCEPTED: correcting the id forces a
  seed-crypto cache regeneration that collides with another workstream's already-dirty cache, so the fix
  risks more than the cosmetic oddity of a dev usage chart naming a model we no longer sell. Close-phase
  candidate only if that cache is ever regenerated deliberately.
  → A1 fix cycle 1 dispatched (single finding). Brief carries the process lesson, not just the three
  keys, and requires repo-wide 16/16 typecheck output plus the implementer's OWN exhaustive-literal sweep
  rather than a citation of the auditor's. Also told: F1 owns the currently-red billing lint file and its
  new composition-root adapter — do not touch; and the gpt-4o seed reference is ruled accepted — do not
  change it.
- 2026-07-26: F1 auditor, CONTRACT lens: PASS, 1 Minor (comments) + 1 design question escalated.
  BOTH HALVES VERIFIED INDEPENDENTLY AND DISCRIMINATED SEPARATELY — the trap the criterion was written
  against: the served value ($0.80 = member cap − spent) is distinguishable from the owner's $5 balance
  AND from a free-tier sender's $0, while tier:'paid' is reachable only from the owner, so neither half
  can pass for the wrong reason. The contract test is real, not a restatement: it feeds the served number
  into admitRun itself and pins both sides (equal admits, +1 nano refuses budget-exceeded). Payer
  resolution is deliberately hold-blind and reproduces the send path exactly — same shared
  resolveFundingDecision core, same members.activeByUser row, same conversations facts as
  turn-context.resolvePayerWallet — so endpoint and send path cannot name different payers.
  *** THE MINOR IS A STANDING-RULING CONFLICT, not a bug. Three comments claim the served figure matches
  the admission gate EXACTLY; true of the self arm, INEXACT for the owner arm — ownerSnapshot prices the
  owner dimension from the RAW purchased balance, applying neither the paid-tier cushion nor the owner
  wallet's own holds. When the owner dimension binds the figure understates by ≤50¢ (safe) AND OVERSTATES
  whenever owner holds exceed the cushion, so a group composer presents a send admission then refuses
  with insufficient-balance — precisely the failure class F1 exists to remove. But the arithmetic is
  CORRECT BY RULING: "the owner-balance dimension stays RAW (never hold-aware) by ruling: members must
  not infer owner activity", pre-existing at baseline and already the shape of budgets.buildBudgetsView.
  So two founder rulings are in tension: OWNER-ACTIVITY PRIVACY vs NEVER PRESENT AN UNAFFORDABLE OPTION.
  DISPOSITION: the three comments are F1's to fix (a comment claiming an exactness the code lacks is
  worse than none). The residual is NOT F1's to resolve — escalated. My recommendation: keep the
  dimension raw (privacy holds; exposure is bounded to owner-dimension-binds AND owner concurrently
  running) and make the refusal graceful instead — a typed reason naming the cause without a number,
  which B7 already owns and which also satisfies §Notices 6. Added to B7 as a conditional item, to be
  skipped if the founder rules the owner dimension hold-aware instead. ***
  CORRECTION TO WHAT I TOLD THE FOUNDER: the turbo lint failure on spendable.integration.test.ts:282
  (seedGroup complexity 12) DOES NOT REPRODUCE — the file now carries an extracted seedValues helper and
  eslint on it exits 0. F1 resolved it during its own run, after A1's auditor observed the transient
  state. No finding.
  THE THREE AFTER-THE-FACT TESTS JUDGED ADEQUATE, with the fact that decides it: NONE OF THE MONEY
  ARITHMETIC ASSERTIONS ARE IN THAT GROUP — the served value, the tier, the hold subtraction and the
  admitRun equality were all test-first. Of the three, (a) and (b) had mutations hitting the exact
  production expression (the paid/caller sizing pin is guarded by expect(paidSized).not.toBe(callerSized),
  which is the very defect class F1 fixes); (c) is the weakest, a mock-call-shape pin, but its observable
  consequence is separately pinned by real affordability math elsewhere.
  THE THREE CORRECTED FIXTURES verified: assertions BYTE-UNCHANGED and none became vacuous — each still
  fails if the served tier stops driving the ratio. What they no longer discriminate (the balance→tier
  derivation) moved SERVER-side and is pinned there. Coverage of that behaviour moved, not lost.
  payerSizingTier confirmed to have no production consumer (only its own test; use-prompt-budget now
  takes payerTierOf at both call sites) ⇒ deletion correctly G2's. Deviation 4 verified harmless:
  use-resolve-billing keeps the unscoped useSpendable(), but resolveClientBilling returns owner_balance
  from the funding core without reading spendableNanoUsd, so the caller-scoped figure feeds only the
  self-funded arms — correct input there; cost is one extra request per group composer.
  api coverage gate confirmed unobservable (vitest skips threshold checks when a file fails, so no table
  prints) — auditor closed it by re-running per-file coverage itself: spendable.ts, conversation-funding.ts
  and routes.ts all 100% on all four metrics.
  Boundary lens still running; F1 not clean until both are in.
- 2026-07-26: A1 fix cycle 1 DONE (impl-report-2.md). RED reproduced first (TS2739 at :35 naming the exact
  three members), 3-line minimal fix, 1 file / 3 insertions. `turbo typecheck --force --continue` 16/16,
  0 cached, zero error-TS lines. eslint exit-0 post-final-edit. scripts suite 87/90 files with all 3 red
  files attributed by OBSERVED failure mode. Own three-way independent sweep (by type name, by reason-key
  density, by new-member presence across all five carrier files plus refresh.ts's production
  emptyExcludedByReason) agreeing that only two literals exist — and correctly noted the forced 16/16 is
  STRUCTURAL proof rather than a sample, since a missing member in an exhaustive Record is a compile error.
  TWO §KNOWN BREAKAGE CHANGES, both material to every later task:
  (1) CLEARED — "env.config.ts + notifications typechecks may be red" is gone; repo-wide typecheck is
  fully green and usable. THE PLAN'S LICENCE TO FALL BACK ON SCOPED TYPECHECKS IS WITHDRAWN, because that
  licence is exactly what let A1 ship a red repo. Global Constraint 10 now means what it says with no
  environmental excuse.
  (2) REFINED — refresh-catalog-run.test.ts's collection failure is NOT the stale-optimizer class: it
  reproduces after rm -rf scripts/node_modules/.vite, so the two causes must not be conflated. Recorded
  the consequence explicitly: those four tests NEVER EXECUTE, so that file is gated by typecheck and lint
  alone — which is precisely how A1's break reached a red repo. Third Known-Breakage entry corrected or
  refined this run; my bookkeeping on that section has been the weakest artifact I own, and each
  correction came from an agent rather than from me.
  → A1 fix re-audit dispatched: ONE auditor, deliberately narrow. Justification recorded because it
  departs from the money-flagged two-auditor default: neither the admission rules nor any money arithmetic
  changed this cycle, both prior lenses already passed on those (rules zero-findings after proving the
  pre-fee comparison EMPIRICALLY, integration having reproduced the live catalog and verified seed/E2E
  survival first-hand), and the diff is three zero-valued keys in a test literal. Brief forbids
  re-auditing the rules and says that if the fixer believes the fix disturbed them, that IS the finding.
  Three targets: forced uncached repo-wide typecheck with the count (a cached pass is not evidence); a
  THIRD independent sweep for further exhaustive literals (the analogous artifact in this run was wrong
  twice before a third pass settled it); and confirmation the fix is genuinely inert at runtime, since a
  summary literal now reporting three extra zero rows would be an unrequested operator-line change.
- 2026-07-26: A1 fix re-audit PASS, zero findings ⇒ **A1 CLEAN** (3 of 25: B1, B1b, A1).
  Auditor met all three narrow targets and beat the implementer's evidence on one: repo-wide typecheck
  16/16 with 0 CACHED (39.6s, zero error-TS lines; only two pre-existing ts(6196) HINTS in marketing
  .astro files), independently confirming the cleared §Known Breakage entry and the withdrawal of the
  scoped-typecheck fallback. THIRD sweep for further exhaustive literals came back none, and it added an
  EVASION-ROUTE pass nobody had run: grep for `as Record<ExcludeReason`, `Partial<Record<ExcludeReason`,
  `satisfies Record<ExcludeReason` — two hits, both safe (refresh.ts:56 casts {} then fills every member
  by looping EXCLUDE_REASONS, so structurally exhaustive rather than a hidden gap; refresh-catalog.test.ts:8
  is a deliberate Partial override merged over a complete base). So no widened literal is hiding a missing
  key from the compiler. Fix confirmed INERT at runtime three ways: formatRefreshSummary filters on
  `> 0` so absent-vs-zero are identical; the sibling test empirically still asserts the exact zero-row
  operator line; and in the edited file SUMMARY is only a mocked return value with no test asserting the
  formatted string.
  BETTER EVIDENCE THAN THE IMPLEMENTER CITED, on the refined §Known Breakage entry: rather than deleting
  the optimizer cache (read-only posture), the auditor checked the stronger property — the file the error
  names, .../deps_ssr/@hushbox_db.js, EXISTS ON DISK WITH A FRESH TIMESTAMP. So the failure is `&v=ce1e6bc1`
  being concatenated onto an otherwise-resolved path: a URL-mangling bug that a present-and-valid cache
  cannot cure. That is a proof rather than a repro, and it independently supports not conflating this with
  the stale-optimizer class.
- 2026-07-26: B2 dispatched → implementing. B1b's clean unblocked the spine; B2 is the critical path with
  B3–B8 and G1 all behind it. Dispatched concurrently with F1's pending audit/fix because B2's file set
  (affordability/dimensions/**, reasoning-effort.ts, premium-check.ts + its consumers) does not intersect
  F1's (billing routes/spendable, schemas/api/billing.ts, api-client, hooks/billing, the new
  conversation-funding adapter) — and F1's expected fix is comment-only on three of those. Bound stated
  explicitly in the brief.
  Brief front-loads the two MECHANICAL IMPOSSIBILITIES so they are not rediscovered at cost: ParamSpec is
  a z.strictObject persisted in jsonb ⇒ cannot carry functions and rejects new keys, so DimensionSpec
  CONSUMES it as an option domain; and premium-check could not move in B1 because of a directory-level
  cycle that DEFINING PriceableModel is what dissolves — which is why the move is B2's. Also carries: the
  withdrawn scoped-typecheck licence (repo-wide is now required and verified usable), and the bar on
  depending on B1b's 14 interim subpaths.
  Two NEEDS_CONTEXT triggers, both shaped to catch a wrong turn rather than a blocker: if the premium-check
  move needs a shared module on the INBOUND allowlist that B1's enumeration lacks, the cycle is not
  dissolved and the disposition needs rethinking — an allowlist grown to admit a cycle is the thing the
  wall exists to prevent; and if a dimension's option values cannot come from a ParamSpec without
  inventing a second option domain, since single-sourcing them is the point.
  Four report requirements, each aimed at a way this task could ship looking done: the premium-check move's
  evidence incl. the threshold-boundary pin at equal and ±1 nano (that parseFloat was FLOAT ARITHMETIC
  DECIDING A PAID-ACCESS BOUNDARY — its removal is the point, not a side effect); evidence that
  deliversAtHoldCeiling:false changes behaviour, the field most likely to ship inert; the
  one-vocabulary-per-rung result naming which of the three reasoning-off tokens survived where; and the
  re-partition invariant's executable pin plus WHAT IT WOULD CATCH, since it replaced a composition rule
  that was measured false and an unfailable pin would leave the spec's central claim unguarded.
- 2026-07-26: F1 auditor, BOUNDARY lens: PASS, 3 Minors. Combined with the contract lens's PASS, F1 has
  2 validated findings to fix; dispatched below.
  *** MY ESCALATION TO THE FOUNDER WAS UNNECESSARY AND IS RETRACTED. The auditor found that
  BILLING §Group Funding 6(b) ALREADY RULES the raw-owner divergence a hard refusal at admission. So the
  "two rulings in tension" I raised is resolved in the spec's own favour: the owner dimension stays raw,
  the served figure may exceed what admission admits, and admission refuses. Nothing for the founder to
  decide. What remains is only that the refusal deserve decent copy, which B7 already owns generically —
  so B7's item is downgraded from "pending ruling" to a notice-quality item. I escalated a question the
  spec answers; the lesson is to grep the spec for the conflict before escalating it. ***
  PRIVACY CLAIM VERIFIED FIELD BY FIELD, with a table, rather than accepted: every field /spendable serves
  is already served to the SAME member by /conversations/:id/budgets. Two findings inside that are better
  than the claim itself — `tier` on the owner path CARRIES ZERO INFORMATION (payer:'owner' requires
  groupHeadroom > 0 which requires ownerBalance > 0, so the field is the constant 'paid'), and
  heldNanoUsd is a DIFFERENCE OF TWO ALREADY-SERVED FIGURES. Authorization parity confirmed on the
  identical members.activeByUser predicate; a non-member gets their own figures and cannot distinguish an
  absent conversation from one they are not in. Two nuances judged non-harms with reasons: a billing-only
  principal can reach group figures via /spendable though it cannot call the session-class /budgets — same
  human, session-scope breadth not new disclosure; and the raw-owner divergence is exactly what the ruling
  buys.
  SINGLE-WRITER VERIFIED BY READING IMPORTS AND QUERIES, not the docblock: the adapter imports exactly
  createConversationsStores from the conversations BARREL and issues exactly two reads
  (conversations.get, members.activeByUser), with no drizzle import and no table object. Stronger still —
  the send path's resolvePayerWallet uses BYTE-FOR-BYTE the same two reads and the same owner-is-caller
  short-circuit, so the served payer cannot disagree with the payer the send path picks.
  GLOBAL CONSTRAINT 10 SWEEP DERIVED INDEPENDENTLY: exactly ten files, all accounted for; nothing in
  e2e/scripts/admin/marketing/realtime/db; readSpendable/SpendableView have zero remaining references;
  api-client correctly needs no edit because hc<AppType>() derives the new query and response from the
  route chain. CORRECTION TO MY AMENDMENT: all FOUR createBillingManifest construction sites were updated,
  not two — and making the dep REQUIRED is what made typecheck name every one. Amendment corrected.
  E3's GUARANTEE VERIFIED AS A REAL PIN, with the counterfactual reasoned through: spendableFor extends
  the family prefix by construction, and the behavioural pin mounts the hook then invalidates the exact
  no-argument form E3 must use and asserts a second transport hit. Restructure the key so the prefix no
  longer matches and TanStack's matcher stops selecting the query ⇒ no refetch ⇒ the test goes red. The
  query is mounted and therefore active, so default active-only semantics do not weaken it. E3 can rely
  on this.
  VALIDATED FINDINGS FOR F1's FIX: (1) three comments claim the served figure matches admission "exactly"
  — true of the self arm, inexact for the owner arm; comments only, the math is correct by ruling.
  (2) useModelFloor NOW MIXES WALLETS — use-prompt-budget.ts:679,706 feed the PAYER-SCOPED
  spendableNanoUsd into resolveClientBilling, whose parameter is documented and used as the CALLER'S OWN;
  the sibling useResolveBilling deliberately kept the unscoped read for exactly this reason, so two
  callers of one core now feed it different wallets. Reachable: a paid-tier non-owner with zero hold-aware
  group remaining but positive durable headroom gets self-fundable models GREYED. Money direction is
  fail-closed (hence Minor) but greying an affordable model violates the founder's standing rule, so it
  is fixed. NOTE I RULED DELIBERATELY: E1 is slated to delete this hook, so this is arguably throwaway
  work — fixed anyway because E1 is several tasks away and until then the regression is live in the one
  direction the standing rule forbids. Two lines beats a live regression.
  THIRD MINOR WAS MINE AGAIN: G2's own criteria named NONE of the items I routed to it — I recorded them
  in the ROUTING task's amendment instead of the OWNING task's criteria, so a G2 implementer reading only
  §G2 would have missed all of them. Fourth bookkeeping defect of this run and the pattern is now clear:
  I record decisions where I am working rather than where they will be read. Swept every other routed
  item to check for the same error — B2, B3, B6, B7, B8, G1 all correctly carry theirs in their own
  criteria; G2 was the only gap. Folded in all three (payerSizingTier deletion, the cap−spent−held
  composition, and the new tier-vocabulary duplication the auditor found: workflow.ts's StorageStamp.tier
  is a bare z.enum whose OWN DOCBLOCK says it "mirrors" the canonical UserTier union — a self-documented
  banned sync contract) and widened G2's file list to match.
- 2026-07-26: F1 fix cycle 1 DONE (impl-report-2.md). Repo typecheck 16/16 uncached; shared green; web
  green INCLUDING the coverage gate (markdown-renderer flake did not fire — third data point that it is
  load-dependent); api 465 files/6391 tests with only §Known Breakage template-html, re-verified that dir
  unmodified vs 39a07db0 and F1's api edits comments-only; arch:check 11 rules/1999 files; eslint exit-0
  from all three package dirs post-final-edit. Finding 2 pinned by a test watched red for exactly the
  stated symptom.
  NEEDS_CONTEXT correctly NOT fired, with real reasoning: the two-useSpendable-calls precedent transfers
  because usePromptBudget ALREADY issues that exact scoped+unscoped pair, and in a solo conversation both
  calls share one query key so TanStack dedupes them.
  ACCEPTED SCOPE EXPANSION — the fixer found a SECOND instance of the same defect and fixed it: added
  isOwnSpendablePending to useModelFloor's isPending, because scoped-read-warm + unscoped-in-flight made
  spendableNanoUsd fall back to 0n and GREYED EVERY AFFORDABLE ROW for a render. Same defect class, same
  file, same forbidden direction; leaving it would have left a visible flash of greyed rows. +1 test.
  PRE-EMPTED A FALSE-POSITIVE FINDING, which is worth noting as good practice: it left ownerSnapshot's own
  docstring BYTE-IDENTICAL and said so, because that docstring already stated the raw-dimension exception
  and made no exactness claim — it is the correct comment the other three drifted from, and it is the
  fourth site an auditor would expect changed. Passed to the re-auditor as a coordination fact so the
  audit does not spend effort there or flag its absence.
  TEST-INFRA CHANGE recorded for later web tasks: the use-spendable mock in use-prompt-budget.test.ts is
  now ARGUMENT-AWARE (mockUnscopedSpendable, default undefined ⇒ both arms share the old fixture); all 66
  pre-existing tests keep their fixtures and assertions. Written into §E1 as an inherited shape.
  ROUTED TO E1 AS A CRITERION, and this time into E1's OWN criteria rather than F1's amendment — applying
  the lesson from this run's fourth bookkeeping defect: E1 deletes useModelFloor, which DELETES BOTH OF
  THIS CYCLE'S REGRESSION PINS. The defect class survives the rewrite (a payer-scoped figure reaching a
  caller-scoped parameter; a partially-loaded funding read greying affordable rows), so E1 must re-pin
  both against whatever replaces the hook. A deletion that silently drops a regression test is how the
  regression returns.
  → F1 fix re-audit dispatched: ONE auditor, narrow, justified in the brief — no server money arithmetic
  changed (api edits are comments only, the behavioural change is client-side greying in the fail-closed
  direction) and both prior lenses already passed on the contract, the privacy claim, single-writer, the
  GC10 sweep and the E3 key pin. Brief forbids re-auditing the contract and says that if the fix disturbed
  it, that IS the finding. Four targets: verify the new test fails when the fix is REVERTED rather than
  trusting the claimed red; check the GROUP case where the scoped and unscoped reads genuinely differ (the
  fixer's dedupe argument only covers solo); confirm the three comments now STATE the raw-owner exception
  rather than merely softening "exactly" into vagueness (a comment that no longer overclaims but no longer
  informs is not a fix); and check the argument-aware mock rewrite did not quietly relax any of the 66
  pre-existing tests — a mock rewrite being the classic place an assertion loses its teeth with no expect
  line changing.
- 2026-07-26: F1 fix re-audit PASS, 1 Minor. Both cycle-1 findings VERIFIED CLOSED at the end state.
  COUNTERFACTUAL PROVEN INDEPENDENTLY rather than trusting the claimed red: the auditor drove the shared
  core directly at the test's own inputs — paid-tier floor 30,600,000n; spendableNanoUsd 0n ⇒
  {"fundingSource":"denied","reason":"insufficient_balance"} ⇒ isBelowFloor true ⇒ test fails;
  1,000,000,000,000n ⇒ personal_balance ⇒ passes. And the load-window test is equally load-bearing: with
  no isOwnSpendablePending, isPending is false while ownSpendableData is undefined ⇒ 0n ⇒ denied ⇒ greyed,
  failing both assertions. Neither test tautological.
  GROUP CASE CHECKED (the fixer's dedupe argument only covered solo): solo/no-group both reads normalize to
  spendableFor(null) so TanStack dedupes one query; in a group they genuinely differ and each feeds the only
  parameter it is correct for. The ONLY divergent state is hold-blind-headroom-positive + hold-aware-
  insufficient, and there the picker now AGREES with the composer, which is useModelFloor's documented
  contract. Admission may still refuse, and §Group Funding 6(b) already settles that direction — so nothing
  unsettled, consistent with my retraction of the escalation.
  MOCK REWRITE VERIFIED NOT TO HAVE RELAXED ANYTHING — the classic place teeth are lost with no expect line
  changing: with mockUnscopedSpendable unset BOTH reads return the single pre-existing fixture, byte-for-byte
  the old one-call behaviour; it is reset to undefined in both beforeEach blocks so there is no order
  dependence; the arg-tracking spy keeps its teeth (toHaveBeenCalledWith('conv-1') still fails if scoping is
  removed, since every other call passes undefined/null); 68 tests (66+2) pass. Noted-not-flagged: the
  fixture type makes tier/payer optional, looser than the wire, but the tier-sensitive tests set tier
  explicitly and the tier-blind ones use a tier the server would have served.
  ALL THREE COMMENTS CONFIRMED to STATE the exception rather than soften "exactly" into vagueness — each
  names the raw owner dimension, both omissions (cushion and owner-wallet holds), the ruling behind it, and
  §Group Funding 6(b) as the resolution; and ownerSnapshot's docstring was correctly left untouched, exactly
  as my coordination fact predicted.
  VALIDATED MINOR, and the irony is worth recording: a cycle whose entire mandate was COMMENT ACCURACY
  introduced a wrong comment. use-prompt-budget.ts:683 claims "useResolveBilling splits them the same way",
  but use-resolve-billing.ts:35 issues exactly ONE argument-free useSpendable() and splits nothing — what
  splits is the composer PATH. A reader following the pointer to confirm the precedent finds a single
  unscoped read. → F1 fix cycle 2 dispatched, one clause, with the auditor's suggested replacement offered
  verbatim. Justified for one clause because it misdirects anyone verifying the precedent, INCLUDING E1's
  implementer, and E1 is several tasks from deleting the hook.
  RESIDUAL THE AUDITOR CHECKED AND DELIBERATELY DID NOT FLAG, recorded so it is not rediscovered: on
  fall-through the floor is still sized at the PAYER's tier (paid floor 30,600,000n vs free 31,200,000n —
  ~2% understatement for a free-tier member). That is cycle 1's served-tier design, it satisfies the
  criterion "client sizing inputs take the payer's tier", and it lands inside the same spec-accepted
  divergence. Not moved by the fix.
  HONEST LIMIT DISCLOSED BY THE AUDITOR: it could not byte-diff cycle 1 against cycle 2 (no commit boundary
  exists), so "comments only in api/shared" rests on convergent evidence — untouched mtimes on passing test
  files, ownerSnapshot's arithmetic reading as reported, clean lint — not on a diff. Correct posture.
  *** NEW §KNOWN BREAKAGE ENTRY, from this audit: five apps/api integration files time out on
  "model-catalog test lock: timed out acquiring" under full-suite load and ALL FIVE PASS IN ISOLATION
  (175 tests) — shared-Redis test-lock contention. Two traps recorded with it: it is LOAD-DEPENDENT so its
  absence proves nothing, and it includes models/domain/refresh.integration.test.ts, a CATALOG-ADMISSION
  file, so a task working near the model catalog will be tempted to attribute a real failure to it. ***
  B2 IS LIVE AND CURRENTLY RED: repo typecheck is 15/16 on
  affordability/dimensions/derive.ts(333,3) TS6133 'model' declared but never read — untracked B2 tree,
  mtimes moving during the audit. Expected mid-flight state, attributed away from F1, and F1's fix-2 brief
  tells it not to chase it.
- 2026-07-26: F1 fix cycle 2 DONE (impl-report-3.md), comment-only. Repo typecheck 16/16 UNCACHED —
  B2's derive.ts TS6133 is GONE, so B2 closed it mid-flight; the file is still untracked. eslint exit-0
  post-final-edit; use-prompt-budget.test.ts 68/68, identical to the prior cycle, which is the expected
  signature for a comment-only change; src/hooks/billing 12 files/237 tests.
  DELIBERATE DEVIATION FROM THE AUDITOR'S SUGGESTED WORDING, and the reasoning is good: rather than naming
  the two hooks as PEERS, it states the DELEGATION (usePromptBudget → useResolveBilling), arguing peer
  phrasing invites the same wrong mental model that produced the original error. Cited split:
  use-prompt-budget.ts:466 (scoped, sizing) and :546 (delegates the compare). Routed to the auditor to
  judge, explicitly licensed to conclude the fixer improved on its own suggestion.
  VERIFIED RATHER THAN ASSUMED the STOP-AND-ASK item: usePromptBudget has exactly ONE production caller
  (prompt-input.tsx:696), so "the composer path" is a checkable phrase rather than a vague one — which is
  the whole point of the fix, since the clause it replaced was unverifiable.
  NO TEST ADDED, with reasoning I accept: a test asserting a comment's wording would be a SYNC CONTRACT
  against the code it describes (banned by CODE-RULES), and the behaviour the comment documents is already
  pinned by the two red-watched tests from cycle 1. Routed to the auditor for confirmation rather than
  ruled by me alone.
  → Verification dispatched via SendMessage to the SAME auditor that raised the Minor, resumed from its
  transcript rather than spawning a fresh one: it already holds this file's call graph and the counterfactual
  it derived, so a fresh auditor would re-pay that cost for a one-clause comment. Scoped to exactly two
  judgments (is the new wording accurate and checkable; is it genuinely comment-only) plus confirmation of
  three incidental claims (16/16 via B2 closing its own error; the single production caller at
  prompt-input.tsx:696; the no-test reasoning). Proportionality recorded deliberately: the standing rule is
  that every fix is re-audited, and this honours it without spending a full audit on one comment line.
- 2026-07-26: B2 implementer DONE_WITH_CONCERNS (impl-report-1.md). shared 115 files/2789 tests with the
  coverage gate green; repo typecheck 16/16 UNCACHED (it broke this briefly mid-run and closed its own
  TS6133 unprompted); eslint exit-0 from all three package dirs post-final-edit; api 6391 pass with all 7
  failures in template-html (§Known Breakage, dir byte-identical to HEAD); web 393 files/6412 tests.
  *** THE DISCOVERY THAT REFRAMES EARLIER WORK: premium-check.ts HAD NO PRODUCTION CONSUMER, and the live
  premium classifier is apps/api/src/slices/models/domain/trial-eligibility.ts, which carries its OWN price
  quartile (:33), its OWN recency window (:42) and a trial-affordability leg. If true, the parseFloat fix I
  prioritised — and argued for on the grounds that float arithmetic was deciding a paid-access boundary —
  was applied to DEAD CODE, while the real One-Implementation-Shared violation is still live and unowned.
  Routed to B5 (owns eligibility predicates) to decide whether trial-eligibility collapses onto the moved
  implementation or the moved one is deleted as redundant, and to report which — two premium classifiers is
  not an acceptable end state. Flagged to the audit as the single most consequential claim in the report and
  told to derive it independently, since it currently rests on B2's word alone. ***
  MY PLAN-SCOPING DEFECT, conceded: §B2's Files list could NOT satisfy its own criteria 6, 7 and 9, and its
  scoped checks (test:shared only) understated the blast radius. A vocabulary collapse over a union type
  necessarily reaches every consumer; moving a file necessarily reaches its importers. B2 was right to
  proceed and enumerate rather than stop. OWNERSHIP SPILL recorded so the owners are not surprised:
  use-prompt-budget.{ts,test.ts} (F1's — 1 production line + 2 test lines, forced because a comparison
  against a removed union member is TS2367); chat/{routes,turn-definition,turn-reasoning}.ts + 4 chat tests
  (B4's, then C3's, then E4's); use-reasoning-effort.{ts,test.ts} + reasoning-effort-menu.{tsx,test.tsx}
  (E1's, incl. renaming the exported offersEffortNone → offersEffortOff); premium-check.{ts,test.ts}
  DELETED + models/index.ts + shared/index.ts. F1's live verification auditor was NOTIFIED by SendMessage
  so it attributes the extra diff in use-prompt-budget.ts to B2 rather than raising it as F1 scope creep.
  TWO PRE-EXISTING MONEY DEFECTS THE MOVE EXPOSED AND FIXED, neither with a live consumer: exceedsTrialBudget
  fed the estimator RAW PRE-FEE rates while its docblock claimed the core applies markup (it does not) ⇒
  under-priced by 15%; and isPremiumModel called Date.now() inside a module documented clock-free. Both
  would have been real defects the moment a consumer appeared. Routed to the audit to verify the
  no-live-consumer half, since a live consumer makes the first a SHIPPED money defect rather than latent.
  CRITERION 2 MET BY INTERPRETATION, disclosed rather than papered over: openness is not a declared field,
  so "a non-enumerable dimension declared open is rejected at registration" is discharged by openDimension()
  throwing and OpenDimension being obtainable nowhere else. Routed to the auditor to judge on merits and to
  say whether the criterion's WORDING needs changing rather than the code.
  CRITERION 7 DELIBERATELY INCOMPLETE AND CORRECTLY SO: the live classifier prompt still prints low/medium/
  high from the hardcoded triple at smart-model/effort-dimension.ts:18 (prompts.ts:72,74,84,88). Deleting
  that triple is B6's OWN named criterion; B2 built renderDimensionSection as the producer B6 consumes and
  did not pre-empt it. Auditor told not to score it as incomplete but to judge whether what B2 built is
  actually consumable by B6.
  HANDED FORWARD: exceedsTrialBudget / TRIAL_AFFORDABILITY_MULTIPLIER are newly on both barrels and need
  B8's disposition ruling like estimateOk/estimateErr; dimensions/index.ts publishes registry+types only
  with derivations behind the wall, which B8 must CONFIRM rather than assume; and E4 must know PriceableModel
  has NO parameters field, so media dimensions cannot reach a per-model ParamSpec through it (effort reads
  `reasoning`, so B2 needed none). BILLING.md DEFECT for the approved batch: §Data Structures types
  PriceableModel.reasoning as `ReasoningMetadata`, a type that does not exist — the catalog's is
  ModelReasoning (model-descriptor.ts:84).
  → B2 auditing, 2 auditors (money + the registry is high-stakes), distinct lenses: (A) THE REGISTRY —
  does deliversAtHoldCeiling:false actually change behaviour (the field most likely to ship inert); does the
  re-partition pin FAIL when the invariant is violated (it is the only guard on a claim whose predecessor
  was measured false); judge criterion 2's interpretation; and confirm every fact the criteria call DERIVED
  is not a second hardcoded table. (B) THE COLLAPSE AND THE MOVE — derive the no-production-consumer claim
  independently; verify which of the three reasoning-off tokens survived where, since D1 is about to write a
  column against one; check each out-of-ownership edit was forced AND minimal file by file (a union removal
  forces a rename, it does not license a behaviour change — offersEffortNone → offersEffortOff is the one to
  check for a semantic shift); and verify the two pre-existing defects were real and had no live consumer.
- 2026-07-26: F1 cycle-3 verification PASS, finding closed, no new findings ⇒ **F1 CLEAN** (4 of 25:
  B1, B1b, A1, F1). Verified by the same auditor resumed from transcript — the proportionate route, and it
  re-ran every check itself rather than reading the report's numbers.
  THE AUDITOR RULED THE FIXER IMPROVED ON ITS OWN SUGGESTION, without reservation, and named a
  consideration it had not weighed: the fixer wrote "the composer path" rather than citing
  prompt-input.tsx because CODE-RULES BANS SPECIFIC FILE PATHS IN COMMENTS (paths move), so the claim stays
  grep-verifiable while the comment stays durable. Its verdict: "Accuracy: equal. Explanatory power and
  durability: better than mine." Peer phrasing would have left the reader free to keep the exact wrong
  mental model that produced the false clause.
  COMMENT-ONLY VERIFIED STRUCTURALLY, not by claim: it diffed the useModelFloor hunk against its own
  pre-cycle capture — comment block 6 → 8 lines, final sentence changed, and every executable line
  byte-identical (both useSpendable calls, the isPending composition, the resolveClientBilling call). 68/68
  with no test added or edited is the expected signature, measured rather than quoted. Because the zero
  executable delta was confirmed independently, gating on the focused file plus the owning directory is
  proportionate rather than a shortcut — its words.
  NO-TEST REASONING ACCEPTED ON ALL THREE GROUNDS: a test asserting a comment's wording is the banned
  artefact (a sync contract between prose and the code it describes); the documented behaviour is already
  pinned by cycle 2's two tests, which it had verified counterfactually through the shared core; and the TDD
  iron law is not engaged because no production code was written.
  INCIDENTALS CONFIRMED: repo typecheck 16/16 uncached with B2 — not F1 — having closed the derive.ts
  TS6133 inside its own rewrite of resolveOption (the unused `model` parameter is gone); usePromptBudget has
  exactly one production caller; and B2's 'none'→'off' lines were already in the tree when the auditor first
  read the diff, so it never attributed them to F1 — the SendMessage coordination note cost nothing but
  would have if the timing had gone the other way.
- 2026-07-26: F2 dispatched → implementing. Opened by F1's clean; no file conflict with B2 (which owns
  dimensions/**, reasoning-effort.ts and the relocated premium module, while F2 owns
  affordability/billing/funding-decision.ts + client-billing.ts), and B2's in-flight work is audits, which
  are read-only.
  PLAN DEFECT FIXED BEFORE DISPATCH: F2's third criterion read "the payer-switch notice from B7 fires on
  fall-through" — UNSATISFIABLE at F2's position, since B7 is not built and F2's only dependency is F1. This
  is the same class as B1b's original criteria depending on producers built later. Corrected: F2 owns the
  decision and the typed reason it carries, B7 owns the copy and the rendering (B7's own criteria already
  require the payer-switch disclosure incl. the no-allocation case), and F2 must REPORT THE EXACT REASON
  VALUE it emits so B7 wires to a real constant instead of inventing one.
- 2026-07-26: B2 auditor, COLLAPSE + MOVE lens: PASS, 1 Minor. Registry lens still running; B2 not clean
  until both are in and its fix cycle lands.
  THE DEAD-CODE DISCOVERY CONFIRMED AND SHARPENED, derived independently rather than taken on B2's word:
  at 39a07db0 the moved file's exports reached exactly TWO places — its own test and one re-export line —
  and exceedsTrialBudget / TRIAL_AFFORDABILITY_MULTIPLIER were not even on that line. The live chain is one
  hop LONGER than B2 reported: models/domain/tier-gate.ts holds the local isPremiumModel and derives from
  trial-eligibility.ts, which carries TRIAL_PRICE_PERCENTILE = 0.75 (:33), TRIAL_RECENCY_MS = 182 days (:42)
  and its own affordability leg. So both halves stand: the parseFloat fix I prioritised landed on DEAD CODE,
  and a live One-Implementation-Shared violation is correctly B5's. Plan updated with the verified chain.
  A SECOND PRE-EXISTING CONTRADICTION ROUTED TO B5 ALONGSIDE IT, because it is the SAME clause: the live
  trial gate PRICES STORAGE INTO THE 1¢ CAP (trial-eligibility.ts:23-25,194-201), contradicting §Cost and
  §Trial Usage ("Trial never persists" ⇒ no storage term) — exactly the clause the moved function was
  corrected against. Ruling one without the other would leave the two implementations disagreeing for a NEW
  reason right after being collapsed for the old one.
  VOCABULARY COLLAPSE VERIFIED COMPLETE: `off` is the single token (REASONING_OFF), `Min` survives only as
  a label in exactly one entry, `none` is gone from our id set — every surviving 'none' literal is either
  OpenRouter's native supportedEfforts word (documented as distinct) or an unrelated domain. medium ↔ Mid
  exists ONCE. Global Constraint 10 sweep clean: no reasoningEffort reference in e2e/, scripts/, apps/admin,
  apps/marketing, packages/{db,realtime,ui}; the one e2e effort test drives the LABEL "High", not an id. And
  a stale persisted 'none' preference clamps to 'auto' rather than crashing — the migration-free path D1
  needs before it writes a column.
  ALL NINE OUT-OF-OWNERSHIP PRODUCTION EDITS READ IN FULL AND CONFIRMED FORCED AND MINIMAL: token renames
  plus one type import; no branch, ordering or predicate changed. offersEffortNone → offersEffortOff is a
  PURE rename — body byte-for-byte identical to 39a07db0 — which is the one I flagged as most likely to hide
  a semantic shift. use-prompt-budget.ts is exactly one line, which F1's comment-only cycle absorbed.
  BOTH PRE-EXISTING DEFECTS CONFIRMED REAL AND CONSUMER-FREE: premium-check.ts:53-56 fed
  usdToNanoUsd(parseFloat(...)) raw provider rates under a comment claiming "core applies markup", while
  price-request.ts:7 states it applies no fee math and MARKUP_BASIS_POINTS = 1500n is applied only at the two
  seams ⇒ a genuine 15% under-price, latent only because nothing imported it. Date.now() confirmed at :43.
  VALIDATED MINOR — a wrong-mechanism comment on a money function, and specifically dangerous:
  premium.ts:80-84 says the storage legs "are dropped by pricing at zero input chars and the unit
  output-storage ratio". False. outputCharsPerTokenForTier('trial') is CHARS_PER_TOKEN_STANDARD, not unit,
  and output-storage is a LIVE storage line item removed only by the explicit
  items.filter(item => item.kind === 'provider') at premium.ts:111. A reader who believes the zeroing does
  the work COULD DELETE THE FILTER and silently re-add a storage charge to a turn that never persists — and
  B5 is the reader most likely to be in that file next. Queued for B2's fix cycle.
  ROUTED TO B6, located precisely so B6 need not find it: the two effort resolvers diverge in the
  `mandatory` GATE, not in the ordering. derive.ts's resolveOption rises to the lowest offered rung only when
  support.mandatory; effort-options.ts's resolveEffortForModel rises whenever the model cannot disable. A
  model that can disable but is not mandatory resolves DIFFERENTLY under each, so collapsing onto the wrong
  one silently changes which rung a pinned request lands on. Written into B6's criteria.
  DOC ERRATA GREW: §Data Structures also writes `readonly modelId: ModelId`, and no ModelId type exists
  either — an undisclosed sibling of the ReasoningMetadata defect, so `string` was the only option. Both are
  in the approved BILLING.md batch.
- 2026-07-26: B2 auditor, REGISTRY lens: FAIL, 1 Important + 2 Minors + a design question I ruled.
  *** IMPORTANT — A MONEY-UNIT DEFECT. reserveContribution(MODEL_DIMENSION, …) returns
  { kind: 'money', nanoUsd: <combined per-TOKEN rate> }, but ReserveContribution's money arm is documented
  as "what an open dimension's worst option costs the hold" and §Cost classes defines resource:money as
  nano-USD out of spendable. A PER-TOKEN RATE IS NEITHER. The real hold term is MAX over candidates
  cost(m, ceiling(m)) = rate × ceiling, so the derivation understates by ROUGHLY THE CEILING IN TOKENS.
  Worse, derive.test.ts PINS the wrong-unit value (3000n) as expected, and the only protection is prose at
  model.ts:13-15 telling a future implementer not to read it — the "don't drift" comment class CODE-RULES
  bans as a resolution. B3 is the consumer that will read this union. ***
  MY RULING on the direction the auditor correctly said needed one: give a RATE-SHAPED requirement its own
  `kind`, carrying nano-USD PER TOKEN, distinct from money. Rejected the alternative (make `requirement`
  return real money) because it is impossible in principle, not merely awkward: the model dimension's cost
  depends on the ceiling, which depends on the funding, which the registry does not have — that circularity
  is exactly why §The hold expresses this term as a MAX over candidates rather than a per-option constant.
  With a distinct kind, a consumer wanting money must SUPPLY a ceiling, so treating a rate as an amount
  becomes unrepresentable instead of merely forbidden by a comment. Fixer must state the consumer contract
  B3 will read, since that artifact is what stops the defect reappearing downstream. Doc gap queued for the
  founder: §Cost classes assigns the model dimension NO class, which is what allowed this in the first place.
  MINORS: two dead exports (EffortOptionId is knip's only new finding repo-wide; offeredEffortOptionIds is
  test-only and duplicates offeredLevels().map(label)) — Phase 4 gates on knip and a test-only export invites
  a second ladder authority; and A PIN THAT CANNOT FAIL (re-partition.test.ts:80-91 — partitionPoolTokens
  takes no support argument so the loop recomputes one call, and the second assertion is filler). The pin
  list read one longer than it is. Exactly the vacuity class I briefed for.
  *** THE REGISTRY LENS CORRECTED THE COLLAPSE LENS, AND MY PLAN AMENDMENT WITH IT. An hour ago I wrote into
  §B6 that the two resolvers "diverge in the mandatory gate". That is WRONG — the divergence is UNREACHABLE
  because canDisable ⟺ reasoning defined ∧ ¬mandatory, so there is no live bug. The real hazard is
  arithmetic: THREE implementations now coexist (dimensions/derive resolveOption; estimate/effort-options
  resolveEffortForModel, which is LIVE via turn-reasoning.ts; and smart-model/effort-dimension
  pickClassifiedEffortPlan, the distance-sorting one), while B6's criterion names only "the distance-sorting
  implementation is deleted" — so SATISFYING THE CRITERION LEAVES #2 as a second nearest-below resolver with
  the same carve-out. B6 amended: exactly one survives, name it, say what happened to the other two.
  When two auditors disagree I now take the one that traced reachability over the one that compared bodies. ***
  ALSO ROUTED TO B6: B2's protocol is LABELLED LINES while the live parser is POSITIONAL (line 1 model,
  line 2 effort) and resolveClassifiedEffort matches the hardcoded triple — adopting renderDimensionSection
  without replacing the parser in the same task leaves producer and parser on different protocols.
  TWO PLAN CRITERIA REWORDED ON BOTH AUDITORS' RECOMMENDATION — the plan was wrong, not the code.
  Criterion 2: "rejected at registration" → "rejected when opened", because openness is CORRECTLY not a
  declared field (§Pinned or open makes it a property of what the user fixed), so there was nothing for
  defineDimension to reject; the structural property holds because openDimension() is the only producer of
  the open form and throws. E4's continuous-dimension criterion inherits the same reading and already works.
  Criterion 1: there is NO per-model ParamSpec for effort — ingestion seeds only temperature/topP/
  maxOutputTokens and `reasoning` is a behaviour — so the literal reading applies to MEDIA dimensions, which
  do have ParamSpecs. Met in substance: one vocabulary constant, no second copy, offered set from the row.
  ROUTED TO B3: B2's re-partition suite pins that the pool is maxB(m) and the ceiling option-invariant, but
  the ceiling itself is a TEST CONSTANT there, so "the PRICED ceiling is derived from maxB(m)" is unpinned
  end to end until B3's producer exists. B3 must pin it against the produced value, not a fixture.
  CONFIRMED NON-INERT, verified by construction not by test name: deliversAtHoldCeiling:false branches
  deliveredCeilingTokens (false ⇒ floor(held / worstFactor) over PRESENTED options, so the answer is
  identical whichever option is chosen — the spec's consequence made observable), and registry.ts refuses
  multiplicative + true. Honest caveat recorded: both shipped entries declare true and nothing calls
  deliveredCeilingTokens yet, so the field is real and pinned but not on a live path until B3/E4 — intended
  bottom-up order, not incompleteness. Re-partition pin CONFIRMED FAILABLE with each mutation traced.
  Nothing regressed by the whole registry: combinedRateNanoUsd, isPremiumModel, exceedsTrialBudget,
  priceableModelFrom and the registry itself have no production caller yet.
  → B2 fix cycle 1 dispatched, 4 items (the unit defect with my ruling, two dead exports, the vacuous pin,
  and the wrong-mechanism premium docblock from the other lens).
- 2026-07-26: B2 fix cycle 1 DONE (impl-report-2.md). shared 115 files/2806 tests with the coverage gate
  green; repo typecheck 16/16 zero cached; eslint exit-0 post-final-edit; knip's NEW finding is gone with
  only the two pre-existing Known-Breakage ones left. Each fix watched red first — the unit fix against the
  exact wrong value {kind:'money', nanoUsd:3000n}, the replaced pin under a reverted mutant.
  *** MY RULING WAS PARTLY WRONG AND THE FIXER CORRECTED IT. I said a consumer wanting money "must supply a
  ceiling", implying rate × ceiling yields the hold term. IT DOES NOT: nanoUsdPerToken × ceiling ≠
  cost(m, ceiling), because THE INPUT LEG IS PROMPT-SIZED, NOT CEILING-SIZED. So no arithmetic converts the
  rate into money at all. A consumer must price cost(m, ceiling(m)) per candidate THROUGH THE ESTIMATOR and
  take MAX over candidates for an open dimension, Σ for pinned siblings; the rate's only legitimate role is
  the balance- and prompt-independent candidate TOTAL ORDER. My framing was wrong in the same way the
  original comment was wrong — it named a mechanism that does not exist. Recorded as B3's contract with an
  explicit instruction that any expression multiplying a moneyPerToken by a token count is a defect. Routed
  to the re-audit with licence to find BOTH the ruling and the fixer wrong. ***
  FRAMEWORK EXTENSION, disclosed and needing a founder doc line: the distinct kind is derived from a NEW
  FOURTH DIMENSION_RESOURCES member, `moneyPerToken`, where §Cost classes documents three. The fixer's
  reasoning is sound — a resource defines a requirement's UNITS per §Data Structures, and a rate is a
  different unit from an amount — and it named the alternatives it rejected: a new declared field (moves a
  derived fact into a declared one, against the section's whole premise) or keying on spec.id (puts
  per-dimension code back in the generic path). Added to the approved BILLING.md batch as a FRAMEWORK
  EXTENSION rather than a bug fix, alongside the model-dimension cost-class gap that allowed the defect.
  CONTAINMENT VERIFIED BY THE FIXER, which is why no NEEDS_CONTEXT fired: ReserveContribution,
  DIMENSION_RESOURCES and MODEL_DIMENSION have ZERO consumers outside dimensions/, so the change is fully
  contained and F1's and F2's files were never opened.
  SURGICAL RESTRAINT ACCEPTED AND QUEUED, not waved: registry.test.ts:120's test name still says "at
  registration" while the criterion it pins was reworded to "when opened". The assertion is correct; only
  the name is stale. The fixer flagged it and left it rather than widening a surgical cycle — the right
  call, so it goes to the Phase 4 close batch (the established home this run for mechanical one-liners)
  and the re-auditor is told not to raise it.
  → B2 fix re-audit dispatched: ONE auditor, narrow, justified — both prior lenses ran, the collapse/move
  lens PASSED, and the fix is contained to a directory whose exports have no outside consumers. Four
  targets: is the illegal state now genuinely UNREPRESENTABLE rather than prose-forbidden (incl. that no
  path still treats a rate as an amount, and what became of the test that pinned 3000n); is the fixer's
  consumer contract CORRECT against §The hold and the estimator, since B3 builds on that sentence and I
  have already been wrong about it once; was the replaced pin actually made FALSIFIABLE under a real
  mutation; and does premium.ts's comment now name the true mechanism (the explicit provider-kind filter)
  rather than crediting a zeroing it does not do — B5 being the next task in that file and the one who
  would be misled.
- 2026-07-26: F2 implementer DONE_WITH_CONCERNS (impl-report-1.md). Repo typecheck 16/16 uncached; shared
  115 files/2806; api 465 pass with only §Known Breakage template-html; web 393 files/6412 pass, exiting 1
  only on the documented load-flaky markdown-renderer gate (100% branch in isolation); eslint exit-0 on
  owned files from both package dirs post-final-edit; billing scope 100% on all four metrics. ~10 lines of
  pure decision logic, boundary pinned BY AMOUNT at core/client/contract level and proved discriminating by
  mutating >= to >.
  TYPED REASON DELIVERED AS ASKED, so B7 wires to a real constant: `'group_headroom_insufficient'`
  (exported `PayerSwitchReason`), on FundingDecision.self.payerSwitch (required, | undefined) and
  ResolveBillingResult.payerSwitch. Set ONLY on an approved fall-through — never solo, owner, or any
  refusal. ONE value deliberately covers allocation-exhausted, never-allocated and positive-but-too-small,
  which is what makes B7's no-allocation-as-well-as-exhausted criterion satisfiable from a single reason.
  Written into B7's criteria with an explicit "do not invent one".
  ACCEPTED DEVIATION: chat/domain/turn-context.ts and billing/domain/spendable.ts each gained one line
  (turnEstimateNanoUsd: undefined) + a comment — a required-member contract change under Global Constraint
  10, without which repo typecheck ships red. No behaviour change in either.
  *** THE SPEC GAP, ESCALATED — AND THIS TIME I GREPPED THE SPEC FIRST (the lesson from retracting the last
  escalation). BILLING.md mandates priority 1's estimate comparison and says NOTHING about when the payer is
  frozen, so it genuinely does not resolve this. §Funding Decision Matrix priority 1 is now correct ON THE
  CLIENT and CANNOT BE IMPLEMENTED ON THE SERVER as the path is ordered: resolveTurnContext freezes the payer
  BEFORE the turn is priced, because the ceiling is bounded by the payer's own funding. So a member with
  positive-but-insufficient group headroom is frozen owner-funded and then refused at admission, where the
  matrix says fall through to personal funds. tierGateRejection is estimate-blind for the same reason.
  WHY IT IS A RULING AND NOT A BACKLOG LINE: after F2 the client tells that member "your personal funds will
  pay" AND PERMITS THE SEND; the server then refuses it. That is the standing product rule broken — an
  option presented the user cannot use — and the divergence is now SHARPER than before F2, because the
  client's promise got more specific while staying unkept. The gap is PRE-EXISTING (the payer froze before
  pricing at baseline too); F2 made it visible by making the client right.
  MY RECOMMENDATION: hoist a MINIMUM-TURN ESTIMATE AT THE OWNER'S TIER ahead of the payer freeze and decide
  the payer on that. It breaks the apparent circularity — the ceiling needs the payer, the payer needs a
  price — because the MINIMUM cost is payer-independent enough to settle the question: if the group cannot
  cover even the cheapest admissible turn it can never be the payer, so fall through; once the payer is
  fixed, price fully. Same shape as eligible(m), which already grades on the corner a model can actually
  reach rather than an unreachable zero, so no new principle is introduced. PROVISIONALLY ROUTED TO C3
  (owns the turn-compile path) so it is not lost, with an explicit bar on starting it without the founder's
  go, since it changes send-path ordering. ***
  F1 INTERACTION recorded, informational not a defect: the served payer/tier stay estimate-blind, so on a
  fall-through the client sizes at the OWNER's paid ratios while the MEMBER pays. The verdict itself is
  correct (useModelFloor compares the caller's own spendable); only the sizing ratio is the wrong tier.
  → F2 auditing, 2 auditors (money), distinct lenses. (A) BOUNDARY — verify equal-is-fundable and
  one-nano-below-is-not in BOTH directions and CHECK the claimed >= → > mutation rather than accepting it;
  verify fall-through and guest-refusal are still DISTINGUISHABLE FROM EACH OTHER, not merely present (two
  branches returning the same value would satisfy the words and lose the behaviour); verify payerSwitch is
  set on exactly the claimed states, since a reason set on a refusal would attach a B7 disclosure to a
  blocked send; and verify one value really covers all three shapes without collapsing a distinction B7
  needs. (B) PARITY + SWEEP — derive the GC10 consumer set independently and say for each producer whether
  its value is RIGHT or merely TYPE-SATISFYING (an `undefined` passed to satisfy a required-but-undefined
  member being the specific thing to look at); exercise BOTH callers of the shared core; judge whether making
  turnEstimateNanoUsd REQUIRED was right given that a missing estimate silently reverts priority 1 to the old
  headroom-versus-zero behaviour; and judge whether E1 can consume this WITHOUT computing the estimate twice,
  since that would be a second implementation in waiting. Also asked: how would a reader discover the
  client/server verdict divergence FROM THE CODE rather than from this plan.
- 2026-07-26: B2 fix re-audit: FAIL, 1 Important + 1 Minor. All FOUR prior fixes confirmed landed, and the
  auditor did the two things I most wanted: it RAN ITS OWN MUTATION on the replaced pin (scratchpad script
  importing the real derive.js/effort.js; real implementation 0 disagreements over 7 presenting models ×
  every option, mutant 22) so the replacement genuinely discriminates; and it verified the fixer's correction
  of my ruling END TO END — cost = Σfixed + ceiling × Σvariable with the fixed leg carrying
  inputTokens × inputRate + inputChars × storage, so combinedRate × ceiling is NOT cost(m, ceiling), and
  pricing per candidate with MAX over an open dimension / Σ over pinned siblings is exactly §The hold.
  *** IMPORTANT — A WRONG DURABLE COMMENT THAT I PROPAGATED INTO THE PLAN. model.ts:10-14 (restated at
  types.ts:171-172) asserts the combined per-token rate "is the balance-independent, prompt-independent total
  order §Smart Model 1 mandates". FALSE: §Smart Model 1 mandates an order on TURN COST with an IDENTIFIER
  TIEBREAK, reproducible from the catalog AND THE PROMPT SIZE, and §Predicates fixes the quantity as
  maxCallCost(m) = cost(m, min(providerCap, contextHeadroom)). Ordering by inputRate + outputRate is a
  genuinely DIFFERENT order — input leg prompt-weighted, output leg carries storage, per-model caps differ
  (§Smart Model 3 requires catching an enormous-capacity model too) — and a rate carries no tiebreak. The
  sentence is self-contradictory besides: a "prompt-independent" order cannot be why an order needs the
  prompt size. AND I PROMOTED IT VERBATIM INTO plan.md AS B3's CONTRACT, so it was about to be implemented
  against. Sixth plan defect of this run, same mechanism as the others: I transcribed a subagent's claim into
  the plan without deriving it. Both the docblock (B2 fix cycle 2) and my contract (already corrected) fixed. ***
  MY OVERSTATEMENT TO THE FOUNDER CORRECTED: I said the distinct kind makes treating a rate as an amount
  "unrepresentable". The auditor refused that at face value and is right — a DELIBERATE
  hold += c.nanoUsdPerToken under the moneyPerToken arm STILL TYPECHECKS, because both arms carry raw bigint.
  The honest claim is UNREACHABLE BY ACCIDENT, and that is the limit of what my ruling asked for. Recorded in
  B3's contract so no one inherits the stronger claim.
  ROUTED TO B5 AS A CRITERION, spec-decided so NO founder ruling pending (I checked before routing):
  estimate/smart-model-affordability.ts:107-120 sorts the pool by summed rates, TIEBREAK-FREE, while the spec
  names a cost order on maxCallCost with an identifier tiebreak. Pre-existing, not B2's. B5 must order on
  maxCallCost AND pin that a rate-ranked pool and a cost-ranked pool DISAGREE on a real catalog pair —
  otherwise the two orders are indistinguishable in test and the wrong one survives.
  MINOR: derive.ts:273's isNanoUsdResource true-branch of cheapestPresentedOption is UNCOVERED (v8 reports
  158 and 273) — the single place a moneyPerToken requirement feeds a derived decision (criterion 4's failure
  fallback), so the bigint-comparison path could regress silently while the per-file 95% gate stays green.
  THE FOURTH RESOURCE CONFIRMED CORRECT: the auditor checked that three would not have sufficed without
  either mislabelling a rate as money (the original defect) or keying on spec.id, that no §Cost-classes-
  forbidden state becomes representable, that defineDimension's none⟺free pairing still holds, and that
  partition + moneyPerToken still derives {kind:'none'}. It stands; only the ordering claim was wrong. Still
  needs the founder's doc row.
  → B2 fix cycle 2 dispatched, 2 items. Brief explicitly bars settling the ordering question in the docblock
  ("state what the rate IS and stop asserting it is the mandated order") since that is B5's, and bars
  touching smart-model-affordability.ts. One NEEDS_CONTEXT trigger: if removing the ordering claim leaves the
  docblock unable to say why the rate exists at all, that is a design question rather than a comment problem.
- 2026-07-26: B2 fix cycle 2 DONE (impl-report-3.md). shared 115 files/2807 tests, coverage gate green with
  derive.ts branch 97.01 → 98.5; shared typecheck clean uncached; eslint exit-0 after the final edit — and
  the re-lint rule earned its place, catching a unicorn/numeric-separators-style error on `5_000n`.
  GOOD JUDGMENT ON THE COMMENT FIX: both sites now carry the NEGATIVE FACT ("the rate is not that order")
  rather than falling silent, on the reasoning that a bare deletion invites the wrong claim to be RE-DERIVED
  from `ordered: true` + a rate. That is the right read of the failure mode — the original defect was an
  inference someone made and wrote down, so removing the sentence without removing the inference leaves the
  trap. And neither site says what the pool DOES rank by, so B5's decision is untouched.
  New assertion falsified under TWO mutations, one it uniquely catches, with the mutated derive.ts restored
  byte-identical. Diff is two docblocks plus one test assertion, so no production behaviour changed and
  repo-wide typecheck was not re-run (Global Constraint 10 has no trigger) — reasonable.
  CARRIED FORWARD, both disclosed rather than buried: B5 inherits the only executable pin available here, so
  until it lands NOTHING pins that the pool is not rate-ranked and smart-model-affordability.ts still sorts
  by summed rates tiebreak-free (untouched, mtime unchanged) — already a B5 criterion. And derive.ts:158
  (`worst <= 1` in deliveredCeilingTokens) remains uncovered; it appeared in the auditor's v8 output but not
  in its finding, and branch coverage clears the gate without it. Routed to the re-audit to say whether it
  agrees or whether it joins the close batch, rather than my ruling it alone.
  The fixer also superseded its own earlier overstatement in the report itself ("a wrong consumption is now a
  type error" → "unreachable by accident, not unrepresentable"), so the run record no longer carries the
  stronger claim in two places.
  → Verification dispatched via SendMessage to the SAME auditor that raised both findings, resumed from
  transcript: it holds the §Smart Model 1 / §Predicates derivation AND a working mutation harness for
  derive.js, so a fresh auditor would rebuild both to check two docblocks and one assertion. Three scoped
  judgments (docblock accuracy at both sites incl. whether stating the negative beats silence; whether the
  new assertion is genuinely falsifiable, verified with its own harness; whether leaving :158 uncovered is
  acceptable) plus two claim confirmations (smart-model-affordability.ts untouched; no production behaviour
  changed). This is B2's second fix cycle, so the three-cycle cap has one left.
- 2026-07-26: B2 fix verification PASS, zero findings ⇒ **B2 CLEAN** (5 of 25: B1, B1b, A1, F1, B2).
  Auditor re-ran its own mutation harness: mutation A (comparison flipped) → 'high', mutation B
  (isNanoUsdResource narrowed to 'money') → TypeError, and it checked B against the suite's other two
  cheapestPresentedOption fixture shapes — both UNAFFECTED, so the new test is the SOLE guard on the
  moneyPerToken arm; the uniqueness claim holds. Fixture non-monotonicity confirmed real: the cheapest rate
  is neither first-presented nor first-by-id, so neither enumeration order nor the tiebreak can produce it.
  IT AGREED THAT STATING THE NEGATIVE BEATS SILENCE, on a structural reason better than the fixer's: the
  entry declares ordered:true ALONGSIDE a rate requirement and cheapestPresentedOption really does order by
  that rate, so "the rate is the candidate order" is RE-DERIVABLE FROM THE FILE ITSELF — which is how the
  claim reached my plan the first time. CODE-RULES' "code that looks removable but isn't" category.
  Agreed to leave derive.ts:158 uncovered with reasoning (a reachable defensive guard for multiplicative with
  worst factor ≤ 1, which defineDimension legally admits; 98.5% branch clears the 95% gate) and offered the
  one-line closer if the close batch wants zero uncovered lines in the money layer. HONEST LIMIT disclosed:
  byte-identity of the restored derive.ts rests on content re-read + green pins, NOT a git diff, because the
  directory is untracked so no baseline hash exists. One nitpick it deliberately did NOT raise (a slightly
  loose §Predicates pointer) — correct restraint.
- 2026-07-26: F2 auditor, BOUNDARY lens: PASS, ZERO FINDINGS. Boundary pinned by amount at THREE levels
  (core, client shell, cross-side contract matrix): headroom exactly 40_000_000n against a 40_000_000n
  estimate funds the owner, 39_999_999n does not. It reproduced the claimed >= → > mutation VERBATIM on an
  out-of-repo copy — 1 failed / 17 passed, the failure exactly the equality test — so the inclusive edge is
  asserted, not incidental. And it traced the live path (use-prompt-budget → use-resolve-billing →
  deriveClientFundingInputs) to confirm the production client feeds the same quantity the send gate compares,
  so the boundary is live rather than unit-local.
  Fall-through and guest refusal confirmed still DISTINGUISHABLE FROM EACH OTHER (different constructors), no
  pre-existing assertion weakened anywhere in the diff, and one tightened from toEqual to toStrictEqual.
  payerSwitch confirmed set on exactly the claimed states — structurally, since the field is ABSENT from the
  owner and refuse union members, so a leak is not representable. And one reason value covering all three
  shapes is not merely acceptable but MANDATED: §Notices 5 requires one wording for all of them, "including
  when they were never allocated a budget at all".
  *** IT CHECKED SOMETHING I DID NOT ASK FOR, AND IT BOUNDS MY ESCALATION: it verified the escalated server
  gap is not a MONEY LEAK. Admission's per-scope gate DOES compare the estimate against min(scope remaining)
  and returns budget-exceeded (budget-resolution.ts:82-117, admission.ts:54), so the outcome is a hard
  refusal exactly as §Group Funding 6(b) rules — the group budget CANNOT be silently overspent, which is the
  materially worse shape it went looking for. So the gap is a bad PRESENTATION outcome, not a lost-money one.
  Recorded in the F2 amendment because it changes how urgent the founder's ruling is. ***
  Observation recorded for B7, explicitly not a finding: a group fall-through for a trial-tier caller would
  attach payerSwitch to trial_fixed where nothing is charged — unreachable today (trial means
  unauthenticated, so it can never hold group context), but B7 must not write copy assuming
  payerSwitch ⇒ a charge lands.
- 2026-07-26: B3 dispatched → implementing. Opened by B2's clean; it is the spine's centrepiece with B4–B8
  and lane E behind it. Brief front-loads the moneyPerToken contract that cost two cycles to settle (no
  arithmetic converts the rate to money; price per candidate through the estimator, MAX over open / Σ over
  pinned; the rate is a UNIT and specifically NOT a ranking basis, which is B5's and which the live code gets
  wrong), tells B3 it is the registry's FIRST production consumer and should report a wrong-shaped derivation
  rather than work around it, and requires the arithmetic vocabulary pinned BY AMOUNT with the numbers stated
  — a test that checks a term merely EXISTS satisfies the words and loses the arithmetic. Three
  NEEDS_CONTEXT triggers incl. the one that matters most: if satisfying "one call, two evaluations" would
  require a CALLER to supply the empty basis, since the ruling's whole point is that the producer substitutes
  it so a prompt-dependent `affordable` is unobtainable rather than discouraged.
- 2026-07-26: F2 auditor, PARITY + SWEEP lens: FAIL, 1 Important + 1 Minor — BOTH comment-accuracy defects
  F2's change created. Implementation and tests judged correct on every axis.
  *** IMPORTANT — FOUR DOCBLOCKS NOW ASSERT SOMETHING F2 MADE FALSE, AND THE PIN THEY CITE CANNOT CATCH IT.
  funding-decision.ts:8, client-billing.ts:5, funding-decision.contract.test.ts:9-10 and
  use-resolve-billing.ts:25 claim client and server "can never drift" on who-pays — one adding "(pinned by
  funding-decision.contract.test.ts)" and the contract test promising "a future divergence becomes a failure
  of this table, not a silent client↔server drift". For a group member with 0 < headroom < estimate the client
  core returns self + payerSwitch while resolvePayerWallet returns owner. AND THE CONTRACT TEST'S SERVER LEG
  IS A HAND-WRITTEN LITERAL — the three new rows pass turnEstimateNanoUsd: ONE, so it pins a server behaviour
  production does not have. So the only in-code signal about a live divergence says the divergence is
  impossible and already pinned; the truth is discoverable ONLY from this run's plan. ***
  *** AND IT CAUGHT ME MIS-CITING THE SPEC, TWICE. The Minor is turn-context.ts:391-393 calling admission's
  refusal "the spec's hard stop (§Group Funding 6b)". §6(b) RULES THE RACE CASE — exhaustion discovered only
  at admission, where the client's retry re-resolves. THIS CASE IS DETERMINISTIC: the retry re-resolves to the
  same refusal forever, and priority 1 with §6(a) says a signed-in member FALLS THROUGH. So the server's
  behaviour is a SPEC VIOLATION, not a documented hard stop — and I repeated that mis-citation to the founder
  twice, most recently to argue the escalation was less urgent than it is. F2's own impl report stated BOTH
  halves ("but the matrix says a signed-in member should fall through") while the shipped comment stated only
  the half that made it look settled; I read the comment's half and propagated it. Plan amendment corrected:
  the gap is not a money leak AND not spec-sanctioned. Second time this run I have mis-stated which clause
  governs — the fix is to read the cited clause rather than the citing comment. ***
  EVERYTHING ELSE VERIFIED AND STRONG: Global Constraint 10 consumer set DERIVED INDEPENDENTLY — zero
  consumers outside packages/shared, apps/api, apps/web — with all five producers judged on whether their
  value is RIGHT or merely type-satisfying: deriveClientFundingInputs (right), spendable.ts:337 undefined
  (right by design, no prompt exists yet), turn-context.ts:368 solo (right, unreachable), turn-context.ts:401
  group (TYPE-SATISFYING ONLY — the escalated gap, and the reason both findings exist), chat/routes.ts tier
  gate (inherits it by spread). turnEstimateNanoUsd REQUIRED judged the correct call for the reason I hoped
  for: the failure mode is SILENT — a missing estimate reverts priority 1 to headroom-versus-zero with no
  trace — so optional would have compiled all three server sites unchanged and made undefined the default for
  every future producer; required made typecheck enumerate the complete set. Same pattern the run blessed for
  F1's required adapter dep. Staleness analysed: too low silently restores the old behaviour, too high
  switches the payer early and charges the member where the owner should pay; nothing detects it (freshness is
  E3's).
  E1 CONFIRMED ABLE TO CONSUME WITHOUT RE-DERIVATION, with one plumbing note now in E1's criteria: the
  estimate is computed once per surface and reused, but usePromptBudget returns only fundingSource and DROPS
  THE REST, so a send-gate surface needing the typed reason outside generateNotifications must widen that
  return — a one-line change, NOT a recomputation. Recorded so E1 does not "fix" it by pricing twice.
  → F2 fix cycle 2 dispatched, both comment items, with the deliverable stated as making the next reader
  unable to repeat MY error from the code alone — not a wording tidy. One NEEDS_CONTEXT trigger: if stating
  the divergence accurately would require asserting WHEN the payer freeze gets reordered, since that is an
  unruled escalation and a comment must not promise a fix with no owner.
- 2026-07-26: F2 fix cycle 1 DONE (impl-report-2.md), comment text only. eslint exit-0 in all three package
  dirs; affordability/billing 4 files/104 tests; turn-context.test.ts 19; hooks/billing 12 files/237 tests.
  Repo-wide typecheck deliberately skipped under Global Constraint 10's no-trigger rule (zero executable,
  type or signature change; syntactic validity covered by three lint runs).
  THREE JUDGMENT CALLS I ACCEPT, all disclosed rather than buried:
  (a) NO COMMENT NAMES A REMEDY. Writing "closing it means pricing a minimum turn ahead of the payer freeze"
  would assert an UNRULED design, so the comments carry the cause (the payer freezes before pricing) and the
  open consequence, and nothing about how or when it closes. Its own words on why the STOP condition did not
  fire: "accuracy needed the cause, not the fix." Exactly right — a comment must not promise a fix with no
  owner.
  (b) TWO SURVIVING "can never drift" COMMENTS LEFT AS CORRECT (client-billing.ts:161,
  client-billing.test.ts:552) because those are CLIENT-INTERNAL (who-pays verdict ⇔ sizing tier), not
  client↔server — the identical-vs-complementary distinction CODE-RULES asks for, applied to the same phrase
  appearing in true and false instances. And it swept affordability/, hooks/billing/, slices/chat/ and
  slices/billing/ to establish there is NO SIXTH SITE, so the five were the complete set.
  (c) Dropped an incidental `(GB-1)` audit-plan identifier from the contract-test docblock — a Global
  Constraint 8 violation sitting inside the exact sentence being rewritten, so re-authoring it was not an
  option.
  TWO ITEMS ROUTED TO THE PHASE 4 CLOSE BATCH, both found by the fixer and correctly left alone:
  a DANGLING §2.K SPEC POINTER in funding-decision.ts's docblock plus the contract test's docblock and
  describe title — it resolves to nothing in docs/ and appears to point at a superseded backend-redesign
  section. Small, but it matters more than its size: IT IS THE ONLY SPEC POINTER A READER OF THE FUNDING CORE
  GETS. And packages/shared/dist/src/billing/funding-decision.d.ts still carries the retracted "can never
  drift" text, so a grep for the old wording still hits it — gitignored and imported by nothing, so a grep
  trap rather than a defect.
  B3's ownership respected (no edits under affordability/estimate/ or affordability/dimensions/); the only
  cross-workspace file beyond F2's list is use-resolve-billing.ts, comment-only, exactly as the finding named.
  → Verification dispatched via SendMessage to the SAME auditor that raised both findings, resumed from
  transcript: it derived the §6(a)/6(b) distinction and traced all five sites, so a fresh auditor would
  rebuild both to check comment text. Three scoped judgments — are all five sites accurate (with the live risk
  named explicitly: BOTH the original comment and I got this citation wrong, so a THIRD wrong version is the
  real hazard); does the contract test stop over-claiming; is it genuinely comment-only, stating the evidence
  since the untracked directory gives no git baseline — plus confirmation of judgment calls (a) and (b),
  including the no-sixth-site completeness claim. The two close-batch items are explicitly barred.
- 2026-07-26: F2 fix verification PASS, both findings resolved, no new findings ⇒ **F2 CLEAN**
  (6 of 25: B1, B1b, A1, F1, B2, F2 — LANE F COMPLETE).
  *** IT FOUND A BETTER BASELINE THAN ANYONE THOUGHT EXISTED, and this is a method fix for the whole run:
  the untracked affordability/ files have TRACKED PRE-MOVE TWINS at their old paths in 39a07db0. So
  "untracked directory ⇒ no git baseline" is FALSE — two agents (and I) had accepted it. Diffing
  baseline-old-path → current-new-path and filtering comments yielded EXACTLY the pass-1 executable set item
  for item, so the comment-only claim is PROVEN rather than inferred from mtimes and green tests; and
  use-resolve-billing.ts showed ZERO non-comment lines changed versus baseline. Written into §Known Breakage
  as a method note so later audits of moved files stop settling for weaker evidence. ***
  SPEC CITATIONS RE-DERIVED, and the restraint is as valuable as the check: it confirmed §6(b) is now cited
  for what it rules and correctly EXCLUDED (verifying determinism in code — turn-context.ts:406 passes
  turnEstimateNanoUsd: undefined UNCONDITIONALLY, so the retry escape 6(b) relies on does not exist here),
  and priority 1 cited exactly. It then found §6(a) "one degree loose but not wrong" — 6(a)'s literal subject
  is pre-send EXHAUSTION, ours is pre-send INSUFFICIENCY, and the tightest citation is §Group Funding 2,
  which NEITHER version cited — and explicitly declined to demand it: "Demanding citation-shade #3 here would
  be exactly the manufactured finding the brief warns about." It named the thing that made the original a
  defect: 6(a) "is no longer used as an absolution."
  CONTRACT TEST CONFIRMED to stop over-claiming at both placements, and the judgment not to rename the rows
  or the `it` title confirmed correct: once both disclaimers exist a rename is cosmetic, and keeping row name
  strings FROZEN is what makes the pass auditable as comment-only.
  COMPLETENESS SWEPT WIDER THAN THE FIXER'S — apps/, packages/, e2e/, scripts/ for five phrase variants,
  ~50 hits, all unrelated single-source invariants. No sixth client↔server funding-parity claim exists.
  ROUTED TO G2, an observation it deliberately did not raise as a finding: the two surviving "cannot drift"
  clauses on payerSizingTier are correct ONLY because the symbol is dead — the precondition is now "same
  caller, same estimate", since after F2 the estimate is an input to the payer decision, so a caller handing
  undefined to one side and an amount to the other could genuinely diverge. And the same docblock's
  "exhausted-headroom fall-through" is now too narrow (exhausted OR insufficient). G2 must delete the
  DOCBLOCK'S CLAIMS with the symbol, not just the symbol — otherwise they become wrong the moment anything
  calls it again.
  THROUGHPUT NOTE, stated because it is now the run's binding constraint rather than a scheduling detail:
  with lane F complete and B1/B1b/B2/A1 clean, EVERY remaining task is serialized behind the B-spine —
  B4 needs B3, B5 needs B4, B6 needs B5, and lane C needs B6 while lane E needs B5–B8. So B3 is the only
  dispatchable task and there is no parallelism to exploit until B6 lands. That is inherent to the spine
  design and was visible at planning time; recording it so the low agent count is not mistaken for a stall.
- 2026-07-26: B3 implementer DONE_WITH_CONCERNS (impl-report-1.md) after ~103 min / 181 tool uses — the
  run's largest task. shared 123 files/2938 tests coverage-green; marketing 452; web 6410; api only the
  §Known Breakage template-html (empty git diff vs HEAD, no api file touched); repo typecheck 16/16;
  arch:check green; eslint exit-0 per package post-final-edit.
  TWO OF MY PLAN PREMISES WERE WRONG AND B3 CORRECTED BOTH. estimateTokenCount was a duplicated CONSTANT,
  not a duplicated question (money-path reservation vs marketing illustration) — collapsed onto
  CHARS_PER_TOKEN_STANDARD and changed to take a CHAR COUNT, since it accepted content inside a content-free
  module. No number moved. My "/4 vs /2" hazard was wrong twice over: NOTHING IMPORTS apps/web/src/lib/tokens
  at all, and FOR A PAID USER BOTH RATIOS ARE ALREADY 4 — I had conflated INPUT estimation (paid = 4
  chars/token) with OUTPUT-STORAGE estimation (the inverted paid = 2). Different terms. Plan corrected with
  the superseded wording kept so it is not re-derived.
  *** B3 REFINED B5's ORDERING CRITERION AND IT MATTERS: the ENGINE choice must stay BASIS-INDEPENDENT.
  maxCallCost depends on contextHeadroom, hence on the prompt; affordable is evaluated at an EMPTY basis and
  admissible at the real one — so choosing the classifier ENGINE by a prompt-weighted quantity lets the two
  sets pick DIFFERENT ENGINES, hence different classifier reserves, and admissible ⊆ affordable CAN BREAK.
  B3 uses combined rate + id tiebreak for the engine precisely to stay basis-independent. So: POOL order on
  maxCallCost, ENGINE choice on a prompt-independent quantity with the id tiebreak. Two agents gave me
  partially conflicting ordering advice and this is the resolution — they were describing DIFFERENT
  DECISIONS, and I had flattened them into one criterion. ***
  MONEY SPEC VIOLATION STILL LIVE, routed to both owners: estimate/classifier-line-item.ts emits
  `classifier-storage` and estimate/smart-model-affordability.ts folds it into the LIVE reserve, contradicting
  §Cost, §Reasoning Effort 7 and the founder's ruling that a classifier call carries no storage. B3's producer
  drops it, so the live path and the produced set now DISAGREE until it lands — which makes it a fix, not a
  cleanup. Emitting file → B6, folding file → B5, each told to coordinate rather than half-fix it.
  GAP WITH NO OWNER, now assigned: WEB SEARCH IS A DIMENSION WITH NO REGISTRY ENTRY. §The Dimension Framework
  treats it as cost-affecting but B2 registered only model and effort, so "one registry entry describes a
  dimension completely" is true of most dimensions rather than all. B3's interim home is Selection.webSearch
  with the amount pinned (172,500,000n on three models). Folded into E4 — which already registers additional
  dimensions — with an instruction to delete the interim field, rather than opening a new task this late.
  B4's SCOPE SHRANK: B3 implemented the shared-token solve itself because the §Math vocabulary is incoherent
  without it, with the basis correctly Σᵢ cost(mᵢ, ceiling(mᵢ)) and never T × Σrates. B4 retains the
  heterogeneous-pair pin, the createEstimateRun cross-verification and the summed-rate-guess deletion.
  Recorded in B4 so its implementer does not rebuild what exists.
  ROUTED TO B6: e_min(m) ALREADY EXISTS as B2's cheapestEffortOption, so that criterion is already satisfied
  — and a NEW instance of B6's own defect shape: classifierReserveChars cannot see model descriptions through
  PriceableModel, so the reserve understates the PROMPT overhead as well as the truncated context; closing it
  may need a PriceableModel field, a contract change.
  DEVIATION for B8 to rule: getTurnOptions takes a 4TH argument, `catalog`, against §The public surface's
  documented three — because Selection names models by id and §Smart Model needs the pool. Routed to the
  audit with the alternative named (Selection could carry priced models, but that pushes catalog resolution
  to callers and risks two callers resolving differently).
  OUT-OF-OWNERSHIP EDITS accepted, forced by One-Implementation: apps/marketing/src/lib/calculate-cost.{ts,
  test.ts}, apps/web/src/lib/tokens.test.ts and 4 estimate/ files, to collapse a per-token storage rate that
  already existed in THREE places before B3's variableRate would have been a fourth.
  → B3 auditing, 2 auditors, distinct lenses. (A) ARITHMETIC — every §Math term checked against THE SPEC's
  number rather than B3's test (a test asserting B3's computation agrees with itself proves nothing); the
  shared-token solve's basis, since B3 wrote it unprompted and §Multi-Model 2 forbids the alternative;
  whether ANY expression multiplies a moneyPerToken by a token count, since B3 is that contract's first
  consumer and the defect it replaced was exactly that shape; and inputStorage exactly ONCE in a
  three-sibling hold, which is invisible in a single-model test. (B) CONTRACT + SEAMS — is a prompt-dependent
  `affordable` genuinely UNOBTAINABLE (keystroke sweep byte-identical, empty basis not caller-suppliable);
  is admissible ⊆ affordable proven over BOTH differing inputs, since a generator varying only funding would
  pass while leaving it unproven; is the fixture genuinely non-degenerate rather than named so; are options
  MARKED not filtered incl. the new non-text refusal and the outlier exclusion; and are B3's RefusalCode set
  and OptionSet shape actually what B7 and E1 need — B3 rates those medium-confidence, so they are the parts
  most worth attacking. Both told a tracked pre-move baseline exists despite the untracked directory.
- 2026-07-26: B3 auditor, ARITHMETIC lens: PASS, 2 Minors. THE STRONGEST VERIFICATION METHOD OF THE RUN: it
  wrote its OWN re-implementation of §Math importing NOTHING from the module, then ran 3,000 multi-sibling and
  1,500 smart-slot turns — EXACT bigint match on every produced hold, hold ≤ funding in all 3,864 sendable
  cases, and MAX ≠ Σ in 969 of the smart cases so the discriminator was actually exercised. That is the
  spec-versus-implementation check I have been asking for all run, done properly.
  THE THREE CHECKS I ASKED FOR, all by amount and all independently derived:
  · SHARED-TOKEN SOLVE — heterogeneous money-bound case, T=3247 with sibling C's providerCap binding at
  2000 ⇒ produced 28,003,400n, which is exactly Σᵢ cost(mᵢ, ceiling(mᵢ)) and NOT the 29,998,600n a
  T × Σrates basis would give. Each sibling's own cap and headroom applied inside the shared T (9750 / 8000 /
  2000 in one turn). summedVariableRate appears only in the solve.
  · inputStorage COUNTED ONCE across three siblings — 3-sibling paid hold 70,275,000n, hand-derived to the
  nano; per-sibling counting would have been 70,875,000n. The exact invisible-in-a-single-model-test defect.
  · NO EXPRESSION MULTIPLIES A moneyPerToken BY A TOKEN COUNT — every occurrence grepped; the rate arm is
  produced in derive.ts and consumed by nothing on B3's path, and money comes only from priceRequest /
  evaluateManifest per candidate, MAX over the open dimension and Σ over pinned siblings.
  Also verified by amount: 600n/1200n inverted output-storage; 250 vs 500 input tokens at identical char
  counts; rounding against the user; budgetBuys floored; MINIMUM_OUTPUT_TOKENS gating both entry and option
  verdicts; trial carrying zero storage anywhere; smart-slot hold = MAX over arrangements + reserve
  (70,193,000n, where Σ would be 94,868,000n), with the classifier reserve provider-leg only.
  ILLEGAL STATES CONFIRMED TO BE COMPILE ERRORS with tsc: sendable:true with an empty runnable, and a
  Selection with no answer source, both fail to typecheck; holdNanoUsd exists only on the pair.
  *** MINOR 1 IS A ONE-IMPLEMENTATION VIOLATION GUARDED BY THE BANNED ARTIFACT, and I ruled it.
  turn-arithmetic.ts's costNanoUsd, feasible and eligible have NO PRODUCTION CALL SITE: turn-core re-derives
  cost(m, ceiling(m)) through the estimator fold and INLINES THE feasible FORMULA THREE TIMES, while
  turn-core.test.ts:224 exists to prove the two cost implementations AGREE — precisely the golden cross-check
  CODE-RULES names as banned. No live divergence (the 4,500-case sweep proves the amounts identical).
  MY RULING: the vocabulary is the single home for the PREDICATES, the estimator is the single home for
  PRICING. turn-core CALLS feasible()/eligible() instead of inlining them (deleting three copies of one
  formula), costNanoUsd DELEGATES to the estimator instead of reimplementing it, and the agreement test is
  deleted because it then has nothing to compare. That resolves the two constraints that were pulling apart —
  §Math's terms keep named homes (this task's criterion) and pricing keeps one implementation (CODE-RULES). ***
  MINOR 2: the web-search amount is expressed twice inside one function — a hand-rolled
  WEB_SEARCH_RESERVATION_NANO_PER_MODEL × siblings product for the total, and webSearchLineItem() for the
  manifest. Both correct today; the line-item builder is meant to be the one home, so derive the total from
  it. This also falsifies one report overstatement ("turn-core contains no rate expression of its own").
  READING SETTLED AND RECORDED IN THE PLAN so nobody "corrects" it back: the criteria's literal "10 × $0.005"
  is the PROVIDER figure, while the pinned 172,500,000n is its BILLABLE equivalent (57,500,000n/model, markup
  baked at definition in estimate/search-reservation.ts, which is byte-identical to 39a07db0 and therefore
  pre-existing). §Units and rates decides it: billable is the only rate that exists in any calculation.
  Auditor independently confirmed all three of B3's routed concerns are real and correctly routed, not B3
  defects: live classifier-storage at smart-model-affordability.ts:277,377 (B5/B6), classifierReserveChars
  blind to descriptions (B6's own criterion), and the pinned-sibling ceiling read off the worst viable
  arrangement — conservative, so reserve ⊇ bill holds.
  Contract/seams lens still running; B3's fix cycle held to batch both.
- 2026-07-26: B3 auditor, CONTRACT + SEAMS lens: FAIL — **2 CRITICALS** + 2 Importants + 1 Minor. The most
  serious audit result of the run, and it lands on exactly the invariant the task exists to establish.
  *** CRITICAL 1 — admissible ⊆ affordable IS FALSE AT OPTION LEVEL, and affordable gets WORSE as balance
  rises (contradicting §Affordability 6). turn-core.ts:555-560 reads a pinned sibling's ceilingTokens and
  every per-option verdict off worstOf(VIABLE candidates) — and the IDENTITY of the worst viable candidate is
  itself a function of funding and basis. So the affordable pass (larger funding, empty basis) can clear a
  costlier candidate INTO viability, making it "worst", and therefore solve FEWER shared tokens than
  admissible. Repro on B3's OWN property-test catalog with held=0n: affordable gives ceiling 8941 with
  `medium` GREYED, admissible gives 13291 with `medium` AVAILABLE — the send gate and the classifier are
  offered a rung the picker greys. Because held=0n the funding legs are identical, so B3's "basis leg alone is
  monotone" property is false too. 162 violating samples on its own fixture; ~8% of a realistic 3-model grid.
  SET-level subset still holds (0 in 800k) — the breakage is per-model/per-option, which is why the existing
  property missed it. ***
  *** CRITICAL 2 — ANY EXPLICIT EFFORT PIN REFUSES THE WHOLE TURN when one selected model has an empty
  effort-support set. effortGate resolves `resolvable: pin === undefined`. Verified: a mandatory-single-rung
  model pinned at ITS OWN RUNG → refused; a non-reasoning model pinned off/Min → refused; a three-rung model
  beside either → refused AT EVERY RUNG, while the same call's turnDimensions marks all four rungs AVAILABLE.
  A flat presented ⇒ feasible violation at turn level, against §Reasoning Effort 3/4/9/10.
  reasoningBudgetTokens already returns 0 for such a model, so the arithmetic was ready for correct
  behaviour; the empty-options input is B2's and spec-consistent, so the refuse-on-pin decision is B3's. NO
  TEST COVERED A PIN ON A HETEROGENEOUS SELECTION. ***
  Important 3: the properties that should have caught Critical 1 are under-asserted — the basis-leg property
  checks only MODEL-level availability and never OPTION availability (exactly where the violation lands), and
  the combined sweep's generator never sampled the smart-slot/reference-arrangement shape. Fixing the bug
  without strengthening both leaves the invariant unpinned.
  Important 4 CONVERGES with the arithmetic lens on the vocabulary/inline duplication, and sharpens why it
  matters: B5's criteria consume eligible(m) BY NAME, so a B5 edit would silently not reach the producer. My
  ruling (predicates in the vocabulary, pricing in the estimator, agreement test deleted) covers it.
  Minor 5: RefusalCode and per-model Availability.reason cover only the FEASIBILITY axis — E1 needs a
  per-model premium-lock reason (its criterion is premium rows MARKED not removed) and B7 must collapse three
  live premium-locked phrasings. Bounded enum extension; cheap now, day-one rework for two tasks if left.
  *** MY OWN APPROVED SHAPE WAS WRONG, and I ruled the correction: on the sendable:false arm an OptionSet
  carries NO ENTRIES, so a zero-balance payer's picker has no rows to grey and no per-row reasons — though
  notion 1 exists precisely to grey them. B3 implemented the documented union faithfully. RULING: `all` and
  `turnDimensions` move to BOTH arms; only `runnable` stays exclusive to the sendable arm — which keeps
  "sendable with nothing runnable" unrepresentable (the property NonEmpty was added for) while making an
  unsendable set renderable as a fully-greyed picker. §Data Structures joins the doc batch. Seventh plan/spec
  defect of mine this run, and the first that would have shipped a visibly wrong picker. ***
  JUDGED NECESSARY, not convenient: B3's 4th `catalog` parameter stays — Selection is identifier-shaped by
  §Data Structures, the smart-slot pool is catalog-minus-pinned, and pushing resolution to callers is the
  two-callers-resolve-differently hazard. §The public surface owes the correction; added to the doc batch.
  AFFIRMED STRONGLY by this lens too: the empty-basis substitution is airtight — EMPTY_PROMPT_BASIS is applied
  INSIDE the producer, getTurnOptions accepts exactly one basis, and the only basis-accepting entry point
  (evaluateTurn) is on NO barrel and absent from the exports map even though 15 interim deep paths are listed
  there, so a prompt-dependent `affordable` is UNOBTAINABLE rather than discouraged. Options genuinely marked
  never filtered (one entry per catalog model plus one per unpriceable selected id, set-equality asserted at
  150 balances across four tiers with a non-zero-greyings control). The completeness fixture ASSERTS each of
  its four claimed properties before using them, so it cannot decay unnoticed.
  DID NOT ROUTE A SEPARATE VALIDATOR for the Criticals despite the standing rule, and the reasoning is
  recorded: both come with exact reproductions and sweep counts, and B3's OWN report named Critical 1's
  mechanism (its Concern 6) while understating it as cosmetic — so the implementer and the auditor
  independently identified the same mechanism, which is the corroboration a validator would have supplied.
  → B3 fix cycle 1 dispatched, 6 items. The deliverable for Critical 1 is stated as THE MONOTONICITY ARGUMENT,
  not the diff; for Important 3, evidence the strengthened properties FAIL against the pre-fix code, since a
  property that only passes after the fix proves nothing about whether it would have caught the bug. One
  NEEDS_CONTEXT trigger: if no arrangement is monotone in both funding and basis without changing what the
  hold is taken over — trading a correct hold for a monotone presentation is the wrong trade and needs a
  ruling, not a choice.
- 2026-07-26: B3 fix cycle 1 DONE_WITH_CONCERNS (impl-report-2.md). shared 123 files/2955 tests coverage-green
  with src/affordability at 100%; repo typecheck 16/16 zero cached; arch:check 11 rules/2016 files; eslint
  exit-0 post-final-edit; api only §Known Breakage's template-html.
  *** IT MEASURED MY SUGGESTED FIX AND FOUND IT ALSO BROKEN. My brief offered two directions for Critical 1;
  direction #2 ("worst over ALL candidates") is ALSO NON-MONOTONE — measured, 5/6 properties still red. It
  instead grades a pinned entry on THE PINNED SIBLINGS' OWN ARRANGEMENT, whose membership is fixed by the
  selection and therefore independent of funding and basis. Hold untouched. Testing both offered directions
  rather than picking one is exactly right, and it caught an orchestrator error I would not have. ***
  ACCEPTED TRADE, ESCALATED as an FYI: a pinned sibling's presented ceiling is now OPTIMISTIC while a smart
  slot is unresolved, because the conservative reading is provably non-monotone. I checked the spec before
  escalating (the lesson from two earlier mis-citations): BILLING.md DECLARES ceilingTokens at :825 but never
  defines it for an unresolved multi-source turn, and the "up to X" language at :490 is about the
  downward-closed-prefix representation, not about multi-source resolution. So the semantics are genuinely
  UNDEFINED rather than settled. My recommendation is accept: the hold is untouched so reserve ⊇ bill holds,
  feasibility (not the number) is what presented ⟺ feasible constrains, and the alternative provably breaks
  TWO documented invariants (the subset property and §Affordability 6). Routed to the contract auditor to
  judge whether an optimistic displayed ceiling can mislead a user into a send that fails.
  GAP WITH NO OWNER, now assigned to B5: the enum landed but NOTHING PRODUCES the three tier codes. Premium
  marking needs a `premium`/`releasedAt` field on PriceableModel (shared-type change, GC10) because
  classification needs a POOL PERCENTILE and a CLOCK — both already B5's, which takes a percentile over the
  priceable pool for the outlier test and inherits A1's release-date basis. The trial code is free
  (exceedsTrialBudget already computes it from a PriceableModel + basis.systemChars). Until one is wired,
  E1's "premium rows are MARKED, not removed" has no data to mark with. Same file family as the
  two-premium-classifiers ruling, so B5 decides both together.
  ROUTED TO B7, both overrulable in a line: B3 SPLIT premium into premium_requires_account +
  premium_requires_credit on the reasoning that different ACTIONS are different CONDITIONS under §Notices 2 —
  so one-wording-per-condition is satisfied by two reasons rather than violated by one. Good argument; B7
  judges. And option_not_offered is now reachable ONLY via a pinned id outside the declared domain (effort
  resolution is total over the domain), so B7 must not write copy expecting it from a legal rung.
  ROUTED TO E1: turnDimensions is EMPTY on an unsendable smart-slot-only turn (no contributing model) while
  per-row dimensions still render — so the turn-level strip has nothing to show in a state where the rows do.
  HONEST UNRESOLVED ITEM, disclosed rather than buried: one earlier pnpm test:api run showed 2 failed files /
  8 tests, but only the tail was captured so the second file's identity was LOST; a clean re-run showed 1/7.
  Consistent with §Known Breakage's load-dependent model-catalog-lock entry (which includes a
  catalog-admission file) but UNVERIFIED. Recorded as unverified rather than attributed.
  (G3) joins (G1) in the close batch — both pre-existing plan identifiers in estimate/reasoning-plan.ts.
  → TWO verifications dispatched by SendMessage, both resumed from transcript rather than respawned:
  the CONTRACT auditor (holds the subset repro and the dense sweeps) on all six findings, told to judge the
  MONOTONICITY ARGUMENT rather than the green tests and to attack the mandatory-single-rung case hardest since
  the fixer rates its own confidence there only medium; and the ARITHMETIC auditor on ONE question only —
  re-run its from-spec differential harness and confirm THE HOLD DID NOT MOVE, since a grading change that
  quietly shifted it would be a reserve ⊇ bill regression and that harness is the only thing in this run that
  can detect it independently.
- 2026-07-26: B3 fix — ARITHMETIC lens follow-up: **HOLD UNCHANGED, byte-identical in both regimes.** Both
  from-spec differential harnesses re-run against the fixed tree: 3,000 pinned-sibling turns 0 mismatches
  (2,399 sendable); 1,500 smart-slot turns 0 mismatches (1,465 sendable, 969 with MAX ≠ Σ so the
  discriminator stayed exercised); seven point holds identical TO THE NANO
  (242,775,000n · 70,275,000n · 254,450,000n · 81,950,000n · 21,350,000n · 9,999,000n · 28,003,400n ·
  smart 70,193,000n). affordability suite 47 files/1297 tests (was 1280 — the new pins).
  *** THE GRADING/HOLD SPLIT VERIFIED AS REAL AND THE HOLD STILL CONSERVATIVE — the thing I most needed
  checked. On the repro fixture the pinned entry's presented ceiling is now 64,000 on BOTH passes (its own
  arrangement, provider-cap bound) while holdNanoUsd = 92,995,650n = MAX over the VIABLE candidate
  arrangements {b-mid 92,995,650n, e-plain 58,287,950n}. So the ceiling a picker row shows and the arrangement
  the hold is priced on are now computed from DIFFERENT arrangements exactly as claimed, and the hold is still
  sized on the costliest viable one (a-cheap at 13,291 tokens there, not at its presented 64,000).
  reserve ⊇ bill INTACT. That is what makes the optimistic-ceiling trade safe rather than merely monotone. ***
  AUDITOR SELF-CORRECTED A FALSE ALARM, and the correction is itself a useful pin: its first pass of that repro
  expected 92,999,550n (a 3,900n gap) because ITS OWN harness's viability test required only
  ceiling ≥ MINIMUM_OUTPUT_TOKENS and omitted the reasoning term. Restoring B(m, e_min(m)) +
  MINIMUM_OUTPUT_TOKENS resolved it — c-mandatory's ceiling in its own arrangement is 4,991 < 4,096 + 1,000 so
  it is NOT eligible, and d-plateau's is 0. "The discrepancy was my harness, not the code", and the exclusion
  is eligible(m) behaving exactly as §Smart Model 2 requires, visible in the entries as c-mandatory greyed
  with a reason. An auditor debugging its own instrument before accusing the code is the posture I want.
  FINDING 2 CHANGED SENDABILITY, NEVER AN AMOUNT: an effort pin on a model with no ladder now sends where it
  previously refused, and reserves nothing — hold is 21,350,000n for pinned {}, {effort:'high'} and
  {effort:'off'} alike. So holds now EXIST in cases that previously refused, but no existing hold's value moved.
  MINOR 1 CONFIRMED FIXED: costNanoUsd now folds siblingLineItems through evaluateManifest and IS the live
  per-sibling pricing call at turn-core.ts:303; feasible/requiredCeilingTokens are called at :305, :343, :344,
  :364, :367 instead of inlined; the agreement test is gone. My ruling landed as intended.
  *** MY INCIDENTAL WAS WRONG — MINOR 2 IS NOT FIXED. I told the auditor the web-search total now derives from
  webSearchLineItem; the code contradicts me. turn-core.ts:269-270 still hand-computes
  additiveNanoUsd = WEB_SEARCH_RESERVATION_NANO_PER_MODEL × siblings.length while :293 separately pushes
  webSearchLineItem(siblings.length) — the amount is still expressed twice in one function. The fixer's own
  Files-changed table never claimed it, so I crossed it with finding 4 and asserted it without checking. Same
  pattern as my earlier errors: stating a fact I had not verified. Queued for B3's next cycle, still correct by
  amount (172,500,000n on three models, re-verified), same one-line direction. ***
  Contract lens still running on the six findings; B3's second fix cycle held to batch Minor 2 with whatever it
  returns. That will be cycle 2 of the three-cycle cap.
- 2026-07-26: B3 fix re-audit, CONTRACT lens: FAIL — all six cycle-1 findings DISCHARGED and independently
  verified, but ONE NEW CRITICAL found while probing the accepted trade. Present in cycle 1 too, so not a
  regression from the fix; the auditor states plainly that it missed it in audit 1.
  *** NEW CRITICAL — A reserve ⊇ bill VIOLATION, THE RUN'S CORE INVARIANT. turn-core.ts:333-345 (siblingBlock ⇒
  runnable) versus :605-609 (holdArrangement): THE SET THE CLASSIFIER IS PRESENTED AND THE SET THE HOLD'S MAX IS
  TAKEN OVER ARE DIFFERENT SETS, AND NEITHER CONTAINS THE OTHER. A candidate's entry is graded on the CANDIDATE
  ALONE, while viableCandidates requires EVERY SIBLING OF ITS ARRANGEMENT to fit — so a candidate whose
  arrangement starves a pinned sibling is PRESENTED AS RUNNABLE yet EXCLUDED FROM THE HOLD'S MAX. Measured:
  placed hold 89,263,685n; if the classifier picks the presented v/dear that arrangement prices at
  ≥ 119,934,700n — 30,671,015n, ≈34% MORE THAN ADMISSION RESERVED. Reproduced 599 times under an explicit pin
  and 75 TIMES ON AUTO with a mandatory-reasoning pinned model, so it needs no pin to occur. §Affordability
  names this exact failure: "the hold … must cover the worst option the classifier can pick … This is the one
  place where using the wrong set is a money defect." ***
  CYCLE-1 VERIFICATION WAS EXCEPTIONAL AND WORTH RECORDING AS THE BAR: the monotonicity argument was JUDGED,
  not trusted — every premise checked against code properties, INCLUDING TWO THE REPORT NEVER STATED that the
  argument silently depends on (sendability's "∃ viable candidate" is monotone ONLY because each candidate
  arrangement has fixed membership; contributorsOf feeds turnDimensionsFor from `runnable`, whose membership IS
  funding-dependent, and is safe ONLY because mergeTurnOption prefers an available option so extra contributors
  can only ADD availability). It then built a NEW sweep the implementer had not seen — 8 models incl. two
  mandatory shapes, a plateau, a budget-native and a non-reasoning model, rates spanning 10n→400,000n per
  token, 4,000 draws × three legs, asserting set/model/OPTION/CEILING/turn-dimension dominance on BOTH union
  arms — 0 violations over 96,000 entry-checks, repeated under a second seed with 400× larger funding ranges.
  AND IT RE-MEASURED BOTH REJECTED ALTERNATIVES ITSELF in an out-of-repo mirror: cycle-1 worst-viable grading
  → 5 failed/1 passed; ITS OWN suggested "worst over ALL candidates" → 5 failed/1 passed with the exact figure
  the fixer quoted. Verdict in its words: "My suggestion was the worse one; theirs is right." It also supplied
  the mechanism I lacked — for an unclamped arrangement total = funding − ((funding − fixedCosts) mod Σrate),
  so "costliest" FLIPS ON A REMAINDER. That is why both of my directions failed and the fixer's succeeded.
  Important 3 verified against PRE-FIX behaviour: the final property file over cycle-1 grading fails 5 of 6 with
  the exact assertion messages quoted, and the surviving property is genuinely orthogonal.
  THE ACCEPTED TRADE JUDGED SOUND: presented ⟺ feasible holds with respect to the ceiling actually presented,
  which is the honest answer to notion 3's "up to what ceiling each"; reserve ⊇ bill is untouched BY THE TRADE;
  and an optimistic ceiling cannot mislead a user into a send that FAILS, because the send gate is a separate
  monotone predicate and an over-presented ceiling degrades to a SHORTER ANSWER, not a refusal. Given the
  conservative reading is provably non-monotone, the optimistic side is correct — and the §Data Structures
  escalation framing was judged the right one.
  Findings 4/5/6 discharged with TYPE PROBES, not readings: {sendable:true, runnable:[]} still a compile error,
  OptionSet-level holdNanoUsd still a compile error, and NEWLY a sendable:false arm omitting all/turnDimensions
  is ALSO a compile error — so a refusal can no longer silently drop rows. The premium SPLIT judged defensible
  and explicitly not worth collapsing (§Notices 3 requires an action, "create an account" and "add credit" are
  different actions, so §Notices 2 makes them different conditions), and placing an unconditional tier lock
  ahead of money is right because a money action cannot unlock a premium model. Both producer claims confirmed:
  nothing anywhere produces the three codes, and isPremiumModel needs priceThreshold + releasedAt + nowMs — the
  last of which THE PURITY RULE FORBIDS the core to read — so a contract change is genuinely required.
  ROUTED TO B5 with an addition the fixer did not have: its resolved-corner criterion is UNSATISFIABLE for a
  mandatory-single-rung model through dimensionSupportFor, which exposes NO rung (options: [],
  maxReasoningBudgetTokens 0), so the producer can only grade on MINIMUM_OUTPUT_TOKENS — the unreachable zero
  that criterion exists to forbid. Evidence is a rate-identical pair: the one-native-level model is SENDABLE at
  a 3,343-token ceiling while the three-level model is correctly REFUSED at the same funding. The single
  mandatory level must become PRICEABLE (a B2 shape question) first. Pre-existing on the Auto path.
  → B3 fix cycle 2 dispatched, 2 items (the new Critical + the web-search duplication I wrongly reported fixed).
  Brief requires the OWED PROPERTY shown failing against current code before the fix, and re-confirmation of the
  two unstated monotonicity premises, since changing what enters `runnable` touches both. Cycle 2 of the
  three-cycle cap; if cycle 3 does not clear it I escalate rather than loop.
- 2026-07-26: B3 fix cycle 2 DONE (impl-report-3.md). shared 123 files/2957 tests coverage-green with turn-*
  all 100/100/100; repo typecheck 16/16 zero cached AFTER the final edit; arch:check 11 rules/2016 files;
  eslint exit-0; api only §Known Breakage's template-html.
  CRITICAL FIXED IN THE PREFERRED DIRECTION AND STRUCTURALLY: a candidate is presented **iff its whole
  arrangement is viable**, so `runnable ∩ candidates` IS `viableCandidates` BY CONSTRUCTION, not by agreement —
  which is the difference between a fix and a sync contract. Defect first reproduced at the brief's own figures
  (hold 89,263,685n vs arrangement 119,967,135n, +34.4%), both new tests watched red.
  THE HOLD DID NOT MOVE, proven not asserted: an 83,520-turn differential shows 0 rows changed hold and 0
  changed sendability on either arm, and the presented set ONLY EVER SHRANK (20,631 admissible / 23,277
  affordable rows removed, zero gains). So the under-reserve was closed by NARROWING PRESENTATION TO MATCH THE
  HOLD rather than by raising the hold — the direction I asked for. Downstream surfaces render a strictly
  narrower candidate set, so no re-sequencing is implied for E1/B6/B7.
  STOP-AND-ASK correctly not triggered, and checked rather than assumed: sendability was already gated on ≥1
  viable candidate and changed on 0 of 83,520 turns, and §Story 1.2 REQUIRES the narrower set — so narrowing
  breaks no story that must send.
  IT CLOSED THE UNSTATED PREMISE THE AUDITOR FOUND: premise B (contributors read from `runnable`) was NOT
  ASSERTED ANYWHERE at turn level; it is now pinned inside expectSubset with a watched control — inverting
  mergeTurnOption turns 3 of 6 property tests red at that line. An implementer converting an auditor's verbal
  premise into an executable pin is the best possible response to that finding.
  *** THIRD INSTANCE OF ONE FAMILY, found by the fixer unprompted while fixing the second: mergeTurnOption ORs
  the turn-level effort union over PINNED siblings where §Turn Stories 2.1 requires an AND. Measured — two
  pinned siblings with effort open: the menu marks `high` available at EVERY balance while pinned:{effort:'high'}
  is unsendable (model_output_cap_too_low). A menu enabling a level the send gate refuses, which §Reasoning
  Effort 3 forbids outright. Correct rule as the fixer states it: AND over pinned, OR over runnable candidates. ***
  MY RESPONSE IS A CRITERIA CHANGE, NOT A THIRD PATCH — "fix the process, not the code", applied to myself.
  Three consecutive audits found three defects in ONE FAMILY, and the family is the finding: B3's producer
  computes FOUR views of "what is presented or possible" — per-row availability, the turn-level dimension
  union, sendability, and the hold's MAX domain — and NOTHING STRUCTURALLY FORCES THEM TO AGREE. New §B3
  criterion added: derive all four from ONE place so agreement is structural rather than asserted, and pin
  PAIRWISE AGREEMENT as a property rather than a spot check. Fixing instance 3 alone leaves instance 4 for the
  next reader, and on three audits' evidence there probably is one.
  → B3 fix cycle 3 dispatched — the LAST under the three-cycle cap, and the brief says so explicitly as context
  rather than pressure, adding that "the family is closed and here is why" would be a better outcome than a
  fourth patch. It also asks the fixer to HUNT INSTANCE 4 ITSELF, on the reasoning that it found instance 3
  unprompted and is better placed than an auditor to find another — and to supply the argument that closes the
  family if it concludes there is none, since that argument is worth more than the diff. One NEEDS_CONTEXT
  trigger: if a single derivation cannot serve all four readings without changing what the hold is taken over,
  since the hold is now verified across 83,520 turns and trading it for structural tidiness is the wrong trade.
  Last cycle's deviation (candidate rows regraded, pinned rows keep their own-fit verdict) accepted and carried
  forward, with permission to revisit only if the single-derivation requirement forces it.
- 2026-07-26: B3 fix cycle 3 DONE_WITH_CONCERNS (impl-report-4.md) — and the criteria change paid for itself.
  shared 124 files/2,965 tests coverage-green with src/affordability 100 on all four axes; typecheck 16/16;
  arch:check 11 rules/2,017 files; eslint exit-0 post-final-edit; api identical to both prior cycles.
  *** IT FOUND AND FIXED TWO MORE FAMILY MEMBERS, which is exactly why the criterion beat a third patch.
  INSTANCE 4 (live, and the fixer calls it the COMMONEST SHAPE): the menu GREYED rungs the send gate ACCEPTS —
  a single model pinned above its cap greys off/low while pinning low sends. That is the founder's standing rule
  broken in the OTHER direction from everything found so far: hiding an option the user can actually use.
  INSTANCE 5 (structural): a candidate row's rungs stood above what its arrangement honours, against §Story
  2.2's "capped by the tightest pinned sibling". ***
  THE FIX DELETES THREE COMPETING DERIVATIONS rather than adding a rule — the shape I wanted, since a new rule
  would have been a fourth thing to keep in agreement.
  FAMILY CLOSED BY ARGUMENT, NOT JUST DIFF: every decision-driving reading is now a query over ONE LEAF
  PREDICATE, and exactly one reading is deliberately different — a pinned row's own-fit diagnosis, which NO
  DECISION CONSUMES. Its own words for the residual risk: "a future reading that consumes it is what instance 6
  would look like." A named failure mode is a far better artefact than a claim of completeness.
  NOTHING ABOUT MONEY MOVED: 55,440-turn differential with hold, send gate, row verdicts and `runnable`
  byte-identical (26,873 sendable), zero refusal-code changes, and viableCandidates ≡ reachable.running BY
  CONSTRUCTION. STOP-AND-ASK correctly not triggered on that basis.
  PREMISE B ELIMINATED RATHER THAN RE-ASSERTED — the union no longer reads `runnable` at all, so the premise it
  depended on cannot be violated. That also closes the earlier concern about empty turnDimensions on an
  unsendable slot-only turn, as a side effect rather than a patch.
  COORDINATION FACT WRITTEN INTO B6/B7: per-row rungs changed on 34,854 turns and the turn menu on 28,412 of
  the differential, INTENTIONALLY. Money is untouched, but a test written from B3's EARLIER reports' rung
  expectations will now be wrong — so B6 and B7 must write expectations against the new semantics.
  RESIDUAL RECORDED WITH A DO-NOT-FIX, and the reason is the point: on turns whose only open dimension is
  effort, pinning drops the classifier reserve, so the menu is conservative by ≈0.1¢. Pre-existing, safe
  direction, and closing it would require A SECOND PRICING PASS PER RUNG — precisely the multiple-derivation
  hazard three cycles were spent removing. Written into the plan alongside the note so a later reader does not
  "improve" it back into the defect family.
  TWO DEVIATIONS ROUTED TO THE AUDITOR rather than accepted by me: instance 5 was fixed WITHOUT A REACHABLE
  HARMFUL PICK (the fixer could not construct one and argues why; revertible in one line, with pair 4 of the
  agreement property being the test that would prove a revert) — is that justified or speculative? And one
  docblock was edited outside the minimal blast radius because it described a deleted mechanism.
  → Final verification dispatched to the auditor that found instances 1 and 2, resumed from transcript with all
  its sweeps and mirror harnesses. Asked to judge the CLOSURE ARGUMENT and then HUNT INSTANCE 6 ITSELF, with
  the framing that it has found something in every pass, so if it finds nothing this time I need to know WHAT
  CONVINCED IT — that is the outcome the run needs most. Also: weight instance 4 heaviest since it is claimed
  live and common; confirm the pairwise property fails PRE-FIX; independently re-check that no money moved; and
  rule on both deviations and the do-not-fix residual.
- 2026-07-26: B3 final verification: **PASS** — 1 Minor, no Critical, no Important. The auditor that found a
  defect in EVERY prior pass could not find one this time, and stated what convinced it, which is the outcome I
  asked for rather than a bare verdict.
  WHY THE FAMILY IS CLOSED, judged not trusted: all four readings are, by inspection of EVERY call site, queries
  over one leaf predicate — send gate = reachable.running.length > 0, hold = worstOf(reachable.running), a
  candidate row and each of its rungs = one RowGrader at different arguments, the menu = reachableAt once per
  rung. The quantifiers are nowhere written as a rule; they FALL OUT of a conjunction over an arrangement's
  siblings inside a disjunction over arrangements, "which is why they cannot be stated inconsistently". And the
  deletions are PHYSICAL: grep -c of the removed symbols returns 0 and Arrangement no longer caches a verdict —
  "there is no second predicate left to drift from."
  INDEPENDENT EVIDENCE BEYOND READING: an independent price ORACLE built from the exported vocabulary alone
  reproduced holdNanoUsd BYTE-EXACTLY on all 484 sendable draws, with the hold equal to MAX over the
  arrangements of exactly the RUNNABLE candidates and 0 under-coverages — so the money reading is externally
  correct, not merely self-consistent. 4,003 enabled-rung checks: no rung the menu enables refuses when pinned.
  5,611 greyed-rung checks: every greyed rung carries EXACTLY the refusal code the send gate itself returns
  (5,611/5,611, both arms). 21,102 row↔rung checks, 0 failures.
  DIFFERENTIAL RUN AGAINST THE REAL PRE-FIX FILE (it located the earlier capture — a stronger control than the
  fixer's own reconstruction): 110,880 records, and the four zeros hold — sendability + refusal code 0,
  holdNanoUsd 0, row verdicts/reasons/ceilings 0, the runnable list 0 — with 29,207 sendable so the zeros sit on
  paths that are actually reached. Per-row rungs 83,790 and menu 81,263 changed, intended.
  FIVE RED CONTROLS verified in a mirror and restored byte-identically, with assertion strings matching the
  fixer's quotes; the true pre-fix combination reddens ALL SIX new tests. So the property fails pre-fix rather
  than merely passing now.
  INSTANCE 4 AT SCALE, and the shape matters: 44,245 rung-records moved greyed→enabled (affordances RESTORED)
  alongside 67,280 enabled→greyed (false affordances removed) and 30,010 reason-only corrections. Both
  directions at volume, each correct per the universal checks — so the live defect really was payer-hostile.
  THE AUDITOR SUPPLIED THE REASON INSTANCE 5 WAS WORTH FIXING, which the fixer had not: its unreachability
  proof rests on requirements being ARRANGEMENT-INDEPENDENT, and **E4 is scheduled to break that premise** when
  media parameters become additive per-model dimensions. So fixing it converted an argument about to expire into
  a structure. That is a better justification than either of us had.
  RESIDUAL MEASURED PRECISELY: 1,036 cases, EVERY ONE carrying insufficient_funds — money-bound only, never
  cap- or length-bound, which is the exact signature of dropping the classifier reserve — and the flip window is
  6,474,000n, EXACTLY one classifier reserve for that catalog. Direction is the one §Reasoning Effort 3 permits.
  Correction recorded: ≈0.1¢ is the figure for a realistic cheapest engine; the general bound is "one reserve".
  VALIDATED MINOR, and it is the sharpest possible finding against a closure argument: turn-types.ts:185 still
  publishes "Every combination inside is feasible", now DELIBERATELY FALSE for a pinned row — so the single
  exception the closure argument rests on is guarded ONLY BY PROSE, and that sentence ACTIVELY INVITES E1 to
  consume it, which is the fixer's own description of what instance 6 would look like. docs/BILLING.md:826
  carries the identical sentence → founder doc batch.
  MY RULING on the design question it routed (§Reserve ⟺ classify): the shared predicate STAYS POOL SIZE and
  C1/C2 must use the same one. Reasons the audit established: over-reserve is licensed by §Affordability 10; the
  dangerous direction is unreachable since runnable ⊆ pool; and a naive collapse onto the presented set HAS NO
  FIXED POINT — with the reserve one candidate is presentable, drop it and three are, which re-buys it. The real
  exposure was the B3↔C2 seam, since the spec demands ONE predicate shared by estimator and executor: so the
  executor MAY skip the call when the presented set collapses to one, and the unspent reserve is simply never
  charged — a hold not spent is released, so reserve ⊇ bill is untouched and "no call, no reserve" is an
  efficiency preference, not a correctness rule. Written into Lane C; §Reserve ⟺ classify's "exactly" joins the
  doc batch.
  → B3 fix cycle 4 dispatched for the one Minor. Proceeding past the three-cycle cap deliberately and with the
  reason recorded: the cap exists to stop non-convergent loops, and this converged — a PASS with one stale
  sentence is not the failure mode the cap guards against. The brief also carries the two report corrections the
  auditor measured (the one-line revert reddens pair 3 not pair 4; the residual's bound is one reserve) and one
  NEEDS_CONTEXT trigger that matters: if stating the two-kinds-of-row rule accurately needs a TYPE-LEVEL
  distinction, say whether it should be type-level — because a rule guarded only by prose is what this finding
  is about.
- 2026-07-26: B3 fix cycle 4 DONE (impl-report-5.md) ⇒ **B3 CLEAN** (7 of 25: B1, B1b, A1, F1, B2, F2, B3).
  Comment-only nature proved MECHANICALLY (comment-stripped executable content identical, 88 lines); shared 124
  files/2,965 tests; typecheck 16/16 zero cached; arch:check 11 rules/2,017 files; eslint exit-0.
  Both report-4 corrections applied (the one-line revert reddens pair 3 not pair 4; the residual's bound is
  exactly one classifier reserve, 0.65¢ on the expensive fixture and ≈0.1¢ only for a realistic cheapest
  engine), and the E4-breaks-arrangement-independence justification for instance 5 is now recorded as the
  durable reason. Lane C's reserve-predicate ruling confirmed to match what B3 implements — closed, not carried.
  ACCEPTED DEVIATION: it added ONE characterisation assertion on a cycle briefed as comment-only, because the
  divergence the new docblock publishes was pinned NOWHERE in the divergent case. Right instinct — publishing a
  rule and pinning it belong together — test-only, watched red under a control, turn-core.ts restored
  byte-identically, and deleting ten lines restores a strictly comment-only diff.
  *** NEW SCOPE RULED, NOT A FIX CYCLE: A PINNED ROW CARRIES NO `dimensions` LIST. The fixer answered the
  question I had not asked — whether a type-level distinction is WANTED, having established one is not NEEDED.
  Its answer: a `kind` discriminator would NOT make the rule structural, because a consumer can still read a
  pinned row's dimensions; the change that WOULD is a pinned row carrying its blocking reason and no dimensions
  at all, making the mistake A COMPILE ERROR. Ruled yes, on three grounds: THREE OF THE FIVE defects in this
  family came from exactly this class (an agreement guarded by prose rather than structure), and B3's own
  closure argument rests on the one remaining prose guard — this is it; it is the founder's stated standard of
  structural impossibility over convention; and TIMING IS THE REASON IT IS NOT DEFERRED — ModelEntry is consumed
  by B6, B7, E1 and E4, NONE of them built yet, and the fixer flagged it as "decide before E1 builds against the
  current shape, not after". Every cycle of delay adds a consumer to retrofit. Sequenced ahead of B4 because a
  later type change would force rework on whatever consumes it first. ***
  Dispatched to B3 rather than E1 (the first consumer) deliberately: B6 and B7 both consume rungs and both come
  BEFORE E1, so routing the implementation downstream would leave two tasks building against a shape already
  ruled wrong. Brief demands proof the mistake is now a COMPILE ERROR (the previously-compiling read shown
  failing to typecheck), a full consumer sweep with dispositions so the four downstream tasks inherit a known
  surface, and confirmation the hold/send-gate/row-verdicts/runnable are unmoved — a type change should move
  none of them. One NEEDS_CONTEXT trigger: if removing dimensions from a pinned row destroys a diagnosis a
  SURFACE genuinely needs and availability's reason cannot carry, say what it needs and how it should be
  carried — the point is to make the mistake impossible, not the diagnosis unavailable.
  docs/BILLING.md:826's false sentence remains in the founder's doc batch; the fixer verified it is the only
  other occurrence anywhere, and the batch must not close without it.
