# T3 — Parent component on the port

## Objective

Move `DocumentSandbox` off `iframe.contentWindow.postMessage` and onto the port the frame
transfers on its one-shot `ready`, enforce first-ready-wins parent-side, and pin the
regression the old tests could not see.

## Files changed

| File                                                                | Why                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/document-panel/document-sandbox.tsx`       | `postToFrame` posts through the captured port; window listener accepts only `ready` and captures `event.ports[0]`. |
| `apps/web/src/components/document-panel/document-sandbox.test.tsx`  | Helper and every transport assertion re-expressed against the port; new pins for the bug and the hijack guard.     |
| `document-panel.streaming-preview.test.tsx`                          | Same helper change for the pipeline-level suite (`openPreview` now performs the port handshake).                   |

Component shape:

- `portRef: React.useRef<MessagePort | null>(null)` is the transport handle.
- `postToFrame` → `portRef.current?.postMessage(message)`. No `contentWindow` post survives
  anywhere in the file (`grep contentWindow` returns one hit: the listener's source gate).
- The window listener keeps `event.source === iframeRef.current?.contentWindow`, keeps
  `parseFrameToParentMessage`, then returns unless the message is `ready`. It ignores a
  `ready` when a port is already held (first-ready-wins) and ignores a `ready` carrying no
  port. Otherwise it stores the port, adds a `message` listener, calls `port.start()`, sets
  `readyRef`, and dispatches `idle` (python) or `startAutoRun()` (render kinds) — the same
  two arms as before.
- `handleFrameMessage` (extracted, `useCallback` on `isPython`) parses, drops `ready`, applies
  the `requestId !== requestIdRef.current` staleness drop, dispatches `{ type: 'frame' }`.
  The reducer, `displayStatus`, the debounce effect, and the once-only React failure rule are
  untouched — the diff does not reach them.
- `stop()` clears `portRef` alongside `readyRef`/`requestIdRef`.

`port.addEventListener('message', …) + port.start()` rather than `port.onmessage = …`: the
repo lint rule `unicorn/prefer-add-event-listener` rejects the assignment form, and a listener
added that way leaves the port paused
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MessagePort/start): "This method is
only needed when using `EventTarget.addEventListener`; it is implied when using `onmessage`").
See Concerns — the vitest environment cannot pin that `start()` call.

## Tests added

| Test                                                                        | Behavior                                                                          | Criterion |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------- |
| `never posts into the frame window across a whole render cycle`             | Zero `contentWindow.postMessage` calls across handshake → init → rendered.         | 5         |
| `sends nothing into the frame window, wildcard or otherwise`                | Re-expression of the old "never a wildcard" assertion.                             | 1, 5      |
| `ignores a frame message that arrives on the window instead of the port`    | A valid `rendered` on the window changes nothing.                                  | 2         |
| `ignores a ready that carries no port`                                      | No port, no handshake — still `booting`, nothing sent.                             | 2         |
| `ignores a ready that arrives on the port`                                  | `ready` on the port is inert; no second `init`.                                    | 2         |
| `ignores a second ready from the same frame`                                | Second `ready` neither re-inits nor captures the offered port.                     | 3, 6      |
| `does not redirect later traffic to a port a second ready offered`          | After a hijack attempt, `init`+`run` still land on the first port; attacker gets 0. | 6         |
| `ignores malformed messages on the port`                                    | Junk over the port leaves the status alone.                                        | 2         |
| `hands the replacement frame the bridge and never posts to the dead port`   | Post-`stop` frame handshakes normally; the dead port receives nothing further.     | 3, 4      |

Re-expressed (not deleted), per criterion 7:

- `sends init to the frame when it reports ready` — `toHaveBeenCalledWith({…}, ORIGIN)` on the
  frame window → `toHaveBeenCalledWith({…})` on the transferred port. Renamed to
  `sends init through the port when the frame reports ready`.
- `posts to the frame targeting the sandbox origin, never a wildcard` — the origin argument no
  longer exists on this path; its intent (never broadcast into the frame's window) is now
  `sends nothing into the frame window, wildcard or otherwise` plus the full-cycle pin.
- `sends init then run when Run is clicked` — both `toHaveBeenNthCalledWith(n, {…}, ORIGIN)`
  became port calls without the origin argument.
- `spends one attempt on a burst of edits` — `toHaveBeenLastCalledWith({…}, ORIGIN)` → port call.
- Every `postSpy` call-count assertion (`waits for the code to hold still`, `never
  re-initializes before the frame is ready`, `leaves python to its Run button`, `surfaces the
  verdict of the queued attempt`, `does not auto-run python on ready`, and the two
  `postSpy`-counting pipeline tests) now counts port sends. `ORIGIN` survives only where it
  belongs: the iframe `src` assertions.
- `drops console output from a killed run` — the post-stop message now arrives over the port
  instead of a synthesized window event, so it still proves a torn-down frame cannot mutate the UI.

Transport in the tests: the test mints the channel the frame would mint, spies on the end the
parent is handed (`vi.spyOn(port2, 'postMessage')`, which still calls through), delivers
frame→parent messages by really posting on the other end, and yields the loop before
asserting (`settle()` — `vi.advanceTimersByTimeAsync(0)` when the clock is faked, a real
`setTimeout(0)` otherwise). Delivery is genuine port delivery, not a hand-invoked handler.
Both files close every minted channel in `afterEach`.

## Self-gate

| Command                                                                    | Result                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------- |
| `pnpm test:web`                                                            | pass — 393 files, 6397 tests, exit 0 (gate included) |
| `turbo typecheck lint --filter=@hushbox/web`                               | pass — 2 successful, 2 total                       |
| `eslint src/components/document-panel/document-sandbox.tsx …` (pkg dir, last edit) | pass, exit 0                             |
| `jscpd --threshold 2` over the three owned files                           | pass — 0 clones                                    |
| Coverage, `document-sandbox.tsx`                                           | 99.21 stmts / 97.91 branch / 100 funcs / 99.1 lines |

Lint caught one thing mid-implementation and it was fixed at the cause, not silenced:
`unicorn/prefer-add-event-listener` on `port.onmessage = …` → `addEventListener` + `start()`.

Test counts, per file:

| File                                       | Before | After |
| ------------------------------------------- | ------ | ----- |
| `document-sandbox.test.tsx`                | 44     | 52    |
| `document-panel.streaming-preview.test.tsx` | 10     | 10    |

## Acceptance criteria

1. **`postToFrame` posts through the captured port; `contentWindow.postMessage` never called.**
   Met. `grep -n contentWindow document-sandbox.tsx` → one hit, the listener's source gate.
   Pinned by the zero-call test.
2. **Window listener keeps the source gate, accepts only `ready`, captures `event.ports[0]`;
   everything else arrives on the port.** Met. Three tests: foreign source ignored, a valid
   `rendered` on the window ignored, a `ready` without a port ignored.
3. **First-ready-wins, reset on frame replacement.** Met. The guard is `if (portRef.current)
   return`, and `stop()` — the only path that increments `frameKey` — nulls `portRef`, so the
   replacement frame's `ready` is the next first. Two tests: the second `ready` is inert; the
   post-`stop` frame handshakes and drives `req-2`.
4. **Port ref cleared in `stop()`.** Met, in the same callback as `readyRef`/`requestIdRef`.
   The replacement-frame test asserts the dead port's call count never grows afterwards.
5. **Regression pin: zero `contentWindow.postMessage` across init→rendered.** Met. RED
   observation below. The test also asserts `iframe.contentWindow` is still the spied window,
   so the spy cannot pass vacuously against a window happy-dom swapped out.
6. **Hijack attempt fails.** Met — see the RAISED note on what "fails" means observably.
7. **All tests in both files pass with assertions intact.** Met: 52 + 10. No test weakened or
   deleted; the origin-argument assertions were re-expressed as listed above. (The plan says
   "105 tests in `document-sandbox.test.tsx`" — the file held 44 before this task; see RAISED.)
8. **Per-file 95% coverage holds.** Met: the only source file edited is `document-sandbox.tsx`
   at 99.21/97.91/100/99.1 from these two suites alone. The single uncovered line (140) is the
   reducer's `ready` arm, already `v8 ignore`-annotated before this task.

Global constraints: `packages/shared/src/documents/bridge.ts` untouched (1); no wildcard and no
parent→frame window post added (2); nothing under `apps/sandbox` or `e2e` touched (T1's
territory); no plan or task identifiers in shipped comments (9); `eslint` re-run from
`apps/web` after the last edit (10); no E2E run (11).

## RED observations

Criterion 5's pin, written first and run against the unchanged component
(`vitest -t 'never posts into the frame window'`):

```
AssertionError: expected "postMessage" to not be called at all, but actually been called 1 times
  1st postMessage call:
    Array [
      Object { "code": "<h1>hi</h1>", "kind": "html", "requestId": "req-1", "type": "init" },
      "http://localhost:7400",
    ]
 ❯ src/components/document-panel/document-sandbox.test.tsx:106:27
```

That is the bug itself: `init` posted at the frame's window naming
`http://localhost:7400`, silently dropped by an opaque-origin recipient. The status assertion
on the line above it passed at that point (today `rendered` rides the window event), so the
failure was solely the forbidden call.

Whole-suite RED after the helper was moved to the port and before the component changed:
**29 failed / 23 passed**, every failure a transport one — e.g.
`sends init through the port …`: "expected postMessage to be called with … Number of calls: 0";
`flips to rendered only when the frame posts rendered`: "expected 'loading' to be 'rendered'";
`ignores a second ready from the same frame`: "expected postMessage to be called 1 times, but
got 0 times". The 23 that passed are the iframe-attribute, static-copy and pre-handshake tests
that never touch the transport.

## Deviations

- **`addEventListener` + `start()` instead of `onmessage`.** Forced by the repo lint rule; the
  alternative was an `eslint-disable`, which the rules forbid without justification and which
  no justification supports here.
- **`emit` in both test files is now async.** Port delivery is a task, not a microtask, so the
  tests that observe a frame message must yield the loop. The alternative — invoking the
  handler the component installed — would have kept the tests synchronous but would have
  stopped exercising real port delivery.

## Concerns and limitations

- **`port.start()` is not pinned by any test that can fail without it.** Node's `MessagePort`
  (which is what leaks into both vitest environments — happy-dom 20.11.0 has no
  `MessageChannel`) starts a port as soon as a `message` listener is attached, so deleting
  `port.start()` leaves the suite green (verified: removed the line, ran
  `flips to rendered only when the frame posts rendered`, still passed). In a browser it is
  mandatory per the HTML spec / MDN. The only execution-level proof of that line is the
  founder-run `e2e/chat/runnable-documents.spec.ts`.
- **stderr noise** from happy-dom failing to fetch `http://localhost:7400/{render,python}.html`
  is pre-existing (baseline: 87 `DOMException` lines; now 100 — the tests yield real
  event-loop turns, so more of happy-dom's aborted iframe navigations get a chance to log).
  Same class, no new error type, no `act()` warnings.
- **The two test files each carry their own channel/handshake helper.** They differ (different
  environment, different mount path) and their correctness does not depend on agreeing, which
  is the existing shape of these two files; `jscpd --threshold 2` reports 0 clones. Not
  hoisted to a shared helper for that reason.
- The port handler is installed once, at handshake, closing over `isPython`. A `kind` change
  without a remount would leave it stale — the panel keys this component by the user's
  selection, so that cannot happen today, and the pre-existing effect had the same property.

## Confidence

High. Every acceptance criterion has a test that was observed failing for the right reason
before the code existed; the state machine was not touched and its whole existing suite passes
unchanged in meaning. The one thing I cannot demonstrate here is `port.start()`, which only a
real browser can exercise.
