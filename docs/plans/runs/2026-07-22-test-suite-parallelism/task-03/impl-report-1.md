# BT3 — CI caching for test worker-weights — impl-report-1

## Objective
Add GitHub Actions caching so CI keeps its own self-updating copy of the per-package
worker-weights (`scripts/.cache/test-weights/<pkg>.json`, gitignored) across runs:
restore the latest prior weights before the full test run, save the freshly-rewritten
weights after. Purely additive to `.github/workflows/ci.yml`.

## Files changed
- `.github/workflows/ci.yml` — added two steps to the existing `test` job: a
  `Restore test worker-weights` step (before `Run tests`) and a `Save test worker-weights`
  step (after `Save AI cassettes`, last in the job). +28 lines, 0 deletions.

## Tests added
None. This task changes only CI workflow YAML; there is no product runtime surface to
drive test-first. Verification is by YAML parse + step-ordering inspection (below). CI is
not run per the brief.

## Self-gate
- YAML parse (`yaml@2.9.0` from workspace `node_modules`): **pass** — `ci.yml` parses; the
  `test` job's steps list shows `Restore test worker-weights` immediately before
  `Run tests`, and `Save test worker-weights` after `Save AI cassettes`.
- `git diff --stat`: **pass** — `.github/workflows/ci.yml | 28 ++++ (+28 -0)`; additive only,
  no existing step altered.
- `git check-ignore scripts/.cache/test-weights/api.json`: **pass** — path is gitignored
  (returns the path), matching the Contract's "already gitignored via `scripts/.cache/*`".

## Exact YAML diff
```diff
@@ before "Run tests" @@
+      # Worker-weights — CI keeps its own self-updating copy of the per-package
+      # test-work weights (scripts/.cache/test-weights/<pkg>.json, gitignored).
+      # A full `pnpm test` run rewrites these files; the allocator reads them to
+      # size each package's worker pool next run. The unique save key below never
+      # collides (actions/cache entries are immutable), so `restore-keys` prefix
+      # fallback restores the most-recent prior weights and the save writes the
+      # freshly-updated ones — a cache that updates every run instead of freezing.
+      - name: Restore test worker-weights
+        uses: actions/cache/restore@v4
+        with:
+          path: scripts/.cache/test-weights
+          key: test-weights-${{ runner.os }}-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}
+          restore-keys: |
+            test-weights-${{ runner.os }}-${{ github.ref_name }}-
+            test-weights-${{ runner.os }}-main-
+            test-weights-${{ runner.os }}-
+
       - name: Run tests
         run: pnpm test
         env:
           TURBO_FORCE: true

@@ after "Save AI cassettes" @@
+      # Persist the weights this run just rewrote under a fresh, never-colliding
+      # key so the next run's restore-keys prefix fallback picks them up. Saved
+      # even on failure — carrying the restored weights forward is harmless and
+      # a partial recording is still a better signal than none.
+      - name: Save test worker-weights
+        if: always()
+        uses: actions/cache/save@v4
+        with:
+          path: scripts/.cache/test-weights
+          key: test-weights-${{ runner.os }}-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}
```

## Cache key + restore-keys, and WHY it self-updates
- **Save key** (unique per run): `test-weights-${{ runner.os }}-${{ github.ref_name }}-${{ github.run_id }}-${{ github.run_attempt }}`.
  `actions/cache` entries are **immutable** — a `save` under a key that already exists is a
  no-op. Embedding `run_id`+`run_attempt` guarantees a brand-new, never-colliding key every
  run, so the save always writes a fresh entry containing the weights this run just rewrote.
  A single *stable* key (the naive alternative) would write once, then silently refuse every
  subsequent save and freeze the weights forever — which is exactly the failure the brief
  warns against. Keying on the weights' own content-hash would likewise never restore a
  prior copy (the hash only exists after the files are written), so that is rejected too.
- **Restore key** (same unique key, so the current run never re-hits its own entry) plus
  **`restore-keys` prefix fallback**, most-specific first:
  1. `test-weights-${{ runner.os }}-${{ github.ref_name }}-` → newest weights from a prior
     run **on this same branch + OS** (best signal: same code, same box).
  2. `test-weights-${{ runner.os }}-main-` → newest weights from `main` on this OS (a fresh
     feature branch with no cache of its own still starts from `main`'s warm weights).
  3. `test-weights-${{ runner.os }}-` → any prior weights on this OS (last-resort warm start).
  On a cache miss the allocator (BT1) falls back to an even split, so a cold cache is safe.
- **Self-updating loop**, per run: `restore-keys` prefix-fallback restores the *latest* prior
  weights → the `Run tests` step (full `pnpm test`) rewrites `<pkg>.json` with this run's
  measured work → the `Save` step writes those under a fresh unique key → next run's prefix
  fallback picks the newest one. Restore latest → job updates the files → save. This exactly
  mirrors the existing `Restore/Save AI cassettes` steps in the same job (unique per-run save
  key + prefix `restore-keys`), so the mechanism is already proven in this pipeline.
- **Runner-OS scoping** (`${{ runner.os }}`): the weights are a work-share signal that is
  worker-invariant but still OS/runner-shaped; scoping avoids restoring a foreign-OS cache.
- **`if: always()` on save**: matches the cassette save; a run that fails after partially
  rewriting weights (or that only restored prior weights) still carries a usable copy
  forward. Purely beneficial — a missing/partial cache degrades to BT1's even-split fallback.

## Acceptance criteria
- **Restore before, save after the full test step** — met. Step list (from YAML parse) puts
  `Restore test worker-weights` immediately before `Run tests` and `Save test worker-weights`
  as the final step, after `Save AI cassettes`.
- **Path `scripts/.cache/test-weights/`** — met. Both steps use
  `path: scripts/.cache/test-weights`.
- **Key persists AND updates across runs (not content-hashed to the weights)** — met. Unique
  per-run save key + prefix `restore-keys` fallback; reasoning above.
- **Purely additive; existing gates/steps unaltered** — met. `git diff --stat` = +28 -0; no
  existing line changed; only two new named steps added to the `test` job.
- **Scoped to `.github/workflows/` only** — met. Only `ci.yml` touched; no
  `package.json`/config edits. No overlap with BT1's `scripts/` ownership.

## Deviations
None.

## Concerns and limitations
- Chose `actions/cache/restore@v4` + `actions/cache/save@v4` (standard GitHub actions) to
  mirror the adjacent `Restore/Save AI cassettes` steps in the same job. The Turbo/Docker
  caches in this job use `useblacksmith/cache@v5` / `stickydisk@v1` instead. The brief called
  for "standard actions/cache", and consistency with the cassette pattern (same restore→save
  self-updating idiom) made `actions/cache` the right match; if the run prefers Blacksmith's
  cache backend for all caches, this is a one-line `uses:` swap. Flagging, not blocking.
- CI was not run (per brief); correctness is argued from YAML validity + the proven-in-repo
  cassette pattern, not from an observed CI run.

## Confidence
high — additive YAML mirroring an existing, working self-updating cache pattern in the same
job; parse-verified, diff-verified additive, gitignore-verified path.
