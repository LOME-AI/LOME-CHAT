# Full-suite failure inventory — `pnpm test:all` under landed concurrency config

Single run, 2026-07-22. Config as landed: `sequence.concurrent: true` + `maxConcurrency: 12`
(global, `packages/config/vitest.config.ts`). One run = **lower bound** (breakage is
non-deterministic). Turbo `--continue`; `ads`/`ops` were turbo cache HITS (not re-run).

## Totals
- **408 test files failed · ~3,840 tests failed** across 12 packages.
- Wall: 15m01s (turbo). `ads` + `ops` cached-pass.

## Per-package (authoritative, from each vitest summary)
| pkg | files failed | tests failed | tests passed |
|---|---|---|---|
| web | 214 / 363 | 2455 | 3539 |
| ui | 56 / 90 | 469 | 1295 |
| admin | 43 / 70 | 238 | 321 |
| scripts | 33 / 82 | 211 | 1506 |
| api | 25 / 435 | 284 | 5690 (+37 skip) |
| marketing | 24 / 50 | 121 | 331 |
| crypto | 6 / 36 | 30 | 465 |
| db | 4 / 26 | 18 | 479 |
| config | 1 / 27 | 5 | 318 |
| shared | 1 / 100 | 6 | 2214 |
| realtime | 1 / 12 | 1 | 364 |
| crawler-view | 1 / 16 | 2 | 128 |

## Failure MODE by package (error-line signature counts — characterize mode, not exact test tallies)
| pkg | timeout | RTL not-found | act()/render leak | spy | assert | ECONNREFUSED |
|---|---|---|---|---|---|---|
| web | 23 | 3336 | 2986 | 616 | 636 | 30 |
| ui | 14 | 721 | 78 | 117 | 79 | 5 |
| admin | 0 | 353 | 2 | 40 | 72 | 0 |
| marketing | 0 | 228 | 0 | 14 | 7 | **130** |
| api | **165** | 0 | 0 | 3 | 75 | 0 |
| scripts | 7 | 0 | 0 | 49 | **157** | 37 |
| crypto | **29** | 0 | 0 | 6 | 3 | 0 |
| db | 2 | 0 | 0 | 0 | 14 | 0 |

## Three distinct failure CLASSES (Verified from sampled blocks)
1. **Frontend concurrent-within-file breakage (~3,300 failures; web/ui/admin/marketing).**
   `sequence.concurrent` runs all tests in a file at once against ONE shared jsdom document.
   Renders/portals/spies from one test leak into another's queries. Signatures: "An update to
   FocusScope/Presence/DismissableLayer inside a test was not wrapped in act(...)" +
   RTL "Unable to find". E.g. `share-message-modal.test.tsx` 18/23 failed;
   `recovery-phrase-modal.test.tsx` 22/35; `settings.test.tsx` 36/48.
   **These packages are NOT the perf bottleneck — this is breakage for zero benefit.**
2. **Backend contention timeouts (~200; api 165 + crypto 29).** The predicted class.
   `Test timed out in 15000ms` on real-infra integration tests (OPAQUE/Postgres/Redis-HTTP
   CPU queued under 12-wide concurrency). E.g. `app-auth-rate-limit`, `app-deletion`,
   `app-eviction` integration tests. Scheduling-only; fixable via testTimeout/maxConcurrency
   tuning (per limiter-collision-diagnosis.md).
3. **Preview-server ECONNREFUSED (~200 lines; marketing 130, scripts 37, web 30).**
   `connect ECONNREFUSED 127.0.0.1:<port>` — a preview/readme server didn't come up (e.g.
   `readme/preview-readme.test.ts`). Likely a port/stack issue OR concurrent tests racing a
   single shared server. Needs its own diagnosis — NOT a contention timeout.

Distinct failing-file list: `scratchpad/fail-files.txt` (408 lines, `<pkg>\t<file>`).

## Load-bearing conclusion
Global `sequence.concurrent: true` is **not viable as landed**. ~86% of the failures are
frontend component tests that cannot share a jsdom document concurrently, and those packages
were never the bottleneck (the win is the api `identity/routes` pole). The decision this
forces: **scope concurrency to where it pays** (backend integration suites) rather than
flipping it globally and repairing 3,300+ frontend tests. Human decision required before any fix.
