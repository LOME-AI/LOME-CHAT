# impl-report-1 — E2E containment harness on the port

## Objective

Move `e2e/helpers/sandbox-harness.ts` from a wildcard `contentWindow.postMessage` to the
shipped `MessageChannel` handshake, so the containment corpus exercises the real delivery
path. Exported surface must not change; the seven consuming tests are not mine to rewrite.

## Files changed

- `e2e/helpers/sandbox-harness.ts` — the parent page now captures the frame-transferred
  port from the one-shot `ready` and drives the frame through it; module/function docs
  updated to record the transport and the ordering constraint.

No other file touched. `git status` snapshot taken before the first edit; the tree was
already dirty with prior-run and concurrent-workstream work (per plan A7), none of which I
touched.

## Tests added

None, and none are possible. This file is E2E-only infrastructure; the behaviour it
implements is observable exclusively by running the containment specs, which Global
Constraint 11 and T4 criterion 5 forbid me from doing. There is no unit-test seam here —
the code under change is a string of browser script executed inside a Playwright page.
This is stated again, unhedged, under **Verification status** below.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo typecheck lint --filter=@hushbox/e2e --force --continue` | pass — 2 tasks successful, 0 cached |
| `npx eslint helpers/sandbox-harness.ts` (run from `e2e/`, after the final edit) | pass — exit 0 |

Prettier rides the lint gate, so formatting is covered. No test execution, by instruction.

## Acceptance criteria

**1 — listener registered before the iframe is attached; port captured; `send` posts through it.**
Met. The parent page is one inline classic script in `<body>`. Within it the window
`message` listener is registered at generated-script line ~119 and the first frame is
created at ~149 — the iframe does not exist in the markup at all, it is created by the
script *after* the listener is live. There is no `page.evaluate()` registration and no
post-load listener install, so the one-shot `ready` cannot be lost to a race.
`__docFrame.send` calls `port.postMessage(msg)` and nothing else.

**2 — `waitForReady` / `teardownFrame` / `recreateFrame` still work; recreate re-handshakes.**
Met. Detail in "How recreate re-handshakes" below.

**3 — exported surface keeps its signatures.**
Met. `DOCUMENT_IFRAME_SANDBOX_ATTR`, `FrameSourceDelivery`, `SandboxRenderer`,
`sandboxOriginUrl`, `DocumentSandboxHarness` and its `bridgeLog` / `open` / `waitForReady`
/ `sendInit` / `sendRun` / `sendStop` / `teardownFrame` / `recreateFrame` are unchanged in
name, arity, and type. The internal `DocumentFrameControl` (`send`/`teardown`/`recreate`)
and the `ParentMessage` union are also unchanged. The consuming spec needed no edit and
got none.

**4 — `DOCUMENT_IFRAME_SANDBOX_ATTR` stays exactly `allow-scripts`.**
Met, verified by grep: `export const DOCUMENT_IFRAME_SANDBOX_ATTR = 'allow-scripts';`.
Nothing was added to it — no `allow-same-origin`, `allow-popups`, `allow-top-navigation`,
`allow-modals`. The corpus's own assertion `expect(DOCUMENT_IFRAME_SANDBOX_ATTR).toBe('allow-scripts')`
still holds.

**5 — specs not run; verification is typecheck + lint + careful read.**
Met as instructed. See **Verification status**.

## Verified against the shipped bootstraps

I read the real handshake rather than the plan's summary of it. Both
`apps/sandbox/src/render/bootstrap.ts:532-556` and
`apps/sandbox/src/python/bootstrap.ts:300-332` do the same four things: mint
`new MessageChannel()`, keep `port1` as `embedderPort`, register the inbound listener with
`port1.addEventListener('message', …)`, call `port1.start()`, then
`parent.postMessage({ type: 'ready' }, '*', [channel.port2])`.

My parent mirrors that exactly: it reads `ev.data.type === 'ready'` and takes
`ev.ports[0]`, which is the transferred `port2`. Outbound `port.postMessage(msg)` lands on
the bootstrap's `port1` listener, which reads `event.data` and runs it through
`parseParentToFrameMessage` — so the raw message object is the right payload shape, and
`ParentMessage` needed no change. Inbound, the frame's `post()` helper writes every
`loading` / `console` / `result` / `error` through `embedderPort.postMessage(message)`, so
the parent's port handler is now the only place those arrive.

I also matched the shipped parent (`apps/web/src/components/document-panel/document-sandbox.tsx:518-547`):
same `event.source` identity gate, same first-ready-wins guard, same
`addEventListener` + `start()` ordering. Independently, T1's sibling
`apps/sandbox/src/embed-harness.ts:296-301` throws when no port has been captured rather
than dropping the message; I arrived at the same choice for `__docFrame.send` before
reading it, which is a useful convergence signal.

## How `recreateFrame` re-handshakes and captures the new frame's port

`waitForReady(2)` is a live assertion in the teardown test, so it had to keep meaning
something — and it now means strictly more.

- `makeFrame()` sets `port = null` as its first statement, so creating a frame instance
  always drops whatever port was held. `recreate()` is `frame = makeFrame()`, so the new
  element and the cleared capture slot happen together and cannot desynchronise.
- The window listener is registered once, for the page's lifetime — it is not re-installed
  per frame, so there is no re-registration race on recreate.
- The new frame's `ready` passes the `ev.source !== frame.contentWindow` gate because
  `frame` was reassigned synchronously inside the same `page.evaluate` turn, before any
  message task can run. The `if (port) return` guard is open (just cleared), so
  `ev.ports[0]` is captured, listened on, started, and only then does `readyCount` go to 2
  and `statusEl` become `ready:2`.
- Ordering is deliberate: the counter advances **after** capture-and-start. So
  `waitForReady(n)` is no longer merely "n frames announced themselves" — it is "n frames
  handshook and the current one is drivable". If a future bootstrap edit ever announced
  `ready` without transferring a port, `open()` would fail at `TIMEOUTS.MODAL` instead of
  proceeding into a mystery, which is the failure direction I want.
- `teardown()` sets `port = null` alongside removing the element, mirroring the app's
  `stop()` clearing `portRef`, so a torn-down frame's port is never posted through.

## Where `port.start()` sits and why it cannot be skipped

It sits immediately after `p.addEventListener('message', …)` and before the `readyCount`
increment, inside the window handshake handler.

A `MessagePort` is created in a paused state. Assigning `onmessage` implicitly starts it;
registering with `addEventListener` does **not**. Without the explicit `start()` the port
queues every frame message forever and delivers none — the harness would hang on the first
`toContainText`, and the failure would look like a containment failure rather than a
transport failure. Both shipped bootstraps carry the same call with the same reasoning, as
does the app's parent.

Per plan A5 this line is unpinnable by test: both vitest environments hand out Node's
`MessagePort`, which auto-starts on listener attach, so a green suite is not evidence the
call exists. Nothing in this run executes my file at all. It is correct by construction and
by reading, and the founder-run specs are its first real exercise.

## Behaviour the founder should watch when running the suite

All seven tests keep their subject matter; what changed underneath them:

1. **Every `BLOCKED:*` / `CSPV connect-src` / `NAV:attempted` / `RTC:*` / `MODAL:RETURNED`
   line now reaches the log over the port, not the window.** Those are frame-side
   `console.log`s relayed as `console` bridge messages. The rendered log line format is
   byte-identical (`MSG console:<stream> <text>`), and every assertion is a `toContainText`
   substring match, so no assertion string needed touching. If the port transport were
   broken, these tests fail by timeout on the first `toContainText` — that is the new
   failure mode to recognise, and it would mean transport, not containment.
2. **Parent-side `CSPV frame-src …` is unchanged.** It comes from the parent document's own
   `securitypolicyviolation` listener, which never rode the bridge. The two frame-src
   tests (header and meta delivery) are the least affected of the seven.
3. **The two request-only tests are wholly unaffected** — the served-CSP test and the
   app-origin frame-src test never load the harness page.
4. **The teardown test keeps its teeth, deliberately.** I did *not* call `port.close()` on
   teardown, only dropped the reference. Closing would have blinded the assertion: if a
   zombie frame survived removal it would still post through its `port2`, still arrive at
   `record()`, and still increment the `BEACON` count — which is exactly what
   `expect.poll(countBeacons).toBe(frozenCount)` needs to be able to observe. A closed port
   would have made a real zombie invisible and the test vacuously green.
5. **`open()` is now a stronger fence** (waits for port capture, not just the announcement)
   and **`send` now throws** instead of silently dropping if called with no port captured.
   No consuming test sends after teardown, so neither should surface; if the throw ever
   does fire it will appear as a `page.evaluate` rejection naming
   `document sandbox harness: no port captured`.
6. **The window path no longer logs arbitrary messages.** Previously any window message
   with a string `type`, from any source, was appended. Now the window handler accepts only
   `ready` from the current frame instance. I checked all seven tests: none post a window
   message expecting it to be logged, and none of the injected documents call
   `parent.postMessage`.

## Deviations

None from the acceptance criteria.

One factual correction to the brief, not a deviation: the brief stated my file was the last
place in the repo posting into a frame window with a wildcard. After my change,
`apps/sandbox/src/embed-harness.ts:310` still does. It is not a leftover — it is T1's
deliberate forgery-path probe (`postToFrameWindow`), carrying an `eslint-disable` with the
justification "the forgery path under test; a wildcard is what an attacker would use", and
it exists so a test can prove the frame *ignores* window messages. It is a negative-path
probe, not a delivery path, so Global Constraint 2 is satisfied. Flagging it only so the
count in the T5 doc task is stated accurately.

## Concerns and limitations

- **The change is unverified by execution.** Stated plainly, without hedging: I did not run
  the containment specs, I could not run them, and nothing else in this run executes this
  file. Typecheck and lint prove the TypeScript around the page compiles and conforms; they
  prove nothing about the browser script inside the template literal, which is a string as
  far as every tool in my gate is concerned. The first real evidence will be the
  founder-run `e2e/security/document-sandbox-containment.spec.ts`.
- The `ev.source !== frame.contentWindow` gate compares WindowProxy identity across an
  opaque origin. That is a legal identity comparison with no property access, and it is the
  same gate the shipped app uses, so I am confident in it — but it is confidence from
  reading the app and the spec, not from an observation I made this session.
- `frame` is assigned synchronously in the same task that creates the element, so no
  `ready` can arrive before the variable is set. This is reasoning about the event loop,
  not a measurement.

## Confidence

Medium-high on correctness by construction — the handshake matches both shipped bootstraps
and the shipped parent line for line, the port lifecycle is handled at all three points
(capture, teardown, recreate), and `start()` is present with the ordering that makes
`waitForReady` a real fence. Held below high for one reason only: zero execution, by
instruction, on code whose only proving ground is a suite I may not run.
