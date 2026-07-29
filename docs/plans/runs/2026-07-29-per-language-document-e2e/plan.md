# Per-language document E2E

**Tier 1.** One task. Gives every runnable kind an E2E proof that its runtime executes and its output is
really visible — not merely that some text appeared.

## Why

Today's document E2E asserts terminal bridge states and text visibility. It proves the transport works. It
asserts **nothing** about geometry or colour: a repo-wide check found no `toHaveCSS`, no height assertion,
and the only `boundingBox()` in the set is on the panel itself for resizing.

Every defect the founder caught by eye — documents 150px tall, an unthemed grey canvas, a sorting
visualiser whose bars all computed to `0px`, a console squashed to one line — sits in that blind spot. The
sorting-lab bug is the sharpest case: an E2E written in the existing style would have **passed**, because it
would assert on the stats readout, which updates perfectly while every bar has zero height.

**`js` has no test at all** — one of four runnable kinds is entirely unexercised.

## Shape (founder-approved)

**One test per kind, all assertions for a kind inside that one test.** Split on the axis that fails
independently — the runtime (Sucrase, plain JS, React+esm.sh, Pyodide) — never per assertion, because each
extra `test()` pays a fresh conversation seed, page load and runtime warm-up. Python stays alone so
Pyodide's cost does not inflate the others.

**Extend `e2e/chat/runnable-documents.spec.ts`**; do not add spec files. `CODE-RULES` prefers extending,
suite runtime is a shared budget, and its `seedDocumentConversation` helper already reduces per-test setup
to one API call plus a navigation.

## The work

| Kind | Change | The assertion that matters |
| --- | --- | --- |
| **js** | **new test** | bars exist **and have non-zero height**; switching algorithm; reaching `sorted` |
| **html** | extend | the canvas is **actually painted** (sample pixels), not merely present |
| **jsx** | extend | reducer state recomputes on interaction; the SVG has real geometry; the confetti canvas appears — the only E2E proof bare-specifier → esm.sh resolution works in a real browser |
| **python** | extend | console lines **and** a PNG; the console caps at five lines; the source sits below the controls |
| — | **new test** | a rendered document **fills** the panel, and the frame's background matches the app after a theme toggle |

Net: two new tests, three extended.

## Constraints

1. **The specs are NOT executed by this run.** The founder runs E2E. Verification is a careful read against
   the shipped app plus `turbo typecheck lint` over the e2e package. The report must say plainly that the
   behaviour is unverified by execution — no hedging that implies otherwise.
2. **Fixtures are purpose-built and minimal**, defined in the spec as today's are. They are not the seeded
   showcase documents. Each must clear `MIN_LINES_FOR_DOCUMENT` (15) and must genuinely run inside the
   sandbox: no network of any kind, npm only by bare specifier via esm.sh, Python only the vendored wheels
   (numpy/matplotlib/Pillow — **pandas and scipy are unavailable**).
3. **Assert the thing that breaks, never a proxy.** A text assertion that passes with zero-height bars is
   the exact failure this task exists to remove.
4. **Test ids come only from the `TEST_IDS` registry.** If a new id is genuinely needed, add it to
   `packages/shared/src/test-ids.ts` and say so — literal `data-testid` strings are lint-banned.
5. No existing assertion weakened or deleted; the file must not become a suite "pole".

## Known technical risk

Pixel sampling and geometry live **inside a cross-origin, opaque-origin frame**. `FrameLocator` gives
locators but not arbitrary evaluation. Reaching into the frame requires `page.frames()` plus `evaluate` —
which does work against this opaque frame (proven directly this session, measuring `#document-root` and bar
heights inside the real sandbox). Use that route and keep the selection robust rather than index-based.

## Related E2E

The three existing document specs. None is run by this workflow.
