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
