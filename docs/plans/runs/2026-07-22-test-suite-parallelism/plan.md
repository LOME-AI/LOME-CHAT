# Plan — test-suite-parallelism (Tier 2) — CURRENT SNAPSHOT

Goal: cut the ~15-min api test suite while keeping the EXACT 95% coverage gate and integration-first strength. Root cause (measured): Vitest parallelizes by FILE; giant serial `routes.integration.test.ts` files (identity/routes = 892s cov ≈ whole api wall) run on one core; suite is I/O/wait-bound (~1 core); plus a ~2.6× coverage-on-crypto v8-JIT penalty.

> On resume after compaction: trust THIS file + `ledger.md` + `git status` over recollection. Nothing is committed; the tree is the human's.

---

## CURRENT STATUS (read first)

### ✅ DONE & CLEAN (landed, safe, standalone)
1. **ESLint `--cache`** — root `package.json` `lint` + `lint:fix` (`--cache --cache-location node_modules/.cache/eslint/`). Warm re-lint ~10× (29.95s→2.93s on shared).
2. **`.md` excluded from turbo test cache inputs** — `turbo.json` test `inputs` has `"!**/*.md"`. Doc edits no longer bust a package's test cache.
3. **`deps.optimizer.ssr`** — `packages/config/vitest.config.ts` pre-bundles `@hushbox/db|shared|crypto`. Import 120s→54s on probe.
4. **Worker-budget + weights caching system (BT1+BT2+BT3, all audited CLEAN)** — see "Budget system" below. Full-run workers ~100→~30; solo `test:api` 10→20.

### ⚠️ LANDED but NOT SAFE (in the tree, makes suite flaky-red)
5. **`sequence.concurrent: true` + `maxConcurrency: 12`** — `packages/config/vitest.config.ts`. Probe 347s→124–164s (**2.1–2.8×**) BUT breaks **8–21 tests flakily** (contention timeouts, non-deterministic). **The full suite is currently red because of this. Breakage is UNFIXED.**

### ⏳ NEXT UP (gating order)
1. **[GATING] Re-run the FULL-SUITE total error view** — the run enumerating ALL concurrency failures across every package NEVER COMPLETED (agent went quiet). Human wants this BEFORE any concurrency fixes. Re-dispatch: `pnpm test:all` with concurrency on, `--continue`, capture all failures grouped by pkg/file. One run = lower bound (flaky).
2. **Concurrency-breakage fixes** (held for human review of #1). Diagnosis: CONTENTION timeouts, not limiter collisions → likely CONFIG TUNING (lower `maxConcurrency`, raise `testTimeout`) NOT test rewrites. The lone `429` must be INSTRUMENTED (log limiter key) before any fix — do not blind-fix.
3. **Split giant `routes.integration.test.ts`** (identity/conversations/chat) — CPU-across-cores win; contingent on concurrency-safety validated. Must land BEFORE the dynamic gate.
4. **Dynamic per-file time gate** (see below) — after splits.
5. **CODE-RULES docs** — at the very end.

---

## Locked decisions (human-approved)
- `sequence.concurrent`: GLOBAL default. `maxConcurrency`: CONSTANT **12**, hardcoded in vitest.config.ts (NOT env-plumbed — dropped `HB_MAX_CONCURRENCY`; a constant needs no seam).
- Worker budget: solo = CORES; full = `round(CORES×1.5)` split by per-package work-share.
- Dynamic per-file gate: **`total/workers` floor** (file > K × total_test_time/worker_count); **BLOCKING immediately**; runs on `pnpm test` + ALL variants; MUST be proven to trigger on a known violator (test-the-test).
- NO shuffle / no order check — invariant is "tests pass under our global concurrent config" (natural enforcement).
- ALL docs → CODE-RULES.md; propose the doc diff at the very end.

## Measured facts (baselines — don't re-measure)
- api full (coverage): ~905s (transform 33s, import 530s, tests 1496s summed); parallelism ~1.65×. Full-repo `test:all`: ~1054s.
- identity/routes probe: 892s cov / 347s no-cov (cpu 55% = ~0.5 core → I/O-bound).
- Probe under concurrency (MC=12): 124s(8 fail)/164s(21 fail) vs 347s baseline.
- argon2id = 227ms (NOT the bottleneck). Postgres `max_connections` = 1000 (compose; fsync/sync-commit off) → DB not binding; RAM is.
- Slow tail is contention (OPAQUE crypto CPU queued under concurrency), retry-wait (Upstash client, ~116s/12 tests), timing tests (~28s/3).

---

## Worker-budget system — DONE (BT1+BT2+BT3 all audited clean)

Invocation-aware, duration-weighted worker budget. Solo = full box; full = weighted budget so a full run doesn't oversubscribe; heavy packages get more workers; prints allocation per package; weights self-update every full run (gitignored cache; CI keeps its own via Actions cache).

### Contract (as built)
- **Weights cache**: per-package `scripts/.cache/test-weights/<pkgShort>.json` = `{ "totalWorkMs": <n> }` (per-package files → no cross-process race; gitignored via `scripts/.cache/*`; already populated from verification runs).
- **Weight = Σ test durations** (worker-INVARIANT). Captured on FULL runs via `--reporter=json` parse. Not updated on turbo cache HITS (wrapper doesn't run) → cached pkg keeps last real weight (correct). CI uses `TURBO_FORCE:true` → all pkgs run → full weight refresh each CI run.
- **Env**: `HB_TEST_SCOPE=full` (root test/test:all) | else solo. In `turbo.json` **passThroughEnv** (reaches tasks, NOT in cache key). No `HB_MAX_CONCURRENCY`.
- **Allocation** (`CORES=availableParallelism`=20; `OVERSUB_FULL=1.5`; MC=12): solo→CORES; full→`budget=round(CORES×1.5)=30`, `maxWorkers_p=max(1,round(budget×share))`. **N authoritative from WORKSPACE** (packages with a `test` script) NOT weight files (cold-cache safety → even-split across true N≈14, not N=1). Missing pkg → median. Prints `[<pkg>] scope=… · work-share=… · workers=n · maxConcurrency=12` per package (per-package, no consolidated summary; cache-hit replays historical line).
- Behavior note: on a PARTIALLY-cached local full run, a lone cache-miss pkg still gets only its fractional share (box under-used) — minor, self-limiting; cold full run is correct; use solo `test:<pkg>` for single-pkg iteration.

### Tasks — all DONE & audited clean
- **BT1** — `scripts/run-package-tests.ts` (+ colocated test, + workspace-enum helper). 100% file coverage. (impl→cold-cache-fix→cleanup, all clean.)
- **BT2** — wiring: 14 test-bearing packages route through wrapper (depths/with-env/passthrough correct); root `test`/`test:all` set `HB_TEST_SCOPE=full`; `turbo.json` passThroughEnv; `maxConcurrency:12` hardcoded, untouched.
- **BT3** — `.github/workflows/ci.yml`: Actions cache restore/save for `scripts/.cache/test-weights/` (unique-save-key `…-${run_id}-${run_attempt}` + prefix `restore-keys` incl `-main-` → self-updating, dodges cache immutability).

---

## Dynamic per-file time gate (NOT built — future task)
Guardrail so a giant serial file can't silently dominate the suite again. Custom Vitest **Reporter** (`onTestRunEnd(testModules)` + `testModule.diagnostic()` for true worker-occupancy incl import/setup; `ctx.config.maxWorkers` in `onInit`), added to shared config `reporters` → runs on every `vitest run` (pnpm test + all variants). Metric = `total/workers` floor, BLOCKING. AC: proven to TRIGGER on a synthetic over-threshold file (test-the-test) AND pass on the post-split suite. K set from post-split measurements. Land AFTER file splits (else it fails CI on known-big files).

## Deferred / likely-moot
- **redis-down retry (T6)**: the ~13.9s waits are the `@upstash/redis` client's OWN retry (NOT cockatiel — clamping the resilience factory does nothing). Real knob = `retry:{retries:0}` at `new Redis()` in `apps/api/src/lib/context/factories.ts`, but needs env-mode plumbing (`isTest` is private in `packages/shared/src/env.ts`; VITEST forwarding ad-hoc). LIKELY MOOT once concurrency overlaps the waits — decide after concurrency settles.

## Kept / DROPPED
- Kept: deps.optimizer.ssr; the whole budget system; lint --cache; .md cache exclusion.
- DROPPED (with evidence): per-file test-COUNT cap (→ dynamic time gate instead); istanbul provider swap (v8 is the recommended best, accuracy-equal since 3.2); `viteModuleRunner:false`; argon/KDF reduction (227ms); cockatiel backoff clamp (wrong knob); `HB_MAX_CONCURRENCY` env plumbing (constant).

## Landed files (reconcile against `git status`)
Modified: `package.json` (lint --cache, test/test:all HB_TEST_SCOPE=full), `turbo.json` (.md exclusion, passThroughEnv), `packages/config/vitest.config.ts` (deps.optimizer, sequence.concurrent, maxConcurrency:12), `.github/workflows/ci.yml` (weights cache), + 14 package `test` scripts (apps/*, packages/*, ops, ads, scripts). New (untracked): `scripts/run-package-tests.ts` (+ `.test.ts`, + workspace helper). Gitignored: `scripts/.cache/test-weights/*.json`.

---

## Remediation tasks (2026-07-22 continuation) — direction: SEQUENTIAL-by-default, speed api via SPLITTING

Decision context (human): concurrency abandoned as global mechanism (node tests written sequential-within-file;
api migration = XL, off-payoff on saturated box). Speed comes from FILE-LEVEL parallelism + splitting the api
pole + oversubscription. api = 907s solo = the whole suite critical path (identity/routes ~892s cov = the pole).

### Task WB125 — worker-budget solo runs → 125% cores
- Objective: solo (single-package) test runs allocate `round(cores × 1.25)` workers to use idle CPU on
  I/O-bound suites (observed: solo `test:api` sits ~70% CPU = ~6 idle cores). Full-suite stays `round(cores × 1.5)`.
- File ownership: `scripts/run-package-tests.ts` (+ colocated `run-package-tests.test.ts`).
- Acceptance criteria: `computeMaxWorkers` solo branch returns `Math.max(1, Math.round(cores × 1.25))`
  (was `cores`); full branch UNCHANGED (`round(cores × 1.5)` budget). Colocated test updated TDD-style
  (new expectation fails first). 100% file coverage preserved. On a 20-core box: solo → 25 workers, full → 30.
- Scoped check: `pnpm test:watch scripts/run-package-tests.test.ts`; the wrapper is dev-tooling (scripts/).
- Sensitive? no.

### Task SPLIT-IDENTITY — split identity/routes.integration.test.ts (the pole)
- Objective: break the ~158-test single-file pole into cohesive smaller integration files so file-level
  parallelism (+ oversubscribed workers) can attack it; ZERO behavior change, coverage identical.
- Design context: file-level parallelism is the real speedup mechanism; a single 892s file monopolizes one
  worker while the box idles. Splitting is also concurrency-safe by construction (separate files don't share
  intra-file state). Next pole after this = chat/routes (184 tests) — separate follow-up task.
- File ownership: `apps/api/src/slices/identity/routes.integration.test.ts` → new sibling files + optionally a
  colocated shared-setup helper. Non-overlapping with WB125.
- Acceptance criteria: PENDING structure map (below). Core invariants fixed now: (1) every original test
  survives with identical name/behavior; (2) shared setup extracted ONCE to a colocated helper, never
  duplicated (CODE-RULES One-Implementation-Shared); (3) durable orthodox names (no v2/tmp), matching repo
  convention; (4) `pnpm test:api` green for the split files + coverage on identity routes unchanged;
  (5) no production code touched.
- Sensitive? YES (identity: auth/OPAQUE/TOTP/recovery/account-deletion) → 3-lens audit panel.

### Task REDIS-CLASS1 — add `retry: false` to 5 deviating dead-Redis test constructors
- Objective: 5 test-local `new Redis({url,token})` dead-clients omit `retry: false`, paying the default
  5-retry (~4.3s backoff) cost. Add `retry: false` to match the established 10+ site convention → instant
  fail, same terminal assertions. Test-infra consistency + speed; zero production surface.
- Sites (Verified by analyst): billing/domain/trial-spend.integration.test.ts:26 · billing/domain/
  auditors.integration.test.ts:202 & :296 · billing/domain/admission.integration.test.ts:25 ·
  chat/domain/trial-settlement.integration.test.ts:46.
- File ownership: those 4 test files only. No production code. Not overlapping other in-flight work.
- Acceptance criteria: each dead-Redis constructor gains `retry: false` (matching convention
  `new Redis({ url, token, retry: false })`); affected test files stay GREEN; measure wall-time
  before/after on those files (expect the redis-down tests much faster); no other change.
- Sensitive? no (test-infra). Note: editing tests, not production → verification is green + faster, not TDD-RED.

### Task REDIS-CLASS2-INVESTIGATE — feasibility of Option B (inject failure at a seam)
- Investigation only (report, no code). Does the app pipeline expose a seam to inject a Redis failure so the
  9 `identity/routes.integration.test.ts:1024` "Redis unavailability fails closed" tests can inject
  `errAsync(unavailableError())` (as pipeline-session.test.ts:149 already does) instead of driving a real dead
  client through `createRequestRedis`? Report: seam exists? refactor shape, effort, risk. Human decides after.

### Task REDIS-CLASS2 — Option B (approved): inject reject-all redis for the 9 fail-closed tests
- Objective: the 9 `Redis unavailability fails closed` tests (identity/routes.integration.test.ts:1024-1187)
  pay ~4.3s Upstash retry backoff each (4 carry 40_000ms timeouts). Replace the real-dead-client-via-DEAD_ENV
  approach with a reject-all redis fake injected at the existing `c.var.redis` seam (pattern already used at
  middleware/rate-limit.test.ts:93/106). TEST-ONLY, no production change, no new pattern.
- Design (analyst-verified): (1) define DEAD_REDIS = a Proxy whose every property is `() => Promise.reject(...)`,
  cast `as unknown as Redis` — Proxy (NOT hand-enum) so no un-stubbed op (redisSet/redisSetNx/redisGetDel/
  incr/expire/ttl/eval/del) slips past 503; (2) in `deadApp()` (~:1035) after `applyPipeline(new Hono())` add
  `app.use('*', async (c,next)=>{ c.set('redis', DEAD_REDIS); await next(); })` then `app.route(...)`;
  (3) drop the DEAD_ENV dead-URL trick (postDead passes testEnv); remove DEAD_ENV if it becomes dead code;
  (4) remove the four 40_000ms timeout args (:1110,1125,1162,1186).
- File ownership: identity/routes.integration.test.ts only. SEQUENCED BEFORE the split (same file).
- Acceptance: all 9 tests stay GREEN asserting 503 + {code:UNAVAILABLE} (for the RIGHT reason — every op
  rejects); other tests in the file unaffected; the 9 tests run fast (no backoff/40s); typecheck+lint clean;
  add a doc-comment noting the Upstash transport is intentionally not exercised (vendor behavior).
- Sensitive? YES (auth fail-closed) → correctness + security audit; the key risk is a test passing for the
  wrong reason (un-stubbed op → non-503) — the Proxy must be provably total.
