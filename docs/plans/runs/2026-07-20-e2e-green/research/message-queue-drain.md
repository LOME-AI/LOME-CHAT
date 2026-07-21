# RC-9 localized — message-queue drain: the held-stream release barrier is one-shot / in-memory-only

Spec: `e2e/chat/message-queue.spec.ts` — `queued message auto-sends after active run completes`.
Artifacts: `e2e/report/2026-07-20T05-25-42/failed/e2e-chat-message-queue-spec-ts-iphone-15-queued-message-auto-sends-after-active-run-completes/`.

## Verdict

The defect is the **release barrier**, not the drain trigger. The drain-on-settle wiring in
`apps/web` is correct; it never fires because the held primary run **never settles** — its
DO-side release barrier returned `{"released":false}`, i.e. nothing was parked to release at
the instant the test released. Smart Model is the window-widener that makes the barrier's
one-shot / in-memory-only design lose the race, not an independent bug.

Location (app/harness seam): `packages/realtime/src/conversation-room.ts`
- `heldStreamRelease` slot — 129-138 (single per-DO, **in-memory-only**, `null` in a fresh instance)
- `attachHeldStreamRelease` — 299-307 (sets the slot at `executor.start`)
- `releaseHeldStreamRoute` — 310-317 (**one-shot**: reads slot, nulls it, `released: slot!==null`; a
  release with nothing parked is silently discarded — no latch)
- mock park: `apps/api/src/slices/models/adapters/mock-provider.ts:387-396` (`echoStream` emits the
  first 8-char delta then `await ctx.awaitStreamRelease()`; the awaited gate is the in-memory promise
  whose resolver lives in the DO slot).

## Evidence (decisive)

1. `trace/resources/86c367…json` — the release-stream response body is exactly **`{"released":false}`**.
   So at release time the DO's `heldStreamRelease` slot was `null` (route line 313–316).
2. `page-snapshot.txt` — A's assistant tile is frozen at **"Echo: Qu"** (`MOCK_CHUNK_CHARS = 8`,
   `MOCK_ECHO_PREFIX = 'Echo:'`, mock-provider.ts:60,62) = exactly the single first delta of the
   held-echo path. So A's primary genuinely parked on a **defined** `awaitStreamRelease` gate
   (echoStream only takes the park branch when `holdPrimaryStream===true && awaitStreamRelease!==undefined`)
   whose resolver was never called. Model tag: **"ling-2.6-flash Smart"** → Smart Model resolved via
   the classifier stage; the send button is disabled; B still queued (`1 message queued`).
3. `trace/1-trace.network` timeline: `POST /chat` (A, header `x-mock-hold-primary-stream:true`, **201**)
   at 05:22:02.584 → `GET …/release-stream` (**false**) at 05:22:04.698 → a second `POST /chat`
   (no hold header, **200 not 201**) at 05:22:05.772. Only one release call; only one held send.
4. `error.txt` — `expect(getByTestId('queued-messages')).not.toBeVisible()` times out at 30s; the pill
   stack never unmounts. `console-errors.txt` clean; no api-error (B never errored — it never ran).

## Why `released:false` while A is parked — the barrier race

`startRun` calls `executor.start` **synchronously** and awaits `handle.admitted` before the POST
returns 201 (`packages/realtime/src/room-core.ts:540-575`); `heldStreamExecutor.start` runs
`attachHeldStreamRelease` in that same synchronous call (`conversation-room.ts:145-146`). So for a
**single** live run in a **single** live DO instance the slot is set *before* the 201 and a later
release must observe it. It did not (`released:false`). That is only possible when the parked run and
the release **do not meet in the same live instance at the same time**:

- The held **primary** run's `executor.start` (which sets the slot) had **not happened yet** at
  04.698 — Smart Model's classifier/pre-inference stage runs first and `waitForStreamingActive`
  (chat.page.ts:637-645) only gates on `data-streaming-count > 0`, which the **classifier** stream
  satisfies. The test therefore enqueues, cancels, and fires its **one-shot** release while only the
  classifier is streaming; the primary parks *after* the release, into a slot no longer being watched
  (release already consumed → `false`); **or**
- the DO instance was reconstructed/hibernated between park and release (in-memory `heldStreamRelease`
  resets to `null` on a fresh instance; the parked gate promise dies with the old instance). This
  harness demonstrably reconstructs ConversationRoom instances (see plan Task-11: `ctx.id.name`
  undefined after wrangler restart / stale `.wrangler`).

Both mechanisms are the **same defect class**: the release is a one-shot signal against
**non-durable, non-latching** in-memory state; if the held primary is not parked-and-present in the
exact live instance at the exact moment of release, the release is lost and the primary is orphaned
forever. The second `POST /chat` at 05.772 (200, no run created) is the client's drain firing on a
false client-side "settle" while A's run is still active server-side; the server creates no run, so B
stays queued — a downstream symptom, not the cause.

## Defect location

App/harness seam in `@hushbox/realtime` (`conversation-room.ts`) — the dev/E2E held-stream barrier.
The mock (`echoStream`) and the drain hook (`use-authenticated-chat.ts:1102-1104`, terminal-settle
`!isStreaming` effect) are both correct given a barrier that actually releases the held run.

## Pillar violated

**Determinism Pillar 2.2** — the queue-drain must gate on a *real* terminal settle signal. The
release→settle→drain chain is broken at release→settle: the barrier's "settle" is produced by a
one-shot, in-memory-only handshake that is not guaranteed to be observed by the parked run, so the
terminal event is non-deterministically never emitted.

## Long-term fix

Make the release **latch** so it is order- and instance-independent:
1. `releaseHeldStreamRoute` sets a durable/latched `releaseRequested` flag (DO storage or a persisted
   field) in addition to resolving any currently-parked resolver, and returns the pre-existing latch
   state instead of a bare `slot!==null`.
2. `attachHeldStreamRelease` / the mock park consult the latch: a held run that parks (or a DO that is
   reconstructed) after a release has already been requested must resolve its gate **immediately**
   instead of awaiting forever. Equivalently, persist the barrier so `ctx.id.name`-style
   reconstruction (Task-11) cannot drop it.
3. The held primary's barrier must be keyed to the **primary** inference (the tile the test targets),
   not merely "whatever is parked when release arrives," so the Smart Model classifier stage cannot
   consume or precede the release window.

This removes the wall-clock/instance race for every hold-stream test, not just this one.

## Enforcement rung

**Rung 3/4 — realtime contract test** (`packages/realtime`): hold a run, request release *before* the
run parks (and again in a reconstructed-instance scenario), then start/park the held run and assert it
drains to a single terminal settle; assert `releaseHeldStreamRoute` is idempotent and order-independent
(a release requested before a park still frees that park). Fixture-level: a released hold always
produces exactly one terminal stream event and the queue drains to empty. This pins the barrier's
release↔park ordering contract so the seam cannot silently regress.

## Not the cause (ruled out)

- Drain trigger (`use-authenticated-chat.ts` `drainQueue` / terminal-settle effect) — correct; it
  fires, but on a run that never truly settled.
- Mock echo park logic (`echoStream`) — correct; it awaits a real gate.
- DO addressing — both `startRun` and the release route use identical `idFromName(conversationId)`
  (`conversation-room` adapter:99; routes.ts:1243) → same named DO id (instance identity aside).
