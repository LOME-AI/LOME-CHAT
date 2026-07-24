# Task 07 — `GET /billing/spendable` — implementation report 1

Status: COMPLETE (all acceptance criteria met; unrelated failures attributed below).

## What was built

1. **Shared Lua fragment** (`apps/api/src/slices/billing/domain/admission-scripts.ts`)
   - `ACTIVE_HOLDS_LUA` extracted from `ADMISSION_SCRIPT`: defines
     `local function activeHolds(key, now)` — generic over ANY hold hash (wallet or
     budget scope, per the T08 handoff), sums active holds, counts them, lazily
     prunes expired entries. `now` is a parameter (the two scripts have different
     ARGV layouts).
   - `ADMISSION_SCRIPT` now embeds the fragment via template interpolation; call
     sites changed only from `activeHolds(KEYS[i])` to `activeHolds(KEYS[i], now)`.
     Behavior-identical: the full admission integration suite (29 tests, incl. the
     cushion/holds/run-cap/budget-scope pins) passes untouched, and the
     concurrent-settlement pin (`charge.integration.test.ts`) passes in the full
     billing run.
   - New `HOLDS_READ_SCRIPT`: read-only multi-key script (KEYS = N hold hashes,
     ARGV[1] = nowMs) returning a flat `[sumString, count, …]` array. Sums cross the
     wire as `%.0f` strings (Redis truncates raw Lua number replies to integers;
     the string keeps full 2^53 precision), parsed to `bigint` in TS. It prunes
     lazily exactly like admission. The hold value format is parsed ONLY inside
     Lua — no TS re-parse anywhere (grep-verifiable: no `split(':')`/regex over
     hold values outside the scripts).
   - Sharing is pinned by `admission-scripts.test.ts`: both scripts must contain
     `ACTIVE_HOLDS_LUA` verbatim.

2. **Admission refactor** (`domain/admission.ts`)
   - Exported `resolveEffectiveSpendable(deps, walletId)` = the exact
     snapshot-resolve + `spendableFor` composition `admitRun` gates with (admitRun
     now calls it), so the served number and the admission gate share one
     implementation. `SpendableDecision` exported as its return type. The cushion
     rides through shared `spendableFundsNanoUsd` exactly as before (no second
     implementation was needed — NEEDS_CONTEXT trigger did not fire).

3. **Spendable domain read** (`domain/spendable.ts`, new)
   - `readActiveHolds(redis, keys, now)` — one round trip over N hold hashes via
     `HOLDS_READ_SCRIPT`; typed `unavailable` on Redis failure (fail-closed);
     `[]` for an empty key list. Exported for T08 (from the module; the T08 brief
     adds its own barrel export when it consumes it — kept off the barrels now to
     stay knip-clean).
   - `readSpendable(deps, {userId, concurrentRunCap, now})` — resolves the
     caller's PURCHASED wallet (the balance-gated wallet; the free daily allowance
     is a budget scope and rides the budgets endpoint per BILLING §Affordability
     1/6), reads its effective spendable through `resolveEffectiveSpendable`,
     subtracts the wallet's active holds:
     `{spendableNanoUsd (may be negative), heldNanoUsd, concurrentRunsRemaining = max(cap − active, 0)}`.
     No purchased wallet → typed `not_found`.

4. **Route** (`routes.ts`): `GET /billing/spendable`, route class `billing-token`
   (exists; same class as `/balance` — mobile→web billing portal admitted),
   identity via `billingPrincipalUserId`, NanoUSD-string serialization, errors via
   `respondDomainError` (Redis down ⇒ `unavailable` → 503 `{code:'UNAVAILABLE'}`,
   the same mapping admission uses). Deliberately separate from `/balance`
   (ledger-truth read survives Redis outage — pinned by test).
   - `BillingRouteDeps.concurrentRunCap: number` added; the composition root
     (`app.ts`) wires it to chat's `PER_WALLET_CONCURRENT_RUN_CAP` — one constant,
     two import sites. Billing cannot import chat's barrel (chat already imports
     billing's — cycle), so the cap threads through deps.
   - Barrel: `domain/index.ts` exports `readSpendable` (routes import only the
     domain barrel). Slice `index.ts` unchanged.

5. **Shared schema** (`packages/shared/src/schemas/api/billing.ts`):
   `getSpendableResponseSchema` / `GetSpendableResponse` —
   `{spendableNanoUsd: string, heldNanoUsd: string, concurrentRunsRemaining: int ≥ 0}`,
   exactly the Handoff shape. Re-exported through the existing
   `schemas/api/index.ts` star export.

## Acceptance-criteria evidence

- **Pinning test (analyst C):**
  `spendable.integration.test.ts › serves the exact effectiveSpendable minus held
  sum admission gates with under an active hold` — seeds $2 wallet, places a real
  `admitRun` hold ($0.70), asserts served spendable `=== spendableFundsNanoUsd(2e9,'paid') − 7e8`
  numerically AND behaviorally: `admitRun` with `served+1n` refuses
  `insufficient-balance`, with exactly `served` admits. Route-level twin in
  `routes.integration.test.ts` asserts the same numbers as wire strings.
- **Expired-hold pruning on read:** domain test writes a stale `"amount:expiredMs"`
  field directly, read serves held=0 and the field is HDEL'd (hash gone). Also
  covered inside `readActiveHolds` tests (mixed live/expired).
- **`concurrentRunsRemaining` = cap − active:** pinned at cap−1 under one hold,
  floored at 0 when actives exceed cap.
- **Redis down ⇒ 503 typed; `/billing/balance` unaffected:**
  `routes.integration.test.ts › fails closed with a typed 503 when Redis is down
  while /billing/balance still serves` — dead-Redis env: `/billing/spendable` 503
  `{code:'UNAVAILABLE'}`, `/billing/balance` 200 in the same env. Domain-level
  dead-Redis tests for both `readActiveHolds` and `readSpendable` (`unavailable`).
- **ADMISSION_SCRIPT behavior-identical:** `admission.integration.test.ts` (29
  tests) untouched and green; full billing-slice + app-mount run: 577 tests pass,
  no billing per-file coverage errors (spendable.ts 100%).

## TDD

Every step red-first, watched: schema test (import failure + 3 fails) → schema;
fragment test (3 fails) → extraction; spendable integration test (module missing)
→ `spendable.ts` (one legit fix: Upstash `hgetall` of an emptied hash returns
`null`, assertion corrected); route tests (4 fails, route absent/503) → route +
deps wiring. Minimal green each time.

## Scoped checks (Verified, this session)

- `pnpm test:api` (full): 6072 passed; **2 failing files, both attributed, not
  mine**: (a) `slices/chat/routes.integration.test.ts` (4 tests) — chat
  `routes.ts`/`turn-definition.ts` are dirty from sibling T10's in-flight work;
  (b) `notifications/domain/templates/template-html.test.ts` (7 snapshot
  mismatches, obsolete font-`<link>` in stale snapshots) — pre-existing, no
  notifications file touched by this task. All billing/spendable/route/admission
  files pass.
- `pnpm test:shared` (full): all tests pass; **coverage gate fails on
  `src/estimate/smart-model-affordability.ts` (branches 86.02%)** — file untouched
  by this task (git-clean in `estimate/`; my shared edits are `schemas/api/billing.*`,
  fully covered). Attributed as pre-existing / sibling-run territory (T03 owns
  `estimate/`).
- Typecheck: `tsc --noEmit` exit 0 in both `apps/api` and `packages/shared`.
- Lint: `eslint <owned files>` exit 0 run from each package dir AFTER the last
  edit (api list: admission-scripts{,.test}, admission, spendable{,.integration.test},
  domain/index, routes, routes.integration.test, routes-usage.integration.test,
  app.ts, app-mount.integration.test; shared: schemas/api/billing{,.test}).
- `pnpm arch:check`: OK (11 rules / 1880 files).
- `pnpm lint:unused` (knip): one finding, `packages/config/vitest.package.config.ts`
  (unused file) — pre-existing/committed elsewhere, unrelated; zero findings on
  this task's exports.

## Files changed

- `apps/api/src/slices/billing/domain/admission-scripts.ts` — fragment + read script
- `apps/api/src/slices/billing/domain/admission-scripts.test.ts` — NEW (sharing pins)
- `apps/api/src/slices/billing/domain/admission.ts` — `resolveEffectiveSpendable` extraction (behavior-identical)
- `apps/api/src/slices/billing/domain/spendable.ts` — NEW domain read
- `apps/api/src/slices/billing/domain/spendable.integration.test.ts` — NEW (12 tests)
- `apps/api/src/slices/billing/domain/index.ts` — barrel export
- `apps/api/src/slices/billing/routes.ts` — route + `concurrentRunCap` dep
- `apps/api/src/slices/billing/routes.integration.test.ts` — 5 new tests; testEnv Redis creds now taken from process env (the hardcoded token was wrong and unexercised before this route touched Redis through the pipeline)
- `apps/api/src/slices/billing/routes-usage.integration.test.ts`, `apps/api/src/app-mount.integration.test.ts` — new required dep at manifest construction (mechanical)
- `apps/api/src/app.ts` — wires `PER_WALLET_CONCURRENT_RUN_CAP` into billing deps
- `packages/shared/src/schemas/api/billing.ts` + `.test.ts` — response schema

## Deviations / notes for the orchestrator

1. **`app.ts` + two extra test files edited (outside the Files list).** Unavoidable:
   `BillingRouteDeps` gained the required `concurrentRunCap`, and every manifest
   construction site must supply it. The cap constant lives in the chat slice;
   billing cannot import chat's barrel (import cycle), so the composition root
   threads it — flagged rather than silently re-declaring a second constant.
2. **Wallet basis decision (named ambiguity, resolved from the spec):** the
   endpoint serves the PURCHASED wallet. BILLING §Affordability 6 makes spendable
   a paid-wallet concept (paid: +$0.50 cushion; free: "daily allowance only",
   which is a budget scope served hold-aware by T08's budgets endpoint; trial/guest
   client-side per Task 09). Mirroring chat's payer-wallet fall-through
   (purchased>0 → else free) in billing would duplicate chat's funding rule — a
   sync contract. If the auditors read §Affordability 1 differently, this is the
   place to look.
3. `readActiveHolds` is module-exported but not yet on the slice barrel — T08's
   brief owns the "billing barrel export of the scope-hold reader"; exporting it
   unconsumed now would trip knip.
4. Sibling dirt observed (not touched): T10 in `packages/shared/src/prompt/*`,
   `apps/api/src/slices/chat/routes*`; T01 in `apps/api/src/slices/models/*`.
