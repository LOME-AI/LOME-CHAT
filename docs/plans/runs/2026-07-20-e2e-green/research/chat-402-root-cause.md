# chat 402 INSUFFICIENT_ADMISSION — root cause (run 2026-07-20T11-49-24)

## Evidence
- `failed/e2e-chat-chat-scroll-*/api-errors.txt`: **402 POST /chat body `{"code":"INSUFFICIENT_ADMISSION"}`** on EVERY chat-scroll test. Synchronous on the POST response (not a stream failure).
- Request body (trace resource `c5c36c…json`): `"model":"smart-model"`, tiny prompt ("Visibility test message"), 2-msg history. **The default chat model is `smart-model` (SMART_MODEL_ID).**
- `image-generation-*`: NOT 402 — `Stream failed: ChatRunFailedError: UNAVAILABLE` mid-run (the 6 UNAVAILABLE). Separate defect.
- `server-api.log`: broken-pipe noise only. **No admission telemetry** (estimate/required/balance/reason) is emitted anywhere.

## Trace: is Task-15's stamp effective end-to-end? YES.
- `packages/shared/src/workflow.ts:57,117` — `promptInputTokens` in the modelCall/smartModel node schema (survives JSON transport + re-parse to the DO).
- `chat/routes.ts:859` builds the definition with `budget: turn.budget`; `smart-model-turn.ts:185-191` + `turn-definition.ts:558-568` stamp `promptInputTokens`; `routes.ts:867` sends the whole stamped definition to the DO; interpreter estimates `this.request.definition` (`interpreter.ts:299`) — the stamped definition, not a re-derived one.
- `estimate-run.ts:430-436` — the smartModel estimate is `classifierReserve + MAX(candidate ceilings)` (NOT a sum). Bounded by the affordability filter, which keeps a candidate iff `balance ≥ reserve + ceiling` (`smart-model-candidates.ts:205-209`). So the estimate genuinely fits the balance. **Not an over-estimate; not a Task-15 regression.**

## The wallet is funded, and the seed is present.
- `scripts/lib/seed-personas.ts:132` `DEFAULT_TEST_BALANCE_NANO_USD = $100`; `test-alice` (line 143) = $100; `iphone-15` IS in `E2E_PROJECT_NAMES` (line 82), so `test-alice-iphone-15` is seeded $100. **Not underfunded; not a missing-seed.**

## ACTUAL root cause: shared wallet + per-run hold ≈ balance  →  Task-21
1. ALL iphone-15 `authenticatedPage` tests share ONE wallet — `storageState: e2e/.auth/iphone-15/test-alice.json` (`playwright.config.ts:260`), `fullyParallel:true`, `workers:7` (`playwright.config.ts:39,43`).
2. The route sees the **DB balance ($100, holds NOT deducted)** — `turn-context.ts:275-279` funding = `purchased.balanceNanoUsd`. So `buildSmartModelCandidates` always finds affordable candidates → `buildable:true` (route never 402s here).
3. The 402 is the **DO admission** refusal, returned synchronously via `startRun → respondNonStarted` (`routes.ts:410`, `RUN_REFUSAL_STATUS[INSUFFICIENT_ADMISSION]=402`). Admission gates on the **Redis snapshot MINUS Σ active holds** (`admission.ts` ADMISSION_SCRIPT).
4. Each admitted smart-model run places a **hold ≈ a large fraction of the wallet**: `answerMaxOutputTokens` is sized to consume the whole remaining budget (`turn-definition.ts:206` `budgetMaxTokens = (effective − fixedCost)/variableCostPerToken`), and the estimate = reserve + that worst-candidate ceiling. So the wallet realistically supports ~one in-flight run.
5. With a shared wallet + 7 parallel workers (and back-to-back sends within a test whose prior hold has not been released — settlement release is deferred/best-effort: `releaseHold` best-effort, `withPostCommitSnapshotRefresh` swallows failures `runtime.ts:612`), `snapshot − Σholds < estimate` → admission returns `insufficient-balance` → collapsed to INSUFFICIENT_ADMISSION.
6. `runtime.ts:591` collapses `decision.admitted===false` to INSUFFICIENT_ADMISSION and **discards `AdmissionRefusalReason` (`insufficient-balance|run-cap|budget-exceeded`)** — which is why the reason/estimate/balance cannot be read from the wire or logs. This is the deferred Task-21 telemetry.

Nano-USD numbers: balance = 100_000_000_000 nano ($100); cushion $0.50; `PER_WALLET_CONCURRENT_RUN_CAP=5` (`chat/domain/constants.ts:29`). The exact estimate/required cannot be quantified — no admission telemetry exists (that gap is itself part of the fix).

### 402 VERDICT
Root cause = **shared-wallet + holds (Task-21)**, NOT Task-15. Every parallel iphone-15 chat test admits against the SAME `test-alice-iphone-15` wallet; each smart-model hold reserves ~the full balance, so overlapping runs see `snapshot − Σholds < estimate` → 402. Task-15's estimate fix is correct and effective end-to-end.
FIX: (1) Task-21 per-test wallet isolation — each test gets its own funded wallet (kills cross-test contention); (2) stop discarding the refusal reason at `runtime.ts:591` — surface `decision.reason` + estimate + `snapshot−holds` as admission telemetry so this is diagnosable; (3) ensure prompt hold release within a test (settlement/`releaseHold`/snapshot-refresh) so sequential sends on one wallet don't self-collide.

## UNAVAILABLE (6 image tests) — separate
- `image-generation-*` pass admission (no 402), then fail mid-run `ChatRunFailedError: UNAVAILABLE`. Redis is UP (text got INSUFFICIENT_ADMISSION, not ADMISSION_UNAVAILABLE), so this is **media storage (MinIO/R2), not admission**.
- `storage-r2.ts:196-213` — a failed PUT (`assertOk`) or the CI `recordServiceEvidence` write both map to `unavailableError` → UNAVAILABLE. The bucket-ready gate (`scripts/db-bucket-ready.ts` → `ensureMediaBucketReady`) runs only on `pnpm db:up` (`package.json:58`), NOT in the e2e global-setup.
### UNAVAILABLE VERDICT
Cause = the media bucket / MinIO was not ready (or the service-evidence write failed) for THIS e2e invocation because the readiness gate is bound to `db:up`, not to the e2e run.
FIX: call `ensureMediaBucketReady` in the e2e global-setup (make it a run precondition, independent of `db:up`); verify the MinIO endpoint/credentials/bucket name the Worker uses, and in CI confirm the `service_evidence` write path is healthy.
