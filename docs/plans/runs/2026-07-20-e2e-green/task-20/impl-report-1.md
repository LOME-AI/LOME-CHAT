# Task-20 — held-stream release latch (message-queue drain) — impl report 1

## Objective

Make the dev/E2E held-stream release barrier LATCH so it is order- and
instance-independent: a run that parks (or a DO that reconstructs) after a
release has already been requested resolves its gate immediately, keyed to the
primary run that awaits it. Fixes the message-queue drain (`released:false` →
primary orphaned → `queued-messages` never unmounts).

## Files changed

- `packages/realtime/src/conversation-room.ts` — added durable release latch:
  - New exported const `HELD_STREAM_RELEASE_STORAGE_KEY` (DO-storage key).
  - `releaseHeldStreamRoute` is now `async`: persists the latch to DO storage
    (`ctx.storage.put(key, true)`) in addition to resolving any live parked
    resolver; still returns `{ released: <resolver-was-present> }`.
  - `attachHeldStreamRelease` still captures the resolver synchronously (so a
    release arriving while the run is parked-and-live is observed and the 201
    guarantee is preserved), but the `awaitStreamRelease` closure is now async
    and first consults the persisted latch (`isReleaseRequested()`); if release
    was already requested it resolves immediately without awaiting the resolver.
  - New private `isReleaseRequested()` reads the latch from DO storage.
  - Route dispatch `POST /mock/release-stream` now `await`s the async route.
  - Updated the two barrier doc comments to describe the latch.
- `packages/realtime/src/workers-validation/conversation-room.workers.test.ts` —
  imports the new key; adds the two contract tests below.

## Composition with Task-11's identity changes

Task-11 made the DO reconstruction-safe: `ctx.id.name` is absent on a nameless
platform revival (alarm/hibernation wake), so the `RoomCore` is now built lazily
in `buildRoom()` behind a single-flighted `ensureRoom()`, with the conversation
id resolved-and-persisted via `resolveConversationId` (the shared `resolveDoName`
mechanism the JobDispatcher also uses). All of that is left intact and unmodified.

The latch composes cleanly on top of it and is deliberately independent of the
lazy room build:

- The latch lives in the same DO storage that Task-11's identity persistence
  uses (`this.ctx.storage`), under its own key `HELD_STREAM_RELEASE_STORAGE_KEY`
  (distinct from `CONVERSATION_ID_STORAGE_KEY`), so the two never collide.
- `releaseHeldStreamRoute` and `isReleaseRequested` touch `this.ctx.storage`
  directly and do **not** call `ensureRoom()` — a release can be latched (and
  read back) without forcing a room build or needing a resolved identity. This
  matters for release-before-park: the release may arrive before any socket
  upgrade has built the room.
- Because both the latch and the conversation identity are DO-storage-backed,
  they survive the exact reconstruction Task-11 fixed. A held run that re-parks
  in a freshly reconstructed instance resolves its identity (Task-11) and
  consults the persisted latch (this task) from the same durable store — the
  in-memory `heldStreamRelease` resolver dying with the old instance no longer
  orphans the run. The two fixes reinforce the same instance-independence
  property from two angles (identity vs. release signal).
- The held-stream executor wrapper (`heldStreamExecutor` / `attachHeldStreamRelease`)
  is constructed inside Task-11's `buildRoom()`; the latch check was added to the
  `awaitStreamRelease` closure it produces, so it rides the existing lazy-build
  wiring without introducing a second construction path.

## Tests added (workers-validation, real DO + real storage)

- `drains a held run whose release was requested before it parked` — release
  fires with nothing parked (`released:false`), then a `holdPrimaryStream` run
  starts and parks; the persisted latch resolves the park immediately. Asserts
  exactly one `run-finished` (`succeeded`). Covers criterion 1 (release-before-park)
  + criterion 2 (single terminal settle).
- `drains a held run when the release latch was persisted before this instance
  existed` — seeds `CONVERSATION_ID_STORAGE_KEY` + `HELD_STREAM_RELEASE_STORAGE_KEY`
  directly into a nameless-revived DO's storage (simulating a reconstruction
  after a prior instance's release), then starts and parks a held run; it drains
  with no release call. Asserts exactly one `run-finished`. Covers criterion 1
  (release-after-reconstruct) + instance-independence.

The pre-existing held-stream tests (release-after-park → `released:true`;
no-op-with-nothing-held → `released:false`; no-barrier-without-directive) remain
green unchanged — `released` still reports live-resolver-presence, so their
contracts are preserved while the latch is layered underneath.

## Self-gate

- `vitest --config vitest.workers.config.ts` (workers project) — pass — 24/24
  (2 new).
- `pnpm test:realtime` — pass — 362 node tests + 24 workers tests.
- `turbo typecheck lint --filter=@hushbox/realtime` — pass (after fixing one
  `promise/prefer-await-to-then` lint by converting `isReleaseRequested` to
  async/await). Re-ran `eslint` on both owned files after the last edit: exit 0.
- `tsgo --noEmit` — pass.
- `jscpd` on both changed files — 0 clones.
- E2E proof `pnpm e2e e2e/chat/message-queue.spec.ts` — **deferred to
  orchestrator consolidated run**. Per-task e2e is deprecated for this run; the
  orchestrator confirms message-queue.spec.ts on the central serialized pass.
  The run I started was cancelled before completion so it could not run
  unattended and reset the shared DB. The regression proof for this task is the
  realtime contract test below (release-before-park AND release-after-reconstruct
  both resolve + exactly one terminal settle), reported green.

## Acceptance criteria

1. Release latches; run that parks/DO that reconstructs after release resolves
   immediately; barrier keyed to the primary tile — MET. The latch is persisted
   in DO storage and consulted by the primary's `awaitStreamRelease` closure
   (which only the `holdPrimaryStream` primary receives), so it is
   order-independent (release-before-park) and instance-independent
   (survives reconstruction). Evidence: both new workers-validation tests green.
2. TDD failing realtime contract test first — MET. Both tests written first and
   verified RED (park timed out: "timed out waiting for run-finished after
   latch") for the right reason (latch unimplemented), then GREEN after the
   implementation. Exactly one terminal settle asserted in both.
3. Enforcement rung — contract test pins release↔park order/instance
   independence (Rung 3/4, realtime workers-validation contract test). MET.
4. Proof: `pnpm test:realtime` green (362 node + 24 workers). E2E
   (`message-queue.spec.ts`) deferred to the orchestrator's consolidated
   serialized run (per-task e2e deprecated for this run).

## Deviations / design notes

- `released` return value kept as "a live resolver was freed right now" rather
  than a bare latch-state boolean. This preserves the three existing
  held-stream test contracts and is truthful; the e2e helper
  (`chat.page.ts:releaseHeldStream`) only checks `response.ok()`, never the
  `released` value, so the drain no longer depends on it. The latch — not the
  return value — is what fixes the race.
- The latch is not cleared once consumed (a latch, not a one-shot). In dev/E2E a
  conversation maps to one held run and a fresh DO, so there is no cross-run
  leak; leaving it latched is what makes it consumption-race-free. The mechanism
  is dev/E2E-only (no production run carries `mockDirectives`), so no production
  behavior changes.
- Did not touch `apps/api` mock-provider — the mock's `awaitStreamRelease` gate
  semantics did not need to change; the fix is entirely DO-side. Task-09's echo
  lines untouched.

## Concerns / limitations

- `conversation-room.ts` is excluded from the node vitest coverage gate
  (vitest.config.ts) by design; it is exercised only through the workers project
  (which does not enforce coverage). The new branches are covered by the two new
  workers tests, but there is no line-coverage number for this file.

## Confidence

high — root-cause latch matches the research diagnosis exactly; both race
directions pinned by real-DO contract tests; full realtime suite + typecheck +
lint + jscpd clean.
