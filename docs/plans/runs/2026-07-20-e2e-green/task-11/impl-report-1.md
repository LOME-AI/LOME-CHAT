# Task-11 impl-report-1 — ConversationRoom DO shard/identity reconstruction crash

## Objective

ConversationRoom's DO shell threw at construction when `ctx.id.name` is undefined
(the platform reconstructs an alarm-firing / hibernation-woken DO from the stored id
alone, which carries no name). This is the exact bug class the JobDispatcher already
fixed on 2026-07-18 by persisting its shard identity to DO storage. Fix ConversationRoom
the same way, extracting a shared identity-persistence helper both DOs use.

## Files changed

- `packages/realtime/src/do-identity.ts` (new) — shared `resolveDoName(idName, store, options)`
  helper + `DoIdentityStore` / `DoIdentityOptions` types. The one mechanism both DOs use:
  a live `idFromName` construction persists the name under a caller-supplied storage key;
  a nameless revival reads it back; nothing persisted anywhere throws the caller's message.
- `packages/realtime/src/job-dispatcher-core.ts` — `resolveDispatcherShard` now delegates to
  `resolveDoName` (kept its `SHARD_STORAGE_KEY` and error text unchanged); removed the now-
  duplicated `ShardStore` interface and inline logic. Imports `resolveDoName`/`DoIdentityStore`.
- `packages/realtime/src/room-core.ts` — exports `CONVERSATION_ID_STORAGE_KEY` and
  `resolveConversationId(idName, store)` (delegates to `resolveDoName`), the room's identity seam.
- `packages/realtime/src/conversation-room.ts` — the shell no longer throws in the constructor.
  Identity + `RoomCore` are built lazily via `ensureRoom()` (single-flighted `roomPromise`),
  resolving the conversation id through `resolveConversationId` against DO storage. All route
  handlers, `webSocketMessage/Close/Error`, `alarm` (now async), and `upgrade` obtain
  `{ core, conversationId }` from `ensureRoom()`. The heartbeat auto-response registration stays
  in the constructor (needs no identity). Added `RoomShellState` internal type.
- `packages/realtime/src/do-identity.test.ts` (new) — unit tests for `resolveDoName`.
- `packages/realtime/src/room-core.test.ts` — added `resolveConversationId` unit tests
  (persist-live / read-back-nameless / throw-when-absent).
- `packages/realtime/src/job-dispatcher-core.test.ts` — `FakeShardStore` now implements the
  shared `DoIdentityStore` (was `ShardStore`); import updated.
- `packages/realtime/src/workers-validation/conversation-room.workers.test.ts` — added 3 workerd
  tests: persists conversation id on live construction; serves a route when revived without a
  named id; runs its deadline alarm when revived without a named id. Uses the exported
  `CONVERSATION_ID_STORAGE_KEY` constant rather than a literal.

## Tests added

- `resolveDoName returns live id name and persists it` — live-construction persist path (AC1 mechanism).
- `resolveDoName falls back to persisted name` — nameless revival read-back (AC1).
- `resolveDoName throws caller message when absent` — fail-fast when never persisted (AC1).
- `resolveConversationId` persist / read-back / throw trio — room's identity seam (AC1).
- workers: `persists its conversation id to storage on a live construction` — AC1 persist under workerd.
- workers: `serves a route when the platform revives it without a named id` — AC1/AC2 the core bug:
  reconstruction without `ctx.id.name` no longer throws (RED reproduced the exact old throw).
- workers: `runs its deadline alarm when the platform revives it without a named id` — alarm path
  survives nameless revival.

## Self-gate

- `pnpm exec vitest run --coverage` (realtime node project) — pass — 12 files / 362 tests;
  coverage all-files 100% functions/lines, `do-identity.ts` 100%, `room-core.ts` 99.29% lines /
  97.1% branches (per-file gate is 95). Run directly because the `pnpm test:realtime` wrapper's
  `ensure-stack` step tried a DB migrate against a Docker Postgres that was down after the
  session restart — an infra prerequisite; realtime tests touch no DB. (Earlier in the session,
  before the restart, the full `pnpm test:realtime` ran green end to end.)
- `pnpm run test:workers` (workerd project) — pass — 2 files / 22 tests (13 room + 9 dispatcher).
- `turbo typecheck lint --filter=@hushbox/realtime --force` — pass — 2 tasks successful.
  (Two prettier line-wrap errors in the two new test assertions were auto-fixed with
  `eslint --fix`, then lint re-run clean — no rule disabled, no code weakened.)

## Acceptance criteria

1. **ConversationRoom survives reconstruction without `ctx.id.name`; shared helper both DOs use — met.**
   Constructor no longer throws; identity resolved lazily via the shared `resolveDoName`.
   JobDispatcher refactored onto the same helper. Workers tests prove route + alarm both work
   after a nameless `idFromString` revival. The two DOs did not diverge — one helper, parameterized
   by storage key + error message.
2. **TDD: failing realtime test first — met.** The 3 workers tests failed first with the exact old
   throw `ConversationRoom requires a named id — reach it via idFromName(conversationId)` (RED
   captured in-session), then passed after the shell change. Unit helper tests likewise RED→GREEN.
3. **Proof `pnpm test:realtime` green; no e2e — met** (via the note in Self-gate: node 362 + workers 22
   green; wrapper's DB-migrate prereq is unrelated infra).

## Deviations with reasons

- Ran the realtime node suite through `vitest run --coverage` directly rather than the
  `pnpm test:realtime` wrapper for the final gate, because the wrapper's `ensure-stack` DB migrate
  failed against a down Docker Postgres after the session restart. Realtime tests use neither
  Postgres nor Redis; the direct run is the faithful proof of the same test set + coverage gate.

## Concerns and limitations

- `pnpm test:realtime` cannot complete without the local Docker stack (Postgres) up, even though
  realtime has no DB tests — the wrapper's `ensure-stack` gate blocks it. Not caused by this task;
  flagged so the orchestrator knows the wrapper needs a live stack to reproduce the green run.
- The heartbeat auto-response is registered in the constructor (unchanged behavior; needs no
  identity). Everything identity-dependent moved behind `ensureRoom()`.

## Confidence

High — the fix mirrors the proven JobDispatcher pattern, both DOs now share one mechanism, RED
was observed for the exact reconstruction throw, and node + workers suites plus typecheck/lint
are green with coverage over the gate.
