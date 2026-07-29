# Task 01 — per-language document E2E

## Objective

Give every runnable document kind an E2E proof that its runtime executes **and** its
output is really visible: two new tests (`js`, fill-and-theme) and three extended
(`html`, `jsx`, `python`), all in `e2e/chat/runnable-documents.spec.ts`.

## Execution status — read this first

**The specs were not run.** No Playwright process was started at any point in this task.
Everything below is a claim about code that has been read against the shipped app, type
checked and linted — never about observed test behaviour. Nothing here should be read as
"the tests pass"; nobody knows that yet, and the first real run may well surface
calibration or engine issues (see Concerns).

## Files changed

- `e2e/chat/runnable-documents.spec.ts` — two new tests, three extended, five fixtures
  (one new, one extended `html`, one new `js`, extended `jsx`/`python`), and the two
  small spec-local predicates the geometry assertions read through.
- `e2e/pages/document-panel.page.ts` — the measurement surface the spec needs: the
  `Frame` lookup, in-frame heights/root-fill/background/canvas-pixel readers, the
  console strip's metrics, the figure's decoded size, the frame and content-area boxes,
  and the confetti marker locator. Every raw selector stays here; the spec passes only
  its own fixtures' selectors in.

No other file changed. No `TEST_IDS` entry was added — see below.

## Tests: the one assertion that carries each

| Test | Load-bearing assertion | Why text cannot catch it |
| --- | --- | --- |
| `js document draws bars with real height and re-sorts them on interaction` | `expect(Math.min(...heights)).toBeGreaterThan(0)` together with `isAscending(heights)` after each sort, over `renderedHeights('[data-bar]')` measured inside the frame | This is the founder's sorting-lab defect exactly: the readout (`order: sorted by bubble`) is written by the same call that places the bars and is correct whether the bars are 108px or 0px tall. A text-only test passes over a completely invisible visualiser. Measuring the rects' rendered heights is the only thing that separates the two. |
| `html … is interactive, and toggles raw/rendered` | `expectPixelNear(await documentPanel.canvasCentrePixel('#doc-canvas'), CANVAS_FILL)` | An unpainted canvas is present in the DOM, correctly sized, and visible — every existing assertion in that test passes over one. Only the pixels say whether `fillRect` ever ran. |
| `react document imports an npm package and renders inside the sandbox` | the bar's measured height going from `24` to `48` across the click (`renderedHeights('#react-bar')`), plus the `canvas[data-confetti="fired"]` marker | The height *is* the component's state. A text readout of the same number updates identically with a zero-height bar, and `rendered` alone says nothing about whether a second commit round ever reached the DOM. The confetti marker exists only because the bare-specifier module's default export was actually invoked — a resolved-but-never-called import reaches `rendered` too. |
| `python document runs on Pyodide and returns a matplotlib figure` | `strip.clientHeight >= strip.lineHeight * 4` **and** `strip.scrollHeight > strip.clientHeight`, plus `sourceBox.y > consoleBox.y > runBox.y` and a non-zero `naturalWidth` | The console's text is identical whether the strip stands five lines tall or is squashed into one scrolling line — `toContainText` reads the full text either way. Layout order is likewise invisible to text: a source block above the output pushes a run's result below the fold with no textual difference. A broken image also keeps its box and passes `toBeVisible()`; only the decoded size proves real PNG bytes. |
| `a rendered document fills the panel and paints the app background` | `frameBox.height > contentArea.height * 0.9`, `rootHeight > frameHeight * 0.9`, and `frameBackgroundColour() === appBackgroundColour()` before **and** after the theme toggle | The 150px-tall document and the unthemed grey canvas are both fully-passing documents by every text and status assertion — the iframe falls back to its 300×150 intrinsic size, or paints the browser default canvas, while reporting `rendered` and showing its text. Only the box and the computed colour differ. |

## Fixtures — size and runnability

`documentFixture` pads any body to `MIN_LINES_FOR_DOCUMENT + 4`, so every fixture clears
the threshold by construction, not by a hand count. Measured body lengths (evaluated
from the file's own array literals):

| Fixture | Body lines | Card `lineCount` | Threshold (15) |
| --- | --- | --- | --- |
| `HTML_DOC` | 19 | 19 | clears |
| `JS_DOC` | 74 | 74 | clears |
| `REACT_DOC` | 28 | 28 | clears |
| `PYTHON_DOC` | 20 | 20 | clears |
| `FILL_DOC` | 4 | 19 (padded) | clears |

How each was satisfied to actually run inside the sandbox, given no execution:

- **No network anywhere.** No fixture fetches, loads a remote image, or names a font.
  The only module imports are bare specifiers (`canvas-confetti`, `react`), which
  `rewriteBareImports` rewrites before the engine sees them; under E2E `ESM_CDN_URL`
  points at the sandbox origin's own `/esm-stub`.
- **npm resolves.** The stub's fixture set is exactly `react`, `react/jsx-runtime`,
  `react-dom/client`, `canvas-confetti` (`apps/sandbox/src/esm-stub.ts`). The js fixture
  imports only `canvas-confetti`; the react fixture imports `canvas-confetti` plus
  `useState`/`useEffect` from `react`, both of which the stub exports. Nothing else is
  imported anywhere.
- **js is not transpiled** (`renderJs` imports the module directly), so `JS_DOC` uses
  only native syntax — spread, arrow functions, destructuring swap, `replaceChildren`,
  `createElementNS`.
- **The react fixture is written to the stub's reconciler.** The stub mounts through
  `document.createElement` + `setAttribute`, so it cannot mount an SVG (no namespace) and
  does not wire React event props. The fixture therefore takes its geometry from a
  `<canvas>`'s `width`/`height` content attributes and wires its click from an effect —
  both of which behave identically under real React, so the fixture is not stub-shaped
  fiction. This is a deviation from the plan's wording; see Deviations.
- **Python uses only vendored wheels** — `numpy` and `matplotlib`, no pandas, no scipy —
  and prints deliberately short lines so a console line cannot wrap on the narrowest
  panel (a wrapped line is a taller line, and the strip's height is judged in units of a
  line).
- **Opaque-origin constraints respected.** No fixture touches `localStorage`, cookies, or
  WebRTC. Inline `<script>` (html) and inline attributes are within the sandbox CSP
  (`script-src` allows inline by design; `style-src` allows `'unsafe-inline'`).
- **`js` is a real runnable kind**: `getDocumentType('js') === 'js'`, `'js'` is in
  `RUNNABLE_DOCUMENT_KINDS`, and it renders on `render.html` like html/react.

## New TEST_IDS entries

**None.** Every app-side selector came from the existing registry (`documentPanel`,
`documentPanelScroll`, `highlightedCode`, `documentCard`, `messageItem`, `themeToggle`).
Everything inside the sandbox frame is a document's own markup, not app DOM, so it is
addressed by role/text or by the fixture's own attributes through page-object methods —
`data-testid` never enters a document fixture.

## Technical route for the in-frame measurements

`FrameLocator` yields locators but no `evaluate`, and the renderer frame is cross-origin
with an opaque origin. The page object therefore finds the `Frame` via `page.frames()`
(matching `/render.html`) and evaluates in it; the lookup throws when the frame is absent
so a caller's `expect.poll` retries rather than measuring a torn-down frame. Selection is
attribute- and id-based (`[data-bar]`, `#react-bar`, `#doc-canvas`, `#document-root`),
never index-based.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo typecheck lint --filter=@hushbox/e2e --force` | pass (2/2 tasks, cache bypassed) |
| `npx eslint --fix e2e/chat/runnable-documents.spec.ts e2e/pages/document-panel.page.ts` (run from `e2e/`, after the final edit) | pass, no findings |
| `npx tsc --noEmit -p e2e/tsconfig.json` | pass |
| Playwright specs | **not run** — the founder runs E2E |

Three lint findings were fixed during the work rather than suppressed:
`restrict-template-expressions` on the canvas fill (now built by `join`),
`unicorn/no-await-expression-member` in two poll callbacks, and
`unicorn/prefer-query-selector` in the root-fill reader.

## Acceptance criteria

- **js gets a test at all** — met: `js document draws bars with real height and re-sorts
  them on interaction`, covering non-zero bar heights, algorithm switching (via a Reset
  that restores the unsorted order, so the second algorithm's click is a real re-sort and
  not a no-op over sorted data), reaching a sorted state, and the confetti marker.
- **html asserts the canvas is really painted** — met, by reading the centre pixel back
  through `getImageData` with a ±2 per-channel tolerance for engine rounding.
- **jsx asserts state recomputes on interaction with real geometry, and the confetti
  canvas appears** — met; geometry is the canvas bar's measured height, not an SVG (see
  Deviations).
- **python asserts console lines and a PNG, the console cap, and source below the
  controls** — met: eight printed lines with the last one asserted present, a strip that
  is several lines tall and scrolls rather than grows, `run < console < source` in y, and
  a decoded (non-zero `naturalWidth`) figure.
- **A rendered document fills the panel and matches the app background after a theme
  toggle** — met, through the app's own theme control (`TEST_IDS.themeToggle` in the chat
  header, which drives `ThemeProvider.triggerTransition`); no second toggle mechanism was
  invented.
- **No existing assertion weakened or deleted** — met: every prior assertion is present
  and unchanged; the only edits to existing tests are added steps.
- **Test ids only from the registry; fixtures purpose-built and minimal; no spec files
  added** — met.

## Deviations

1. **The react test's "real geometry" is a canvas, not an SVG.** The plan's `jsx` row
   asks for "the SVG has real geometry". The E2E react runtime is the esm-stub
   reconciler, which mounts via `document.createElement` — an `<svg>` created that way is
   an `HTMLUnknownElement` and its children have no layout, so an SVG in a react document
   would measure zero height in E2E *by construction*, and a test written that way would
   fail for a reason that has nothing to do with the app. The fixture instead takes its
   height from a `<canvas>`'s `height` content attribute, which is real layout geometry in
   both the stub and real React. Real SVG geometry is covered where it can genuinely run:
   the `js` fixture, whose module has full DOM access and uses `createElementNS`.
2. **The js fixture carries a Reset control** beyond the plan's "switching algorithm".
   Without it the second algorithm sorts already-sorted data and a no-op would pass.

## Concerns and limitations

- **Unverified by execution.** Restating it because it is the single most important fact
  about this report: no assertion here has ever been observed to pass or fail. Threshold
  choices (`FILL_RATIO = 0.9`, `MIN_CONTENT_AREA_PX = 200`, four visible console lines,
  ±2 pixel tolerance) are reasoned from the shipped CSS — `max-h-[6.5rem]` over 1rem
  lines, the iframe's 150px intrinsic fallback, the 659px-tall shortest project viewport
  — not calibrated against a run.
- **`Frame.evaluate` against the opaque frame is proven for the measurement route the
  orchestrator ran this session, which I take to be Chromium.** This file is not
  project-gated, so it also runs on firefox, webkit, iphone-15, pixel-7 and ipad-pro. If
  an engine refuses the in-frame evaluation it will fail deterministically on that
  project, not flakily; the mitigation, if it happens, is a `@chromium-only` tag on the
  geometry steps, which I did not apply pre-emptively because guessing at it would weaken
  coverage on engines that are fine.
- **The react fixture depends on the stub's re-render semantics** (fresh elements per
  commit, effects flushed after each commit, functional `setState`). It is written to be
  correct under real React too, but only the stub path is exercised in E2E.
- **The theme step assumes the chat header's toggle is reachable with the panel open.**
  It is laid out above the content row that holds the panel, on every viewport, so
  nothing overlaps it — read from `chat-layout.tsx`, not observed.
- **`expect.poll` on the frame background** is the one place a genuine wait exists: the
  restyle rides a `postMessage` with no app-side completion signal. It gates on the
  painted colour, which is the app's own state, not on a clock.

## Runtime expectation

I expect this file to grow by roughly 20–25s of test work and by ~10s of wall clock per
browser project, and not to become a pole.

Reasoning: the file goes from 4 tests to 6. Each new test pays the same setup as the
existing render tests — one seeded conversation over the API plus a navigation
(`seedDocumentConversation`) — and then a sandbox render. The `js` test adds four clicks
and four batched in-frame reads on top of that; the fill test adds one theme toggle and
three reads. Neither loads Pyodide, so neither is anywhere near the python test's cost,
which continues to dominate the file. The three extensions add no new page load and no
new render: they are extra assertions inside renders that already happened, the most
expensive being the figure `scrollIntoViewIfNeeded` and the pixel read, both sub-second.
With `fullyParallel`, wall clock is bounded by the slowest single test (still python at
`TIMEOUTS.XXLONG`), so the added tests should hide inside the existing tail rather than
extend it, given a free worker. I did not add `test.slow()` to either new test: both do
less work than the existing html test plus a handful of round trips, and the 60s default
budget has ample room — but that is the calibration most likely to need a second look
after the first real run under a saturated matrix.

## Confidence

**Medium** — the code is type-clean, lint-clean and written against the shipped app read
line by line (renderer bootstrap, esm-stub fixture set, panel layout, frame-theme bridge,
CSP), and every assertion targets a defect that text cannot see. It is medium and not
high for exactly one reason: nothing was executed, so the fixtures' runnability and the
thresholds' calibration rest on reading rather than on a green run.
