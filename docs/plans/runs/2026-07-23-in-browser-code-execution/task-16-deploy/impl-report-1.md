# Task 16 — Deploy wiring for the document sandbox origin (impl report 1)

## Objective

Make the already-built sandbox package actually deploy, and get the two env vars it
depends on (`ESM_CDN_URL`, `SANDBOX_ORIGIN_URL`) into the CI steps that consume them.
Four changes: custom-domain route, turbo build passthrough, env-generator wiring +
regeneration, and the CI deploy step + Pyodide caching.

## Files changed

- `apps/sandbox/wrangler.toml` — zone route replaced by a custom domain
  (`pattern = "sandbox.hushbox.ai"`, `custom_domain = true`); comment records why a
  custom domain is available here (exclusive hostname) and not for `admin.hushbox.ai`
  (hostname split across two Workers).
- `turbo.json` — `build` task gains `passThroughEnv: ["ESM_CDN_URL"]`; without it turbo's
  strict env mode strips the variable and `apps/sandbox/src/build.ts` fail-fasts.
- `scripts/generate-env.ts` — `headers-env` now emits `SANDBOX_ORIGIN_URL` alongside
  `VITE_API_URL`; whole-workspace build variants (`build-env`, `build-env-web-release`)
  now emit `ESM_CDN_URL`. The literal-line emitter was extracted
  (`generateLiteralLines`) so `generateSecretsEnv` and `generateBuildEnv` share one
  implementation instead of two copies.
- `scripts/generate-env.test.ts` — four new tests (below).
- `.github/workflows/ci.yml` — regenerated blocks + hand-written steps: Pyodide cache in
  the `build` job, `sandbox-dist` artifact upload (build job) / download (deploy job),
  and `Deploy Sandbox assets Worker` immediately after `Deploy Admin assets Worker`.
- `.github/workflows/release.yml` — regenerated `build-env-web-release` (now carries
  `ESM_CDN_URL`).
- `.github/workflows/build-android.yml`, `.github/workflows/run-ops-script.yml` —
  regenerated only; the deltas there are another workstream's pending registry drift that
  `pnpm generate:env` flushed (see Concerns).

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `build-env section > emits ESM_CDN_URL for the sandbox origin build` | the whole-workspace build block carries `ESM_CDN_URL: https://esm.sh` | change 3 (Build step) |
| `build-env-web-release > emits ESM_CDN_URL for the sandbox origin build` | the release workflow's `pnpm build` step carries it too | change 3 (scope) |
| `build-env-mobile section > omits ESM_CDN_URL from the web-only bundle build` | web-only build blocks stay free of it | change 3 (scope) |
| `headers-env section > emits SANDBOX_ORIGIN_URL for the CSP frame-src directive` | the Generate `_headers` block carries `SANDBOX_ORIGIN_URL: https://sandbox.hushbox.ai` | change 3 (headers step) |

All four were watched failing first (RED) against the unmodified generator, each for the
expected missing-variable reason, then made green by the generator change.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/generate-env.test.ts` | 109 passed, 1 failed — the failure is pre-existing and unrelated (see Concerns) |
| `pnpm test:watch scripts/` (whole scripts suite) | 1803 passed, 1 failed + 2 suites failed to load — all three pre-existing/environmental (see Concerns) |
| `pnpm generate:env` | regenerates cleanly; a second run is a no-op (byte-identical ci.yml) |
| `pnpm verify:env --mode=production` | pass — "All environment verifications passed" |
| `pnpm exec prettier --check` (turbo.json, all four workflows, both scripts files) | "All matched files use Prettier code style!" (run after the last edit) |
| `pnpm exec eslint generate-env.ts generate-env.test.ts` (from `scripts/`) | exit 0, no output |
| `pnpm exec turbo build --dry=json --filter=@hushbox/sandbox` | turbo parses the commented turbo.json; `@hushbox/sandbox#build` depends on `@hushbox/sandbox#fetch-pyodide`; task shows `specified.passThroughEnv: ["ESM_CDN_URL"]` |
| `pnpm exec wrangler deploy --dry-run` (from `apps/sandbox`, after a local build) | pass — "Read 26 files from the assets directory …/dist", "No bindings found", no route/config warnings |
| ci.yml YAML parse (js-yaml) + step-order dump | valid; step lists confirmed (below) |

Prettier has no TOML parser, so `apps/sandbox/wrangler.toml` is not prettier-checked
(pre-existing repo condition, not a change here).

## Acceptance criteria

1. **Custom domain** — met. `apps/sandbox/wrangler.toml` now holds
   `pattern = "sandbox.hushbox.ai"` + `custom_domain = true`, no `zone_name`, no `/*`.
   Durable comment records the exclusive-hostname reason and the admin contrast.
   `apps/admin` untouched.
2. **turbo build passthrough** — met, with a factual correction: the `build` task did
   **not** declare `passThroughEnv: ["HB_TEST_SCOPE"]` (that key is on the `test` task).
   `build` had no `passThroughEnv` at all, so the change is
   `"passThroughEnv": ["ESM_CDN_URL"]` on `build`; `HB_TEST_SCOPE` was deliberately not
   added there — it is a test-scope variable no build reads.
3. **Env generator → both blocks** — met, generator-side only (no hand-edits inside the
   GENERATED markers). Regenerated output:
   - build-env: `ESM_CDN_URL: https://esm.sh`
   - headers-env: `SANDBOX_ORIGIN_URL: https://sandbox.hushbox.ai`
   The same treatment reaches `build-env-web-release` in release.yml, whose step also
   runs the whole-workspace `pnpm build`; web-only variants (`build-env-mobile`,
   `build-env-android`, `build-env-mobile-test`) deliberately do not carry it.
4. **Deploy the sandbox + cache Pyodide** — met, with one necessary addition:
   - `Deploy Sandbox assets Worker` sits inside the existing `deploy` job, immediately
     after `Deploy Admin assets Worker`, mirroring it exactly (`working-directory:
     apps/sandbox`, `pnpm exec wrangler deploy`, same two secrets). No new job.
   - **The deploy job runs no build.** Verified: its steps are checkout → setup →
     download artifacts → deploy. `pnpm build` lives in the `build` job. So
     `apps/sandbox/dist` cannot exist in the deploy job on its own; a bare deploy step
     would fail. Fixed the same way admin does it: `Upload sandbox build artifact`
     (`sandbox-dist`, `apps/sandbox/dist`) in the build job, `Download sandbox build
     artifact` in the deploy job before the deploy steps. The dist is ~27 MB (Pyodide
     included).
   - The dependency claim holds where the build actually happens: turbo's dry run shows
     `@hushbox/sandbox#build` depends on `@hushbox/sandbox#fetch-pyodide`, so the assets
     are fetched before the sandbox dist is assembled in the build job.
   - Pyodide caching: the `test` job (ci.yml ~line 206) and the `e2e` job (~line 565)
     already cache it with `useblacksmith/cache@v5`, `path: apps/sandbox/public/pyodide`,
     `key: pyodide-${{ hashFiles('apps/sandbox/scripts/fetch-pyodide.sh') }}` — both
     pre-existing in the working tree. The `build` job had none, so the same step with
     the identical mechanism and key was added there, before `Build`.

Post-change step order (from the YAML parse):

- build job: Cache Turbo → Verify production environment → **Cache Pyodide assets** →
  Build → Merge marketing → Generate _headers → Upload web → Upload admin →
  **Upload sandbox** → mobile OTA → Upload mobile.
- deploy job: Download web → Download admin → **Download sandbox** → Download mobile →
  … → Deploy API → Deploy Web → Deploy Admin → **Deploy Sandbox**.

Existing API/Web/Admin deploy steps are unmodified (diff shows only additions around
them).

## Deviations

- `turbo.json`: `HB_TEST_SCOPE` not added to `build` (see criterion 2) — the brief's
  premise about the existing value was inaccurate.
- ci.yml gained two steps beyond the brief's list (`Upload sandbox build artifact`,
  `Download sandbox build artifact`). Without them the requested deploy step deploys a
  non-existent `dist`.
- `scripts/generate-env.test.ts` was edited (TDD requires the failing test first); the
  brief's BOUNDS named the generator without naming its test file.
- Pyodide caching landed in the `build` job rather than the `deploy` job: the deploy job
  never downloads Pyodide (no build, no fetch), so there is nothing to cache there.

## Concerns and limitations

- **`passThroughEnv` does not hash.** `ESM_CDN_URL` changes the emitted
  `apps/sandbox/dist/config.js`, but passthrough variables are excluded from turbo's task
  hash (dry run: `environmentVariables.configured` is empty). If any job ever builds the
  sandbox under a non-production `ESM_CDN_URL` and shares the `.turbo` cache with the
  production build job (CI restores `turbo-main-`), a stale dist could be reused. Today
  no CI job does that (`build:e2e` is filtered to web + marketing). Switching the key from
  `passThroughEnv` to `env` would close it for good; that was not done because the brief
  specified `passThroughEnv`.
- **Regeneration flushed another workstream's drift.** `pnpm generate:env` rewrites every
  marker in all four workflow files, so the run also emitted uncommitted registry
  additions from a concurrent push-notification workstream (`VAPID_*`,
  `NOTIFICATION_TAG_SECRET`, `VITE_VAPID_PUBLIC_KEY`, `VITE_SANDBOX_ORIGIN_URL`) into
  ci.yml / release.yml / build-android.yml / run-ops-script.yml. This is unavoidable (the
  generator has no per-marker mode) and correct — CI fails on generator drift — but the
  diff in those files is not all this task's.
- **Pre-existing test failures, not fixed:**
  - `generate-env.test.ts > verify-secrets section > generates for loop with all backend
    secret keys` — the expectation lacks `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
    `NOTIFICATION_TAG_SECRET`. Attribution: `packages/shared/src/env.config.ts` has +131
    uncommitted lines adding those; `git show HEAD` has zero occurrences of
    `VAPID_PUBLIC_KEY` in either file. Owned by the notifications workstream.
  - `seed-run.test.ts` and `refresh-catalog-run.test.ts` fail to load with
    `Cannot find module …/.vite/vitest/…/deps_ssr/@hushbox_db.js` — a vite dep-optimizer
    cache artifact, unrelated to any file touched here.
- `apps/sandbox/dist` was built locally to make the wrangler dry run meaningful. It is
  gitignored (`apps/sandbox/.gitignore:2`) and left in place.
- The custom domain provisions DNS + certificate on the first real deploy; that step has
  never run against Cloudflare, so first-deploy behavior is unverified by construction
  (no credentials available here).

## Follow-up: ESM_CDN_URL moved from `passThroughEnv` to `env`

The cache-key concern raised above was ruled closed, and `turbo.json`'s `build` task now
declares `"env": ["ESM_CDN_URL"]`. The comment records the durable reason: the value is
baked into the sandbox's `/config.js`, so it determines build output and belongs in the
cache key; `passThroughEnv` supplies a value without hashing it, which would let a dist
built against the local test stub replay from cache for a production build. The `dev`
task keeps `passThroughEnv` — it produces no cached artifact, so hashing buys nothing.

Verification:

- Task graph unchanged: `@hushbox/sandbox#build` still depends on
  `@hushbox/config#build` and `@hushbox/sandbox#fetch-pyodide`.
- Hash now varies with the value — the point of the change. Two dry runs of
  `turbo build --filter=@hushbox/sandbox`, differing only in `ESM_CDN_URL`:

  | `ESM_CDN_URL` | task hash |
  | --- | --- |
  | `https://esm.sh` | `f9219d72b9a8d380` |
  | `http://localhost:7400/esm-stub` | `db9f99a6d2c63e11` |

  and `environmentVariables.configured` now carries a hashed
  `ESM_CDN_URL=<digest>` entry (it was empty under `passThroughEnv`).
- The value still reaches the build: `ESM_CDN_URL=https://esm.sh turbo build
  --filter=@hushbox/sandbox --force` succeeds and the emitted `dist/config.js` contains
  `esmCdnUrl` = `esm.sh`. With the variable unset the same command fails fast —
  "ESM_CDN_URL is not set — run `pnpm generate:env` …" — confirming the strict-env path
  is exercised, not silently defaulted.

Gates re-run after this edit: `pnpm generate:env` (idempotent, no workflow diff),
`pnpm verify:env --mode=production` (pass), `prettier --check` on all touched files
(pass), `eslint` from `scripts/` (exit 0), `generate-env.test.ts` (109 pass, same single
pre-existing failure).

## Follow-up: release.yml's `prepare-web` headers step (audit finding)

`release.yml`'s "Generate _headers (CSP hashes per marketing route)" step carried a
hand-written env block with only `VITE_API_URL`. `scripts/generate-headers.ts` fail-fasts
on `SANDBOX_ORIGIN_URL` before doing any work, and the step runs directly rather than
through `scripts/with-env.ts`, so the workflow block is its only source — the
`prepare-web` → iOS path broke deterministically. Confirmed by reproduction, not by
reading:

- step env as it was (`VITE_API_URL` only, `SANDBOX_ORIGIN_URL` unset): exit 1 —
  "SANDBOX_ORIGIN_URL must be set (got undefined). The generated CSP's frame-src must
  allow the document sandbox origin so the app can embed its renderer iframe."
- step env as it now is (both vars): exit 0 — "Wrote …/apps/web/dist/_headers
  (14 marketing pages, 32 blocks)".

Fixed the generator-owned way, not with a literal: the step's env is now wrapped in a
`headers-env` marker pair, so ci.yml and release.yml draw the same block from one source
and neither can drift. The step's `VITE_API_URL` rationale comment was moved above the
marker (nothing hand-written survives inside it). Post-regeneration the block reads
`VITE_API_URL: https://api.hushbox.ai` + `SANDBOX_ORIGIN_URL: https://sandbox.hushbox.ai`,
matching ci.yml.

Also mirrored the Pyodide cache into `prepare-web` (same action, path and
`hashFiles('apps/sandbox/scripts/fetch-pyodide.sh')` key), before `Build web` — that job
runs the whole-workspace `pnpm build`, which now transitively fetches ~26 MB inside an
8-minute budget.

Tests added:

| Test | Behavior |
| --- | --- |
| `headers-env in release.yml > emits SANDBOX_ORIGIN_URL for the CSP frame-src directive` | the release workflow's block carries the var |
| `headers-env in release.yml > does not leak build secrets into the headers step` | negative case — no `VITE_HELCIM_JS_TOKEN`, no `ESM_CDN_URL` in that block |
| `generate-headers.ts steps > draws its env from the generator in every workflow that runs it` | scans `.github/workflows/*.yml`: every step running `generate-headers.ts` has its `env:` inside a `headers-env` marker |

The third is the one that would have caught this finding, and it was watched failing for
exactly the right reason ("release.yml runs generate-headers.ts with an env block the
generator does not own") before the fix, then green after. The two fixture tests are
regression pins that passed on write — the generator is workflow-file-agnostic, so the
defect was in release.yml's markup, not in generator code; they exist to keep a future
generator change from dropping the block.

Verification after the change:

- `pnpm generate:env` run twice: every file under `.github/workflows/` byte-identical
  between runs (`diff -r` of two snapshots).
- `pnpm verify:env --mode=production` — pass.
- All nine workflow YAMLs parse (js-yaml); `prepare-web` steps resolve to
  Cache Pyodide assets → Build web → Merge marketing → Generate _headers → Upload web,
  with the headers step's env parsing to both variables.
- `prettier --check` on turbo.json + the four generated workflows + both scripts files —
  clean; `eslint` from `scripts/` — exit 0.
- `generate-env.test.ts` — 112 passed, 1 failed (the same unrelated pre-existing
  `verify-secrets` staleness).

`apps/web/dist/_headers` was rewritten by the reproduction run; it is gitignored
(`.gitignore:6`).

## Confidence

High for changes 1–3 and the generated blocks (each verified by a command whose output is
quoted above). Medium for change 4's end-to-end deploy: the step wiring, artifact flow and
YAML are verified structurally, but the deploy itself and the custom-domain provisioning
can only be proven by a real `main` deploy.
