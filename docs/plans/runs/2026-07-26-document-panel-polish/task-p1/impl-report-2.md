# P1 — Frame styling and theme (impl report 2)

Four fixes on top of impl-report-1, all from the orchestrator's rulings: the frame's
selector (A2), a comment that was wrong about which case is hard, the palette collapse
(A1), and a dedicated restyle message so a theme change does not re-run the document (A3).

## Objective

1. **A2** — frame styles `html { … }`, not `:root`, so a document's own root-level rule
   actually wins.
2. Correct the comment claiming a document's `:root` rule is the hardest case to win.
3. **A1** — delete the compiled-in palette; the embedder sends hex-constrained
   `background` / `foreground`, the frame paints them. `theme` keeps only `color-scheme`.
4. **A3** — a dedicated parent→frame `theme` message restyles a live frame without
   unmounting or re-executing the document.

## Files changed

| Path                                            | Why                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/documents/bridge.ts`        | `DocumentColour` (hex-constrained), `FrameAppearance` (the three fields, shared), `ThemeMessage`, union entry. |
| `packages/shared/src/documents/bridge.test.ts`   | Colour-constraint, init-colour, `ThemeMessage`, and union-discriminant tests; one narrowing fix.               |
| `apps/sandbox/src/frame-theme.ts`                | `html` selector; palette deleted; `frameThemeCss`/`applyFrameTheme` take a `FrameAppearance`.                  |
| `apps/sandbox/src/frame-theme.test.ts`           | Rewritten for the appearance-shaped input; selector assertion moved to `html{`.                               |
| `apps/sandbox/src/render/bootstrap.ts`           | `applyFrameTheme(msg)` on init; new port-only `theme` branch that touches nothing else.                       |
| `apps/sandbox/src/python/bootstrap.ts`           | Same `theme` branch, ahead of the `init` branch that still only stashes code.                                 |
| `apps/sandbox/src/render/render.browser.test.ts` | Two new browser tests, a `waitForBackground` probe, and colours added to the four theme-driving inits.        |
| `apps/sandbox/public/render.html`                | Comment corrected: the colours are the embedder's, not derived from a theme name.                             |
| `apps/sandbox/public/render.js`                  | Regenerated bundle.                                                                                          |
| `apps/sandbox/public/python.js`                  | Regenerated bundle.                                                                                          |

`csp.ts`, `embedder-channel.ts`, `python.html`, `public/_headers`, and the
`sandbox="allow-scripts"` attribute are untouched — `git status` for `apps/sandbox/` lists
none of them as modified by this work.

## The wire contract P2 will be written against

```ts
FrameAppearance = { theme?: 'light' | 'dark'; background?: DocumentColour; foreground?: DocumentColour }
DocumentColour  = z.string().regex(/^#[0-9a-fA-F]{6}$/)

InitMessage  = { type: 'init'; kind; code; requestId; ...FrameAppearance }   // paint on create
ThemeMessage = { type: 'theme'; ...FrameAppearance }                        // restyle in place
```

Every appearance field is optional, on both messages. The three fields exist once
(`FrameAppearance.shape`, spread into both) rather than being typed twice.

**How P2 should use it:** send the appearance on `init` so a newly created frame is painted
before anything is shown in it; send `theme` for every later change. A second `init` still
restyles (criterion 4 holds) but restarts the document, so it is the wrong tool for a theme
toggle.

## Tests added

| Test                                                                | Behavior                                                                | Fix |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | --- |
| `DocumentColour > accepts a six-digit hex colour in either case`      | The tokens' exact shape parses.                                          | 3   |
| `DocumentColour > rejects anything that is not six hex digits`        | `#fff`, `red`, `var(--background)`, `rgb(0,0,0)`, `#faf9f` refused.       | 3   |
| `DocumentColour > rejects a value carrying CSS declaration or block syntax` | `;`, `{`, `}` cannot ride in — the breakout the security lens named. | 3   |
| `init > carries the colours the embedder resolved`                    | Both colours survive a parse round-trip.                                  | 3   |
| `init > rejects init with a colour that is not six-digit hex`         | A bad colour fails the whole init.                                       | 3   |
| `theme > round-trips an appearance with no document attached to it`   | The restyle message needs neither `requestId` nor `code`.                | 4   |
| `theme > accepts a theme message stating only the colour scheme`      | Partial appearances are legal.                                           | 4   |
| `theme > rejects a theme message with a colour that is not six-digit hex` | The constraint binds on both messages.                                | 3,4 |
| `union > discriminates init, run, stop, and theme`                    | `theme` reaches the frame's intake at all.                               | 4   |
| `frame theme > paints the colours the embedder resolved`              | The declarations carry the given values, not built-in ones.              | 3   |
| `frame theme > states only the parts of the appearance the embedder stated` | An unstated part is omitted, not guessed.                           | 3   |
| `frame theme > states nothing when the embedder stated no appearance` | Empty appearance ⇒ empty stylesheet.                                     | 3   |
| `keeps a document's own html-level colours over the frame's`          | A document's `html { … }` beats the frame's rule.                        | 1   |
| `restyles a live frame without re-running the document`               | Colours change; run count stays 1 and post-render state survives.        | 4   |

Two existing tests were adjusted rather than added to: `frame theme > sets the colour scheme
to the theme it is given` (appearance-shaped argument) and `frame theme > states its colours
as a defeasible default` (selector assertion moved with the implementation, as instructed).
The old `paints a different canvas and text colour in each theme` is replaced by `paints the
colours the embedder resolved` — with no palette, "different in each theme" is the
embedder's property, not the frame's.

### RED evidence

**FIX 1 — a document's `html { … }` losing to the old `:root` frame rule.** The new browser
test was run against the committed `:root` bundle before any change:

```
FAIL  keeps a document's own html-level colours over the frame's
AssertionError: expected 'rgb(26, 24, 22)' to be 'rgb(0, 128, 0)'
```

`rgb(26, 24, 22)` is the frame's dark canvas: the document's own
`html { background-color: rgb(0,128,0) }`, which arrives later in the document, lost to the
frame's `:root` rule on specificity. After the selector change and a rebuild, the same test
passes with `rgb(0, 128, 0)`, and the pre-existing `:root` case still passes alongside it —
both halves of the promise now hold.

The unit assertion was watched failing for the same change:
`expect(css.startsWith('html{')).toBe(true)` → `- true / + false`.

**FIX 3.** The nine new/changed schema tests were RED against the old bridge (unknown keys
stripped by `z.object`, missing exports, `No matching discriminator` for `'theme'`), and the
five `frame-theme` tests were RED with
`TypeError: Cannot destructure property 'background' of 'THEME_COLOURS[theme]' as it is
undefined` — the palette lookup the change deletes.

**FIX 4.** The new browser test was RED against the pre-change bundle:
`Error: frame background stayed rgb(250, 249, 246)` — the frame validated the `theme`
message (it was already in the union at that point) and then ignored it, because no intake
branch handled it.

### Proof a restyle does not re-run the document

The html document under test increments `globalThis.__runs` and writes it into the DOM. The
frame realm survives an `init`, so a re-execution shows up as a second increment; the test
also writes a marker into the rendered element *after* the render, which nothing recreates.
After the `theme` message lands (`colorScheme: 'dark'`, background `rgb(26, 24, 22)`, colour
`rgb(242, 241, 239)`), the probe reads:

```
runs: 1     marker: 'kept'     text: 'run 1'
```

A restyle routed through `init` would give `runs: 2`, `marker: undefined`, `text: 'run 2'`.

### Proof the public bundles ship none of HushBox's palette

Grepped over the committed, rebuilt bundles:

- Each of the ten `--background*` / `--foreground*` token values in
  `packages/config/tailwind/index.css` (`faf9f6`, `1a1a1a`, `1a1816`, `f2f1ef`, `faf5ed`,
  `eae8e3`, `525252`, `252320`, `2d2b28`, `9a9894`): **0 occurrences** in `public/render.js`
  and **0** in `public/python.js`.
- Stronger, and drift-proof: `grep -oE '#[0-9a-fA-F]{6}\b'` finds **0** six-digit hex colour
  literals of any kind in either bundle.
- What the bundles do carry is the builder: `` `html{${t.join(";")}}` `` (render) and
  `` `html{${r.join(";")}}` `` (python) — a joiner over whatever arrived, with no table
  behind it.

No new test pins this, deliberately: with the palette gone there is nothing left to drift.
The property is structural — `frameThemeCss` has no colour to emit that it was not given,
which `states only the parts of the appearance the embedder stated` pins directly.

## Self-gate

| Command                                                                    | Result                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm test:shared`                                                          | pass — 3017 tests                                                  |
| `pnpm --filter @hushbox/sandbox test`                                       | pass — 18 files, 174 tests; coverage 100% (per-file gate)          |
| `apps/sandbox` → `npx tsgo --noEmit`                                        | pass                                                              |
| `apps/sandbox` → `npx eslint .` (after the last edit)                       | pass — exit 0, no output                                          |
| `packages/shared` → `npx eslint src/documents/` (after the last edit)       | pass — exit 0, no output                                          |
| `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/sandbox`   | **fails on `@hushbox/shared#typecheck`** — not this work, below   |

### The two failures that are not mine

```
src/affordability/turn-arithmetic.test.ts(351,19): error TS1355: A 'const' assertion can only be applied to …
src/affordability/turn-core.outlier.test.ts(67,3): error TS2322: Type '(bigint & $brand<"NanoUSD">) | undefined' is not assignable to type 'string | undefined'
```

`packages/shared`'s lint fails on 16 errors in the same tree
(`src/affordability/**`: `smart-model-affordability.ts`, `smart-model-order.test.ts`,
`percentile.ts`, `premium.ts`/`.test.ts`, `turn-arithmetic.test.ts`,
`turn-core.resolved-corner.test.ts`).

Attribution: every one is under `src/affordability/`, which this task never touches;
`turn-core.outlier.test.ts`, `turn-core.resolved-corner.test.ts` and `percentile.ts` are
**untracked** (`??` in `git status`) — files that did not exist at my snapshot and that I did
not create. `npx eslint src/documents/` (my only files in that package) is exit 0, and
`apps/sandbox` is clean on both gates. This is the estimator/affordability workstream
running concurrently.

One typecheck error *was* mine and is fixed: widening `ParentToFrameMessage` with a message
that carries no `requestId` broke an unnarrowed `result.data.requestId` in
`bridge.test.ts`; the test now narrows on the discriminant first.

### Bundle drift — byte-exact

`build-bundle.test.ts` and `build-python-bundle.test.ts` pass — 8 tests, of which the four
byte-exactness ones are the `keeps the committed public/*.js in sync with the source` and
`write*Bundle rewrites the committed bundle from source` pair in each file. Independent
rebuild-and-hash:

```
render fresh 762c98280ef326b4 committed 762c98280ef326b4 identical true bytes 541057
python fresh a0b22bdbda6c472c committed a0b22bdbda6c472c identical true bytes 333070
```

## Global constraints — re-verified from the rebuilt bundles

- **Handshake untouched (constraint 1).** Both bundles still read
  `new MessageChannel; …port1.addEventListener("message", …), …port1.start(); … parent.postMessage({type:"ready"}, "*", [port2])`
  — listener, then `start()`, then the one-shot transfer, in that order. First-ready-wins
  lives on the embedder side, which this task does not touch.
- **Exactly one wildcard postMessage per bundle** (`grep -o 'postMessage([^)]*"\*"' | wc -l`
  → 1 and 1): the `ready` broadcast.
- **Intake stays port-only.** `addEventListener("message"` appears twice in `render.js`
  (handshake port + the pre-existing `settleTick` scheduler hop, both `MessageChannel` ports,
  each followed by `.start()`) and once in `python.js` (handshake port). The only
  `globalThis.addEventListener` calls anywhere are `render.js`'s pre-existing
  `error`/`unhandledrejection` handlers; `python.js` has none. The new `theme` branch is a
  case inside the existing port callback — a schema change, not a transport change.
- **Port unreachable from `globalThis` (constraint 4).** Still asserted by the passing
  `keeps its end of the channel off the frame global` and the python suite's `js.globalThis`
  scan. Nothing new is published.
- **Neutralize-first ordering.** `render.js` ends `…Eg();iT();})();` and `python.js` ends
  `…Td();sg();})();` — WebRTC neutralizer, then bootstrap.
- **CSP / sandbox attribute (constraint 3).** `csp.ts` unmodified; the fix still rides the
  `style-src 'self' 'unsafe-inline'` already in the policy. `allow-same-origin` appears
  nowhere in either bundle.
- **Constraint 6** — no plan or task identifier in any shipped file, comment, or test name.

## Acceptance criteria (as amended)

1. **`InitMessage` carries a closed-set colour scheme** — met, and now also the two
   hex-constrained colours; the schemas still name no window, origin, or port.
2. **`render.html` layout block** — met, unchanged from report 1.
3. **Both bootstraps apply the appearance; a document's own colours still win** — met, and
   now actually true: `html` loses on order to any root-level author rule, pinned by browser
   tests for both `:root` and `html` document rules.
4. **Re-initialising with a different theme restyles live, no remount** — met, unchanged.
   **A3 adds the fix that matters:** the `theme` message restyles without re-running.
5. **Fill assertion** — met, unchanged.
6. **Colour scheme and background differ between themes** — met; the difference is now the
   embedder's to state, asserted at both unit and browser level.
7. **Both bundles regenerated; drift byte-exact** — met, above.

## Deviations

1. **`frame-theme.ts` / `frame-theme.test.ts` remain outside the plan's file-ownership
   list**, as in report 1 and for the same reason (two bootstraps, one implementation). No
   other task in this run owns anything in `apps/sandbox`.
2. **`FrameAppearance` is exported from the bridge**, beyond the fields A1 asked for. The
   three fields are needed by two message schemas and by the frame's own function signature;
   spreading one `.shape` is what keeps them from being typed three times.
3. **`ThemeMessage` carries no `requestId`.** A restyle is not a run: it names nothing to
   answer about, and the frame sends nothing back. The browser test therefore watches the
   frame's computed appearance instead of waiting on a terminal message.
4. **No new bundle-content test for the absent palette.** Reasoning under "Proof the public
   bundles ship none of HushBox's palette" — the property is structural now, and a negative
   assertion listing today's token values would itself be the mirror A1 removed.
5. **`/* v8 ignore */` on `applyFrameTheme`** — unchanged from report 1, same reasoning.

## Concerns and limitations

- **Python's `theme` branch is verified by reading and by a bundle grep, not by a browser
  test.** `python-core.browser.test.ts` is not in my ownership. The shipped branch is
  `t.type==="theme"){zu(t);return}` ahead of the `init` branch, with `zu` the shared
  `applyFrameTheme`. `init` still only stashes code, so A3's "keep it that way" holds.
- **The frame no longer paints anything an embedder does not send.** An embedder that sends
  `theme` but no colours gets `color-scheme` only and the browser's default canvas — the
  visible seam A1 accepted in exchange for deleting the mirror. P2's criterion is what closes
  it; until P2 lands, the panel sends no appearance at all and the frame is unpainted, which
  is the pre-P1 appearance rather than a regression.
- **`DocumentColour` is exactly six hex digits.** Every `--background*`/`--foreground*` token
  in `packages/config/tailwind/index.css` is that shape today (verified by reading it), so
  nothing is lost. A move to `oklch()` is a deliberate widening that must still exclude
  `;`, `{`, `}`.
- **Restyle delivery is unacknowledged.** The frame answers a `theme` message with nothing,
  so an embedder cannot know it landed. That is correct for a fire-and-forget restyle, and it
  is why the browser test polls; a future need for confirmation would be a new frame→parent
  message, not a `requestId` on this one.
- **`#document-root` still gets `min-height`, not `height`** — unchanged from report 1.

## Confidence

**High.** Both amendments and both corrections are pinned by tests watched failing for the
right reason against the real shipped bundle in a real browser, including the two that
motivated the rulings: the `html { … }` override (which failed with the frame's dark canvas
winning) and the restyle-without-re-execution (which failed on a frame that ignored the new
message). The full sandbox suite is green at 100% per-file coverage, both bundles are
byte-exact, and the transport constraints were re-read out of the rebuilt bundles rather than
inferred from a green suite. The only failing gate is `@hushbox/shared`'s typecheck and lint,
entirely in a concurrent workstream's files, with my own files in that package clean.
