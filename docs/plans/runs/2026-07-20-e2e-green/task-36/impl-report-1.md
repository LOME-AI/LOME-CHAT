# Task-36 impl-report-1

## Objective

Cap local Playwright worker concurrency for the media-heavy mobile projects
(`iphone-15`, `pixel-7`, `ipad-pro`) so the full media suite does not saturate the
single local backend at the 12-worker global pool. Config-only; mirrors the existing
firefox precedent. No app/product code change.

## Files changed

- `playwright.config.ts` — added a per-project `workers: isCI ? 4 : '25%'` cap to each of
  the three media-heavy mobile projects, with a rationale comment (full comment on
  `iphone-15`, one-line back-references on `pixel-7` and `ipad-pro`).

## Diff (semantic)

Added to `iphone-15` (after `dependencies: ['setup-iphone-15']`):

```ts
// Capacity-match to the single local backend (one wrangler Worker + one
// MinIO + one Redis + one Postgres). This project runs the full media
// suite; at the global pool (12) N concurrent media runs saturate that
// one backend — storage.put exhausts retries (UNAVAILABLE) and the redis
// revocation read 503s. Production scales the backend, so this cap is a
// local-only capacity match, not a product limit. Set one step below the
// firefox precedent (30%) because firefox does not run the media suite.
// '25%' of the 12-worker pool = 3 locally; 4 in CI (both ≤ pool, so the
// workers ≤ persona-pool invariant at :46-50 holds).
workers: isCI ? 4 : '25%',
```

Added to `pixel-7` and `ipad-pro`:

```ts
// Media-suite capacity cap — see iphone-15 above for the rationale.
workers: isCI ? 4 : '25%',
```

## Chosen worker values + rationale

- **Local: `'25%'`** → 25% of the 12-worker pool = **3 workers**. One step below the
  firefox local precedent (`'30%'` = ~3.6) because these projects run the full media suite
  (image/video generation → `storage.put` against one MinIO) while firefox does not. Does
  not exceed the firefox local value (criterion 1).
- **CI: `4`** → identical to the firefox CI value (`isCI ? 4`). CI top-level workers is 7,
  so 4 ≤ 7 and 4 ≤ 12 pool.
- **Invariant preserved (criterion 2):** both 3 (local) and 4 (CI) are ≤
  `E2E_WORKER_POOL_SIZE` (12, verified at `scripts/lib/seed-personas.ts:256`), so fewer
  workers than pooled personas → no shared-wallet cross-worker admission contention.
  `E2E_WORKER_POOL_SIZE` and the top-level `workers` (`:50`) were not touched.

## Verification: per-project `workers` is honored (criterion 4)

- **Type support:** `TestProject.workers?: number|string` is a native field in
  `@playwright/test` v1.60.0 —
  `node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/types/test.d.ts:744`.
  The doc block at `:710-744` explicitly documents per-project worker limiting and states
  the global limit caps total worker processes while Playwright limits per-project workers
  via `testProject.workers`. (Verified — read the type file.)
- **Runner is vanilla Playwright:** e2e scripts invoke `playwright test` through a thin env
  wrapper only — `package.json:39-41` (`tsx scripts/with-env.ts playwright test ...`);
  `with-env.ts` sets environment, it is not a custom test runner. No custom runner
  intercepts or reimplements project config. (Verified — grepped package.json scripts.)
- **Existing precedent:** the firefox project already relies on the identical field
  (`playwright.config.ts:150` for `setup-firefox`, `:245` for `firefox`) and the config
  typechecks/lints clean today, confirming the field is accepted and not silently dropped.
- Conclusion: the mechanism is genuinely honored; this is not a no-op. No STOP condition
  hit.

## Self-gate

- `pnpm typecheck` — **pass** — 15/15 tasks successful.
- `pnpm lint` — **pass** — 15/15 tasks successful (FULL TURBO).
- `npx prettier --check playwright.config.ts` — **pass** — exit 0 (run because the
  root-level config file may sit outside the per-package lint scopes; Prettier is enforced
  as an ESLint rule in this repo, so I confirmed formatting directly).

Note: `pnpm typecheck` / `pnpm lint` run per-package via turbo; the 15 lint tasks are all
package-scoped, so I additionally ran Prettier directly on the owned root file to be
certain it is gated. (An earlier ad-hoc `npx tsgo -p tsconfig.json` surfaced pre-existing
TS6306/TS6310 project-reference-composite errors unrelated to this change — that is not the
repo's sanctioned typecheck path and reflects invoking tsgo directly against the root
solution tsconfig, not my edit.)

## Acceptance criteria

1. Per-project `workers` cap added to `iphone-15`, `pixel-7`, `ipad-pro` mirroring firefox
   — **met** (see diff; local `'25%'`, CI `4`, ≤ firefox local `'30%'`).
2. `workers ≤ persona-pool` invariant preserved; `E2E_WORKER_POOL_SIZE` and top-level
   `workers` untouched — **met** (3/4 ≤ 12; no edit to `:50` or seed-personas).
3. Comment recording WHY (single local backend can't serve N concurrent media runs;
   production scales) — **met** (full comment on iphone-15, back-refs on the other two).
4. Per-project `workers` confirmed honored by this repo's runner — **met** (see
   Verification section; no STOP).
5. No app/product code, no storage-r2/MinIO/admission change — **met** (only
   `playwright.config.ts` touched).

## Deviations

None.

## Concerns and limitations

- **Behavioral proof is deferred** (as specified). This task does not run any `pnpm e2e*`
  command. That the media `UNAVAILABLE`/`503`/browser-crash cascade is actually eliminated
  is validated by the user's next `pnpm e2e:fast` (single-project `iphone-15`) and full
  `pnpm e2e` run. `e2e:fast` targets `iphone-15` alone, which now caps at 3 local workers.
- The exact sustainable number (3 local) is a reasoned estimate anchored to the firefox
  precedent, not an empirically tuned value; if the user's run still shows saturation, the
  cap can be lowered further without any other change.

## Confidence

High — the change is a two-token edit replicated across three project blocks, exactly
mirroring an in-file precedent that already typechecks/lints clean; the honored-mechanism
question is settled by the Playwright type definition and the vanilla runner path. The only
open item is the intentionally deferred behavioral e2e proof.
