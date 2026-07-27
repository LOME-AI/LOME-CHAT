# Close-out fix batch — report 2

## Objective

Three gaps the run's completeness critic found across task boundaries: the product's own
handshake listener could lose the one-shot `ready` (FIX 1), the product silently dropped a
parent→frame message when no port was captured while both harnesses throw (FIX 2), and the
embed harness's parent-side handshake had drifted from the shape the product and the e2e
harness share (FIX 3).

## Files changed

- `apps/web/src/components/document-panel/document-sandbox.tsx` — handshake listener moved
  from a passive effect to a layout effect; `postToFrame` now throws instead of dropping.
- `apps/web/src/components/document-panel/document-sandbox.test.tsx` — one new test pinning
  the listener-vs-frame ordering.
- `apps/sandbox/src/embed-harness.ts` — embedder page's handshake rewritten in the app's
  shape (source gate, `ready`-type gate, first-ready-wins, `addEventListener` + `start()`).

No bundle regenerated; none needed (see FIX 3).

## FIX 1 — the listener can no longer lose `ready`

### What changed

`React.useEffect` → `React.useLayoutEffect` for the effect that installs the `message`
listener. Nothing else: the effect body, its dependency array, and the iframe's mount point
in the render are untouched. This was the least disruptive of the two options the brief
allowed — deferring the `<iframe>` by one render would have changed *when the frame starts
loading* for every document, which is observable (an extra paint before the frame exists,
and a slower first render on the streaming path), while a layout effect changes only when
the listener is registered.

### Why the ordering is now unlosable

A `message` event can only be delivered in a task of the event loop. React's commit phase —
DOM mutation, then layout effects — runs to completion synchronously inside the task that
performed the render, so no message can be delivered between the iframe's insertion and the
layout effect that follows it. The listener therefore exists before the frame's first
message can be dispatched at all, for every mounting path (discrete click, transition,
streaming update) and for every asset-load speed, which is what makes it unlosable rather
than merely fast enough.

A passive effect has no such guarantee: React schedules it through the Scheduler, which for
non-discrete updates lands in a *later* task than the commit. Any `ready` arriving in that
gap is gone permanently, because `ready` is one-shot and nothing re-announces it — and
nothing may, since a re-announcement collides with first-ready-wins (Global Constraint 6).

The load-bearing fact is recorded as a comment above the effect, including why the exposure
is worst on Capacitor (sandbox assets are local files; no network round trip in which to win
the race).

### Would any existing test have caught it? No — plainly, no.

All 52 pre-existing `document-sandbox.test.tsx` tests drive the handshake through
`handshake()`, which dispatches the `ready` from test code *after* `render()` has returned.
`render()` is wrapped in `act()`, which flushes passive effects before returning, so in
every one of those tests the listener is installed long before the `ready` is dispatched.
The ordering was invisible by construction. The same is true of the two harnesses' own
suites: they test the frame side, and their parent sides already had the ordering right.

### The new test, and its RED

`the handshake listener beats the frame > takes a ready that arrives in the commit that
mounted the frame`. A sibling component's `useLayoutEffect` dispatches the `ready` — that
is the earliest moment a real frame could answer, and it is inside the same commit that
inserted the iframe, after React's mutation phase.

RED observed against the pre-change component:

```
× takes a ready that arrives in the commit that mounted the frame
AssertionError: expected "postMessage" to be called with arguments: [ Array(1) ]
Number of calls: 0
```

Zero calls is the right reason: with the listener still unregistered the `ready` was
dropped, no port was captured, and no `init` was ever sent — the "Working…" symptom in
miniature. GREEN after the one-word change, with the other 52 tests untouched and passing.

A first attempt at the RED used `flushSync(() => root.render(…))` to try to leave passive
effects pending. It **passed against the unfixed code** — React flushes passive effects
within `flushSync` — so it was discarded rather than kept as a weaker pin. Recording it
because it is a trap for the next person: `flushSync` does not reproduce this window.

## FIX 2 — `postToFrame` fails loudly

```ts
const port = portRef.current;
/* v8 ignore next -- unreachable through the component's surface: … */
if (!port) throw new Error('document sandbox: the frame transferred no port');
port.postMessage(message);
```

Consistent with `apps/sandbox/src/embed-harness.ts:299` and
`e2e/helpers/sandbox-harness.ts:153-155`, which both throw with the same rationale.

**Deviation from test-first, stated plainly.** No test drives this branch, because nothing
can: I re-derived the reachability the brief describes and confirmed it. `readyRef.current`
and `portRef.current` are set in the same handler and cleared in the same function
(`stop()`), so they are never out of step; Run and Stop are both `disabled` while
`status === 'booting'`, which is exactly the post-`stop` state; the re-drive effect returns
early unless `readyRef.current`; and `stop()` is unreachable from the render (non-python)
view, which has no controls. Every caller of `postToFrame` is therefore behind the
handshake. Writing a test would have meant adding a backdoor to the component solely to
reach a line that exists to catch a *future* regression — worse than the deviation. The
guard is marked with the file's existing `v8 ignore` convention (two such markers were
already present for the same class of by-construction-unreachable code) so the 95% per-file
gate is not satisfied by a fiction.

The behaviour change if a regression ever does reach it: a thrown `Error` out of a click
handler or the handshake handler, instead of a document that hangs forever with no signal.

## FIX 3 — embedder page matches the app's handshake

Before: `port.onmessage = …` with no source gate and no `ready`-type gate. After, in the
app's order — sender gate (`event.source !== frame.contentWindow`), `ready`-type gate,
first-ready-wins, `port.addEventListener('message', …)`, `port.start()`. The `ready` is
still pushed into `__bridge.messages` (inside the gated branch) because `openEmbeddedFrame`
waits on it.

### The `start()` line is genuinely exercised — verified, not assumed

The brief's claim that this is the only real-Chromium exercise of the app's
`addEventListener` + `start()` pattern is now proven rather than argued. I removed
`port.start()` from the embedder page and re-ran two render browser tests:

| Test | Without `start()` |
| --- | --- |
| `transfers a MessagePort with its ready broadcast` | passes (the port is captured; only delivery is paused) |
| `renders a document from an init delivered only through the transferred port` | **fails** — `no matching frame→parent message within 15000ms`, thrown from `embed-harness.ts:301` |

`start()` restored immediately; the full package suite is green with it. So a future drop of
that line now fails a `pnpm test` gate, which was the point of switching forms.

### No bundle changed — confirmed, not assumed

`embed-harness.ts` is test infrastructure and is not an input to either IIFE: the bundles
are built from `src/render/bootstrap.ts` and `src/python/bootstrap.ts`. Two independent
confirmations:

- All four drift tests (`build-bundle.test.ts`, `build-python-bundle.test.ts`) pass, and
  they compare `public/render.js` / `public/python.js` byte-exact against a fresh rebuild.
- `git diff HEAD --stat` for `apps/sandbox/public/` shows the same line counts as the
  run-start baseline (`python.js | 14 +-`, `render.js | 26 +-`) — my edits added nothing.

### What is still unpinned

The two new gates (source, `ready`-type) have no test of their own. Adding one would mean
testing the harness rather than the delivery path, and would need a new injection API on
`EmbeddedFrame`; I judged that out of scope for a consistency fix. They are structural
mirrors of gates the product does pin.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:web` | pass — 393 files, 6411 tests, coverage gate green; `document-sandbox.test.tsx` 53/53, `document-panel.streaming-preview.test.tsx` 10/10; `src/components/document-panel` 99.51 stmts / 98.7 branch / 100 func / 99.46 lines |
| `npx turbo typecheck lint --filter=@hushbox/web --force` | pass — 2/2, cache bypassed |
| `pnpm --filter @hushbox/sandbox test` | pass — 17 files, 162 tests; 28 render browser, 12 python core, 4+4 drift |
| `npx turbo typecheck lint --filter=@hushbox/sandbox --force` | pass — 2/2, cache bypassed |
| `npx eslint src/components/document-panel/document-sandbox.tsx src/components/document-panel/document-sandbox.test.tsx` from `apps/web/` after the LAST edit | exit 0 |
| `npx eslint src/embed-harness.ts` from `apps/sandbox/` after the LAST edit | exit 0 |

One typecheck failure was mine and is fixed: the new test passed
`source: frame?.contentWindow` (`Window | null | undefined`) where `MessageEventInit` wants
`MessageEventSource | null`; corrected to `?? null`.

## Acceptance against the brief

| Item | Status | Evidence |
| --- | --- | --- |
| FIX 1 — listener cannot lose `ready` | met | `useLayoutEffect` at `document-sandbox.tsx:536`; new test RED→GREEN |
| FIX 1 — no `ready` retry/re-announce | met | frame side untouched; the fix is parent-side ordering only |
| FIX 1 — durable comment | met | `document-sandbox.tsx:526-535` (above the effect) |
| FIX 1 — all 52 existing tests kept | met | 53/53 (52 + 1 new), none weakened or deleted |
| FIX 2 — fails loudly | met | `document-sandbox.tsx:474-481` |
| FIX 3 — embedder in the app's shape | met | `embed-harness.ts:88-107` |
| FIX 3 — 28 `render.browser.test.ts` tests kept | met | 28/28 |
| FIX 3 — no bundle rebuild | met | drift tests + `git diff --stat` |

## Deviations

1. **FIX 2 has no test** (unreachable defect trap). Reasoned above; marked `v8 ignore`
   rather than covered by a contrived path.
2. Nothing else. No message shape, schema, or frame-side code was touched; the wildcard
   inventory in Amendment A9 is unchanged (the embedder's `postToFrameWindow` forgery probe
   is untouched).

## Concerns and limitations

- The FIX 1 test's fidelity rests on a claim about React's commit phase — that a sibling's
  layout effect runs inside the same commit that inserted the iframe, after the mutation
  phase. That is what makes it the earliest observable moment; it is not a claim about
  happy-dom, and the test would hold identically in a browser.
- FIX 1 is a fix for a hazard that was never observed in the wild. It is Inferred, as the
  brief states. The proof carried here is that the pre-change code loses a `ready` delivered
  at the earliest moment a frame could send one — not that a real frame has ever done so.
- The e2e specs that would exercise all three of these end to end
  (`e2e/chat/runnable-documents.spec.ts`, `e2e/security/document-sandbox-containment.spec.ts`)
  are founder-run, per Global Constraint 11. Nothing here was verified by E2E execution.

## Confidence

High for FIX 1 and FIX 3: both are pinned by tests that were watched to fail for the right
reason (the new unit test; the `start()`-removal probe in real Chromium). Medium-high for
FIX 2 only because it ships an untested line — mitigated by its being a guard whose failure
mode is a thrown error, not a behaviour change on any reachable path.
