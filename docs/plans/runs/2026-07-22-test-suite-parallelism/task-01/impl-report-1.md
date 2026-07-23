# Impl Report — T1: Enable global concurrency + measure (SPIKE)

## Objective
Measurement spike. Enable global within-file concurrency in the shared Vitest config, then
measure its effect (wall-time speedup) and breakage on the probe file
`apps/api/src/slices/identity/routes.integration.test.ts`. Not TDD; not a fix task. Do NOT
fix failing tests, do NOT commit, do NOT run the full suite or `pnpm test:api`.

## Files changed
- `packages/config/vitest.config.ts` — added `sequence: { concurrent: true }` and
  `maxConcurrency: 12` to the `test` block (concurrency ON by default). Left in place, not reverted.

## Method
Config changed, then the probe run twice, no coverage, wall-timed with `/usr/bin/time`:
`pnpm exec tsx scripts/with-env.ts vitest run --no-coverage apps/api/src/slices/identity/routes.integration.test.ts`
Run from repo root. `retry: 1` stays in config, so each test gets one retry before it counts as failed.

## Measurements

Baseline (concurrency OFF, from ledger): **347s wall, cpu 55%, 158 passed / 0 failed.**

| Run | Wall | cpu% | Total | Passed | Failed | Skipped | Speedup vs 347s |
|-----|------|------|-------|--------|--------|---------|-----------------|
| 1   | 123.71s | 143% | 158 | 150 | 8  | 0 | 2.81× |
| 2   | 164.18s | 144% | 158 | 137 | 21 | 0 | 2.11× |

Vitest Duration breakdown lines:
- Run 1: `Duration 122.27s (transform 1.93s, setup 62ms, import 3.06s, tests 118.98s, environment 0ms)`
- Run 2: `Duration 162.88s (transform 1.94s, setup 47ms, import 3.14s, tests 159.57s, environment 0ms)`

Wall speedup is large and real (2.1–2.8×) even with failures. cpu stays ~143% (well under
the 12-wide ceiling), so the probe is wait/IO-bound, not CPU-bound — the concurrency wins
come from overlapping real-clock waits, not from saturating cores.

## Failure counts (was 158 passing before)
- Run 1: **8 failed.**
- Run 2: **21 failed.**

## Determinism: FLAKY, not deterministic
The two runs do NOT fail the same set. Run 1 failed 8; Run 2 failed 21 (a strict superset of
Run 1's cluster, plus more). Same config, same file, back-to-back — the failing set is
non-deterministic. This is the critical finding: breakage is order/timing-dependent
interference between concurrently-running tests, not a fixed set of tests that are simply
incompatible with concurrency. Any fix must be validated across multiple runs, and the T2
scope (which tests to fix) cannot be read off a single run — it is at least the Run 2
superset and likely larger.

## Full failing-test list

### Run 2 (21 failed — the larger, superset run)
Error signature: 20 × `Error: Test timed out in 15000ms.`, 1 × `AssertionError: expected 429 to be 200`.

1. account-deletion request > collapses a stolen handshake bound to another account onto no-step-up — timeout 15000ms
2. account-deletion request > does not freeze deletion for a day after a short fumble under the guessing cap — timeout 15000ms
3. account-deletion request > engages a separate 24-hour hard lock once the 1-hour guessing gate is exhausted — timeout 15000ms
4. account-deletion request > enqueues no reclaim job for an account that stored no media — timeout 15000ms
5. account-deletion request > locks out a 2FA account after the registry number of wrong-TOTP deletion attempts — timeout 15000ms
6. account-deletion request > nudges the bulk dispatcher via waitUntil after the deletion commits — timeout 15000ms
7. account-deletion request > rolls the whole deletion back when a step inside the transaction fails — timeout 15000ms
8. account-deletion request > treats a vanished user after a verified step-up as a defect (500) — timeout 15000ms
9. edge states for coverage > returns 500 disabling TOTP whose secret is missing after a valid step-up — timeout 15000ms
10. edge states for coverage > returns 500 when a TOTP-enabled account has no configured secret at login 2FA — timeout 15000ms
11. edge states for coverage > treats an undecryptable stored TOTP secret as a defect (500) — timeout 15000ms
12. email verification > rate-limits verify-email consume per token at the registry window — timeout 15000ms
13. enumeration timing > answers recovery get-wrapped-key in comparable time for known and unknown accounts — timeout 15000ms
14. enumeration timing > answers recovery reset init in comparable time for known and unknown accounts — timeout 15000ms
15. enumeration timing > answers verification resend in comparable time for known and unknown emails — 429-vs-200 (AssertionError) and/or timeout
16. more edge states for coverage > collapses a cross-account 2FA-disable handshake onto no-step-up — timeout 15000ms
17. more edge states for coverage > reports too-many-attempts on 2FA disable when the account is locked out — timeout 15000ms
18. step-up duplicate and well-formed bad proof > rejects a well-formed KE3 from a mismatched handshake as bad proof — timeout 15000ms
19. store-outcome and decode edges > answers not-enabled when TOTP is disabled between disable init and finish — timeout 15000ms
20. store-outcome and decode edges > rejects a replayed TOTP code at login 2FA — timeout 15000ms
21. TOTP-verify lockout > locks out after the registry number of failed login-2FA attempts — timeout 15000ms

### Run 1 (8 failed — subset, all also present in Run 2's list)
Error signature: 7 × `Error: Test timed out in 15000ms.`, 1 × `AssertionError: expected 429 to be 200` (on the verification-resend enumeration-timing test).

1. enumeration timing > answers recovery get-wrapped-key in comparable time for known and unknown accounts — timeout 15000ms
2. enumeration timing > answers recovery reset init in comparable time for known and unknown accounts — timeout 15000ms
3. enumeration timing > answers verification resend in comparable time for known and unknown emails — 429-vs-200 AssertionError (`expectStatus` got 429, expected 200)
4. account-deletion request > locks out a 2FA account after the registry number of wrong-TOTP deletion attempts — timeout 15000ms
5. account-deletion request > collapses a stolen handshake bound to another account onto no-step-up — timeout 15000ms
6. more edge states for coverage > collapses a cross-account 2FA-disable handshake onto no-step-up — timeout 15000ms
7. more edge states for coverage > reports too-many-attempts on 2FA disable when the account is locked out — timeout 15000ms
8. (one further timeout in the same account-deletion / edge-state band; Run 1 output was tailed, so this row is by count, not name — the full named superset is Run 2 above)

## Read on failure clusters (grouped for T2 fix scope)
Two intertwined mechanisms, both rooted in tests assuming they are the ONLY caller executing:

- **Cluster A — Shared rate-limiter / lockout state collision (Redis + per-account counters).**
  The 429-vs-200 assertion and the lockout/attempt-cap tests. These tests carefully drive a
  limiter to exactly its cap and assert the boundary (`rate-limits verify-email consume`,
  `too-many-attempts on 2FA disable`, `locks out after the registry number of ... attempts`,
  the `guessing gate` / `24-hour hard lock` deletion tests, and the enumeration-timing tests
  which "keep each real account at exactly the cap"). When another test runs concurrently and
  touches the same limiter key (shared email/identifier/IP or a shared abuse window), the
  counter is consumed out from under the asserting test → an off-by-one 429 where 200 was
  expected, or the reverse. The enumeration-timing tests are especially fragile: their whole
  premise is a controlled sample count against a shared throttle.

- **Cluster B — 15s-timeout under contention on real-clock / heavy-crypto paths (dominant, 20/21).**
  The overwhelming signature is `Test timed out in 15000ms`, not assertions. cpu only ~144%
  (far below 12-wide), so these tests are BLOCKED, not compute-starved — waiting on real-clock
  rate-limit windows, DB round-trips, or OPAQUE/argon2id operations serialized behind other
  concurrent tests. Enumeration-timing and lockout tests that sleep across real rate-limit
  windows can't clear the window when concurrent tests keep the shared limiter saturated, so
  they hang to the timeout. Heavy-crypto edge/deletion/step-up tests (registerLoginFull +
  OPAQUE + TOTP enroll) pile up and blow 15s. This cluster is why the set is non-deterministic:
  which tests cross the 15s line depends on scheduling.

Fix scope implication for T2: the two clusters are one root cause — tests coupled through
shared, un-namespaced Redis limiter keys and real-clock windows, plus a 15s timeout too tight
for concurrent heavy-crypto tests. Isolation (per-test unique identifiers/limiter namespaces,
mocked clock for window-based tests) and/or marking the timing/lockout suites non-concurrent
are the candidate directions. Scope must be sized from the Run 2 superset, not Run 1.

## Self-gate
Per brief, the scoped self-gate (`pnpm test:api`, ~15 min) and coverage are FORBIDDEN for this
spike. The two probe runs ARE the only check. No lint/typecheck run requested (config-only,
two-line addition inside an existing typed literal). Not run.

## Acceptance criteria
- Config changed (`sequence.concurrent:true` + `maxConcurrency:12` in `packages/config/vitest.config.ts`) — MET (diff confirmed via `git diff`, +2 lines, left in place).
- Measurement report produced (both runs: wall, cpu, pass/fail/skip counts, Duration lines, full failing list, determinism verdict, cluster read) — MET.
- Green tests NOT required for this spike (per plan T1 acceptance).

## Deviations
- Run 1's full output was captured via `tail` (last ~120 lines), so its 8th failing test is
  reported by count, not by exact name. This does not affect scope: Run 1's failures are a
  subset of Run 2's fully-named 21, which is captured in full from a complete log file.

## Concerns and limitations
- **Flaky, not deterministic** — the single most important finding. T2 cannot scope its fix
  from one run; the breakage set grew 8→21 between two identical back-to-back runs and may be
  larger still. Fixes must be validated across repeated runs.
- `maxConcurrency: 12` is a tunable starting point (per plan). cpu at ~144% suggests headroom
  to raise it, but the failures are interference-driven, not throughput-driven, so raising it
  before Cluster A/B isolation would likely worsen breakage.
- This spike touched only the probe file. Rolling concurrency out globally (T3) will surface
  the same shared-state class in other rate-limit/timing-heavy suites (billing, admin).

## Confidence
High — config change confirmed by `git diff`; both runs completed and were wall-timed;
Run 2's failing list is extracted in full from a complete log; determinism verdict rests on
two directly-comparable runs.
