# impl-report-1 — Task-30: surface admission-refusal reason (api observability)

## Objective

`createAdmissionHook` in `apps/api/src/slices/chat/domain/runtime.ts` collapsed every
`admitRun` refusal (`decision.admitted === false`) to the opaque
`ERROR_CODES.INSUFFICIENT_ADMISSION` wire code, discarding the typed
`AdmissionRefusalReason` (`insufficient-balance | run-cap | budget-exceeded`). A 402 was
therefore undiagnosable from logs (this is exactly what blinded
`research/chat-402-root-cause.md`). Surface the reason through the typed telemetry logger
at the refusal site, content-free, without changing the client-facing code.

## Gap verification (brief's FIRST step)

Verified the gap still exists AFTER Task-32 landed. `runtime.ts` (refusal branch, was
~line 591) still returned `{ admitted: false, code: INSUFFICIENT_ADMISSION }` with no
telemetry and no reason emitted. Task-32 modified `admission.ts` (the Lua/spendable gate)
but did NOT touch the runtime refusal-mapping site, so the reason was still swallowed.
Proceeded with the fix.

## Files changed

- `apps/api/src/slices/chat/domain/runtime.ts` — at the admission-hook `.match` success
  callback, split the ternary into a block; on `!decision.admitted`, emit
  `deps.telemetry.warn('chat admission refused', { errorCode: decision.reason, runId,
  conversationId })` before returning the unchanged `INSUFFICIENT_ADMISSION` result. The
  granted branch is byte-for-byte the same object as before.

## Tests added

- `apps/api/src/slices/chat/domain/runtime.integration.test.ts` —
  "emits admission-refusal telemetry carrying the typed refusal reason (a 402 is
  debuggable from logs)": builds a runtime with a captured telemetry mock, funds a paid
  wallet with 500n, requests admission for a $0.60 estimate (exceeds balance + $0.50 paid
  cushion), asserts `decision.admitted === false` AND `telemetry.warn` was called with
  `errorCode: 'insufficient-balance'` plus the run's `runId`/`conversationId`. Covers the
  acceptance criterion "test asserting refusal telemetry carries reason".

## Design decisions / constraints honored

- **SafeLogFields is a closed allowlist** (`lib/telemetry/safe-log-fields.ts`), OUTSIDE my
  ownership. It has no field for a refusal reason and no nano-USD-string money field. The
  machine-readable reason maps cleanly onto the existing `errorCode` field (a free string,
  never content). `runId`/`conversationId` are content-free correlation ids already in the
  allowlist.
- **Money never logged as Number.** The only money-typed field is `costUsd` (a float);
  the brief forbids logging money as Number, and there is no nano-USD-string field to add
  without editing `safe-log-fields.ts` (out of ownership). So the estimate and
  effective-spendable/holds are NOT logged (brief: "if available" — they are not available
  within bounds). See Concerns.
- **Client response unchanged.** The wire code stays `INSUFFICIENT_ADMISSION`; the reason
  is telemetry-only, never added to the response body.
- **No content/PII/keys logged.** The redaction lint (`redaction/no-sensitive-log-argument`)
  initially flagged `context.runId`/`context.conversationId` because "con**text**" matches
  its `/text/` regex; destructured to plain `runId`/`conversationId` locals — lint clean.

## Self-gate

- `pnpm test:watch runtime.integration.test.ts -t "debuggable from logs"` — pass (RED
  first: `warn` called 0 times; GREEN after impl).
- `runtime.integration.test.ts` (whole file) — pass, 29/29.
- `npx tsc --noEmit -p tsconfig.json` (apps/api) — pass (exit 0).
- `npx eslint runtime.ts runtime.integration.test.ts` (from apps/api) — pass (exit 0).
- `runtime.test.ts` (unit) — **2 failed / 43 passed. NOT my cause.** Both failures are
  `TypeError: redis.get is not a function` thrown inside `admission.ts:129`
  (`readRedisSnapshot`) via `admitRun` (`runtime.ts:561`) — which executes BEFORE my edited
  `.match` callback is ever reached. Cause: Task-32's `admission.ts` change now calls
  `redis.get`, but the unmodified unit-test redis mocks (`rejectingRedis`
  runtime.test.ts:69-71 and the grant-path mock) provide only `createScript`, not `.get`.
  Failing tests: "maps a Redis-down admission failure to ADMISSION_UNAVAILABLE" and
  "carries the wallet-hold identity on the admission grant". Fixing them requires
  supplying a Task-32-shaped Redis snapshot (balance + wallet type per `spendableFor`),
  which is Task-32 consumer semantics — not mine to guess. Raised for the orchestrator.

## Acceptance criteria

- "typed telemetry emits admission-refusal reason at refusal site" — MET (errorCode =
  `decision.reason`).
- "estimate + (snapshot−holds)" — PARTIALLY MET / not feasible within bounds: no
  SafeLogFields money-string field exists and the refused `AdmissionDecision` carries only
  `reason` (no estimate/holds); brief's "if available" qualifier. See Concerns.
- "TDD at api layer; no money-as-Number, no content logged" — MET.
- "Enforcement: test asserting refusal telemetry carries reason" — MET (the new test).
- "Proof: `pnpm test:api` scoped green" — MET for my files (integration 29/29, typecheck,
  eslint); the 2 unit failures are Task-32-caused (above).

## Deviations

- Did not log the estimate or effective-spendable/holds — blocked by the closed
  SafeLogFields allowlist (out of ownership) and the money-as-Number prohibition. Reason is
  the primary, and load-bearing, deliverable and is emitted.

## Concerns and limitations

- To also surface the nano-USD estimate on the refusal line, a new nano-USD-**string**
  field must be added to `apps/api/src/lib/telemetry/safe-log-fields.ts` (both the const
  array and the interface). That file is outside Task-30 ownership. Flagging for the
  orchestrator if estimate-on-the-line is wanted.
- The infra-failure branch (Redis-down → `ADMISSION_UNAVAILABLE`, runtime.ts ~line 605)
  was left unchanged: it already produces a distinct visible wire code, so it is not a
  blind spot the way the collapsed reason was. Not in scope.

## Confidence

High — the change is a minimal, additive telemetry emission at the exact swallow site;
RED→GREEN verified; typecheck + eslint clean; the only red check is a Task-32 side effect
provably upstream of my edit.
