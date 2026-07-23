# Repo-wide error inventory (2026-07-23, post concurrency-revert)

Discovery for the "fix all non-task errors" sweep. Run while the identity split is in-flight (api results
partly contaminated → deferred). Conclusion: the repo is NEARLY GREEN; the concurrency revert cleared the
prior test failures.

| check | result | detail |
|---|---|---|
| **lint** | ✅ GREEN | turbo 15/15 successful |
| **typecheck** | ⚠️ 1 error | `admin#typecheck` fails only on `apps/api/src/middleware/pipeline-bindings.ts(59,29): TS2304 Cannot find name 'ExecutionContext'` — IN-FLIGHT reasoning-effort work; api-dependent → DEFER to post-split api sweep |
| **arch:check** | ⚠️ contaminated | 1 violation in `identity/routes.integration.setup.ts:488` (single-writer conversations) — the SPLIT's in-flight new file (`.setup.ts` not `.test.ts` → subject to arch rules the test file was exempt from). Route to SPLIT AUDIT, not a pre-existing error |
| **jscpd (duplication)** | ✅ PASS | 1.04% < 2% threshold |
| **gitleaks** | ✅ GREEN | exit 0 (usage text is cosmetic script preamble) |
| **format:check** | ⚠️ non-gate noise | 936 files but ALL generated/excluded: 654 .js (apps/web android/build output), 224 .md (docs/plans + skills), 31 gen .json; the 5 "source" = 2 Capacitor build .css, 2 `legacy/` .ts (quarantined), 1 `__test-fixtures__` .ts. NOT the CI gate (lint's prettier-eslint-rule is). Nothing real to fix |
| **test** | ⏳ deferred | box/DB contention with the split → run post-split (`test:all`). Post-revert, prior concurrency-cross-talk failures should be gone (verify) |
| **knip (unused)** | ⏳ deferred | whole-repo noisy mid-split (new files) → post-split |

## Actionable (real) errors
1. `pipeline-bindings.ts` ExecutionContext TS2304 (in-flight, api) — fix in the post-split api sweep.
2. Any residual test/knip failures — surface in the post-split full run.
Everything else is noise (format), contamination (arch/split), or already green.

## NOT doing (with reason)
- Mass `prettier --write .`: would churn generated/legacy/docs/fixtures; format:check isn't the gate; real
  source is prettier-clean (green lint proves it).
- Per-package fixers for green packages: there is no package-by-package error backlog outside api.
