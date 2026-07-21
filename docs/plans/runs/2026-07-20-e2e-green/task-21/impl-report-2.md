# Task-21 — impl-report-2 (attempt-2, test-infra chat-402 isolation)

## Status: BLOCKED — my test-infra fix landed clean, but the chat-402 flood is app-side (out of my ownership), not test contention. Evidence below.

## Objective
Kill the chat-turn 402 INSUFFICIENT_ADMISSION flood by (A) stopping the per-test
global admission wipe that races parallel workers, and (B) confirming real
per-worker wallet isolation. Verify zero 402 at real parallelism.

## What I changed (all inside granted ownership)

- `apps/api/src/platform/dev/redis-resets.ts` — removed `billing:admission:*`
  from `resetUsageRateLimits` (the per-test hook's prefix list); it now clears
  only the rate-limit prefixes. Added `resetAdmissionState(redis)` (deletes
  `billing:admission:*`) as the once-per-run clear. Dev-only code, kept
  dev-classed.
- `apps/api/src/platform/dev/routes.ts` — added `DELETE /dev/admission-state`
  (`routeClass('dev-only')`, `idempotencyExempt('naturally-idempotent')`,
  `byUpsert`), mirroring the sibling reset routes. Imported `resetAdmissionState`.
- `apps/api/src/platform/dev/routes.integration.test.ts` — TDD: rewrote the
  `/dev/usage-rate-limits` test to pin that it now PRESERVES a `billing:admission:*`
  key (RED against old code, GREEN after), and added a test that
  `DELETE /dev/admission-state` clears wallet-hold + snapshot keys.
- `e2e/global-setup.ts` — added `clearAdmissionState()` (best-effort HTTP
  `DELETE /dev/admission-state`, logged-not-swallowed on miss) as a once-per-run
  clean baseline. Best-effort because Playwright spawns the webServer in
  parallel with globalSetup (config comment, playwright.config.ts:77), so the
  Worker may not answer yet; a miss self-heals via the hold/snapshot TTLs.

Attempt-1's worker-aware `personas.ts`/`fixtures.ts`/pool changes were already in
the tree; I built on them, reverted nothing.

## Caller check for `resetUsageRateLimits` (brief requirement)
Only caller in the source tree is the e2e dev route (`routes.ts:513`; the e2e
hook `fixtures.ts:1082` → `clearUsageRateLimits` → `DELETE /dev/usage-rate-limits`).
No non-e2e caller, so changing its prefix list is safe — no wallet-scoped variant
was required.

## Self-gate
- `pnpm test:watch apps/api/src/platform/dev/routes.integration.test.ts` — pass
  (62/62), including the two admission-reset assertions.
- eslint (from `apps/api`, changed files) — pass (exit 0).
- eslint `e2e/global-setup.ts` (from `e2e`) — pass (exit 0).
- `pnpm typecheck` e2e workspace — pass; `turbo typecheck --filter=@hushbox/api`
  — pass.

## Parallel verification (the decisive result)
`flock … pnpm e2e:fast e2e/chat/chat-scroll.spec.ts e2e/group/group-chat-billing.spec.ts e2e/chat/multi-model.spec.ts`
(iphone-15 project, 50% workers = 12 workers on a 24-core host — genuine
parallelism; fresh stack via `e2e:prepare`).

Result: **13 failed / 62 passed**, still 402 INSUFFICIENT_ADMISSION.
Report: `e2e/report/2026-07-20T12-57-52/`.
- 8× chat-scroll, 3× group-chat-billing, 2× multi-model.
- The 8 chat-scroll + 3 group-billing exactly match attempt-1's residual count
  (report 12-32-47); the +2 multi-model are only because I added multi-model to
  the command. So my change is count-neutral and removes a real latent race —
  but does NOT clear the flood.

## Why (A) + (B) do not clear it — the root cause is app-side, not test infra

The 402 reproduces on a wallet that is **isolated, funded, and freshly cleared**,
on its **first** send — that cannot be cross-worker contention:

1. **Isolation is real.** `testBobPage`/`authenticatedPage` resolve through
   `pooledStorageStatePath`/`createPageFixture` to per-worker personas
   (`test-alice-w<slot>`, `test-bob-w<slot>`); auth.setup captures a storageState
   per pooled persona; the pool (`POOLED_PERSONA_BASE_NAMES`,
   `E2E_WORKER_POOL_SIZE=12`) seeds a distinct funded user+wallet per slot.
2. **Wallets are funded.** Postgres query after the run: every
   `test-alice-w*-iphone-15` and `test-alice-iphone-15` purchased wallet =
   `100000000000` nano ($100). No spend occurred (all runs 402'd pre-settlement).
3. **Admission state was clean.** global-setup's `DELETE /dev/admission-state`
   succeeded (no warn logged before the GPU-probe line), and the per-test wipe
   no longer touches admission — so no stale hold/snapshot bled in. chat-scroll's
   **first** test on a worker 402s on its **first** send → zero prior holds.
4. **Snapshot-miss is not fail-closed.** `admitRun` (admission.ts:174-183)
   bootstraps the snapshot from Postgres on `no-snapshot` and retries; a 402
   means the Lua returned `insufficient-balance`/`run-cap`/`budget-exceeded`
   against a present $100 snapshot with 0 holds → the estimate genuinely exceeds
   the full balance.

Code-level cause (app admission/estimate — NOT test infra):
- The admission Lua gates on the **raw** snapshot balance:
  `if snap.type ~= 'free' and balance - heldSum < estimate then 'insufficient-balance'`
  (admission-scripts.ts:59).
- But the turn's output ceiling is sized against `effective = remaining + PAID_CUSHION`
  (turn-definition.ts:202), i.e. the whole wallet PLUS the cushion, and the
  smart-model estimate is `classifierReserve + MAX(candidate ceilings)`
  (estimate-run.ts:436). The default chat model is `smart-model`.
- The smart-model affordability filter keeps a candidate iff
  `balance >= reserve + ceiling` (smart-model-candidates.ts:205-209) using
  `turnCeilingNanoUsd(descriptor, promptInputTokens)`. If the ceiling the
  affordability filter prices and the ceiling `estimateModelNode` prices at
  admission diverge (e.g. the stamped `promptInputTokens` basis, or
  ceiling-vs-cushion accounting), the assembled estimate can exceed the balance
  the filter thought it fit — producing `insufficient-balance` on a full wallet.

This is the territory of the **app/billing Task-21 (OPTION-F)** —
`estimate-run.ts`, `smart-model-candidates.ts`, `turn-definition.ts` — and/or
**Task-30** (`runtime.ts:591` collapses the refusal reason so the exact
`insufficient-balance` vs `budget-exceeded` cannot be read from wire or logs; I
could not disambiguate without that telemetry). My brief explicitly fences all
of these out of Task-21 test-infra ownership ("Do NOT touch app
admission/settlement — runtime.ts = Task-30").

## Acceptance criteria
1. Per-worker isolated funded wallet — MET (pool + storageState confirmed in
   tree; wallets funded $100; verified via DB). But isolation alone does not
   clear the 402 because the refusal is not contention.
2. Sequential self-collision / hold-release — N/A here: the 402 fires on the
   FIRST send of a fresh wallet, before any hold exists.
3. Verify zero 402 at real parallelism — NOT MET: 13 failed, root cause app-side.
4. No forbidden shortcuts — MET (no over-funding to mask; the isolation and
   admission-clear are legitimate determinism fixes).

## Deviations / concerns
- The brief's Plan-A hypothesis (per-test global admission wipe = THE bug) is
  empirically disproved as the *sufficient* cause: removing it + real isolation +
  funded wallets + clean baseline still 402s. Plan-A is still a correct, necessary
  latent-race fix (kept), just not sufficient.
- The remaining flood is blocked on the app-side estimate/affordability fix
  (app Task-21 OPTION-F) and is un-diagnosable to the exact reason until Task-30
  surfaces the refusal reason. Recommend the orchestrator sequence Task-21
  (test-infra) as landed, and route the residual 402 to the OPTION-F/Task-30
  owner — do not re-attempt it as a test-infra change.

## Confidence: high — that my changes are correct and that the residual 402 is
app-side (fresh isolated funded wallet, first send, refuses; admission gates on
raw balance while the estimate is sized against balance+cushion via smart-model).
Medium only on WHICH app line is authoritative (reason is swallowed by Task-30).

---

## Fix cycle 1 — pin top-level `workers` to the persona pool size

### Finding addressed
Both auditors flagged one Minor: `playwright.config.ts` top-level `workers` was
`isCI ? 7 : '50%'`, unpinned relative to `E2E_WORKER_POOL_SIZE = 12`
(scripts/lib/seed-personas.ts:256). On a host with >24 logical cores, `50%`
exceeds 12; `pooledPersonaName()` then takes `workerIndex % E2E_WORKER_POOL_SIZE`,
wrapping higher-index workers back onto shared personas/wallets and reintroducing
the exact cross-worker admission contention Task-21's isolation removes. On this
24-core box `50%` = 12 = pool, so it was correct today but not guaranteed on all
hosts.

### Change (only file: playwright.config.ts)
- Imported the constant, single-sourcing the relationship:
  `import { E2E_WORKER_POOL_SIZE } from './scripts/lib/seed-personas';`
- Changed the top-level worker count from `isCI ? 7 : '50%'` to
  `isCI ? 7 : E2E_WORKER_POOL_SIZE`, with a comment stating `workers ≤ pool by
  construction`. CI's 7 stays (7 ≤ 12). Per-project overrides that set a lower
  count (`isCI ? 4 : '30%'` on chromium/firefox) are unchanged — already ≤ pool.

No change to seed-personas.ts (pool size untouched, as bounded).

### Self-gate
- Typecheck of `playwright.config.ts` + its new import — pass (exit 0). Run via an
  isolated tsconfig extending `packages/config/tsconfig.base.json` with
  `composite:false` + the repo `paths`, `include: ["playwright.config.ts"]`. (The
  root `tsconfig.json` can't be typechecked standalone — it's a project-references
  root needing `--build`, and a full build surfaces only pre-existing, unrelated
  errors: composite-setting complaints on referenced projects and one unrelated
  `apps/web/.../model-list-body.test.tsx` type error — none in my files.)
- Prettier `--check playwright.config.ts` — pass (exit 0). Prettier is the repo's
  formatting gate (runs as an ESLint rule).
- ESLint: no package eslint config governs the repo-root `playwright.config.ts`
  — it sits outside every `createBaseConfig` base path (e2e's config reports
  "File ignored because outside of base path"), so it is not in the `turbo lint`
  per-package gate. Formatting is therefore covered by the prettier check above.

### Acceptance impact
Criterion 1 (per-worker isolated funded wallet) is now guaranteed on all hosts,
not just where `50%` happens to equal the pool. The residual app-side 402
(criterion 3) is unchanged and remains out of Task-21 test-infra ownership per the
attempt-2 analysis above.

### Confidence: high — one-line worker pin, constant single-sourced from the pool;
typecheck + prettier green.
