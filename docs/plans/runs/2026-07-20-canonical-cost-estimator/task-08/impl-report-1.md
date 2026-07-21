# T8 impl-report-1 — STATUS: NEEDS_CONTEXT (criterion 1 blocked on an out-of-bounds transport gap; criteria 2–5 already satisfied)

## Objective (restated)
Wire the chat/billing slices to the T7-rebuilt estimator: (1) `runtime.ts` injects the estimator AND a
tier-exact `storageContext = { inputChars: TurnBudget.promptCharacterCount, tier: TurnBudget.funding→tier }`
into `createEstimateRun` for the chat turn (and trial turn); general/non-chat passes none. (2) `turn-definition.ts`
stamps feed the estimator. (3) `settlement.ts`/`charge.ts` pathological fallback uses the one shared core, and
media byte-storage stays charged at settlement. (4) `admission.ts` `estimateNanoUsd` path unchanged. (5) fail-closed
preserved.

**No edits were made this session.** This is an investigation report. I did not guess money math (per the brief),
because criterion 1's exact-tier wiring cannot be built inside my file bounds — see the blocker below. The pre-existing
`M` git status on runtime.ts/turn-definition.ts/etc. is the paused-run working-tree baseline, not my work.

## BLOCKER — criterion 1 (inject tier-exact storageContext into createEstimateRun for the chat turn)

### The seam, traced end to end (all Verified this session)
- `createEstimateRun(resolveModel, storageContext?)` is called at exactly one place for chat:
  `runtime.ts:326`, inside `buildExecutor`, as `createEstimateRun(common.pricingResolver)` — **no storageContext today**.
- `buildExecutor` builds the whole `FlowExecutor` with a FIXED `estimateRun` dep and the real path is memoized
  once: `cachedReal ??= buildExecutor(common, providerFor(deps))` (`runtime.ts:345`). One executor per DO/room,
  reused for every turn.
- The runtime is constructed **once per DO from env only** — `createChatConversationRuntime`
  (`conversation-runtime.ts:46`) → `createConversationRuntime(deps)` (`runtime.ts:839`). `ConversationRuntimeDeps`
  carries `db, redis, telemetry, apiKey, storage, chatStores, readEpochPublicKey, …` — **no funding/tier/budget**.
- The estimate is computed **per run at the DO** by `interpreter.run()`:
  `const estimate = this.deps.estimateRun(this.request.definition)` (`workflows/engine/interpreter.ts:299`),
  then handed to the admission hook as `{ definition, estimate }`. The interpreter passes **only the definition** —
  its own comment: "The admission hook only ever receives this server-computed estimate — no path accepts a
  caller-supplied one" (`interpreter.ts:72-75`).

### What `storageContext` needs, and where each datum lives
- `inputChars` = `promptCharacterCount(userMessage.content, history)` (`routes.ts:260`). **Recoverable at the DO**:
  the executor's `start(request)` has `request.inputs[CHAT_TURN_INPUT].text` (= `userMessage.content`) and
  `request.history`. (Only caveat: `promptCharacterCount` is a private route helper — a one-line `reduce`, trivially
  re-derivable in-bounds.)
- `tier` = `TurnBudget.funding.kind === 'purchased' ? 'paid' : 'free'` (`turn-definition.ts:167`). **NOT recoverable at
  the DO.** The payer `funding` is a route-time decision from `resolveTurnContext` (purchased balance vs free daily
  allowance vs owner-funded group budget vs personal fall-through). It is computed at `routes.ts:855-858` and thrown
  away after `buildTurnDefinition`. It does **not** ride:
  - `RunStartBody` (`packages/realtime/src/protocol.ts` — Verified: no funding/tier/budget field) — the route→DO body.
  - `RunContext` / `PaidRunIdentity` (`packages/shared/src/flow-executor.ts:209-289` — Verified: mode, userId,
    senderId, sender, conversationId, walletId, epochNumber, userMessage, forkId, regenerate; **no funding/tier**).
  - `bindHooks(context, definition)` (`room-core.ts:545`) — receives only `RunContext` + definition.
  - the executor `start(request)` — `definition, inputs, history, hooks, runKey, runId, mockDirectives, emit`
    (`room-core.ts:540-552`); no budget.

### Why the in-bounds workarounds are wrong or unavailable
- **Thread funding/tier route→DO (the correct, tier-exact fix):** requires editing `chat/routes.ts` (add to
  `RunStartBody`), `packages/realtime/src/protocol.ts` (`RunStartBody` schema), `packages/shared/src/flow-executor.ts`
  (`RunContext`/`PaidRunIdentity`), and `packages/realtime/src/room-core.ts` (thread into `bindHooks`/context) — **all
  out of my bounds** (brief: models/shared import-only; routes.ts and packages/* not in T8's file list).
- **Recover tier at the DO by reading the payer wallet type:** reproduces the route's funding decision (group budgets,
  owner-funding, free fall-through when purchased ≤ 0). It would yield the WRONG tier for group/owner-funded/fall-through
  turns — a money defect. Also `estimateRun` is synchronous; a DB read is not available on that path.
- **Add storage in the admission hook instead:** the brief explicitly forbids it ("admission `estimateNanoUsd` path
  unchanged … storage now rides inside that estimate via the injected storageContext. No second balance gate").

### Consequence
Because criterion 1 cannot be wired tier-exact in-bounds, the chat/trial admission hold currently does **not** include
storage (`createEstimateRun` is called with no storageContext), so the plan's Global Constraint "Reservation hold
INCLUDES storage" is unmet until this is resolved. This is the central new work of T8 and it is blocked.

## Criteria that ARE already satisfied in the current working tree (no edit needed)

### Criterion 3 — settlement media-storage parity + pathological fallback: INTACT
- **Media byte-storage IS charged at settlement**, single location, not dropped, not double-charged:
  `settlement.ts` `withStorageFees` (line 1119): `mediaFee = BigInt(mediaBytesOf(output)) × MEDIA_STORAGE_COST_PER_BYTE_NANO`,
  folded into `storageFeeNanoUsd` (line 1120) and charged once via `chargeWithinTx`
  (`charge.ts:76` `applyMarkup(baseCostNanoUsd) + storageFeeNanoUsd`; storage never marked up). `mediaBytesOf` reads
  the persisted ciphertext byteLength (`settlement.ts:1126-1130`). No second media-storage charge exists in chat/billing.
- **Pathological missing-cost fallback is NOT in settlement.ts/charge.ts.** They consume `baseCostNanoUsd` + `isEstimated`
  as given (`charge.ts:20,27,76`); the missing-text/video-cost→admission-estimate fallback lives in the workflows/models
  node layer (T7 territory, out of bounds), rebuilt on the shared core there. So chat/billing hold **no** duplicated
  estimate formula. Confirmed by grep (below).

### Criterion 2 — turn-definition stamps feed the estimator: ALREADY DONE
`turn-definition.ts` already stamps `promptInputTokens` (`promptInputTokensFor`, line 177) and answer `maxOutputTokens`
(`turnMaxOutputTokens`, line 181) onto language nodes; `estimate-run.ts` reads both (`inputTokenCeiling`,
`declaredOutputCeiling`). No pricing/storage math is duplicated here — the per-token/markup math is `applyMarkup` +
`STORAGE_COST_PER_CHARACTER_NANO` usage only (a shared nano rate, not a formula clone). The storageContext, when it can
be supplied (criterion 1), needs only `promptCharacterCount` (already a TurnBudget field) + `funding→tier` (already
`tierForFunding`). Nothing to add here beyond criterion 1's injection.

### Criterion 4 — admission.ts estimateNanoUsd path unchanged: CONFIRMED
`admitRun` receives `request.estimateNanoUsd` and uses it directly for the hold and the cost circuit
(`admission.ts:194,210,237,239`: `costCircuitLimitNanoUsd = estimateNanoUsd × COST_CIRCUIT_MULTIPLIER`). No second
balance gate. Storage is meant to ride *inside* that estimate (criterion 1), so admission needs no change.

### Criterion 5 — fail-closed preserved: CONFIRMED
`createEstimateRun` returns `Result<NanoUSD, DomainError>`; an `err` makes the interpreter refuse before admission
(`interpreter.ts:300-306` → `failBeforeAdmission({ kind: 'inputs-invalid' })`). Unchanged by anything here.

## grep proof — no duplicated pricing/storage formula in chat/billing
- `grep -rn "isEstimated|pathological|admission estimate|fallback|baseCostNanoUsd"` over chat/billing domain: no
  estimate-fallback formula; `baseCostNanoUsd`/`isEstimated` only appear as pass-through fields in `charge.ts`.
- Storage math in chat/billing is confined to `settlement.ts` `withStorageFees` (actual chars/bytes × the shared nano
  rate) — the settlement ACTUAL fee, genuinely distinct from the core's admission ESTIMATE, sharing only the
  single-sourced `STORAGE_COST_PER_CHARACTER_NANO` / `MEDIA_STORAGE_COST_PER_BYTE_NANO` constants (billing barrel
  re-exports of the shared nano rates). No mirrored constant, no drift guard, no golden cross-check.

## Options for the orchestrator (pick one; each is a money/scope decision I must not make)
- **(A) Expand T8 bounds** to include `chat/routes.ts` + `packages/realtime/src/protocol.ts` (RunStartBody) +
  `packages/shared/src/flow-executor.ts` (RunContext/PaidRunIdentity) + `packages/realtime/src/room-core.ts`, so the
  payer `funding` (or a precomputed `storageContext = { inputChars, tier }`) is threaded route→DO→executor. Correct and
  tier-exact. Note: shared/realtime are the wire seam T9/T1 also touch — sequencing/ownership call.
- **(B) Split** the transport into its own task (realtime/shared/routes carry funding→DO); T8 keeps the runtime.ts +
  turn-definition.ts consumption once the datum lands.
- **(C) Founder ruling to relax to a conservative tier at the DO:** derive `storageContext` entirely in-bounds — 
  `inputChars` from `request.inputs`+`request.history`, and **tier = 'free'** for the output-storage leg
  (`outputCharsPerTokenForTier`: paid=2, free=4 chars/token — Verified `constants.ts:177,183`; free is the LARGER,
  so it never under-reserves; it over-reserves for paid users, which is explicitly sanctioned for an admission hold
  that is "a deliberate over-estimate"). This deviates from the brief's "tier-exact" and is a money-policy choice.

## Self-gate
None run — no edits made (investigation only). Existing suite state not perturbed.

## Confidence
High — the blocker is a fully traced transport gap (every hop cited file:line); the funding/tier datum provably does
not reach the DO executor within T8's file bounds. High that criteria 2–5 are already satisfied (cited evidence).
The three options are real and each turns on a decision (scope expansion vs money-policy) that is the orchestrator's,
not the implementer's.
