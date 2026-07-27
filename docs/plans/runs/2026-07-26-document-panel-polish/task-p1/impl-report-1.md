# P1 — Frame styling and theme (impl report 1)

## Objective

Give the sandbox frame real CSS so documents fill it and match the app's theme: a `theme`
field on the shared `InitMessage`, layout CSS in `render.html`, and both frame bootstraps
applying the stated theme on every `init`.

## Files changed

| Path                                             | Why                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/shared/src/documents/bridge.ts`         | `DOCUMENT_THEMES` / `DocumentTheme` closed set; `theme` added to `InitMessage`.                   |
| `packages/shared/src/documents/bridge.test.ts`    | Tests for the new enum and the init field.                                                       |
| `apps/sandbox/src/frame-theme.ts` (new)           | The one implementation of the frame's theme stylesheet, imported by both bootstraps.             |
| `apps/sandbox/src/frame-theme.test.ts` (new)      | Unit tests for the generated stylesheet.                                                         |
| `apps/sandbox/public/render.html`                 | `<style>` block: unbroken height chain + zero margin, `min-height` on `#document-root`.          |
| `apps/sandbox/src/render/bootstrap.ts`            | `applyFrameTheme(msg.theme)` as the first act of `handleInit`.                                   |
| `apps/sandbox/src/python/bootstrap.ts`            | `applyFrameTheme(message.theme)` on the python `init` branch (colours only — it paints no preview). |
| `apps/sandbox/src/render/render.browser.test.ts`  | Two probe helpers (`layoutOf`, `appearanceOf`) and five browser tests.                           |
| `apps/sandbox/public/render.js`                   | Regenerated bundle.                                                                              |
| `apps/sandbox/public/python.js`                   | Regenerated bundle.                                                                              |

Nothing in the transport was touched: `embedder-channel.ts`, `csp.ts`, `render.html`'s script
tags, `python.html`, and the `sandbox="allow-scripts"` attribute are unmodified.

## Tests added

| Test                                                                     | Behavior                                                     | Criterion |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | --------- |
| `DocumentTheme > accepts each theme`                                      | The closed set parses both members.                          | 1         |
| `DocumentTheme > rejects a theme outside the closed set`                  | `'sepia'` is refused.                                        | 1         |
| `init > carries the theme the embedder states`                            | `theme` survives a parse round-trip (not stripped).          | 1         |
| `init > rejects init with a theme outside the closed set`                 | A bad theme fails the whole message.                         | 1         |
| `frame theme > sets the colour scheme to the theme it is given`           | `color-scheme` tracks the theme name.                        | 3, 6      |
| `frame theme > paints a different canvas and text colour in each theme`   | Light and dark differ in background and text.                | 3, 6      |
| `frame theme > states no colours when the embedder named no theme`        | An init without a theme yields an empty stylesheet.          | 1         |
| `frame theme > states its colours as a defeasible default`                | `:root`, never `!important`.                                 | 3         |
| `gives a short document the whole frame to occupy`                        | Root height ≈ viewport height, not content height.           | 2, 5      |
| `lets a document taller than the frame scroll to exactly its own height`  | No clipping, and no margin inset padding the scroll extent.  | 2         |
| `paints the canvas and colour scheme the embedder asked for`              | The dark theme's `color-scheme`/background/colour are applied. | 3, 6    |
| `restyles a live frame when a later init names the other theme`           | Same frame element, both values change.                      | 4, 6      |
| `keeps a document's own colours over the frame's`                         | A document's `:root` rule beats the frame's.                 | 3         |

### RED evidence

Every one of the four discriminating browser tests was run against the unstyled frame
(committed `render.html` + the pre-change bundle) before any implementation existed:

- **Criterion 5 (fill):** `AssertionError: expected 582 to be less than or equal to 2` —
  the root measured 18 px against a 600 px viewport. The assertion discriminates; it does
  not pass by construction.
- **Zero margin / no clip:** `expected 2016 to be 2000` — the default 8 px body margin
  padded the scroll extent past the document's own height.
- **Criterion 3 (theme applied):** `expected 'normal' to be 'dark'`.
- **Criterion 4/6 (restyle):** `expected 'normal' to be 'light'`.

The shared-schema tests were RED first as well (4 failures: `theme` silently stripped by
`z.object`, and `'sepia'` accepted as an unknown key). `frame-theme.test.ts` was RED on a
missing module; the later-added `undefined` case was RED-verified separately by removing
the guard (`TypeError: Cannot destructure property 'background'`) before restoring it.

### How a document's own colours still win

The frame's colours are one rule — `:root{color-scheme:…;background-color:…;color:…}` —
in a `<style>` element in `<head>`, with no `!important` and nothing heavier than `:root`
(specificity 0,1,0). Every document style arrives later in the document (an html
document's `<style>` lands inside `#document-root`; a js/react document appends to `head`
after this element), so an author rule of equal specificity wins on order, and anything
more specific wins outright.

Proved by `keeps a document's own colours over the frame's`: an html document carrying
`<style>:root { background-color: rgb(0,128,0); color: rgb(255,0,255) }</style>` is
init'd with `theme: 'dark'`, and the frame's computed root style is the document's green
and magenta, not the dark canvas.

That test cannot fail against today's colourless frame, so its discrimination was proved
directly: adding `!important` to both declarations in `frameThemeCss`, rebuilding the
bundle, and re-running gave
`expected 'rgb(26, 24, 22)' to be 'rgb(0, 128, 0)'` — the unit test
`states its colours as a defeasible default` failed in the same run. The probe was
reverted and both bundles rebuilt.

## Self-gate

| Command                                                                             | Result                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm test:shared`                                                                   | pass — 1 turbo task, all files green                      |
| `pnpm --filter @hushbox/sandbox test`                                                | pass — 18 files, 171 tests; coverage 100% (per-file gate) |
| `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/sandbox --force`     | pass — 4/4 tasks                                          |
| `pnpm run lint` from `packages/shared` and from `apps/sandbox`, after the last edit   | pass — exit 0, no output                                  |

The first lint run failed on two rules in the new unit test (`unicorn/prefer-string-raw`,
`unicorn/no-useless-undefined`); both were fixed at the source (`String.raw` for the regex,
a typed `const unstated: DocumentTheme | undefined` for the argument) and lint re-run after
that last edit.

`frame-theme.ts` is in the coverage report at 6/6 statements and 1/1 functions.

## Acceptance criteria

1. **`InitMessage` gains a closed-set `theme`** — met. `DOCUMENT_THEMES = ['light','dark']`,
   `DocumentTheme = z.enum(...)`, `theme: DocumentTheme.optional()` on `InitMessage`. The
   schema names no window, origin, or port. (Optional rather than required — see Deviations.)
2. **`render.html` layout block** — met. `html, body { height: 100%; margin: 0 }` and
   `#document-root { min-height: 100% }`. Pinned by the fill test and the tall-document test.
3. **Both bootstraps apply the theme on init** — met. `handleInit` calls
   `applyFrameTheme(msg.theme)` before it takes the request; the python intake calls it on
   its `init` branch. Colour scheme, background, and text colour are all set; the
   document-override test proves it stays a default.
4. **Re-init with a different theme restyles live, no remount** — met. `applyFrameTheme`
   rewrites one style element identified by a stable id rather than appending another, and
   `restyles a live frame when a later init names the other theme` drives two inits at the
   same frame element (the harness never re-creates it) and sees all three properties change.
5. **Fill assertion** — met. `gives a short document the whole frame to occupy` measures
   `#document-root` height against `window.innerHeight` inside the frame's own realm
   (tolerance 2 px); RED evidence above.
6. **Colour scheme and background differ between themes** — met, at two levels: the unit
   test on the generated stylesheet and the browser test comparing the dark frame's applied
   values (`dark` / `rgb(26, 24, 22)` / `rgb(242, 241, 239)`) with the light frame's.
7. **Both bundles regenerated; four drift tests byte-exact** — met. `build-bundle.test.ts`
   (2) and `build-python-bundle.test.ts` (2) pass. An independent rebuild-and-hash check:

   ```
   render fresh 049f38672d76fdee committed 049f38672d76fdee identical true bytes 540844
   python fresh 58203b738c836321 committed 58203b738c836321 identical true bytes 332857
   ```

## Global constraints — proof from the built bundles

Read out of the shipped, minified `public/render.js` and `public/python.js`, not the source:

- **One wildcard each (constraint 1).** `grep -o 'postMessage([^)]*"\*"'` returns exactly 1
  match in each bundle — the one-shot `ready` broadcast in `connectToEmbedder`.
- **No window message listener (constraint 1).** `addEventListener("message"` appears twice
  in `render.js` and once in `python.js`, and every occurrence's receiver is a
  `MessageChannel` port, each immediately followed by `.start()`:
  - `render.js`: `let t=new MessageChannel;t.port1.addEventListener("message",…),t.port1.start()`
    (the handshake) and `let o=new MessageChannel;o.port1.addEventListener("message",…),o.port1.start(),o.port2.postMessage(null)`
    (the pre-existing `settleTick` scheduler hop).
  - `python.js`: `let r=new MessageChannel;r.port1.addEventListener("message",…),r.port1.start()`.
  - The only `globalThis.addEventListener` calls in either bundle are `render.js`'s
    pre-existing `error` / `unhandledrejection` handlers.
- **Port unreachable from `globalThis` (constraint 4).** Unchanged and still asserted by the
  existing browser tests, both of which pass: `keeps its end of the channel off the frame
  global` (render, JS-side scan) and the python core suite's scan of `js.globalThis` from
  inside Python for `MessagePort`-valued properties. The theme code adds no global.
- **Neutralize-first ordering.** Both bundles' final statements are the neutralizer then the
  bootstrap: `render.js` ends `…Tg();nT();})();` and `python.js` ends `…Dd();cg();})();`,
  where `Tg`/`Dd` are the WebRTC neutralizer
  (`function Tg(e=globalThis){for(let t of qb)Object.defineProperty(e,t,{configurable:!1,writable:!1,value:void 0…`)
  and `nT`/`cg` are `startRenderer` / `startPythonRuntime`.
- **CSP / sandbox attribute (constraint 3).** `csp.ts` is untouched; the fix uses the
  `style-src 'self' 'unsafe-inline'` the policy already carries. No `allow-same-origin`
  anywhere. `git status` shows no modification to `csp.ts`, `public/_headers`, or
  `python.html`.
- **Bundle drift (constraint 5)** — byte-exact, above.
- **Constraint 6** — no plan or task identifier appears in any shipped file, comment, or
  test name.

## Deviations

1. **A new file outside the listed ownership: `apps/sandbox/src/frame-theme.ts` (+ its
   test).** Criterion 3 makes both bootstraps apply the theme, and a copy of that logic in
   each is exactly the sync contract `CODE-RULES` bans — a drifted copy would be invisible
   until someone looked at a python frame. The narrowest scope covering both callers is the
   sandbox package, so the module lives there. No other task in this run owns anything in
   `apps/sandbox`.
2. **`theme` is optional, not required.** The app and the sandbox origin are separate
   deploys, so a required field means an embedder that predates it has *every* init rejected
   as malformed — the frame answers nothing and the panel reads the silence as "Working…"
   forever. Optional also keeps the field out of the non-owned senders
   (`python/browser-harness.ts` and the python browser tests build inits without it), which a
   required field would have forced me to edit outside my ownership. The cost is that an
   embedder which simply forgets the field gets browser-default colours silently; P2's own
   criterion is what closes that.
3. **`/* v8 ignore */` on `applyFrameTheme`.** The DOM plumbing runs only inside a real
   frame; a Node-environment test of it would assert against a DOM this code never meets —
   the same reasoning `vitest.config.ts` already records for the bootstraps and
   `embedder-channel.ts`. The alternative was adding the file to that config's coverage
   excludes, which is not in my ownership. The theme's actual logic is in `frameThemeCss`,
   which is fully covered, and the plumbing is exercised by the five browser tests against
   the shipped bundle.

## Concerns and limitations

- **The palette is a mirror.** `#faf9f6`/`#1a1a1a` and `#1a1816`/`#f2f1ef` track the app's
  Tailwind `--background`/`--foreground` tokens. The frame is cross-origin and cannot read
  them, and the plan fixed the wire field to a closed `'light' | 'dark'` set rather than
  colour values, so a literal is the only option; the app's own pre-paint background block
  mirrors the same tokens for the same reason. If those tokens change, the frame drifts and
  nothing fails — a seam between the panel and the frame would have to be noticed by eye.
- **Python's theme application is verified by reading and by a bundle grep, not by a browser
  test.** The python browser tests are not in my ownership, and the panel currently renders
  the python frame at `h-0`, so nothing there is visible today anyway. The call site is
  `Od(t.theme)` in the shipped `python.js`.
- **The no-theme path has no browser test.** It is pinned at unit level
  (`frameThemeCss(undefined) === ''`); adding a sixth browser test would have cost the
  package's test budget for a path only a version-skewed embedder takes.
- **`#document-root` gets `min-height`, not `height`,** so a document's own `height: 100%`
  child still resolves to zero. Documents wanting the full frame use `100vh`/`100dvh`, which
  works because the frame is the viewport. This follows criterion 2 literally and is what
  keeps a tall document scrollable.

## Confidence

**High.** Every criterion is pinned by a test that was watched failing for the right reason
(or, for the two guard tests that cannot fail against today's frame, by a deliberately-wrong
implementation that made them fail). The full sandbox suite — including the python runtime
and transport tests — is green against the regenerated bundles, both bundles are byte-exact,
and the transport constraints were verified by reading the shipped output rather than
trusting the suite.
