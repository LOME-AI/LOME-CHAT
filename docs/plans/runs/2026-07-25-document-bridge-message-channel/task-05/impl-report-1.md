# impl-report-1 — bring `docs/DOCUMENTS.md` current with the port transport

## Objective

`docs/DOCUMENTS.md` is the design of record for runnable documents and described a
`postMessage` bridge that no longer exists. Bring it current with the frame-minted
`MessageChannel` transport. One owned file: `docs/DOCUMENTS.md`.

## Files changed

- `docs/DOCUMENTS.md` — the only file touched; six sections edited (below).

## Sections changed

| Section                    | Change                                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture — mermaid     | The two bridge edges became three: `ready (transfers a port)` frame→parent, then `port: init/run/stop` and `port: loading/rendered/console/result/error`. The old diagram labelled the parent→frame edge `postMessage`, which is exactly the call the product no longer makes.      |
| Architecture — web renderer bullet | "receives code via postMessage" → "receives code over the bridge port".                                                                                                                                                                                                   |
| Bridge protocol — preamble | Added that the shared Zod schemas are transport-agnostic (they name no window, origin, or port) and that the transport is free to change without touching them. Message table itself untouched — the shapes did not change.                                                        |
| Bridge protocol — new `### Transport: a frame-minted channel` | The substantive addition. Handshake, why a port beats `'*'`, one-implementation, first-ready-wins, `port.start()`, wildcard inventory. Detailed below.                                                                                           |
| Security model — layer table | New `Bridge transport` row between App-origin CSP and Process lifecycle: port-only intake, no `window` listener in either runtime, closure-scoped endpoint inside the IIFE bundle; prevents realm-sharing document code forging `init`/`run`/`stop`, output broadcast, and a self-navigated frame receiving traffic addressed to its predecessor. |
| Security model — invariants | New invariant 5: the frame's only intake is the transferred port; no `window` message listener in either runtime and no parent→frame `window.postMessage` in the product, because realm-sharing document code makes a window listener directly forgeable.                          |
| Adding a runtime — step 2  | A new renderer page handshakes through the shared `connectToEmbedder`, never a second copy of it.                                                                                                                                                                                  |
| Rejected designs           | New row: `Parent→frame window.postMessage` — explicit target silently discarded, `'null'` throws, `'/'` resolves to the parent and is dropped; a wildcard delivers but is forgeable from inside the frame's realm and survives self-navigation.                                    |

The one relocation: the `document-render-status` paragraph now sits directly after the
message table, above the new `### Transport` heading, so it stays under `## Bridge
protocol` rather than falling inside the transport subsection.

## Acceptance criteria

§T5 criteria, plus the eight facts the brief carried.

| Criterion                                                                             | Met | Evidence                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Handshake documented: frame mints channel, transfers `port2` on one-shot `ready`, all later traffic both directions on the port, frame registers no `window` listener | yes | Transport subsection ¶1; also the mermaid edges and invariant 5                                                                                                                                                                |
| One implementation, both runtimes, with the reason                                     | yes | "One handshake, both runtimes" paragraph names `apps/sandbox/src/embedder-channel.ts` and states the reason: the parent has a single implementation of the other side, so two frame copies would have to agree to be correct, and divergence is silent |
| Accurate wildcard inventory per A9, not the earlier text                                | yes | Wildcard table: the handshake broadcast (one source site, shipped in both bundles) and `embed-harness.ts`'s `postToFrameWindow` forgery probe, plus an explicit statement that the panel posts at the frame's window not at all |
| Why a port rather than `'*'` — capability bound to the receiving document, dies with it | yes | Third bullet of the port-vs-wildcard list, including the self-navigation observation                                                                                                                                            |
| What the change closed, on both runtimes, not theoretical                               | yes | First bullet of that list; the security-model row; invariant 5                                                                                                                                                                  |
| First-ready-wins as an invariant, with the hijack it prevents                            | yes | "First ready wins" paragraph — second `ready` from document code minting its own channel                                                                                                                                       |
| `port.start()` mandatory, and the frame/parent testability asymmetry                     | yes | "`port.start()` is mandatory, and only half of it is testable" paragraph                                                                                                                                                        |
| Message shapes unchanged and transport-agnostic                                          | yes | Bridge protocol preamble; message table left byte-identical                                                                                                                                                                     |
| No task or run identifiers; durable facts; matching register                             | yes | `grep -nE "T[0-9]\|A[0-9]{1,2} —\|previously\|was changed\|this run\|2026-"` returns one pre-existing hit ("previously mermaid-only", Panel UX, not mine)                                                                       |

### Claims verified against the tree before writing them

Every load-bearing assertion in the new prose was checked, not inferred from the plan.

| Claim                                                                     | Check                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One handshake source site, shipped in both bundles                        | `grep -c parent.postMessage` = 1 in each of `apps/sandbox/public/render.js` and `public/python.js`; both match `parent.postMessage(x,"*",[y.port2])`. Source: only `apps/sandbox/src/embedder-channel.ts` has `parent.postMessage`; both bootstraps import `connectToEmbedder` |
| No `window` message listener in either shipped bundle                     | Every `.addEventListener("message"` in both bundles is on a `port1` — two in `render.js` (handshake + the `settleTick` macrotask clock), one in `python.js`      |
| `port.start()` before transfer, listener registered with `addEventListener` | `embedder-channel.ts:58-67`                                                                                                                                     |
| Forgery probe pins intake is port-only, on both runtimes                   | `render/render.browser.test.ts:208` and `python/python-core.browser.test.ts:76,82` call `frame.postToFrameWindow`                                                |
| Panel never posts at `contentWindow`, pinned by a zero-call spy            | `document-sandbox.test.tsx:69` spies on `win.postMessage`; the assertion `expect(windowPost).not.toHaveBeenCalled()` runs after a full init→rendered cycle, guarded by `expect(iframe.contentWindow).toBe(win)` |
| First-ready-wins and port clearing on teardown                             | `document-sandbox.tsx:497` (clear), `:526-541` (only `ready` accepted from the window, `if (portRef.current) return`, `port.start()`)                            |
| Schemas needed no edit                                                     | `packages/shared/src/documents/bridge.ts` is not in this run's changed set; the doc's message table is unchanged                                                 |

## Self-gate

| Command                                                | Result                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `npx prettier --check docs/DOCUMENTS.md`               | pass — "All matched files use Prettier code style!"                                                   |
| Baseline confirmation                                  | `git show HEAD:docs/DOCUMENTS.md` is prettier-clean, so the formatting run corrects only my own drift |

No test or typecheck gate applies — the task is prose in a file outside every package.
Markdown is covered by the lint gate through Prettier only.

## Deviations

One, and it is a precision refinement rather than a departure. The brief's fact 3 says
"two wildcards ship, one per bootstrap". Post-collapse that is one **source** site
(`embedder-channel.ts`) compiled into both bundles — the bootstraps no longer contain the
call. The doc states it that way: "One source site, shipped inside both bundles, sent once
per frame instance." Same inventory, stated so a reader who greps `bootstrap.ts` for `'*'`
and finds nothing is not confused. Verified against the built bundles above.

## Concerns and limitations

**Stale in a doc I do not own — `docs/ARCHITECTURE.md:201`:**

> Parent↔frame traffic is a Zod-typed postMessage bridge shared from `packages/shared`.

The schema half is still true; the transport half reads as the window `postMessage` bridge
this run removed. It is the only `postMessage` mention in any loaded doc — I grepped
`ARCHITECTURE.md`, `TECH-STACK.md`, `DEVELOPMENT.md`, `CODE-RULES.md`, and every nested
`CLAUDE.md`; nothing else in the repo's docs asserts a transport. Suggested wording,
someone else's to apply: "Parent↔frame traffic is a Zod-typed bridge over a frame-minted
`MessagePort`, its shapes shared from `packages/shared`."

`TECH-STACK.md`'s document-sandbox row makes no transport claim and is not falsified.

The `document-render-status` paragraph moved position without changing a word; a reviewer
diffing hunks will see it as a delete plus an insert.

## Confidence

**High.** Every non-obvious assertion was verified against the shipped bundles, the
bootstraps, and the tests that pin it, rather than taken from the plan. The residual risk
is editorial, not factual: whether the transport subsection earns its length at the density
this file keeps.
