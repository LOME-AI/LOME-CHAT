# Ledger — pole-gate

- setup: run dir + plan.md created. Tier 1. Contract verified: vitest@4.1.8 json
  reporter testResults[] = {startTime,endTime,name:filepath}. Design approved by
  human in-conversation (threshold: >50% share AND >=15s floor; no allowlist;
  gate both scopes).
- task-01 → implementing: impl-report-1.md. Self-gate pass (37/37 tests, 100%
  cov changed file, typecheck+lint clean on the 2 edited files). Deviations:
  used deps.warn for the pole block (plan left open); reworded missing-report
  warn + its one test. Noted pre-existing lint fail in e2e-seeded-image-model.ts
  (not ours — concurrent work). → dispatching auditor.
- task-01 → CLEAN. Auditor PASS, no findings; independently reproduced 37/37,
  100% cov, tsgo exit 0, eslint clean. All threshold boundaries (exact-50%,
  just-under-15s, multi-project summation) directly asserted. Orchestrator agrees.
- Next: full-suite run to collect current pole violators (user deliverable, no fix).
- full run (HB_TEST_SCOPE=full, --force --continue): gate ran on all 14 packages,
  none skipped. VIOLATORS = 1: scripts/readme/generate-banner-banners.test.ts
  (339.0s, 67% of scripts test-work). No other package tripped the gate.
- Non-pole failures (pre-existing/concurrent, NOT this task, NOT fixed): api,
  crypto, shared, web real test failures + scripts 5 file-level failures
  (refresh-catalog*, seed*, e2e-seeded-image-model) — all from the in-flight
  builder-helper/refreshCatalog/trial-model refactor in the working tree.
- RUN COMPLETE (gate). Deliverable = 1 violator reported; no fixes.
- Doc change applied to DEVELOPMENT.md (pole gate line) — human-approved.
- Full per-file scan (persisted /tmp reports): only scripts has a pole. api NOT a
  hidden pole (4 co-heavy ~180-200s files, each 9%) — corrected earlier inference.
  crypto/web/shared clean. config 64%/9.3s correctly saved by 15s floor.
- task-02 opened: split scripts banner pole via inject-renderer (Option 1, human
  recommended; user away for the confirm — proceeding on best judgment). → dispatch impl.
- task-02 → implementing: impl-report-1.md. Self-gate pass (8/8 tests, tsgo 0, lint
  clean, coverage gate exit 0: lines/stmts/funcs 100%, branches 96%). RED observed
  (fake render uncalled vs un-seam'd sig). Deleted generate-banner-gif.test.ts; added
  dark+light real-render files; wrapper test now fake-render fast. No-new-pole =
  structural (two ~equal siblings ≤50%). Uncovered branch = render default-arg init
  (CLI-only, v8-ignored path). Noted pre-existing: banner.hash has git conflict markers
  (concurrent, out of scope). → dispatching auditor.
- task-02 → CLEAN. Auditor PASS, no findings; independently reproduced 8/8 tests,
  coverage 100% lines/stmts/funcs + 96% branches (gate 95%, pass), lint clean,
  tsgo clean on task-02 files. No-new-pole = re-derived structural proof (two ~equal
  renders each <50%). Raw-tsc 3 errors are Task-01's file + pre-existing tsgo-accepted
  vi.fn pattern (not a regression). Orchestrator agrees.
- RUN COMPLETE. Both tasks clean. Pole gate shipped + documented; scripts banner pole
  split (renders now 2 parallel files ~114s each, ~40% share each — gate no longer
  trips). No commits (tree is the human's). Deleted latent gif pole file too.
