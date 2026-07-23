# E2E-Green Fix Plan — 2026-07-23

Live backlog. Grows each cycle. Diagnoses in `research/`; run history + transitions in `ledger.md`.

## Global Constraints
- No source edits by the orchestrator; all fixes via sdd-implementer. No git state-mutating commands, no commits.
- Long-term root-cause fixes only. Forbidden: test.skip/.only, weakened assertions, raised timeouts, added retries/waits to hide races, worker-count reduction to dodge saturation.
- TDD at the closest layer: failing test first (watch it fail), then fix.
- Another agent is concurrently editing `apps/api/src/slices/identity/routes-deletion.integration.test.ts` + `routes.integration.setup.ts` and owns `docs/plans/runs/2026-07-22-test-suite-parallelism/`. Do NOT touch their files. Attribute failures with care.
- Fix the class not just the instance: each root cause gets an enforcement-ladder check where one exists.

## Failure taxonomy (Run #0, report 2026-07-23T05-31-47)
- Saturation collateral @12 workers (~43): media(A ~30), billing(C 4), sharing(D 4), crashes(F 2). Pending measured re-run to confirm reproducibility before any infra work.
- Independent bugs: B (glob), G (stale spec), E (public-stats isolation), H (smart-model, founder-decided).
- Excluded / gated: saturation infra (architecture + overlaps concurrent agent → escalate); E schema option (approval); H done via founder decision.

---

## Task-01 — Fix chat-payload capture glob (cluster B)
**Objective:** Make `captureChatRoutePayload` actually intercept `POST /chat` so the 3 media-payload assertions can read the request body.
**Acceptance criteria:**
- `e2e/helpers/route-payload.ts` route matcher matches `POST http://<host>/chat` (no trailing slash) AND `/chat/regenerate`, `/chat/trial`, `/chat/guest` sub-paths; does not break on `/chat` navigation GETs (they carry no postData).
- The 3 tests reach and pass their `toContain('16:9'|'1080p'|'9:16')` assertions when the media turn itself succeeds (note: they still depend on media generation working — see Task-media).
- No other e2e helper behavior changes.
**Design context:** `page.route('**/chat/**')` compiles (Playwright 1.60 `globToRegex`) to `^(.*/)chat/(.*)$`, which requires the literal substring `chat/`; a fresh authenticated turn posts to `/chat` with no trailing segment, so the capture never fires and `captured.get()` stays undefined. Root fix = replace the glob with a RegExp `/\/chat(?:\/|\?|$)/` (analyst Option A — narrowest shared-helper fix, keeps reuse for `/chat/*` flows). Rejected: narrowing to `**/chat` (silently drops sub-paths); larger `waitForRequest` refactor (unneeded churn). Latent bug, not an effort-commit regression (specs byte-identical pre/post 2ab91d7a).
**File ownership:** `e2e/helpers/route-payload.ts` (+ any colocated helper test). Non-overlapping.
**Interfaces:** Consumes/Produces: none changed — same `captured.get()` contract.
**Scoped checks:** e2e path only → no package test/typecheck matrix row; verify via `pnpm e2e e2e/chat/image-generation.spec.ts e2e/chat/video-generation.spec.ts` (the payload cases) AFTER media works, or a helper-level unit assertion that the matcher matches `POST /chat`. Prettier/eslint on the changed file.
**Sensitive?** No.
**TDD:** first add/extend a helper-level test asserting the matcher matches `http://host/chat` (POST) — red today — then fix.

---

## Task-02 — Update stale account-deletion lockout E2E spec (cluster G)
**Objective:** Align `e2e/account-deletion.spec.ts` "fourth failed attempt surfaces lockout error" with the current, deliberate deletion-lockout contract.
**Acceptance criteria:**
- The test loops `maxAttempts` (DERIVED from `IDENTITY_KEYS.deleteAccountLockout` config, not a literal), asserting each wrong-TOTP `/finish` returns `400 INVALID_TOTP_CODE`, then the NEXT attempt returns `403 DELETE_ACCOUNT_LOCKED` (with `retryAfterSeconds` detail).
- `expectApiErrors` / `expectConsoleErrors` updated: expect a 403 (not 429), code `DELETE_ACCOUNT_LOCKED` (not `TOO_MANY_ATTEMPTS`).
- Test name/comments describe the current behavior; no stale "very first"/"4th → 429" language.
- Does NOT edit any identity integration test/setup file (concurrent agent owns those).
**Design context:** Commit `c6209b02` deliberately changed `deleteAccountLockout.maxAttempts` 3→2 and the locked-branch response 429/`TOO_MANY_ATTEMPTS` → 403/`DELETE_ACCOUNT_LOCKED` for documented legacy parity (`keys.ts:220-224`), ALREADY pinned by the committed integration test `routes-deletion.integration.test.ts:172-199`. The e2e spec is the lone stale straggler. This is a stale-test fix, not an app change. Trace showed 400,400,403 (locks on the 3rd attempt with maxAttempts:2). Auth-sensitive — the app side is settled in-repo; do not touch app code.
**File ownership:** `e2e/account-deletion.spec.ts` only.
**Interfaces:** none changed.
**Scoped checks:** `pnpm e2e e2e/account-deletion.spec.ts` (the lockout test). Prettier/eslint on the changed file.
**Sensitive?** Yes (auth/deletion) — single auditor + orchestrator confirms behavior matches the committed integration test.
**TDD:** the failing e2e IS the reproduction; update expectations to the pinned contract and confirm green.

---

## Task-03 — Smart Model legacy affordable-subset pricing (cluster H) [READY]
**Objective:** Reserve/estimate Smart Model at worst-case over the AFFORDABLE subset (balance-dependent), server and client agreeing via ONE shared function, mirroring legacy.
**Acceptance criteria:**
- Server `buildSmartModelCandidates` (`smart-model-candidates.ts:283-290`): binary `menu.some(...)` gate → `menu.filter(item => balanceNanoUsd >= reserve + item.ceiling)`; return `null` when the filtered subset is empty; `candidates: filtered.map(candidateEntry)`. `estimate-run.ts:566` then MAXes over the subset (no edit there).
- $0 wallet → `null` → 402/block. Low-balance wallet with a cheap fitting model → admitted, subset = only the fitting models.
- The affordable-subset gate lives ONCE in `packages/shared/src/estimate/` (e.g. `smart-model-affordability.ts`), imported by BOTH server admission (`smart-model-turn.ts`) AND client affordability (`use-prompt-budget.ts`). Prerequisite hoist: `estimateRunCeilingNanoUsd` + `ratesFromPricing` (from `estimate.ts`) into shared — bound the hoist (watch `callManifest`/`ceilingInput`/`NO_STORAGE` pulling more apps/api-local helpers).
- Client stops pricing Smart Model at catalog headline-min (`list-models.ts:188-219` min); client affordability calls the shared gate; a $0 free-tier + Smart Model session yields `insufficient_free_allowance`, never `free_allowance`.
- Stale balance-INDEPENDENCE comments rewritten (`smart-model-candidates.ts:20-46,263-282`; `estimate-run.ts:444-459`) — else wrong-comments.
- `e2e/chat/smart-model.spec.ts:252` passes UNCHANGED.
- NO client-only copy, NO golden cross-check test between two impls (banned sync-contract) — collapse to the shared function.
**Design context:** Founder decision. Legacy formula (Verified, from `0383e22b:packages/shared/src/smart-model/eligible-models.ts`): `reserve = classifierWorstCase + worstCase(maxFees over affordableSubset)`, `affordableSubset = { m : canAfford(m) ∧ minCost(m)+classifierWorst ≤ effectiveBalance }`, empty ⇒ 402. Reverses 07-20 Task-35 balance-independence. Full detail: `research/smart-model-legacy.md` (analyst return in ledger/agent output).
**Hidden coupling (must not miss):** (1) filter uses `turnCeilingNanoUsd` floor (min-viable answer w/ promptInputTokens), reserve uses `modelCeiling` worst-case — keep the asymmetry (legacy has it; a candidate can pass the floor yet be refused at admission worst-case). (2) classifier reserve added on both legs; $0-block rests on classifierReserve>0 alone exceeding 0. (3) effort dimension consumes `picked.candidates` — shrinking to subset shrinks the auto-effort set (intended). (4) admission Lua unchanged (consumes estimator output).
**SCOPING (deliberate, flagged):** TRIAL path `trial-smart-model-candidates.ts` LEFT UNTOUCHED — no trial e2e failing; independent authority (quota gate), not banned duplication. Do not change it.
**File ownership:** `packages/shared/src/estimate/**` (new file + hoist), `apps/api/src/slices/models/domain/smart-model-candidates.ts`, `apps/api/src/slices/models/domain/estimate.ts` (hoist only), `apps/api/src/slices/chat/domain/smart-model-turn.ts`, `apps/web/src/hooks/billing/use-prompt-budget.ts`, `packages/shared/src/billing/client-billing.ts` + colocated tests. Serialize vs any concurrent shared-estimate task.
**Scoped checks:** `pnpm test:shared` + `pnpm test:api` + `pnpm test:web`; `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/api --filter=@hushbox/web`; then `pnpm e2e e2e/chat/smart-model.spec.ts`.
**Sensitive?** Yes — money/settlement-adjacent → **2-auditor money panel** (both must confirm: subset reserve correct, $0-block, client==server, high-balance concurrency NOT regressed under concurrent-settlement lens, no under-reserve).
**TDD (write first):** (a) `smart-model-candidates.test.ts`: `$0 → toBeNull()`; (b) same: low-bal + cheap+expensive → candidates = [cheap] only; (c) `estimate-run.test.ts`: node reserve = classifier + cheap ceiling (not expensive); (d) shared `smart-model-affordability.test.ts`: client verdict == server null-ness; (e) `use-prompt-budget` test: $0 free-tier + Smart Model → insufficient_free_allowance. Update existing balance-independent-menu assertions in `smart-model-candidates.test.ts`.
**Status:** READY (dispatch after tree free from Run #1).

---

## Task-04 — Public-stats snapshot test isolation (cluster E) [CONDITIONAL — likely IGNORE]
**Human ruling (2026-07-23):** if E is just a concurrency/temp artifact, IGNORE it.
**Decision rule:** the measured re-run reseeds and runs with NO vitest concurrent. If the leaderboard "Image" test PASSES → E was transient shared-DB residue → IGNORE (per ruling). If it REPRODUCES deterministically on the clean reseeded run → it is a real cross-suite isolation defect; only then reconsider (fix B = roll the integration test's snapshot writes into a rolled-back txn, no migration; fix A schema-scope needs approval).
**Design context:** `readLatestPublicStatsSnapshot` (`public-stats-stores.ts:122-139`) reads globally-latest row with NO table-level scope; integration test `public-usage-stats.integration.test.ts:42-85` commits snapshot rows to shared local PG.
**Status:** await measured re-run; default IGNORE unless reproducible.

---

## Task-media — Saturation collateral (clusters A/C/D/F) [PENDING measured re-run + escalation]
**Objective:** TBD after the measured re-run confirms whether the media(503)/billing/sharing/crash failures reproduce on a quiet host.
**Design context:** All four clusters are host-saturation collateral at 12 workers (storage.put→MinIO seam, mock webhook self-fetch drop, chunk-load fail, browser OOM). Doctrine: harden the stack (pooling/limits/backpressure), never lower workers. BUT: (1) needs a measured re-run to pin the binding resource (mem vs MinIO conns); (2) is an architecture/infra decision; (3) overlaps the concurrent `2026-07-22-test-suite-parallelism` agent. → escalate to human with re-run data before any infra edit.
**Billing sub-item (C):** independent of the infra fix — harden the DEV mock self-delivery (`payment-mock.ts` `deliverWebhook`) with a bounded cockatiel retry + make the swallowed delivery failure loud (SafeLogFields). No production change. Legitimate class-fix (one-mechanism-recoverable + never-hide-problems) regardless of the infra outcome.
**Human ruling (2026-07-23):** HARDEN. Orchestrator owns it — concurrent agent is done, no coordination blocker. Do NOT lower workers. First pin the binding resource (measured re-run + instrumentation: host `free -m`, MinIO/Neon `docker stats`) THEN harden that resource (pooling/connection limits/backpressure/memory headroom). Billing sub-item (C mock retry + loud) is independent and proceeds regardless.
**Status:** measured re-run in flight → then pin resource → then harden.
