# Document bridge: frame-minted MessageChannel

**Tier 2.** Five tasks. Fixes a live product bug and closes the test-harness gap that let it ship.

## The bug

`apps/web/src/components/document-panel/document-sandbox.tsx:469` posts to the sandbox iframe with
`targetOrigin = sandboxOrigin()`. The iframe is `sandbox="allow-scripts"` with no `allow-same-origin`,
so its origin is opaque (`"null"`) and **every parent→frame message is silently discarded**. The frame's
`ready` (sent frame→parent with `'*'`) still arrives, so the panel dispatches `auto-start` and sits at
status `loading` / phase `null` — "Working…" forever, for html/js/react and for python after Run.

Verified this session in Chromium against the live dev sandbox:

```
--- posting with EXPLICIT origin ---   call returned: no-throw
results: ['{"type":"ready"}']                                    ← init dropped, no exception
--- posting with WILDCARD origin ---
results: ['{"type":"ready"}', '{"type":"rendered","requestId":"req-2"}']
Failed to execute 'postMessage' on 'DOMWindow': The target origin provided
('http://localhost:7400') does not match the recipient window's origin ('null').
```

Rejected alternatives, all verified, not reasoned: `targetOrigin: 'null'` throws
`SyntaxError: Invalid target origin`; `targetOrigin: '/'` resolves to the parent's origin and is dropped
identically; adding `allow-same-origin` is refused outright — it dissolves the trust boundary the whole
design rests on.

## The fix

The frame mints a `MessageChannel` and transfers `port2` to its embedder on the existing `ready`
broadcast. All later traffic, **both directions**, rides the port.

A port is a capability bound to the receiving *document*, not to an origin — which is why it is stronger
than `'*'`, not merely equivalent. Verified: after forcing a frame to self-navigate to a hostile document
that echoes anything it receives, a port send delivered **nothing** — no interception, no error. With
`'*'` that payload lands in the new document, and only the parent's `frame-src` stands in the way.

Two further gains fall out. The frame drops its `window` message listener entirely, which closes a real
hole: untrusted document code shares the frame's realm and can today forge `init`/`run`/`stop` at its own
window. And frame→parent output (`console`, `result`, rendered document data) stops being broadcast.

The single remaining wildcard is the frame's one-shot `ready`. That one cannot be narrowed: an opaque
frame genuinely cannot know its embedder's origin (`capacitor://localhost` on mobile). Its payload is a
type tag plus a port, and `parent.postMessage` reaches only the actual embedder.

## Global Constraints

Implicitly part of every task's acceptance criteria, and every auditor's lens.

1. **Message shapes do not change.** `packages/shared/src/documents/bridge.ts` is transport-agnostic
   today (pure Zod + types; no mention of `postMessage`, `window`, `origin`, `MessagePort`) and must stay
   that way. If a task believes it needs a schema change, that is an escalation to the orchestrator, not
   a local decision.
2. **Exactly one wildcard `postMessage` survives in the whole system**: the frame's single `ready`
   broadcast, once per frame instance, in each of the two bootstraps. No other `'*'` anywhere, and **no
   parent→frame `window.postMessage` at all** — the parent must never call
   `iframe.contentWindow.postMessage`.
3. **The frame registers no `window` message listener.** After the handshake the port is the only intake.
4. **The port endpoint stays closure-scoped.** Both bundles are esbuild `format: 'iife'`, so module-level
   state is already unreachable from `window`/`globalThis`; the port must not break that. Untrusted
   document code shares the realm and must not be able to reach the port object.
5. **`neutralizeWebRtc()` keeps running before the messaging setup** in both bootstraps (today: the last
   two statements of each file, neutralize first). Ordering is load-bearing.
6. **The parent accepts only the first `ready`/port per frame instance.** Later `ready` messages are
   ignored. Otherwise document code could mint its own channel and hand it up to hijack the bridge. The
   bootstrap is a classic script that runs before any document code, so first-wins is the ordering the
   frame already guarantees — this enforces it parent-side. The guard resets when the frame is replaced
   (`frameKey` increments on `stop`).
7. **Preserved behaviour, unchanged:** the `requestId !== requestIdRef.current` staleness drop; the
   streaming-suppression and `superseded` rules; the once-only React failure guard; python's absence of a
   `stop` intake (the parent tears the frame down instead); python not auto-running.
8. **Byte-exact bundle drift.** `apps/sandbox/public/render.js` and `public/python.js` are compared
   `toBe()` against a fresh rebuild. Any bootstrap edit requires regenerating the owned bundle
   (`pnpm --filter @hushbox/sandbox build:render` / `build:python`).
9. **No plan or task identifiers in shipped code or comments** — no `T1`, no run-dir references, no
   "spike". Comments record durable facts about the code only.
10. **Re-run `eslint <owned files>` from the package directory after your LAST edit**, and require
    exit 0. Passing tests do not imply a clean lint, and `eslint --fix` from the repo root silently
    no-ops under ESLint v9.
11. **Do not run E2E or `pnpm mobile:test`.** The founder runs those. Everything else runs normally.

## Verified facts every task may rely on

- **Opacity comes from the `sandbox` attribute alone, not from a distinct host/port.** A parent page
  served from the *same* origin as the renderer, embedding it with `sandbox="allow-scripts"`, still sees
  `window.origin === "null"` inside the frame, and an explicitly-targeted `postMessage` is still dropped
  while `'*'` is delivered. Test harnesses therefore need **one** server, not two.
- **The `ready` handshake is one-shot and does not queue.** A parent that installs its `message` listener
  *after* the frame begins loading can lose `ready` permanently. In a Playwright harness the listener
  must be registered before the iframe is attached/navigated (inline `<script>` before the `<iframe>` tag,
  or `page.addInitScript` before `page.goto`) — a post-load `page.evaluate()` is a reproducible race that
  silently loses the handshake. In the React app this ordering already holds: the effect installs the
  listener in the same commit that mounts the iframe, and the frame cannot fetch + parse + execute a
  540 KB bundle before that. This is not a new risk — the existing `ready` depends on it identically.
- **`MessageChannel` works in apps/web's vitest environment.** `globalThis.MessageChannel` is defined,
  `new MessageChannel()` round-trips, `port.start()` is not required, and a port injected via
  `new MessageEvent('message', { data, source, ports: [port] })` dispatched on `globalThis` — the exact
  `emit()` pattern at `document-sandbox.test.tsx:28-32` — arrives usable. Caveat for whoever writes those
  tests: this is **Node 22's native** `MessageChannel`/`MessagePort` leaking through, not happy-dom's
  (happy-dom 20.11.0 has no `MessageChannel`); `MessageEvent` *is* happy-dom's. They interoperate, but do
  not assume browser-spec-identical `MessagePort` semantics.

## Tasks

### T1 — Render bootstrap on the port, plus the shared embed harness

**Objective.** Move `apps/sandbox/src/render/bootstrap.ts` to the port transport and restructure its
browser tests to drive the renderer inside a real sandboxed iframe.

**Design context.** This task owns the transport contract both other implementations follow, and it owns
the harness repair that is the actual reason this bug reached a user. Today `render.browser.test.ts`
loads the renderer as a **top-level page** (`page.goto`), so `parent === window` and it drives the
renderer by posting to itself with `'*'`. No opaque origin ever exists in that setup, which is precisely
why 22 passing tests could not see a bug that makes the product unusable. Embedding the renderer in a
real `sandbox="allow-scripts"` iframe is what converts this file from a mechanism test into a delivery
test.

**Acceptance criteria.**

1. `startRenderer()` mints a `MessageChannel`, installs its parent-message handler on `port1`, and sends
   `ready` as `parent.postMessage({ type: 'ready' }, '*', [port2])`.
2. The `window` `message` listener at `bootstrap.ts:506` is **removed**. `parseParentToFrameMessage`
   still validates every inbound message, now on the port.
3. `post()` sends through the port for every message type (`loading`, `console`, `rendered`, `error`),
   including the `settle()` path and the direct `post` call in the React-failure path. Only `ready` uses
   `parent.postMessage`.
4. A new shared test helper — owned by this task, consumed by T2 — embeds a sandbox-origin page in a real
   `<iframe sandbox="allow-scripts">` inside a parent page on the same static server, registers the
   parent listener before the frame is attached, captures the transferred port, and exposes send/observe
   primitives. Place it beside the existing test infra in `apps/sandbox/src/` at a name of the
   implementer's choosing that reads as test infrastructure; exclude it from coverage the way
   `python/browser-harness.ts` already is.
5. All 22 existing tests in `render.browser.test.ts` pass through the new harness with their assertions
   intact. Do not weaken or delete a test to make the transport change fit; if a test cannot be
   expressed, that is a BLOCKED escalation.
6. **The headline regression test:** an `init` delivered *only* through the port, from a real opaque-origin
   embedder, drives a document to `rendered`. This test must fail against the pre-change bootstrap for the
   right reason — record that RED observation in the report.
7. A test pins that the frame ignores a `window.postMessage` `init` (the forgery path document code has
   today), proving the intake really is port-only.
8. `apps/sandbox/public/render.js` regenerated; both drift tests in `build-bundle.test.ts` pass byte-exact.

**File ownership.** `apps/sandbox/src/render/bootstrap.ts` · `apps/sandbox/src/render/render.browser.test.ts` ·
`apps/sandbox/public/render.js` · the new shared harness file.

**Interfaces.**
*Produces* — the wire contract every other task consumes: frame→parent `ready` carries `[port2]` as its
sole transferable; every subsequent message both directions is `port.postMessage(message)` with the
message shapes unchanged from `packages/shared/src/documents/bridge.ts`. Also produces the shared embed
harness (exported signature is the implementer's design; T2 consumes it).
*Consumes* — nothing.

**Scoped checks.** `pnpm --filter @hushbox/sandbox test` ·
`turbo typecheck lint --filter=@hushbox/sandbox` · `jscpd --threshold 2` over owned files.

**Sensitive?** Yes — this is the security boundary. 3-lens audit panel (correctness, security, conventions).

---

### T2 — Python bootstrap on the port

**Objective.** Move `apps/sandbox/src/python/bootstrap.ts` to the port transport and restructure its
browser tests onto T1's harness.

**Design context.** Same harness defect as T1: `browser-harness.ts`'s `run()` drives a top-level page via
`window.postMessage`, so the 11 tests across `python-core` / `python-figures` / `python-micropip` never
exercise delivery either. Python's intake differs from render's — `init` only stashes `pendingCode`, and
execution waits for a separate `run`; there is no `stop` intake because the parent tears the frame down
(main-thread Pyodide cannot be interrupted any other way). Preserve that shape exactly.

**Acceptance criteria.**

1. `startPythonRuntime()` mints a `MessageChannel`, handles `init` and `run` on `port1`, and sends `ready`
   as `parent.postMessage({ type: 'ready' }, '*', [port2])`.
2. The `window` `message` listener at `bootstrap.ts:284` is **removed**; `parseParentToFrameMessage` still
   validates on the port; the `init`-stashes / `run`-executes split and the absence of a `stop` branch are
   unchanged.
3. `post()` sends through the port for `loading`, `console`, `result`, `error`, including the `settle()`
   and load-deadline paths. Only `ready` uses `parent.postMessage`.
4. `browser-harness.ts` drives the python page through T1's shared embed harness. Its exported surface
   (`installPyPIInterception`, `startPythonSandbox`, `launchBrowser`, `openPythonPage`, `PythonPage.run`
   / `.probe` / `.close`) keeps working for its three consuming spec files; changing those signatures is
   allowed, updating all call sites in the same task.
5. All 11 existing tests across the three python browser spec files pass with assertions intact —
   including the mocked-clock `timed_out` test and the WebRTC probe. No test weakened or deleted.
6. A regression test proves an `init`+`run` delivered only through the port, from a real opaque-origin
   embedder, reaches `result`.
7. `apps/sandbox/public/python.js` regenerated; both drift tests in `build-python-bundle.test.ts` pass.

**File ownership.** `apps/sandbox/src/python/bootstrap.ts` · `apps/sandbox/src/python/browser-harness.ts` ·
`python-core.browser.test.ts` · `python-figures.browser.test.ts` · `python-micropip.browser.test.ts` ·
`apps/sandbox/public/python.js`.

**Interfaces.** *Consumes* T1's shared embed harness and its wire contract. *Produces* nothing new.

**Depends on** T1.

**Scoped checks.** `pnpm --filter @hushbox/sandbox test` ·
`turbo typecheck lint --filter=@hushbox/sandbox` · `jscpd --threshold 2` over owned files.

**Sensitive?** Yes — security boundary. 3-lens audit panel.

---

### T3 — Parent component on the port

**Objective.** Move `DocumentSandbox` to the port transport with first-ready-wins, and pin the regression.

**Design context.** The parent's `postToFrame` is where the bug lives. Its comment argues against `'*'`
and is right to; the port satisfies that concern properly rather than abandoning it. The component's
existing state machine — staleness drop, streaming suppression, `superseded`, the once-only React failure
guard — is the product of a long sequence of measured fixes and must survive this change untouched in
behaviour.

**Acceptance criteria.**

1. `postToFrame` posts through the captured port. `iframe.contentWindow.postMessage` is never called —
   from anywhere in the component.
2. The `message` listener keeps its `event.source === iframeRef.current?.contentWindow` gate and now
   accepts **only** `ready`, capturing `event.ports[0]`. All other frame→parent messages arrive on
   `port.onmessage`.
3. **First-ready-wins:** a second `ready` for the same frame instance is ignored — its port is not
   captured and does not replace the live one. Reset on frame replacement so a post-`stop` frame
   handshakes normally.
4. The port ref is cleared in `stop()` alongside `readyRef`/`requestIdRef`, so a torn-down frame's port
   can never be posted through.
5. **Regression pin:** a test asserting the spy on `iframe.contentWindow.postMessage` records **zero**
   calls across a full init→rendered cycle. This is the assertion whose absence let the bug ship —
   today's tests assert the send happened with the origin, which is exactly the broken behaviour.
6. A test proves a hijack attempt fails: a second `ready` carrying an attacker-minted port does not
   redirect subsequent parent→frame traffic.
7. All 105 tests in `document-sandbox.test.tsx` and every test in
   `document-panel.streaming-preview.test.tsx` pass, assertions intact. Tests asserting
   `toHaveBeenCalledWith({...}, ORIGIN)` are re-expressed against the port, not deleted.
8. Per-file 95% coverage holds for every file this task edits.

**File ownership.** `apps/web/src/components/document-panel/document-sandbox.tsx` ·
`document-sandbox.test.tsx` · `document-panel.streaming-preview.test.tsx`.

**Interfaces.** *Consumes* T1's wire contract (`ready` carries `[port2]`; everything else rides the port).
*Produces* nothing other tasks consume.

**Scoped checks.** `pnpm test:web` · `turbo typecheck lint --filter=@hushbox/web` ·
`jscpd --threshold 2` over owned files.

**Sensitive?** Yes — security boundary (the hijack guard). 3-lens audit panel.

---

### T4 — E2E containment harness on the port

**Objective.** Move `e2e/helpers/sandbox-harness.ts` to the port handshake so the containment corpus
exercises the shipped delivery path.

**Design context.** This harness already embeds a real `allow-scripts` iframe — it had the opaque origin
all along — but sends with `'*'` at line 113, taking the path that works. It tests containment, not
delivery, which is why it stayed green through the bug. Its seven consuming tests in
`e2e/security/document-sandbox-containment.spec.ts` are about CSP, sandbox attributes, and frame
teardown/recreate; they must keep testing exactly that.

**Acceptance criteria.**

1. `buildHarnessHtml` registers the parent's `message` listener **before** the `<iframe>` is attached
   (the one-shot `ready` does not queue — see Verified facts), captures the transferred port, and
   `__docFrame.send` posts through it.
2. `waitForReady`, `teardownFrame`, and `recreateFrame` still work; recreate must re-handshake and
   capture the new frame's port, since `waitForReady(2)` is an existing assertion.
3. `DocumentSandboxHarness`'s exported surface (`bridgeLog`, `open`, `waitForReady`, `sendInit`,
   `sendRun`, `sendStop`, `teardownFrame`, `recreateFrame`) keeps its signatures — the consuming spec is
   not this task's to rewrite.
4. `DOCUMENT_IFRAME_SANDBOX_ATTR` stays `allow-scripts` exactly.
5. **The specs are not run** — the founder runs E2E. Verification is `turbo typecheck lint` over the e2e
   package plus a careful read against the shipped bootstraps. State plainly in the report that the
   behaviour is unverified-by-execution.

**File ownership.** `e2e/helpers/sandbox-harness.ts`.

**Depends on** T1, T2.

**Scoped checks.** `turbo typecheck lint --filter` over the e2e package. No test execution.

**Sensitive?** No — single auditor.

---

### T5 — Documentation

**Objective.** Record the port handshake in `docs/DOCUMENTS.md`.

**Design context.** `DOCUMENTS.md` is the design of record for runnable documents and currently describes
a `postMessage` bridge. A doc that describes a superseded transport is a wrong comment at file scale.

**Acceptance criteria.**

1. The bridge-protocol section describes the handshake: frame mints the channel, transfers `port2` on
   `ready`, all later traffic both directions rides the port, frame keeps no `window` listener.
2. The security-model section records **why**: a port is a capability bound to the receiving document, so
   it dies with a self-navigated frame (with the verified observation), and the frame's realm-sharing
   forgery path is closed.
3. The single surviving wildcard is stated with its reason (an opaque frame cannot know its embedder's
   origin; `capacitor://localhost` on mobile).
4. The first-ready-wins rule is recorded as an invariant, with the hijack it prevents.
5. Message shapes are documented as unchanged and transport-agnostic.
6. No task or run identifiers. Durable facts only, tables where they help — matching the file's register.

**File ownership.** `docs/DOCUMENTS.md`.

**Depends on** T1, T2, T3, T4.

**Scoped checks.** None (prose). Prettier via the lint gate.

**Sensitive?** No — single auditor.

## Amendments

### A1 — coverage-exclusion edit outside T1's file ownership (accepted)

T1 edited `apps/sandbox/vitest.config.ts` (one line) to exclude the new shared embed harness from the
coverage gate. Criterion 4 requires that exclusion and `python/browser-harness.ts` is already excluded the
same way, so the edit is in scope even though the path was not enumerated. No other task owns that file.
The T1 audit judges this edit on its merits like any other.

### A2 — the duplication T1 leaves behind is T2's to collapse

T1 reports 4 jscpd clone pairs between its new `apps/sandbox/src/embed-harness.ts` and
`python/browser-harness.ts` (`BridgeLike`, the static server, `launchBrowser`). Package-wide duplication
is currently 1.02% against a 2% threshold, so nothing is failing — but this is exactly the
`CODE-RULES.md` **One Implementation, Shared** case: two copies that must agree to be correct. **T2 must
collapse it by delegating to the shared harness rather than keeping a parallel implementation.** If T2
concludes some clone cannot be collapsed, that is a NEEDS_CONTEXT escalation, not a local decision to
leave a second copy. Add to T2's acceptance criteria: `jscpd --threshold 2` over T2's owned files passes
**and** the clone pairs against `embed-harness.ts` are gone.

### A3 — harness facts T2 must not rediscover the hard way

Verified by T1 while building the harness; authoritative over local guessing:

- **The harness origin must be `http://localhost:<port>`, never `127.0.0.1`.** The sandbox CSP's
  `frame-ancestors` admits only `http://localhost:*` on loopback, so a `127.0.0.1` parent is refused
  embedding.
- **All harness waits poll from Node, never from inside the page.** A page-side wait deadlocks the
  mocked-clock python `timed_out` test, which installs `page.clock`.
- **DOM and global assertions inside the frame go through the harness's `probeFrame()`, not
  `page.evaluate()`** — the frame is opaque-origin, so the parent page cannot reach into it directly.

### A4 — a Chromium-only CSP observation, recorded so it is not mistaken for a guarantee

T1 verified empirically that CSP `'self'` matches the frame's URL origin despite the frame's origin being
opaque. The in-test module stub depends on this; **production does not** (esm.sh is listed explicitly in
the sandbox CSP). Chromium-only, unverified elsewhere. Do not build production behaviour on it.

### A5 — `port.start()` is mandatory and no unit test can pin it

**Every task that attaches a port listener must know this.** The repo's `unicorn/prefer-add-event-listener`
rule rejects the `port.onmessage = …` assignment form, so port listeners are registered with
`port.addEventListener('message', …)`. In a real browser that form leaves the port **paused** — messages
queue and never deliver — until `port.start()` is called. Assignment-form `onmessage` auto-starts;
`addEventListener` does not.

The trap: **both vitest environments get Node's `MessagePort`, which auto-starts on listener attach.** T3
demonstrated this by deleting its `start()` call and watching the whole suite stay green. So a missing
`start()` is invisible to every unit test in this repo and would reproduce the original bug in a new
form — a bridge that silently delivers nothing.

Consequences, binding on the rest of the run:

- Any code using `port.addEventListener` **must** call `port.start()`. Any code using assignment-form
  `onmessage` must not be "fixed" into `addEventListener` without adding `start()`.
- Auditors verify this **by reading**, not by test result — a green suite is not evidence here.
- T1's frame side is partly self-protecting (its browser tests run in real Chromium, where a missing
  `start()` fails). T3's parent side and T4's e2e harness are **not** — happy-dom masks it and the e2e
  specs are not executed this run. Those two need the reading check.
- The only execution that can prove the line lives is the founder-run
  `e2e/chat/runnable-documents.spec.ts`.

### A6 — correction: the plan's test counts for T3 were wrong

§T3 criterion 7 says "all 105 tests in `document-sandbox.test.tsx`". The real count was **44** before the
task (52 after); `document-panel.streaming-preview.test.tsx` held 10 (10 after). The 105 figure came from
a planning-time miscount and was never a requirement — the binding criterion is unchanged and was met:
no test weakened or deleted, every pre-existing assertion re-expressed rather than dropped. Auditors
judge against the real counts.

### A7 — the audit baseline is the working tree at run start, NOT git HEAD

This run began on a dirty tree. A large uncommitted body of prior work is already present — the entire
runnable-documents feature from the 2026-07-23 run, plus unrelated concurrent workstreams. **Nothing in
this repository is committed, so `git diff HEAD` attributes months of other people's work to whichever
task an auditor happens to be reviewing.**

Binding on every auditor for the rest of this run:

- The baseline for "what this task changed" is the implementer's own report and the working tree as it
  stood when the task started — never `git show HEAD`.
- Per `AGENT-RULES.md`: never investigate, fix, or revert changes you did not make. A pre-existing
  uncommitted difference is not a finding.
- Global Constraint 7's "preserved behaviour, unchanged" means unchanged **from the working tree at run
  start**, not restored to HEAD.

Known pre-existing uncommitted deltas that are **out of scope for every task in this run**:

| Path | Owner |
| --- | --- |
| `apps/sandbox/**` (the whole feature) | 2026-07-23 run |
| `apps/web/src/components/document-panel/**` | 2026-07-23 run |
| `apps/web/vite.config.ts` | concurrent workstream |
| `e2e/notifications/notifications.spec.ts` | concurrent workstream |
| `packages/shared/src/affordability/**` | concurrent workstream |

Specifically ruled on and closed: the `reportReactFailure` once-only guard sitting **above** the
`pendingRequestId === requestId` settle branch is **prior-run work, not this run's**. It was a deliberate
fix in the 2026-07-23 run (task-19), which chose to make the guard's comment true rather than narrow it,
and verified 3/3 that two sibling effects throwing in one commit round produce exactly one error rather
than going silent. Do not flag it, and do not revert it.

### A8 — T2's collapse extends to the containment helper, not just the clones

The T1 security re-audit surfaced a structural problem A2 was too narrow to catch. This package now holds
**three** implementations of "serve `public/` safely": `dev-server.ts`, `python/browser-harness.ts`, and
`embed-harness.ts`. They have already drifted in the way that matters:

- `dev-server.ts:66` exports `resolveWithinDir()` — resolve, then assert prefix containment. It refuses
  every traversal payload.
- `embed-harness.ts` carried a copy that was **exploitable** until this fix round, and now defends with a
  *different* technique (`path.posix.normalize` and clamp).

Two techniques, one job, correctness dependent on agreeing — the exact `CODE-RULES.md`
**One Implementation, Shared** case, and the drift already produced a real arbitrary-file-read hole. A2
scoped T2 to the harness↔harness clones; that is not enough.

**T2's collapse must therefore also route containment through the single exported helper**
(`resolveWithinDir`, or one shared helper if T2 judges a better home for it) rather than leaving any
second technique in the tree. Same escalation rule as A2: if T2 concludes a copy genuinely cannot be
collapsed, that is a NEEDS_CONTEXT to the orchestrator, never a local decision to keep two.

Two related observations, deliberately **not** assigned — pre-existing, out of scope, flagged for the
founder rather than fixed by this run:

- `dev-server.ts:88-90`'s `v8 ignore` justification says a real HTTP request "can never reach here". The
  same `%2f` evidence falsifies that claim. The guard itself holds and returns 403 — only the stated
  reason is wrong.
- `embed-harness.ts`'s clamp mixes `path.posix.normalize` with platform `path.join`, which would diverge
  on Windows. The repo does not run there.

### A9 — the accurate wildcard inventory (correcting the orchestrator)

I stated, and repeated, that `e2e/helpers/sandbox-harness.ts:113` was the last remaining wildcard
`contentWindow.postMessage` in the repository. **That was wrong**, and T4 caught it. I had generalised a
T3 auditor's statement that was correctly scoped to the product path into a repo-wide claim.

The accurate inventory, which **T5 must document rather than the version I asserted**:

| Site | What it is | Global Constraint 2? |
| --- | --- | --- |
| `render/bootstrap.ts` — one `parent.postMessage(msg, '*', [port2])` | the `ready` handshake | The permitted one |
| `python/bootstrap.ts` — one `parent.postMessage(msg, '*', [port2])` | the `ready` handshake | The permitted one |
| `embed-harness.ts` — `postToFrameWindow` | T1's **deliberate forgery probe**, eslint-disabled with justification. It exists so a test can post a forged `init` at the frame's window and prove the frame ignores it. Deleting it would delete the proof. | Not a breach — test infrastructure, not the product parent |
| `e2e/helpers/sandbox-harness.ts` | T4's; moved to the port | Resolved |

So: two wildcards ship (one per bootstrap, each carrying only a type tag and the port), and one lives in
test infrastructure whose entire purpose is to be ignored. The product parent has none.

## Dependency graph

```
T1 ──┬── T2 ──┬── T4 ── T5
     │        │
T3 ──┴────────┘
```

T1 and T3 start together. T2 follows T1 (shared harness). T4 follows T1+T2. T5 last.

## Related E2E

Declared at approval; the founder executes them, this run does not.

- `e2e/chat/runnable-documents.spec.ts` (4 tests) — **the spec that would have caught this bug.** It
  drives the real app UI and asserts terminal bridge states: `rendered` for html and react, `complete`
  for python, `error` for the syntax-error document. All four would have hung at "Working…". Unmodified
  by this run; it is the acceptance gate for the fix.
- `e2e/security/document-sandbox-containment.spec.ts` (7 tests) — consumes the T4 harness.
- `e2e/ui/document-panel.spec.ts` — drives the panel through `document-panel.page.ts`.

No new E2E is required: the flows are already covered, and the gap was harness fidelity, not missing
coverage.
