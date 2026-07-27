# T6 — collapse the duplicated frame-side handshake

## Objective

Extract the port handshake both sandbox bootstraps carry — mint channel, register listener,
`start()`, transfer `port2` on the one-shot `ready`, send through the port — into one shared
module both call, so `start()` and the transfer list exist once. No behaviour change.

## Files changed

| Path | Why |
| --- | --- |
| `apps/sandbox/src/embedder-channel.ts` (new) | The one handshake: `connectToEmbedder(onMessage)` mints the channel, registers the caller's handler on `port1` behind `parseParentToFrameMessage`, calls `port1.start()`, broadcasts `ready` with `[port2]`, and returns the send function. The port lives only in this closure. |
| `apps/sandbox/src/render/bootstrap.ts` | Calls the shared helper; its own mint/listen/start/transfer tail and its `parseParentToFrameMessage`/`ReadyMessage` imports are gone. Handler body (init-only) unchanged. |
| `apps/sandbox/src/python/bootstrap.ts` | Same; handler body (`init` stashes / `run` executes / no `stop`) unchanged verbatim. |
| `apps/sandbox/public/render.js` | Regenerated (`build:render`). |
| `apps/sandbox/public/python.js` | Regenerated (`build:python`). |
| `apps/sandbox/vitest.config.ts` | Criterion 7: `src/embedder-channel.ts` added to the coverage exclusions with its justification (below). |

Neither bootstrap retains any step of the handshake. What each keeps is a five-line
`sendToEmbedder`/`post()` pair — the module holds the returned send function and `post()` throws
if it is unset — because criterion 1 specifies the helper *returns* a send function rather than
owning module state. That residue is not correctness-coupled: if the two guards drifted, nothing
about delivery would change (both are unreachable in practice — `startX()` runs at load, before
any message can arrive). Every line whose drift would silently break the bridge is now single.

## Tests added

None. This is an extraction, and the behaviour it moves is already pinned by six real-Chromium
tests written by T1/T2 against the shipped bundles:

| Test | What it pins |
| --- | --- |
| `transfers a MessagePort with its ready broadcast` (render) | the transfer list |
| `keeps its end of the channel off the frame global` (render) | GC 4, by runtime probe |
| `renders a document from an init delivered only through the transferred port` (render) | `start()` + inbound delivery |
| `ignores an init posted at its window instead of the port` (render) | GC 3, forgery closed |
| `runs a document from an init and run delivered only through the transferred port` (python) | `start()` + inbound delivery |
| `ignores an init and run posted at its window instead of the port` (python) | GC 3, forgery closed |

I verified these are not vacuous against the *extracted* code rather than assuming T1/T2's
observations carry over — see the falsification below. A Node-environment unit test of the new
module was considered and deliberately rejected; the reasoning is under *Coverage decision*.

## Falsification: one line, both runtimes

Deleted the single `channel.port1.start()` from `embedder-channel.ts`, rebuilt both bundles, and
ran the two port-delivery tests:

```
FAIL src/python/python-core.browser.test.ts > runs a document from an init and run delivered only through the transferred port
FAIL src/render/render.browser.test.ts > renders a document from an init delivered only through the transferred port
Error: no matching frame→parent message within 15000ms; collected [{"type":"ready"}]
 Test Files  2 failed (2)
      Tests  2 failed | 37 skipped (39)
```

Both runtimes died from one deleted line, for the right reason (the handshake arrives; nothing
else ever does). That is the criterion-3 property demonstrated rather than asserted: before this
task the same experiment had to be run twice, once per copy (T2 did it for python only), and a
drift in one copy left the other green.

The line was restored and both bundles rebuilt to md5s identical to the pre-experiment build
(`a6435e1332fa90441fb5873cdbfadb7c`, `0d3e96c9808915edbbddb79422bbdd0a`).

## Where `port.start()` lives

One frame-side call: `apps/sandbox/src/embedder-channel.ts`, between the listener registration
and the transfer. Full `.start()` inventory in the tree (`grep -rn "\.start()"` over
`apps/sandbox/src`, `apps/web/src/components/document-panel`, `e2e/helpers`,
`packages/shared/src/documents`):

| Site | What it is |
| --- | --- |
| `apps/sandbox/src/embedder-channel.ts` | **the handshake** — the only frame-side one, reached by both bundles |
| `apps/sandbox/src/render/bootstrap.ts` (in `settleTick`) | a throwaway `MessageChannel` used as a macrotask clock; both ends are local, nothing is transferred, no bridge traffic touches it |
| `apps/web/src/components/document-panel/document-sandbox.tsx` | parent side — explicitly out of this task's scope |
| `e2e/helpers/sandbox-harness.ts` | parent side (e2e harness) — explicitly out of scope |

Criterion 3 says "exactly once in the tree"; read literally that is false because of the three
rows above, none of which is the handshake. Read as "the frame-side handshake `start()` exists
once", it is met. Flagging the wording rather than silently picking a reading.

## Bundle evidence (artifacts, not source)

Both bundles were regenerated from the final source and inspected directly.

**`public/render.js` — 540,351 bytes**

- `postMessage` call sites: 3 — `parent.postMessage(n,"*",[t.port2])` (the handshake),
  `t.port1.postMessage(o)` (the returned sender), `o.port2.postMessage(null)` (`settleTick`'s
  local clock channel, both ends in-frame).
- **Wildcard-target `postMessage`: 1** (GC 2).
- `addEventListener(` sites: 4 — two `port1.addEventListener("message")` (handshake +
  `settleTick` clock), plus `globalThis.addEventListener("error")` and
  `…("unhandledrejection")`. `window.addEventListener`: **0**. `onmessage =`: **0** (GC 3).
- `globalThis.X =` assignments: **0**; `window.X =` assignments: **0**; file is IIFE-wrapped
  (`"use strict";(()=>{`), pinned by the `produces a classic-script IIFE (not an ES module)`
  drift test. The runtime probe test `keeps its end of the channel off the frame global` returns
  `[]` from inside the real frame (GC 4).
- Tail: `…}wg();HS();})();` with `wg = function wg(e=globalThis){for(let t of Ub)Object.defineProperty(…)}`
  (neutralizeWebRtc) and `HS` = `startRenderer` → **neutralize first** (GC 5).
- The shared helper, minified: `function Ig(e){let t=new MessageChannel;t.port1.addEventListener("message",o=>{let r=bg(o.data);r.success&&e(r.data)}),t.port1.start();let n={type:"ready"};return parent.postMessage(n,"*",[t.port2]),o=>{t.port1.postMessage(o)}}`

**`public/python.js` — 332,364 bytes**

- `postMessage` call sites: 2 — the handshake and the returned sender. **Wildcard: 1** (GC 2).
- `addEventListener(` sites: **1**, on `port1`. `window.addEventListener`: 0. `onmessage =`: 0 (GC 3).
- `globalThis.X =` / `window.X =` assignments: **0**; IIFE-wrapped, pinned by its own
  `produces a classic-script IIFE` drift test. Python has no in-suite global probe, so I ran one
  ad-hoc against the shipped bundle in real Chromium through the shared embed harness (temporary
  script, deleted; no repo file added):
  `{"hasPort":true,"reachableMessagePorts":[],"RTCPeerConnection":"undefined"}` (GC 4 and GC 5,
  empirically, for the python page).
- Tail: `…})}Ud();tg();})();` with `Ud` = neutralizeWebRtc (same `defineProperty` loop) and `tg` =
  `startPythonRuntime` → **neutralize first** (GC 5).
- Intake shape intact (criterion 4):
  `function tg(){wu=jd(t=>{if(t.type==="init"&&t.kind==="python"){Nd=t.code;return}t.type==="run"&&eg(t.requestId)})}`
  — `init` stashes, `run` executes, no `stop` branch.

The helper minifies to a different name in each bundle (`Ig` vs `jd`): one source, two
independently bundled IIFEs, no shared runtime object and no new global surface.

Message shapes were not touched (GC 1): `packages/shared/src/documents/bridge.ts` is unmodified,
and the `embeds no backend env-config registry names, values, or markers` drift test still passes
for both bundles — the new module imports the narrow `@hushbox/shared/documents` subpath.

## Byte-exact drift

| Bundle | md5 before task | md5 after |
| --- | --- | --- |
| `public/render.js` | `2ae5a70d8b315ee871161b9b9ae51739` | `a6435e1332fa90441fb5873cdbfadb7c` |
| `public/python.js` | `f522d7e409cad8f76e52031f54c8cb06` | `0d3e96c9808915edbbddb79422bbdd0a` |

Both regenerated with `pnpm --filter @hushbox/sandbox build:render` / `build:python`. All four
drift tests pass (`build-bundle.test.ts` 4/4, `build-python-bundle.test.ts` 4/4 — 8 tests
including both `expect(committed).toBe(fresh)` checks). Rebuilding after the last source edit (a
comment) produced byte-identical files, so the committed bundles are exactly what the current
source builds.

## Coverage decision (criterion 7)

**Excluded, with the reason recorded in `vitest.config.ts`.** The observed default was a failure,
not a pass: leaving it included put the file in the report at 0% and failed the per-file gate
(`ERROR: Coverage for lines (0%) … for src/embedder-channel.ts`), because nothing in Node ever
imports it. So both options were live and I had to choose.

- **Why not cover it in Node.** A Node test would have to fake `parent` (the module posts to it),
  and — the decisive part — it could not see the line that matters. Per A5, both vitest
  environments supply Node's `MessagePort`, which starts itself when a listener is attached; a
  Node test of this module passes with `start()` deleted. Shipping such a test would put a green
  file named after the handshake next to the one failure mode that silently kills the bridge.
  That is worse than no test, and it is the exact trap this task exists to close.
- **Why exclusion is the honest classification.** This module *is* bootstrap code, factored out;
  the two bootstraps are excluded for precisely this reason ("they only run inside a real frame
  (never imported in Node), so v8 reports them at 0%"). Extracting code should not change its
  coverage class. Its real verification is stronger than a unit test: six browser tests against
  the shipped bundles, plus the deletion experiment above.

Package coverage returns to the pre-task figure exactly: 131/131 statements, 100% st/br/fn/ln.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm --filter @hushbox/sandbox test` | pass — 17 files, **161 tests**, coverage gate green (100% of 131 statements) |
| `npx turbo typecheck lint --filter=@hushbox/sandbox --force` | pass — 2 successful, 2 total |
| `pnpm exec eslint src/embedder-channel.ts src/render/bootstrap.ts src/python/bootstrap.ts` (from `apps/sandbox`, after the final edit) | exit 0 |
| `pnpm exec prettier --check` over the four edited files | clean |
| `npx jscpd --threshold 2` over the three owned source files | 0 clones |
| `npx jscpd --threshold 2 apps/sandbox/src` | 1 clone, 9 lines (0.41%) — the pre-existing esbuild-options pair T2 flagged; unchanged |
| `pnpm lint:duplication` (repo gate) | pass — 0.99% duplicated lines (was 1.02% at T1) |
| `vitest run src/render/build-bundle.test.ts src/python/build-python-bundle.test.ts` | 8/8 |
| `vitest run src/render/render.browser.test.ts src/python/python-core.browser.test.ts --reporter=verbose` | 39/39, every test named individually |

## Test counts

| Scope | Before | After |
| --- | --- | --- |
| `apps/sandbox` package | 161 (17 files) | 161 (17 files) |
| `render.browser.test.ts` | 28 | 28 |
| `python-core.browser.test.ts` | 11 | 11 |
| `python-figures` / `python-micropip` | 1 / 1 | 1 / 1 |

No test added, weakened, renamed, or deleted; no test file was edited at all.

The four the brief called fragile, each verified by name in the verbose run:

- `ignores an init posted at its window instead of the port` (render forgery) — **pass**, 615 ms.
- `ignores an init and run posted at its window instead of the port` (python forgery) — **pass**,
  533 ms. Both still prove the frame refuses a window-posted `init` and then answers a port one.
- `reports a typed error when the runtime never finishes loading` (mocked-clock `timed_out`) —
  **pass**, 75 ms. Untouched: the helper adds no timer and no page-side wait, so
  `page.clock.install()` still cannot deadlock.
- WebRTC probes — `neutralizes the WebRTC constructors on the frame before document code runs`
  (render) and `neutralizes the WebRTC constructors on the runtime frame` (python) — **pass**,
  80 ms / 2 ms; plus `keeps WebRTC neutralized inside an inline script the CSP now permits`. The
  ordering they depend on is unchanged in both bundle tails.

## Acceptance criteria

1. **Met.** `apps/sandbox/src/embedder-channel.ts` exports `connectToEmbedder(onMessage)`: mints,
   registers the caller's handler on `port1`, `start()`s, transfers `port2` with `ready`, returns
   the send function. Both bootstraps call it; neither retains any handshake step (see the diff —
   `MessageChannel`, `addEventListener`, `start`, `parent.postMessage` and the `sonarjs`
   suppression are gone from both).
2. **Met.** Verified in both built artifacts: one wildcard each, zero window/`globalThis` message
   listeners, zero global assignments inside the IIFEs (plus a runtime probe per page returning
   no reachable `MessagePort`), `neutralizeWebRtc()` still the first of the two tail calls.
3. **Met for the frame-side handshake** — one call, on the shared path, unskippable by either
   bundle, demonstrated by deletion. See the inventory above for the literal-reading caveat.
4. **Met.** Python's handler body is carried over verbatim; the bundle shows
   `init`-stashes / `run`-executes / no `stop` branch.
5. **Met.** 161/161, assertions intact, no test touched.
6. **Met.** Both bundles regenerated; all four drift tests byte-exact (8 tests across the two
   files).
7. **Met.** Excluded, deliberately, with the reasoning recorded in the config comment and above.

## Deviations

1. **`vitest.config.ts` edited** — anticipated by criterion 7 and the file-ownership list.
2. **Prose moved, not just code.** Each bootstrap's docblock carried the transport rationale (why
   a channel, why the wildcard, why `start()`); that rationale moved to the shared module with the
   code it explains, and each bootstrap keeps only what is true of its own page. Leaving two
   copies of the explanation beside one implementation would have been the same drift risk one
   level up. The render file docblock lost its two transport paragraphs; nothing it stated was
   deleted rather than relocated.
3. **No new test.** Argued above rather than assumed; the falsification is the substitute
   evidence, and it is stronger than what a new test could assert.

## Concerns and limitations

- The residual per-bootstrap `post()` guard (5 lines each) is described under *Files changed*. If
  the reviewers prefer zero residue, the alternative is for the shared module to own the
  `sendToEmbedder` state and export `post()` — that contradicts criterion 1's "returns a send
  function", so I did not take it unilaterally.
- The ad-hoc python global probe was a temporary script run through the shared harness and then
  deleted; unlike the render probe it is not a standing test. Adding one would mean editing
  `python-core.browser.test.ts`, which is not in this task's ownership.
- E2E untouched and unrun (GC 11). The parent-side handshake still exists three times, explicitly
  out of scope for this task.
- One pre-existing clone pair remains in the package (esbuild options shared by the two bundle
  builders), unchanged and untouched.

## Confidence

**High.** Nothing about the wire behaviour changed and the artifacts prove it: identical
constraint profile in both bundles, 161/161 with no test edited, both bundles byte-reproducible.
The extraction's central claim — that `start()` now exists once and covers both runtimes — is not
an argument from reading but an observation: removing that one line killed delivery in both
pages in real Chromium, and restoring it reproduced the bundles bit for bit.
