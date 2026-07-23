# Ledger — test-suite-parallelism run

## Locked decisions (human-approved)
- sequence.concurrent: GLOBAL default (all files), root vitest config.
- Dynamic per-file time gate metric: `total/workers` floor — error if a file's duration > K × (total_test_time / worker_count).
- Gate enforcement: BLOCKING error immediately (⇒ giant-file splits must land BEFORE the gate does; K set from post-split measurements so nothing trips on merge).
- NO sequence.shuffle, NO separate order-independence check. Invariant = "tests must pass under our global concurrent config"; a failing test is natural enforcement.

## Hard requirements added by human
- Wall-rule gate: MUST be proven to TRIGGER on a known violator (test-the-test with an over-threshold input) before marked green — not only that it passes clean.
- Gate MUST run naturally on `pnpm test` and ALL variants (test:api/web/... via the turbo test path), not a separate command.
- Reporting cadence: after EACH change, record (a) measured speedup, (b) # tests broken; REPORT to human and PAUSE before any beyond-approved work — fixing broken tests is a SEPARATELY-approved step, never automatic.

## Measurement protocol
- Probe = apps/api/src/slices/identity/routes.integration.test.ts (892s pole).
- Every experiment records: wall time, pass/fail counts (# broken), run 2× for flake, 95% coverage gate stays exact.

## Baselines (measured this session, pre-run)
- api full (coverage): 905s wall (transform 33s, import 530s, tests 1496s summed); parallelism ~1.65×.
- identity/routes isolated: 347s no-cov (cpu 55%) / 892s under coverage (full run).
- deps.optimizer.ssr already landed in packages/config/vitest.config.ts (import 120→54s on probe; ~3% wall; kept).
- argon2id = 227ms (NOT the bottleneck — Tier 1.1 dropped).

## Explicitly DROPPED
per-file test-count cap; istanbul provider swap; viteModuleRunner:false; argon2id/KDF reduction.

## Research findings (Phase 1)
- DOCS: all doc changes go in CODE-RULES.md; propose diff at very end (Phase 4). [human]
- RETRY-WAIT (reshapes plan): the ~13.9s "redis is down" waits are the @upstash/redis client's OWN retry loop (5 retries, ~4.3s/call), NOT cockatiel. Cockatiel backoff clamp = WRONG fix. Real knob = retry:{retries:0} at new Redis() in lib/context/factories.ts:20-25, but needs env-mode plumbing that doesn't exist cleanly (see next) AND may be moot once sequence.concurrent overlaps the waits. DECISION: DEFER retry fix until concurrency+split measured. [Verified: research/retry-wait-source.md]
- ENV-MODE: envUtils (packages/shared/src/env.ts) has NO public isTest/isVitest (isVitest computed but private). Modes: Development|CiVitest|E2E|CiE2E|Production. VITEST forwarding into EnvContext is ad-hoc/inconsistent. Any test-mode auto-clamp requires making isTest public + systematizing VITEST forwarding + threading through *-factory.ts. [Verified: research/env-mode-api.md]

## Research findings (Phase 1) — cont.
- T5 GATE MECHANISM: custom Vitest Reporter (onTestRunEnd(testModules) + testModule.diagnostic() for true worker-occupancy incl import/setup; json reporter UNDERcounts). Worker count via ctx.config.maxWorkers in onInit. Add to shared config `reporters` → runs on every vitest run (pnpm test + variants). No viable community tool. [Verified: research agent]

## Transitions
- human waived plan-approval gate ("execute when ready"); cadence: report speedup+#broken, pause before fixing.
- T1 (concurrency spike) DONE. Config change landed (sequence.concurrent:true, maxConcurrency:12). Probe 347s→124s(run1)/164s(run2) = 2.1-2.8× speedup, cpu~144% (still IO-bound, headroom). Breakage FLAKY: 8 then 21 of 158, back-to-back. Root: shared un-namespaced Redis limiter/lockout keys collide under concurrency (A: 429-vs-200) + 15s timeout blowouts on real-clock-window tests under contention (B: 20/21). Scope ≥21, spans other suites when global. [reported to human]
- SCOPE NOTE: T1 measured ONLY the probe (1 of ~435 api files). Full-suite concurrency breakage unknown & likely larger (billing/admin/chat rate-limit+timing suites). Deferring full-suite enumeration until diagnosis says whether a global harness fix resolves the class.
- Human: do diagnosis first, then dispatch A (proper isolation) unless diagnosis reports a blocking problem.
- DIAGNOSIS analyst DISPATCHED → aa55ca5a1541b4ba6. Why limiter keys collide despite unique accounts; is there ONE global harness knob; isolation options+scope+security-fidelity risk.
- Human: run FULL suite, report ALL errors (total view) BEFORE dispatching any fix. HOLD A until full-suite view reported, even if diagnosis returns clean first.
- FULL-SUITE breakage measurement DISPATCHED → sdd-implementer a5a3cc50720d89e9c. Runs pnpm test:all --continue (concurrency ON, coverage). STILL RUNNING (~60min) — agent armed a monitor; may need SendMessage resume to get the report when suite completes.
- DIAGNOSIS DONE (aa55ca5a). PREMISE CORRECTION: NOT limiter collisions. Domain limiters per-account-unique; probe doesn't mount the shared IP limiter. 20/21 failures = 15s CONTENTION timeouts (OPAQUE crypto CPU queues on ~1.5 cores under 12-wide concurrency). Lone 429 UNEXPLAINED → instrument, don't blind-fix. Real collision class already isolated (house pattern uniqueIp()). Recommendation: config-tune (raise testTimeout + tune maxConcurrency = speedup-preserving; NOT mark-non-concurrent which kills speedup) + per-test-unique-id as standing rule (A ~0-3 files). REJECT global namespace/fake-clock/flush. Security fidelity: only scheduling-only changes are safe. [research/limiter-collision-diagnosis.md]
- HOLDING all fixes until full-suite total view reported to human (human instruction). NOT dispatching original "A isolation" — premise disproven (analyst reported a problem).
- NEXT (pending human, DEFERRED): trial config-tuning (testTimeout+maxConcurrency), re-measure probe ×3. Instrument the 429. Concurrency-breakage FIXES still held pending full-suite total view.
- FULL-SUITE breakage run DID NOT COMPLETE (agent went quiet, no report, no process). Re-dispatch later; the budget-system full run will re-capture it.

## Worker-budget system (human redirected here; build via SDD then PAUSE)
- DB verified: Postgres max_connections=1000 (compose), fsync/sync-commit/full-page-writes OFF already. DB not binding; RAM is. MC LOCKED at 12 (human).
- Design (human-approved): gitignored per-package weight cache scripts/.cache/test-weights/<pkg>.json (already ignored via scripts/.cache/*); AUTO-update every FULL run (no dedicated command); CI keeps own via Actions cache. Weight = Σ test durations (worker-invariant). Solo=full box; Full=weighted budget CORES×1.5. Print allocation. First run/missing → even split; missing pkg → median.
- BT1 (wrapper scripts/run-package-tests.ts) DISPATCHED → a39bd9f66446c98ec (TDD pure fns + e2e on @hushbox/ops).
- BT3 (CI Actions cache for weights dir) DISPATCHED → aec32bb7c15516c2b (parallel, disjoint files).
- BT2 (wiring: vitest.config maxConcurrency←env, package.json test scripts→wrapper, root sets HB_TEST_SCOPE=full) = AFTER BT1 clean.
- Each budget task audited; PAUSE after ENTIRE caching system built+clean (BT1+BT2+BT3, human reconfirmed).
- BT3 DONE (impl). Flag: used actions/cache/*@v4 vs repo's useblacksmith/cache@v5 (convention Q). AUDIT dispatched → ae19c89ba4dc6694d (self-update key correctness, placement, convention, additive).
- BT1 DONE_WITH_CONCERNS (a39bd9f66446c98ec). Pure fns 100% tested, e2e on ops OK, full-writes/solo-no-write confirmed. VALID CONCERN: cold-cache N derived from weight files → N=1 on cold cache → per-package full-budget stampede. SPEC AMENDED: packagesInRun/N authoritative from WORKSPACE (test-having packages), weights only refine shares. Non-issues: --reporter=default+json deviation (good, keeps console); execa preferLocal exec (works w/ or w/o with-env). BT2 coord: wrapper reads HB_TEST_SCOPE/HB_PKG_NAME, sets HB_MAX_CONCURRENCY=12, forwards passthrough args.
- BT1 AUDIT (affebd3b): FAIL, 1 Critical = cold-cache packagesInRun (N=1 stampede). Rest CLEAN (pure core correct, 100% cov not gamed, weight-capture/passthrough/print match). Orchestrator agrees. Latent-note (NOT a finding): npx tsc flags 2 vi.fn mock errors but repo gate tsgo is green → passes by repo standard; awareness only.
- BT1 FIX DONE (a13957e). listTestPackages() enumerates workspace; cold-cache regression watched red(workers=12)→green; @hushbox/ops full run prints workers=2 (budget30÷N≈15). tsgo/eslint green, vitest 25/25, 100% cov.
- BT1 RE-AUDIT dispatched → a611ccd3fa436d4ec (judging cold-cache fix). If clean on that → do the HB_MAX_CONCURRENCY cleanup below → then BT2.
- SPEC AMENDED (human Q): DROP HB_MAX_CONCURRENCY env plumbing — maxConcurrency is a CONSTANT 12, stays hardcoded in vitest.config.ts. Rationale: never varies by scope/package (unlike maxWorkers). BT2 simplified: leave maxConcurrency hardcoded, no config read.
- BT1 cold-cache RE-AUDIT CLEAN (a611ccd3): N workspace-authoritative, cold-cache workers=1 regression pinned, 100% cov, no regressions. Cold-cache fix ACCEPTED.
- BT1 CLEANUP DONE (a4849b6d). HB_MAX_CONCURRENCY grep-gone, 25/25, 100% cov. Flagged pre-existing root typecheck fail (pipeline-bindings.ts ExecutionContext) = other WIP, not this run. LIGHT AUDIT dispatched → a0f7c702e0aaa73c5.
- BT2 dispatched (human: launch now, parallel — disjoint files) → a06d58b48ca19615b. Wire all package test scripts→wrapper (heterogeneous: with-env/not, passthrough flags, ../ vs ../../ depths, config pkg custom --config); root test/test:all set HB_TEST_SCOPE=full; add HB_TEST_SCOPE to turbo passThroughEnv (not cache key); maxConcurrency:12 stays hardcoded. Audit after.
- BT1 CLEANUP AUDIT CLEAN (a0f7c702). BT1 FULLY DONE (impl→cold-cache-fix→cleanup, all audited clean).
- BT2 edits landing (root test/test:all have HB_TEST_SCOPE=full; turbo.json test task passThroughEnv:[HB_TEST_SCOPE]). Awaiting BT2 completion → audit.
- BT2 DONE (a06d58b4). 14 test-having packages routed through wrapper (incl scripts, packages/config); solo ops=workers20, full ops=weight written; maxConcurrency:12 untouched; services/mocks empty, e2e no test. AUDIT dispatched → a881c507686b88781 (completeness + per-pkg depth/passthrough/with-env + scope + passThroughEnv).
- BT2 AUDIT CLEAN (a881c507). PASS no findings. 14/14 routed exhaustively, depths/with-env/passthrough correct, scope+passThroughEnv correct, maxConcurrency:12 hardcoded, zero HB_MAX_CONCURRENCY repo-wide.
- === CACHING/BUDGET SYSTEM DONE (BT1 ✓ BT2 ✓ BT3 ✓, all audited clean). PAUSED per human. ===
- End-to-end verified on @hushbox/ops (solo=workers20, full=weight written). Did NOT run full-suite close: (a) concurrency-breakage still un-fixed (separate held workstream), (b) pre-existing typecheck fail pipeline-bindings.ts (other WIP). Tree not committed.
- STILL OPEN (post-pause, when resumed): concurrency-breakage fixes (held for human review of full-suite total view — full-suite run never completed, re-dispatch); dynamic per-file time gate (T5, custom reporter); CODE-RULES doc (all test-perf docs, propose at very end).

=== RESUME HERE (after compaction) ===
Read plan.md (CURRENT SNAPSHOT) + this ledger + `git status`. Caching/budget system DONE & clean; sequence.concurrent LANDED but suite flaky-red (breakage unfixed). GATING NEXT STEP = re-run the FULL-SUITE total error view (pnpm test:all, concurrency on, --continue, capture all failures grouped by pkg/file) — human wants it before any concurrency fix. Then: concurrency fixes (config-tune, not rewrites; instrument the 429) → split giant files → dynamic time gate → docs. Nothing committed.
- BT3 AUDIT CLEAN (ae19c89b). Self-update idiom correct (unique save key run_id+run_attempt dodges cache immutability; restore-keys prefix restores latest prior; -main- rung warms feature branches). Additive +28/-0. Convention (actions/cache vs blacksmith) judged non-issue — matches adjacent cassette steps. Orchestrator agrees. BT3 = DONE+CLEAN.

--- RESUME (post-compaction) ---
- NEXT-UP #1 DONE: full-suite total error view completed. `pnpm test:all` (concurrency on, --continue), 15m01s.
  RESULT: 408 files / ~3840 tests failed across 12 pkgs (ads/ops cached-pass). Inventory:
  research/full-suite-failure-inventory.md; raw fail-file list: scratchpad/fail-files.txt.
- FINDING (load-bearing, indicts approach): global `sequence.concurrent:true` breaks the FRONTEND
  wholesale — web 2455 / ui 469 / admin 238 / marketing 121 fails = ~3300, all concurrent-within-file
  jsdom breakage (act()/RTL not-found), on packages that are NOT the bottleneck. Only ~200 (api 165 +
  crypto 29) are the predicted contention timeouts. ~200 ECONNREFUSED (preview server, new 3rd class).
- DECISION PENDING (human): pivot from "global concurrent + fix breakage" to "scope concurrency to
  backend integration suites where it pays." Do NOT dispatch fixes until human decides direction.

--- DECISION (human, post-analyst) ---
- ANALYST (research/ + returned): sequence.concurrent is INTRA-FILE only & only speeds I/O-bound tests
  (Vitest docs). Frontend = CPU-bound in happy-dom → gained ~0 from the flag; only api (I/O-bound) pays.
  Frontend NOT concurrency-safe even with container isolation: module-level vi.mock + beforeEach(clearAllMocks)
  cross-talk. 405-file rewrite would not work.
- HUMAN CHOSE Option A: shared browserConfig preset (mergeConfig rootConfig + sequence.concurrent:false),
  consumed by the 5 browser-env configs (web, ui, admin, marketing, crawler-view). 6 config files, 0 test
  files. Clears ~3300 frontend fails; concurrency stays global for node/api where it pays.
- SEQUENCING: implement Option A AFTER the in-flight maxConcurrency=4 full-suite experiment completes
  (avoid box contention; also finalize maxConcurrency from that run's api/crypto timeout numbers).

--- mc=4 EXPERIMENT (human-requested) ---
- Full suite at maxConcurrency=4 vs 12: STRICTLY WORSE. Wall 15m01s→20m46s (+38%).
- Frontend still concurrent(4-wide), still broke: web 2455→1793, ui 469→284, admin 238→168, mktg 121→80
  (~2325 remain) → Option A still required; concurrency-depth doesn't save RTL.
- api timeouts 165→158 (UNCHANGED) ⇒ api timeouts are NOT intra-file concurrency depth; they're FULL-BOX
  saturation (turbo runs 14 pkgs at once). Proof: isolated identity/routes probe had 8-21 at mc=12, full
  run has ~158 at BOTH 4 and 12. maxConcurrency can't fix cross-package contention.
- crypto timeouts 29→12 (halved) ⇒ crypto IS genuine intra-file CPU contention.
- ECONNREFUSED (mktg 130) unchanged ⇒ separate preview-server race.
- ACTION: reverted maxConcurrency 4→12. api-timeout fix is a separate track (testTimeout / worker-budget
  verification / isolate api from full-box load), NOT the maxConcurrency knob.

--- TASK optionA (queued) ---
- Implement shared browserConfig preset (sequence.concurrent:false) consumed by 5 browser configs.
- AFTER audited clean → re-run full suite to isolate the TRUE remaining set (backend classes only).

--- TASK optionA: CLEAN ---
- IMPL (impl-report-1.md): browserConfig preset added; 5 browser configs swapped to it; api untouched.
  Verified: share-message-modal 18/23-fail→23/23 pass; crawler-view 130/130; api resolves concurrent:true.
  Concern raised (not this task): apps/api/src/middleware/pipeline-bindings.ts ExecutionContext typecheck
  error — untouched file, separate in-flight work. Left alone (correct).
- AUDIT: PASS all dims 1.0. Independently re-verified browserConfig differs from root in EXACTLY one
  setting (sequence.concurrent). All 5 browser configs (only those) consume it. 0 test files touched.
  api vitest.config.ts shows modified in git = comment-only edit from OTHER in-flight work, not this task.
- STATUS: Option A DONE & audited clean. Clean full-suite re-run (log: scratchpad/full-suite-optionA.log)
  IN FLIGHT to reveal true remaining node-package error set.

--- CLEAN RE-RUN (post Option A, log: full-suite-optionA.log) ---
- Wall 9m58s (baseline mc12 15m01s → -34%). Log 24K lines vs 2.2M (frontend stopped erroring).
- FRONTEND FIXED: all 5 browser pkgs PASS tests. web 5994/5994 pass; ui/admin/marketing/crawler-view
  green (act() lines that remain are WARNINGS on passing tests, not failures). Option A fully worked.
- web IS in turbo Failed list but 5994/5994 tests PASS → non-test exit: unhandled async errors
  (ECONNREFUSED :8787 wrangler / :3000 vite, + Helcim JS-load DOMException). Separate, likely pre-existing
  flake — NOT concurrency, NOT a test failure. Needs its own check.
- NODE remaining (the real target): api 334 fail (timeout 161 + assert 99), crypto 29 (timeout 28),
  db 19 (assert), shared 6, config 5, realtime 1. marketing ECONNREF 75 but PASSED (retry:1 flake).
- CAVEAT (attribution): tree has heavy IN-FLIGHT feature work (reasoning-effort: modified api/web test
  files per git status — use-chat-stream +129 lines, smart-model-execution.test.ts, etc.). api's 99 asserts
  may be that work, NOT our concurrency. api 284→334 vs baseline suggests contamination. Cannot cleanly
  attribute node asserts to concurrency without a solo attribution run.
- NEXT: run `pnpm test:api` SOLO (box free) to separate box-saturation timeouts (our domain) from genuine/
  feature-work failures. Probe earlier: identity/routes alone = 8-21 fails, so api-solo should be far below 334.

--- CLUSTER 1 ANALYST (timeout/contention) — findings (research/cluster1-timeout-diagnosis.md if written) ---
- ROOT CAUSE (Verified): contention timeouts, NOT bugs. (1) crypto CPU-bound (argon2id/OPAQUE), forced
  concurrent by global flag, gains nothing → same category as frontend. Already testTimeout:30s, still times
  out (envelope 101s, 63259ms retry). (2) Box oversubscribed: 39 fork pools / 20 cores (budget meant 30 but
  Math.max(1) floors inflate to 39; budget ignores maxConcurrency:12 multiplier). crypto's ~36 concurrent
  hashes starve the box → large part of WHY api OPAQUE/DB tests time out. ONE problem.
- ATTRIBUTION (Verified): NONE of cluster-1 files are reasoning-effort feature work. All pre-existing infra
  contention. Safe to fix. (smart-model-turn.integration ≠ modified smart-model-execution.test.)
- RECO: extract shared serialConfig primitive in packages/config; put crypto on it; rederive browserConfig
  from it. 0 test files, fixes all crypto. THEN re-measure api full-box (much api timeout = crypto collateral)
  BEFORE serializing any api file. If identity/routes STILL times out → narrow describe.sequential on that ONE
  file only + consider worker-budget floor fix. REJECT: raise testTimeout (masks, disproven), serialize all
  api (kills I/O win), api own lane.
- RAISED (needs human decision): worker-budget floor defect — Math.max(1) inflation 30→39 + ignores
  maxConcurrency multiplier (scripts/run-package-tests.ts:78,90-96). Part of settled worker-budget system.

--- CLUSTER 2 ANALYST (fast assertion fails) — findings ---
- ROOT CAUSE (Verified by isolation runs): ALSO sequence.concurrent intra-file cross-talk. Isolation
  concurrent→sequential: policies 12→1, linear-real 5→0, live-run 3→0, load-extensions 5→0,
  live-catalog-fetch 6→0, room-core 1→0. Shared module mocks / fake timers / temp dirs / DB rows raced by
  concurrent siblings. pass.integration 26/26 = afterEach delete races siblings (apps/api/CLAUDE.md documents
  "tests run sequentially within the file").
- ATTRIBUTION (Verified vs git status): ~18 files = Class A (OURS, concurrency). NOT ours: crypto/totp.test.ts
  (1 test, deterministic vi.mock hoist, fails sequentially = pre-existing/C), policies 1 residual (lazy
  cockatiel /@fs import, fails sequentially = C), template-html.test.ts (snapshot git-modified = feature/B).
- RECO: Option A — flip node default to sequence.concurrent:false (one config line) fixes all ~18 class-A +
  likely much of Cluster 1. Reject C (rewrite 18 files + permanent author tax), reject B safelist (=all node
  pkgs anyway). File-level fork parallelism (real speedup) is retained.
- CONVERGENCE: both analysts → node tests are WRITTEN for sequential-within-file; concurrency breaks them.
  Crypto serial (agreed). KEY DECISION for human: api sequential-by-default (simple, matches docs, but the
  intra-file api speedup was 124s-of-MOSTLY-FAILING — illusory unless ~18 files rewritten) vs invest in
  rewriting api files for concurrency-safety to keep intra-file speed.

--- DIRECTION CHANGE (human): KILL all concurrency code, back to none. Manual edits, NOT git revert. ---
- Revert ONLY the intra-file concurrency mechanism (sequence.concurrent, maxConcurrency, browserConfig preset
  + the 5 browser-config wirings). git diff HEAD confirms these are the ONLY uncommitted change in all 6 files
  → surgical manual revert restores each to HEAD (git diff HEAD should end empty).
- KEEP (not concurrency): deps.optimizer.ssr, worker-budget system (+ WB125 125% in flight), lint --cache,
  .md cache exclusion, file-splitting effort, Redis-retry research.
- Option A (browserConfig) is thereby UNDONE — superseded by full revert. Frontend returns to plain rootConfig
  (which no longer sets concurrency) = original serial behavior.
- FOLLOW-UP: WB125 wrapper prints a now-stale "maxConcurrency=12" allocation line → drop it after WB125 lands.

--- REVERT-CONCURRENCY: DONE & CLEAN ---
- All 6 vitest configs manually reverted to HEAD. Proof: git diff HEAD empty (all 6); grep for
  browserConfig|sequence.concurrent|maxConcurrency = 0 matches; config typechecks; crawler-view 130/130 green.
  Empty-diff = deterministic exact-revert proof → no separate audit needed. Ledgered clean.
- Kept (unchanged by revert): deps.optimizer.ssr, testTimeout:15000, retry:1 (all pre-existing in HEAD).
- web typecheck fails only on out-of-scope other-agents' files (reasoning-effort-rail.tsx, pipeline-bindings.ts)
  — not ours, left alone.
- Concurrency effort fully unwound. Remaining speed work (non-concurrency): WB125 (in flight), file-splitting
  (map done, planning), Redis-retry research (in flight).

--- WB125: AUDIT PASS ---
- All dims 1.0. solo=round(cores×1.25)=25, full=30. Test 25/25, coverage intact.
- Minor finding (valid, our code): wrapper PRINTS stale `maxConcurrency=12` (scripts/run-package-tests.ts:26
  const + :236 print; 5 test expectations :235,275,290,298,304). Print-only, never passed to vitest. Now false
  post-revert → dispatch cleanup (remove the token + constant + update expectations). WB125 itself CLEAN.

--- CLASS 2 OPTION B: INVESTIGATION DONE — FEASIBLE, TEST-ONLY ---
- Existing seam works: override c.var.redis with a reject-all fake (Proxy cast as Redis), pattern already used
  at rate-limit.test.ts:93/106. NO production change, NO new pattern, NO design decision.
- Shape: in deadApp() (routes.integration.test.ts:1035) add `app.use('*', c=>c.set('redis', DEAD_REDIS))` after
  applyPipeline; drop DEAD_ENV dead-URL; remove the four 40_000ms timeouts (:1110,1125,1162,1186). 9 tests, same
  503/UNAVAILABLE assertions, same handler+operations.ts coverage. Use a PROXY (not hand-enum) so no un-stubbed
  op slips past 503. Recommend proceeding. AWAIT human go (they scoped this to investigate+report).
- SEQUENCING: these 9 tests live in the file the SPLIT relocates (routes-redis-unavailable). Do Option B and the
  split sequentially (either order), never parallel on this file.

--- CLASS 1: DONE & CLEAN ---
- Audit PASS all dims 1.0, no findings. 5 dead-Redis constructors gained retry:false; 4 live clients untouched
  (verified); 54/54 green; ~26s reclaimed on the 4 files (9.64s→2.90s). Independently reproduced.

--- WB125 print cleanup: DONE & CLEAN ---
- Removed MAX_CONCURRENCY const + ` · maxConcurrency=…` log suffix. grep clean, never passed --maxConcurrency
  to vitest, 25/25 green, 100% coverage, typecheck+lint pass. Pure verified deletion → self-gate = audit.
- WB125 fully closed & clean. Allocation line now ends at `workers=<n>`.

--- CLASS 2 OPTION B: IMPL DONE (audit running) ---
- 9 redis-fail-closed tests: DEAD_REDIS Proxy injected at c.var.redis in deadApp(); DEAD_ENV removed; four
  40_000ms timeouts removed. Block 88.4s→10.5s (~78s reclaimed). Adversarial resolve-all breaks all 9 → each
  503 causally from redis rejection. typecheck+eslint pass; full file 158/158 (after clearing 1 orphan row).
- RAISED (pre-existing, NOT ours): routes.integration.test.ts:1380 & :3263 write globally-unique users.email=''
  with no cleanup → escape PREFIX-scoped afterAll → 23505 cross-run poisoning. Affects the SPLIT (:1380→2fa,
  :3263→email-verification files, different afterAlls). DECISION PENDING: fold a cleanup fix into the split vs
  leave + attribute-around.
- Class 2 audit dispatched (correctness+security, sensitive auth fail-closed).

--- CLASS 2 OPTION B: DONE & CLEAN ---
- Audit PASS, no findings. Proxy provably total (gaps fail→500 never spurious 503); each 503 causally redis
  rejection (UNAVAILABLE fingerprint, Postgres live, resolve-all flips all 9); seam order correct; DEAD_ENV
  removal clean, no orphan imports. ~78s reclaimed on the block. email='' defect confirmed independent/out-of-scope.

--- SPLIT-IDENTITY: DISPATCHING (Class 2 cleared the file) ---
- Full spec: research/identity-split-plan.md (8 files + shared setup + folded email='' fix). Work from CURRENT
  file state (post-Class-2: redis-unavailable block uses local DEAD_REDIS proxy + deadApp override — those stay
  LOCAL to routes-redis-unavailable, not shared setup). Sensitive → 3-lens audit panel after.

--- REPO ERROR SWEEP: DISCOVERY DONE (research/repo-error-inventory.md) ---
- Repo is NEARLY GREEN post-revert. lint ✅, jscpd ✅ (1.04%), gitleaks ✅ (exit 0). typecheck: 1 error =
  pipeline-bindings.ts ExecutionContext (in-flight api, DEFER post-split). arch: split-contaminated (setup.ts →
  split audit). format:check red = 936 generated/legacy/docs/fixture files, NOT a gate, nothing real.
- NO package-by-package backlog outside api. Real work = post-split api sweep (pipeline-bindings + test:all +
  knip). Deferred test/knip to post-split (box/DB contention with split).

--- SPLIT-IDENTITY: IMPL DONE (3-lens panel running) ---
- 8 files + routes.integration.setup.ts; original removed. 158/158 preserved; routes.ts coverage byte-identical
  (99.48%L); clean 8-file run 40.3s vs ~315s (~8x). arch:check PASS (impl moved cross-slice conversations
  cleanup from setup.ts→routes-deletion afterAll to satisfy single-writer; LIFO verified). email='' fix proven
  (both files 2x back-to-back, no 23505; only 1 of 2 named tests needed it — routes-2fa already had cleanup).
- CONCERN (corrected attribution — FOLLOW-UP): coverage-run flakes 2-21 `Test timed out 15000ms`. Impl blamed
  "sequence.concurrent" but THAT'S REVERTED. Real cause: split now runs 8 OPAQUE-heavy identity files in
  PARALLEL under coverage (v8 JIT-off ~2.6x) → CPU contention → 15s timeouts. i.e. the split may make the ACTUAL
  gate (pnpm test:api coverage) flaky. MUST fix (raise testTimeout for coverage and/or tune coverage worker cap)
  + measure real api-wall improvement. Handle in post-split api sweep.
- 3-lens panel dispatched (correctness+leak-check, security-fidelity, conventions).

--- SCOPE (human): DROP format:check ---
- Do not fix format:check (936 files = generated/legacy/docs/fixture noise, not a gate). Off the error-sweep list.
- Split speedup so far: 40.3s vs ~315s CLEAN (~7.8x). Coverage-gate number PENDING (needs contention fix +
  measurement in api sweep; monolith-under-coverage baseline ~892s).
- Next split target: chat/routes.integration.test.ts (184 tests) — CONFIRM via per-file duration measurement
  in the api sweep before committing (old durations were concurrency-contaminated).

--- SPLIT panel: 2 of 3 lenses PASS ---
- Conventions PASS (0.97). Minor: setup.ts:19,22 two imports from same module → merge. arch/eslint/jscpd green.
- Security PASS (1.0), no findings. Byte-verified: 150 titles, 28 describes, 206 expects, all status codes match;
  enumeration-timing + 9 redis bodies byte-identical; auth helpers verbatim; email fix confirmed; knip-clean.
- Awaiting correctness lens (158/158 clean run + conversations/orphan-row leak check). Then batch-fix the Minor.

--- TODO (human ask): report COVERAGE time + % speedup once measured ---
- After correctness lens + coverage-contention fix: measure & report (a) identity-8-files coverage time vs
  monolith ~892s, (b) full pnpm test:api coverage wall vs ~907s baseline. % speedup for each. Then confirm next pole.

--- SPLIT-IDENTITY: ALL 3 LENSES PASS — DONE & CLEAN ---
- Correctness 1.0 (no findings): 158/158 clean 41.7s + coverage 158/158 (did NOT flake this pass); routes.ts
  coverage identical (99.48/99.12/99.21/98.48); 178 titles byte-identical to deleted original. LEAK CHECK CLEAR:
  only routes-deletion creates conversations rows (7 others touch none, grep-confirmed); cleans own via LIFO
  afterAll (17/17 2x). email fix confirmed. Security 1.0 clean. Conventions 0.97 (1 Minor: setup.ts:19,22 merge imports).
- Coverage-contention flake is INTERMITTENT (correctness lens got 158/158 under coverage; impl saw 2-21 timeouts).
- Pending fixes: the 1 Minor import-merge (batch with api sweep). 
- MEASURING NOW: pnpm test:api (coverage) → coverage time vs 907s, test failures (sweep), per-file durations (next pole).

--- POST-SPLIT test:api COVERAGE MEASUREMENT ---
- pnpm test:api coverage: 907s → 220s (~4.1x, ~76%). BUT contaminated: wrapper ran 25 forks/20 cores under
  coverage (--maxWorkers=25 overrides coverage 50% cap) → oversubscription thrash + 3 Test-timed-out flakes.
- REAL POLES = the identity split files (OPAQUE+coverage ~5.6s/test): routes-edge 202s, routes-deletion 197s,
  routes-login-session 175s, routes-2fa 162s. conversations 90s(255t), chat/routes only 38s(184t). → chat/routes
  is NOT the next pole. Further speed = split big identity files MORE (diminishing) or shared-OPAQUE-fixture refactor.
- 8 failures: ~3 contention timeouts (identity step-up/2FA, will clear w/ oversub fix); ~3 reasoning-effort feature
  (smart-model-turn x2, chat hard-off wire — in-flight); 1 pre-existing policies lazy-cockatiel (class-C);
  video-adapter.test.ts; chat wallet-201. Re-measure to isolate contention-vs-real.
- FIX: coverage-aware testTimeout (30s under --coverage) + cap coverage workers in wrapper → re-measure.

--- AUTONOMY GRANT (human) ---
- Keep splitting poles automatically (no per-split approval), same manner as identity split. Iterate until NO
  pole exists AND entire codebase green. Also scan OTHER packages for poles + fix.
- Stopping criterion: split while a file ≳2× package median AND split still pays (per-file import floor ~2-12s).
- SURFACE (don't auto-do): (1) shared-OPAQUE-fixture refactor (changes isolation) if splitting floors out;
  (2) reasoning-effort "fixes" that require guessing incomplete-feature intent (fix clear bugs, flag guesses).
- FOUNDATION FIX dispatched: wrapper solo 1.25→1.0 (coverage is CPU-bound, 25>20 oversubscribes/inflates poles);
  coverage-aware testTimeout 30s. Supersedes WB125's 125% (was premised on pole-tail mistaken for starvation).
- LOOP: fix→re-measure test:api (clean poles + isolate real failures) → split biggest pole (audited) → fix real
  failures → repeat across api + all pkgs. scripts (293s) + web (87s) to pole-scan after api.

--- SPLIT GATE (human): only split if it ACTUALLY speeds the suite wall ---
- Split a file ONLY if suite is POLE-BOUND by it: file_time > parallel_floor (Σ file times / workers) AND
  workers idle at tail. If WORKER-BOUND (wall ≈ total/workers), splitting redistributes same work → wall
  unchanged → STOP (don't churn files even if a nominal 'slowest' remains).
- After EACH split: re-measure wall. Dropped→continue to next pole. Not dropped→hit worker/import floor→STOP;
  if a pole still exceeds floor, surface fixture-refactor instead of more splitting.

--- FOUNDATION FIX DONE: OVERSUB_SOLO 1.25→1 (solo=cores=20); testTimeout 30s under --coverage. Gates green.
--- RE-MEASURING test:api (coverage) for clean poles + floor + real failures.

--- RE-MEASURE (post oversub fix): wall 907→196s (~4.6x), 0 timeouts (was 3) ---
- Floor = 1343s/20 = 67s. Wall 196s ≈ top pole 187s → POLE-BOUND. Poles barely de-inflated (real OPAQUE cost).
- Binding CLUSTER (split as a unit): routes-edge 187s, routes-deletion 187s, routes-login-session 177s,
  routes-2fa 160s. conversations 93s(255t cheap), chat/routes 36s. → split the 4 → ~90s pieces → wall ~95s.
- Failures now 4 (was 8), 0 timeouts (contention cleared). GENUINE: 3 reasoning-effort (smart-model-turn x2 +
  chat 'hard-off wire') = in-flight feature (diagnose bug-vs-intent); 1 policies lazy-cockatiel (clear bug);
  1 video-adapter.test.ts file-level unhandled error.
- ACTION: split 4-identity-cluster (parallel, each imports unchanged setup.ts); analyst diagnoses 5 failures.

--- SPLIT2 cluster progress ---
- login-session DONE: routes-login-session(23) + routes-revocation(14) = 37/37 green, setup untouched.
  (Transient whole-pkg typecheck fail = concurrent routes-2fa mid-edit; expected; recheck after all 4 land.)
- Plan: after all 4 splits land → ONE batch correctness+security audit over the ~8 resulting files (behavior-
  preserving redistribution of already-audited tests) + package typecheck/lint → then re-measure wall.

--- SPLIT2 cluster: ALL 4 DONE ---
- edge→routes-edge(19)+routes-timing-store(8); login→routes-login-session(23)+routes-revocation(14);
  2fa→routes-2fa(11)+routes-2fa-disable(9); deletion→routes-deletion-execute(8)+routes-deletion-gate(9).
  Each pair green + leak-proof (deletion/2fa email twice back-to-back, no 23505). setup.ts untouched.
- identity now 12 files, still 158 tests total. Batch-auditing + package typecheck/lint on settled tree, then re-measure.

--- FAILURE DIAGNOSIS: all 5 = ONE cause = deps.optimizer.ssr (research/api-failure-diagnosis.md) ---
- Prod code CORRECT (not feature bugs). (A) stale SSR pre-bundle of @hushbox/shared → REASONING_OFF_WIRE
  undefined → #2/#3/#4 fail (standing trap: recurs on every shared-export add). (B) SSR optimizer breaks
  vi.importActual external-ESM URL (&v=) → #1 cockatiel + #5 video-adapter (fail on FRESH cache → block CI too).
- FIX: deps.optimizer.ssr.enabled:false → all 5 green (266 tests). Only fix for #1/#5. TRADEOFF: loses the
  optimizer import-speed win (120→54s probe). Surfaced to human. Batch-auditing splits + settled gates meanwhile.

--- OPTIMIZER DECISION (human): KEEP optimizer globally (don't lose import speed). Narrow the fix. ---
- Real scope is only 2 files: #1 policies (cockatiel) + #5 video-adapter — importActual-vs-optimizer conflict,
  fail on FRESH cache → the only true CI blockers. #2/#3/#4 (reasoning-effort) are STALE LOCAL CACHE only —
  pass on fresh cache (CI green); local needs `.vite` clear. No test/optimizer change for those.
- Plan: per-file carve-out — run ONLY #1/#5 under a scoped vitest project with optimizer OFF; rest keeps it on.
  Analyst RESUMED to verify the carve-out works (per-dep exclude already known NOT to work; per-file project is
  different). Fallback: rewrite #1 (safe); NOT #5 (partial mock guards SSRF assertion → strength risk).
- Batch audit of the 8 split files running in parallel.

--- SPLIT2 cluster: BATCH AUDIT PASS — DONE & CLEAN ---
- All dims 1.0, no findings. identity 158/158 (12 files); 8 split files = 101 tests; verbatim (byte-identical to
  HEAD on security blocks); deletion leak-safe both files 2x; email fix preserved; setup.ts + prod untouched.
- 4 poles (edge/deletion/login/2fa 160-187s) now 8 files ~half each. Ready for re-measure ONCE optimizer fix lands.

--- OPTIMIZER: idiom-swap DEAD; carve-out VERIFIED ---
- #5 video-adapter ALREADY uses importOriginal factory idiom → nothing to swap, still fails (factory's
  importOriginal resolves malformed &v= URL). Partial mock guards SSRF assertion → can't de-partial-mock. #1
  idiom swap unverified + insufficient alone. → NO in-file fix exists.
- #2/#3/#4: fresh .vite → green (optimizer ON, fresh deps_ssr HAS REASONING_OFF_WIRE). CI already green.
- CARVE-OUT verified green (77 tests, no double-run): add 'api-noopt' project entry to EXISTING
  apps/api/vitest.config.ts projects[] with include=[policies.test, video-adapter.test] +
  deps.optimizer.ssr.enabled:false; add those 2 to main project exclude. ~10 lines, no new file. Optimizer stays
  ON for ~433 other files.
- DECISION PENDING (human): carve-out (keep optimizer, ~10 lines) vs global-disable (simplest, unmeasured speed
  cost). Offered to measure global-disable cost first.

--- OPTIMIZER CARVE-OUT: DONE ---
- apps/api/vitest.config.ts: new api-noopt project (2 files, optimizer off) + those 2 excluded from api; single
  OPTIMIZER_OFF_FILES const. 2 files green (42t), vitest-list proves single-assignment (no double-run), tc+lint 2/2.
  Optimizer stays ON for ~433 other api files. (Re-measure serves as integration audit.)
--- CLEARING .vite + RE-MEASURE test:api (fresh cache, all fixes in) → expect GREEN + post-split2 wall.

--- RE-MEASURE #3 (cold .vite) = POLLUTED, DISCARD. But fixes CONFIRMED. ---
- Original 5 all GREEN now (smart-model-turn/policies/video-adapter no FAIL). Carve-out fixed #1/#5, fresh bundle
  fixed #2/#3/#4. ✓
- Cold .vite thrashed the run: wall 196→368s, everything ~2x (optimizer rebuild under 20 workers). 4 NEW fails =
  rate-limit/lockout TTL-timing tests (caps 20/60, lockout-after-N, TTL retry-after) whose real-Redis TTL windows
  EXPIRED mid-test due to slowness. Artifacts, not real. (Note: those tests are load-sensitive — pre-existing.)
- LESSON: never clear .vite right before measuring (cold rebuild thrashes + trips timing tests). Rebuild done once.
- RE-RUNNING WARM for the true post-split2 green wall.

--- INFRA POLLUTION found: recent walls UNRELIABLE (memory swap) ---
- Box swapping: 7GB swap used, 8GB avail, load 26. → all tests ~2x uniformly (conversations 93→281s etc). The
  309s/368s walls are INFRA-polluted, NOT the split. 1 'failure' = load-sensitive rate-limit TTL test (flakes slow).
- Causes: (1) hours of coverage runs (20 forks × coverage heap) + cold rebuild → swap; ~5k orphan users in local DB.
  (2) config coverageWorkerCap:50% (RAM guard) DEFEATED by wrapper --maxWorkers → coverage runs 20 forks not 10.
- ACTION: reset stack+DB (clear swap/orphans) → re-measure clean. THEN fix wrapper to respect coverage RAM cap
  (~50% under --coverage). Reconsider all recent absolute walls as infra-suspect; relative poles likely still hold.

--- BOX CLEAN (E2E run gone): 21GB avail RAM, load ~1.0, DB reset (orphans cleared). Taking RELIABLE measure. ---

--- CLEAN RELIABLE MEASURE: pnpm test:api = 180s, ALL 6048 TESTS GREEN (0 fail/timeout) ---
- 907s → 180s = ~5x / ~80%. tests-summed 1304s (confirms polluted runs were pure swap). Split2 worked: identity
  poles 160-187s → 68-110s (routes-edge 110, login-session 105, deletion-gate 93; conversations 88). 20 workers
  did NOT swap on clean box → coverage-RAM fix lower priority (only bites pre-pressured box).
- ONE gate blocker: coverage — routes.integration.setup.ts branches 88% < 95%. It's test-infra (.setup.ts,
  helpers were inline-excluded pre-split). FIX dispatched: exclude *.setup.ts from coverage (restores pre-split).
- POLE ANALYSIS: wall 180s vs floor ~82s (1645s work/20). Top pole 110s < wall 180 → transitioning to
  PACKING/import-bound, not single-pole. Decide further-split-vs-stop after coverage-fix re-measure (warm).
- NEW CRITICAL PATH?: api now 180s; scripts baseline 293s may now be the SLOWEST pkg. After api green → measure
  test:all to find new critical path (likely scripts) + pole-scan other pkgs.

--- API FULLY GREEN: coverage fix done (**/*.setup.ts excluded, shared config). test:api exit 0, 6048 pass +
--- coverage gate. api = 907→~185s (~5x). API OPTIMIZATION COMPLETE & GREEN.
--- Measuring test:all to find NEW critical path (api no longer 907s; scripts ~293s likely new bottleneck) +
--- verify whole codebase green. (Watch for coverage-RAM swap at full-run 30-worker budget.)

--- FULL SUITE test:all = 332s (was 1054s, ~3.2x). NEW CRITICAL PATH = scripts (329s) ---
- scripts wall is ~1 file: readme/generate-banner.test.ts (8 tests, 326s ~40s/test, banner image render) ≈ whole
  suite wall. #1 lever: fix/split it → suite 332→~190s (api next). Rest of scripts <22s.
- Per-pkg: scripts 329, api 191, web 171, admin 140, ui 112, crypto 72, marketing 77, config 56, db 55...
- FAILURES (6, for green): crypto envelope-5MiB + totp-vi.mock(class-C); scripts seed-roster + refresh-catalog-run
  + seed-run (2 file-level = likely optimizer/importActual like video-adapter); web use-resolve-default-model
  coverage 87%<95% (all tests pass; branch gap, maybe reasoning-effort).
- DISPATCHED: analyst on generate-banner (split vs optimize); analyst on the 6 failures (bug/feature/pre-existing).

--- SCOPE CHANGE (human): IGNORE all scripts + playwright failures (other agent owns them) ---
- Leave scripts/ tree ENTIRELY alone (incl. generate-banner.test.ts pole) to avoid collision. → full-suite wall
  stays ~330s (generate-banner is critical path, off-limits). Relay banner analyst finding to human as info only.
- MY remaining scope: fix crypto (envelope-5MiB, totp vi.mock class-C) + web (use-resolve-default-model
  coverage 87%; flag if reasoning-effort in-flight). Ignore failure-analyst's scripts entries.
- Pole-check non-scripts pkgs (api optimized/packing-bound; web/admin/ui frontend serial — likely little left).

--- BOTH ANALYSTS IN. PAUSING per human (let other work run; will resume on command). ---
FAILURE DIAGNOSIS (6):
- #1 crypto envelope-5MiB: PRE-EXISTING flaky-slow (correct; 17s cov, crosses 30s under full-run fork contention).
  Fix (owner call): Buffer.compare instead of 5M toEqual, and/or shrink to ~1MiB. NOT a timeout bump. [MINE]
- #2 crypto totp: CLEAR BUG = optimizer/importActual on otplib (prior 'vi.mock hoist' diagnosis WRONG). Optimizer-off
  passes. [MINE]
- #3 scripts seed roster: PRE-EXISTING stale hardcoded assertion (11 vs derived 50). [SCRIPTS-ignore]
- #4/#5 scripts refresh-catalog-run/seed-run: CLEAR BUG = optimizer/importActual on @hushbox/db. [SCRIPTS-ignore]
- #6 web use-resolve-default-model: PRE-EXISTING coverage 87% (git-clean, NOT reasoning-effort). Fix: add 2
  sort-tiebreak tests + v8-ignore unreachable line 41. [MINE]
- STRUCTURAL: SSR optimizer is in ROOT config → breaks importActual in every pkg (5 files/3 pkgs need carve-outs).
  RECO: move deps.optimizer.ssr from packages/config → apps/api/vitest.config.ts ONLY. Then crypto+scripts never
  optimize, no carve-outs needed; fixes #2/#4/#5 at once WITHOUT touching scripts test files. [config decision - MINE]
- HEAD c6209b02 was WIP, already carried failing #3/#6 before our work.
BANNER (scripts, info-only for other owner): 5 real GIF renders, cov-amplified 5x. Split 3 files + merge #3/#4 →
  278→~109s (~2.5x), no prod change. Below 109s needs prod render-size change (product decision).

RESUME PLAN (when human says go): (1) move optimizer to api-only (fixes crypto totp + scripts optimizer fails,
no scripts files touched) — verify api still green + crypto green; (2) crypto envelope-5MiB owner-call fix;
(3) web coverage: 2 tibreak tests + v8-ignore. Then re-measure test:all. api pole work = likely done (packing-bound).

--- CORRECTION (human caught overreach): DO NOT move optimizer to api-only. Only carve-outs were approved. ---
- crypto totp fix = crypto CARVE-OUT (crypto-noopt project OR optimizer-off for totp.test.ts), same approved
  pattern as api policies/video-adapter. Package-local; does NOT touch shared root config or scripts.
- 'move deps.optimizer.ssr to api-only' = analyst NOTE only, NOT approved, NOT planned. Would edit shared config
  (ripples into scripts/others mid-multi-agent) — explicitly NOT doing without a separate human decision.
- REVISED resume plan (non-scripts, when human says go): (1) crypto carve-out for totp; (2) crypto envelope-5MiB
  owner-call fix; (3) web coverage tiebreak tests + v8-ignore. Then re-measure test:all.

--- CLARIFICATION: optimizer stays ON everywhere except the 2 api carve-out files. ---
- crypto fix = per-FILE carve-out of ONLY totp.test.ts (crypto-noopt project, include=[src/totp.test.ts],
  optimizer off; exclude totp from main crypto project). Optimizer stays ON for the rest of crypto.
- NOT removing optimizer for the crypto package; NOT the shared-config move. Exactly the approved api per-file pattern.

--- RESUMED (human): dispatching the 3 non-scripts fixes ---
1. crypto totp per-file carve-out; 2. crypto envelope-5MiB (Buffer.compare, shrink only if needed to clear
   contention margin, preserve multi-block); 3. web use-resolve-default-model (2 tiebreak tests + v8-ignore L41).

--- FIX 2/3 crypto envelope-5MiB: DONE & CLEAN ---
- Buffer.compare alone: 19044ms→692ms (~28x). Deep-equal WAS the cost (not crypto compute). 5MiB KEPT, no shrink,
  full multi-block strength (Buffer.compare===0 ⟺ byte-equality, same as toEqual). 21/21 green, tc+lint pass.
  Accepted on self-gate (mechanical equivalence). Waiting: crypto totp carve-out + web coverage.

--- FIX 1/3 crypto totp carve-out: DONE & CLEAN ---
- crypto-noopt project (totp.test.ts only, optimizer off); 28/28 green; NEGATIVE PROOF (optimizer-on → same
  ERR_MODULE_NOT_FOUND) confirms carve-out is load-bearing; no double-run; tc+lint clean. Only crypto vitest.config
  touched (defineProject→defineConfig+projects, mirrors api). Accepted on self-gate. BOTH crypto fixes done.
- Waiting: web coverage fix. Then scoped test:crypto + test:web integration verify.

--- FIX 3/3 web coverage: DONE ---
- use-resolve-default-model branch 87→96.77% (lines 100%) via 2 comparator tie-break tests. Source unchanged
  (v8-ignore already committed L43). test:web typecheck fails ONLY on api pipeline-bindings.ts ExecutionContext
  (in-flight reasoning-effort, cross-package, NOT mine/web-fix). ALL 3 FIXES DONE.
- Verifying package-level green: test:crypto + test:web.
- FLAG for human: pipeline-bindings.ts ExecutionContext TS2304 = only non-scripts red left; in-flight
  reasoning-effort api file (actively edited?). Fix it (import ExecutionContext) or leave to that author?

--- crypto + web VERIFIED GREEN (test:crypto 495 pass, test:web 6008 pass, both tasks ok). 3 fixes complete. ---
--- HUMAN: fix the last red typecheck (pipeline-bindings.ts ExecutionContext TS2304). Dispatching minimal fix. ---

--- LAST TYPECHECK FIXED: pipeline-bindings.ts += `import type { ExecutionContext } from 'hono'` (added to
--- existing hono import). Full pnpm typecheck GREEN (15/15). One-line, no logic change, matches api convention.
--- NON-SCRIPTS SCOPE COMPLETE & GREEN: api 907→~185s(~5x); crypto (totp carve-out + envelope 19s→0.7s) green;
--- web coverage green; typecheck green. Remaining (NOT mine): scripts fails + generate-banner pole, playwright.

--- generate-banner SPLIT approved by human ("execute the split"). Dispatching. ---
- 3 files: engine (patchCryptoWithSeed x2 + countPlacedReveals x3), banners (MERGE the 2 generateBanners tests
  into 1 covering ??process.cwd() + both assertions), gif (generateBannerGif unchanged). Inline mkdtemp setup
  (NO readme/*.ts helper — coverage include glob). Preserve generate-banner.ts coverage (esp. process.cwd branch).
  Est ~278→~109s. Behavior-preserving, no production change.

--- BANNER SPLIT: DONE. generate-banner.test 269s→23.6s (3 files parallelize). Coverage on generate-banner.ts
--- IDENTICAL (Branch 95.83, uncov L306 before==after). 8→7 tests (merged #3+#4). green, eslint+tsgo pass.
--- Auditing merge + re-measuring test:all for new full-suite wall (expect ~332→~190s, api next critical path).

--- BANNER SPLIT: AUDIT PASS (no findings) — DONE & CLEAN ---
- Merged test covers BOTH #3 (dark+light + >10KB) & #4 (process.cwd branch). ?? branch coverage is operand-exec
  based → nullish call covers both operands → merge loses nothing. Fast tests + #8 verbatim. Prod untouched,
  original deleted, no helper extracted, coverage byte-identical. Waiting on test:all re-measure for new wall.

--- RERUN test:all (human: weird occurrence, no changes) — box snapshot in rerun-boxstate.txt ---
