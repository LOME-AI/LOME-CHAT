# P2 — Panel sizing, python highlighting, and the grey (impl report 1)

## Objective

Four sub-changes in the document panel: reconnect the panel's height chain, send the frame
the app's appearance (on `init`, and on every later change via P1's `theme` message),
highlight python source through the shared highlighter, and drop the muted grey fills.

**Three of the four shipped. The sizing change did not: the defect it names does not
reproduce.** Detail under "Sizing — the diagnosis does not hold". The orchestrator has since
ruled the sizing fix **withdrawn** (the revert stands) and ruled the accessibility
contrast-tier gap **in scope**; that fix is under "The contrast-tier gap, closed".

## Files changed

| Path                                                  | Why                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/document-panel/highlighted-source.tsx`      | New. `HighlightedSource` + its fence builder, moved out of `document-panel.tsx` so both consumers import one implementation. |
| `apps/web/src/components/document-panel/highlighted-source.test.tsx` | New. Colocated tests for the extracted module.                                                                |
| `apps/web/src/components/document-panel/frame-appearance.ts`         | New. `useFrameAppearance` — the app's colour scheme plus the resolved `--background`/`--foreground`.           |
| `apps/web/src/components/document-panel/frame-appearance.test.tsx`   | New. Colocated tests, driven through the real `ThemeProvider`.                                                 |
| `apps/web/src/components/document-panel/document-panel.tsx`          | Imports `HighlightedSource` instead of defining it.                                                           |
| `apps/web/src/components/document-panel/document-sandbox.tsx`        | Appearance on both `init` sends; the `theme` restyle effect; python source through `HighlightedSource`; three fills removed. |
| `apps/web/src/components/document-panel/document-sandbox.test.tsx`   | Streamdown stub, theme harness, appearance tests, fill tests; the six exact-match `init` assertions now state the appearance. |
| `apps/web/src/components/document-panel/document-panel.test.tsx`     | No net change (the two sizing tests were added, then removed with the change they pinned).                     |

`document-panel.streaming-preview.test.tsx` and `document-render-status.tsx` are untouched.
Nothing outside `apps/web/src/components/document-panel/` was edited.

## Sizing — the diagnosis does not hold

The brief and plan state that `document-panel.tsx`'s unclassed wrapper `<div>` "sits at
`height: auto`, so every `h-full`/`flex-1` below it resolves against nothing", and that the
document therefore collapses. I could not reproduce that, and measurement says the opposite.

I built the real chain in Playwright — panel (`relative flex h-full flex-col`) → header →
scroller (`flex-1 overflow-auto`) → the wrapper under test → `RenderSandboxView`
(`relative flex h-full flex-col`) → iframe (`w-full border-0 min-h-0 flex-1`), with the
plain-CSS equivalents of those nine utilities — and measured the iframe with and without a
definite height on the wrapper, in all three engines:

```
chromium {"before.frameHeight":644,"before.scrolls":true,"after.frameHeight":644,"after.scrolls":true}
webkit   {"before.frameHeight":644,"before.scrolls":true,"after.frameHeight":644,"after.scrolls":true}
firefox  {"before.frameHeight":644,"before.scrolls":true,"after.frameHeight":644,"after.scrolls":true}
```

The document already fills (644 = the scroller's client height), and raw source already
scrolls, **with the wrapper exactly as it is committed**. Isolated to the bare mechanism:

```html
<div style="height:300px">
  <div style="height:auto">
    <div style="height:50px"></div>
    <div style="height:100%"></div>   <!-- the percentage under test -->
  </div>
</div>
```

```
chromium { par: 350, kid: 300 }
webkit   { par: 350, kid: 300 }
firefox  { par: 350, kid: 300 }
```

`height: 100%` resolves against the nearest ancestor with a definite height, walking past an
auto-height in-flow block; the auto parent then grows to hold it. Every engine agrees. The
"every ancestor needs `height: 100%`" folklore the plan's reasoning rests on is not how these
engines behave.

The ancestors above the panel are also sound: `chat-layout.tsx:377` puts the panel in
`<div className="flex flex-1 overflow-hidden">`, a row flex, where the panel stretches by
default — so its own `h-full` has a definite containing block.

So the change I was asked to make is inert. I wrote it (`className="h-full"` on the wrapper)
plus two tests, watched the class assertion go red, watched it go green — and then reverted
all of it, because the red was the absence of the class, never a measured collapse. Shipping
it would have added a class that changes nothing in any engine, under a comment
("an `auto` height here resolves them to nothing") that the measurements above show is false.

**What this does not rule out.** The panel-side collapse in the plan's evidence section is
the only claim there that carries no measurement; the collapse that *was* measured is
`body`/`#document-root` at height 0 *inside the frame*, which is P1's fix. If a document
still fails to fill after P1 lands, the cause is inside the frame or above the panel, and
this wrapper is not it. I could not check the running app by eye — the dev stack is down and
starting it mid-run risks the concurrent workstreams.

## Where the app's theme lives, and how the colours are read

- **Theme state:** `apps/web/src/providers/theme-provider.tsx` — `useTheme()` returns
  `{ mode: 'light' | 'dark' }`. It is the app's single source (it owns the `localStorage`
  key, the `dark` class, and the `data-theme` attribute); `mermaid-diagram.tsx` already
  consumes it the same way. No second source was introduced.
- **Colours:** `getComputedStyle(document.documentElement).getPropertyValue('--background' |
  '--foreground')`, trimmed. `packages/config/tailwind/index.css` stays the only place the
  palette is written; nothing is mirrored.
- **Timing:** seeded synchronously on mount, then re-run by one `sync()` that a single root
  `MutationObserver` calls. See "The view-transition ordering" for why the scheme is read
  from the root element alongside the colours rather than from `useTheme()` — the provider
  writes that class outside React, before any render, so React state is stale at the only
  moment that matters.
- **Guard:** each value goes through `DocumentColour.safeParse` (P1's schema, imported — not
  a second copy of the regex). A token that is not six-digit hex is omitted, never sent.
  This is load-bearing rather than tidy: the frame validates the whole message and drops one
  that fails, so an `oklch()` palette would otherwise take `init` down with it and no
  document would render at all.

## The appearance is carried, never re-driven

`useFrameAppearance`'s value is mirrored into `appearanceRef` and read at post time, so the
appearance stays out of `startAutoRun`'s identity — that identity is what the handshake
listener and the re-drive debounce are keyed on, and were it to change with the theme, a
toggle would re-register the transport and restart a debounce in flight. The restyle effect
sends `{ type: 'theme', ...appearance }` and is gated on `readyRef.current`, so nothing is
posted before the handshake (the `init` that follows carries the appearance instead).

## Proof a theme toggle restyles without restarting

At this layer the observable is the traffic and the frame's identity. `restyles a live frame
without re-driving the document` drives the **real** `ThemeProvider` (not a mock) through a
real click on a control calling `triggerTransition`, and asserts, after the toggle:

- `toFrame` was called **exactly once** since the handshake, and that one call is
  `{ type: 'theme', theme: 'dark', background: '#1a1816', foreground: '#f2f1ef' }` — so no
  second `init` was sent;
- `screen.getByTitle('Preview')` is the **same element object** as before the toggle — the
  frame was never torn down, so its realm and everything in it survived.

In-document state survival itself is P1's browser test (`restyles a live frame without
re-running the document`: runs stayed 1, the post-render marker survived), against the same
bundle. This task's half is that the panel sends `theme` rather than `init`.

**Cross-boundary check** — the exact message shapes the panel now emits, run through the
shared parser the frame's intake uses (`parseParentToFrameMessage`):

```
init      ACCEPTED   {type:'init', kind:'html',   code, requestId, theme:'light', background:'#faf9f6', foreground:'#1a1a1a'}
theme     ACCEPTED   {type:'theme', theme:'dark', background:'#1a1816', foreground:'#f2f1ef'}
unpainted ACCEPTED   {type:'init', kind:'python', code, requestId, theme:'light'}
```

## The contrast-tier gap, closed

Ruled in scope by the orchestrator after the first pass flagged it. The accessibility
contrast tiers override `--background`/`--foreground` without moving the theme, so a reader
on a high-contrast tier got a document canvas that no longer matched the panel around it.

**One path, and what specifically flows through it.** The trigger is not either control — it
is the write both controls end in. `apply-settings.ts:53` toggles the `a11y-contrast-*`
classes on `document.documentElement` and `:55-56` sets custom properties in its inline
`style`; `theme-provider.tsx:62` toggles the `dark` class on that same element. So a single
`MutationObserver` on the root element's `class`/`style` attributes calls a single `sync()`,
which calls the single `readAppearance()` — the same function, on the same element, for every
writer. There is no `if (themeChanged)` / `else if (contrastChanged)` anywhere: a tier change
and a theme change are indistinguishable to this code, which is the point. Anything else that
ever restyles the root is covered for free.

**Why I did not take the authorised `useA11yStore` export.** Subscribing to the store fires
one render too early. `A11yProvider` writes the class from a `useEffect` (`a11y-provider.tsx:29`),
and a store subscriber inside its subtree renders *before* that ancestor effect runs — so the
hook would read the computed style while the old class is still on the element and cache the
stale colours. The observer watches the element the colours are actually read from, so it
cannot race it. This is also strictly narrower than the ruling allowed: no new public API on
`@hushbox/ui`, and `packages/ui` is untouched by this task.

**One message per change, still.** The appearance is stored as state and compared by value
before it is written (`isSameAppearance`), so a root write that moves neither token — a focus
width, a font class — changes nothing. On a theme toggle the `mode`-keyed effect syncs first
and the observer's later callback finds the same values, so the frame still receives exactly
one `theme` message; `restyles a live frame without re-driving the document` asserts
`toHaveBeenCalledTimes(1)` and still passes. State is seeded synchronously in
`useState(() => readAppearance(mode))`, so a frame that hands its port over during the
mounting commit is still painted by the `init` that answers it.

### RED evidence

Two tests, both watched failing against the previous hook:

- `useFrameAppearance > follows a contrast tier that moves the tokens under an unchanged theme`
  — added the tier's class exactly as `applySettings` does, with
  `html.a11y-contrast-high { --background:#ffffff; --foreground:#000000 }` in the stubbed
  stylesheet:

  ```
  - Expected                    + Received
  -   "background": "#ffffff",  +   "background": "#faf9f6",
  -   "foreground": "#000000",  +   "foreground": "#1a1a1a",
  ```

- `frame appearance > restyles for a contrast tier the theme never moved` — the end-to-end
  half. Verified as a **mutation check**: with the previous memo-on-`mode` hook restored
  under the new test, the frame received nothing at all when the tier landed
  (`toHaveBeenCalledTimes(1)` failed on zero calls). Green with the observer, asserting the
  single message `{ type: 'theme', theme: 'light', background: '#ffffff', foreground:
  '#000000' }` and that `getByTitle('Preview')` is the same element object — restyled, not
  restarted.
- `useFrameAppearance > leaves the appearance alone when a root change moves neither token`
  is the guard on the value comparison. As first written it compared JSON text and could not
  have failed; it now also counts appearance identity changes and is mutation-checked. See
  "The dedupe pin, corrected".

## The view-transition ordering — confirmed, then fixed

Raised as a Minor in audit, labelled Inferred. **Confirmed by measurement, and it was worse
than a duplicate message: the transient one paired the wrong two values.**

### The ordering, measured in real Chromium

The claim has two halves; both were observed rather than reasoned, in headless Chromium 148
with a real `MutationObserver` and a real `MessageChannel` (the vehicle React's Scheduler
posts its async flush through):

```
click handler: enter
startViewTransition: has it? true
click handler: exit
  VT callback: enter
  VT callback: exit
  react schedules flush
MO-callback
react-render(MessageChannel task)
```

So (1) `startViewTransition` runs its callback **after** the click handler returns, which is
why `applyTheme`'s state update is no longer inside a discrete event and React flushes it on
a task instead of synchronously; and (2) the `MutationObserver` callback for the class
written in that callback runs **before** that task. The observer therefore ran while React
had not yet re-rendered at all.

### What the view-transition test does and does not discriminate

Worth stating precisely, because my first write-up implied more than is true: this test does
**not** fail against the committed HEAD hook, which never recomputes off the class and so
cannot produce a split pair at all. It fails against any implementation that reads the scheme
from React state, a ref, or context — the entire regression class the fix exists to prevent,
which is the axis that matters. The audit verified the ref variant directly: built and run,
it fails this test with "expected 1 times, but got 2 times". The observer itself is pinned
independently by three other tests that *do* fail against HEAD.

### Reproduced in the repo

`document-sandbox.test.tsx` now stubs `document.startViewTransition` with exactly the timing
measured above (callback on a later task), so the theme provider takes its **real** production
branch instead of the synchronous fallback happy-dom forces. Against the previous hook:

```
AssertionError: expected "postMessage" to be called 1 times, but got 2 times
```

and the two messages were:

```
[{"type":"theme","theme":"light","background":"#1a1816","foreground":"#f2f1ef"},
 {"type":"theme","theme":"dark", "background":"#1a1816","foreground":"#f2f1ef"}]
```

The first states `color-scheme: light` over the **dark** canvas — the frame is told to draw
its scrollbars and form controls light against a dark background for a frame. That is the
flicker this task exists to remove, so this was worth fixing.

### Why the suggested ref would not have worked

A ref written on render still holds the previous mode at observer time, because **no render
has happened yet** — that is the whole content of the measurement above. Any React-side
carrier of the mode (hook value, ref, or context) is stale at that instant; the problem is
not where the mode is read from but *when* it becomes readable.

### What changed instead — still one path, one trigger

`readAppearance()` now takes no argument and derives all three values from the root element
in a single pass, taking the colour scheme from the `dark` class. That class is not a second
source of truth: it is the app's own theme output — written by `index.html`'s pre-paint
block, by `theme-flash-script.ts:39`, and by `theme-provider.tsx:62` — and, decisively, it is
the selector the stylesheet resolves `--background`/`--foreground` through. Reading the
scheme and the colours off the same element in the same pass is what makes them incapable of
describing different moments.

`useTheme()` is consequently no longer imported by this hook, and the effect's dependency
array is empty: the MutationObserver is now the single trigger for every writer, which is a
stronger form of the shape the ruling asked to protect, not a trade against it. No second
effect, no debounce, no timing patch.

Holding the whole appearance as one lagging state value is what keeps a change to **one**
message: the frame is told the new appearance only once both halves have been read. Both
paths now behave identically —

- **View transition** (Chromium/Safari): observer fires → one appearance → one message.
- **Fallback** (no VT support): React's sync flush renders with the appearance unchanged, so
  nothing is sent; the observer's microtask then produces the one new appearance.

`restyles a live frame without re-driving the document` still asserts
`toHaveBeenCalledTimes(1)` and passes on the fallback path; the new
`pairs the theme with its own colours under a view transition` asserts the same on the real
one.

### The dedupe pin, corrected

The auditor was right that `leaves the appearance alone when a root change moves neither
token` compared JSON text and so could not fail if `isSameAppearance` were deleted. The probe
now also counts appearance **identity** changes — the exact thing the frame's restyle effect
is keyed on — and both that test and a new
`produces one appearance for a tier change, not one per value it moved` assert on it.
Mutation-checked: with `isSameAppearance` removed, **five** tests fail (the audit's count;
I under-reported it as four), where previously only the sandbox pair did.

## The `act` warnings — measured, root-caused, and cleared

Raised as a Minor. Confirmed and fixed. **The dominant cause was not what the fix was
prescribed for**, so the fix is in two parts.

### The instrument first

My first attempt to reproduce reported **zero** warnings in both files. That reading was
worthless: vitest here suppresses console output for **passing** tests. A positive control —
a component that deliberately dispatches an update from a microtask after mount — also
reported zero, which is what exposed the instrument rather than the code. With
`--disableConsoleIntercept` the control prints the warning, and the two files reproduce the
audit's numbers exactly:

```
frame-appearance.test.tsx : 12
document-sandbox.test.tsx : 47
document-panel.test.tsx   :  0
```

### Root cause: my own teardown, not the mount

Instrumenting `sync()` to print each accepted change showed the trigger. The `afterEach`
blocks I added strip the stubbed `<style>` and clear the root element's class — and they run
**before** Testing Library's auto-cleanup, so the hook's observer was watching a live
component while the page was pulled out from under it. One of the recorded transitions is
unmistakable:

```
TRIGGER {"from":{"theme":"light","background":"#faf9f6","foreground":"#1a1a1a"},
         "to":{"theme":"light"},"cls":"","style":null}
```

— the tokens vanishing, mid-teardown, into a still-mounted component. Calling `cleanup()`
first in both `afterEach` blocks took it from **12 → 4** and **47 → 2**.

### The remainder: the mount flush the ruling named

The six survivors were exactly the tests with no `await` in the body, where the observer's
delivery for what the theme provider wrote as it mounted landed after the test body. Fixed
where the ruling said to put it — in the render helpers, inside `act`, with production code
untouched and nothing silenced:

- `renderProbe` is now `async` and ends `await act(async () => {})`; its eight call sites
  await it.
- **Deviation:** `renderSandbox` has 60-plus call sites, and measurement showed every one of
  the survivors was on the `ThemeHarness` path. So the flush went into a new
  `renderThemedSandbox` helper wrapping it, used by the six appearance tests — a render
  helper that flushes inside `act` after mount, per the ruling, without churning 54 unrelated
  call sites. It also retires the repeated `{ wrapper: ThemeHarness }` argument.

### Verified, with the count of tests that ran

A zero warning count means nothing if the file did not compile — which caught me once here: a
missed `async` left `document-sandbox.test.tsx` failing to transform, and it duly reported
zero warnings while running **no tests**. Both numbers are therefore reported together:

| File                                    | tests run | `act` warnings |
| --------------------------------------- | --------- | -------------- |
| `frame-appearance.test.tsx`             | 8 passed  | 0              |
| `document-sandbox.test.tsx`             | 65 passed | 0              |
| `document-panel.test.tsx`               | 57 passed | 0              |
| `document-panel.streaming-preview.test.tsx` | 10 passed | 0          |
| `highlighted-source.test.tsx`           | 3 passed  | 0              |

## Tests added

| Test                                                                          | Behavior                                                        | Criterion |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| `HighlightedSource > hands the source to the highlighter under its language`   | The fenced block reaches Streamdown tagged with the language.    | 4, 5      |
| `HighlightedSource > opens a fence longer than the longest backtick run`       | Backticks in the source cannot close the fence.                  | 5         |
| `HighlightedSource > leaves the fence bare when the source states no language` | The `language === undefined` path (previously `v8 ignore`d).     | 5         |
| `python > highlights that source as python, the same way the raw toggle does`  | Python source renders through the shared highlighter.            | 4, 5      |
| `useFrameAppearance > states the colour scheme the app is showing`             | The scheme comes from the app, not from the OS.                  | 2         |
| `useFrameAppearance > resolves the app background and foreground tokens`       | Both tokens are read from computed style.                        | 2         |
| `useFrameAppearance > follows the app to the other theme, colours and all`     | A real toggle moves scheme and both colours.                     | 2, 3      |
| `useFrameAppearance > leaves out a token the wire cannot carry`                | A non-hex token is dropped; the rest of the message survives.    | 2         |
| `useFrameAppearance > leaves out a token the page does not define`             | An unresolvable token is omitted, not guessed.                   | 2         |
| `frame appearance > paints a new frame with the appearance the app is showing` | `init` carries the appearance.                                   | 2         |
| `frame appearance > paints a python frame too, before anything is run in it`   | The python `init` carries it as well.                            | 2         |
| `frame appearance > restyles a live frame without re-driving the document`     | One `theme` message, no `init`, same iframe element.             | 3         |
| `frame appearance > states the colour scheme even where the tokens do not resolve` | A partial appearance is still sent.                          | 2         |
| `useFrameAppearance > follows a contrast tier that moves the tokens under an unchanged theme` | A tier that moves the tokens moves the appearance. | 2, 3 |
| `useFrameAppearance > leaves the appearance alone when a root change moves neither token` | A root write that changes no colour changes nothing. | 3 |
| `useFrameAppearance > produces one appearance for a tier change, not one per value it moved` | One identity change per real change.              | 3         |
| `frame appearance > restyles for a contrast tier the theme never moved`       | One `theme` message reaches the frame; same iframe.              | 3         |
| `frame appearance > pairs the theme with its own colours under a view transition` | The real Chromium/Safari path sends one matched appearance.  | 3         |
| `frame appearance > sends no restyle to a frame that has not handed over its port` | Nothing is posted before the handshake.                     | 3         |
| `content sits on the panel background > gives the console strip no fill of its own` | The console strip carries no `bg-*`.                        | 6         |
| `content sits on the panel background > gives a text result no fill of its own` | The result block carries no `bg-*`.                             | 6         |
| `content sits on the panel background > does not wash the frame over while a document is loading` | The overlay carries no `bg-*`.                | 7         |
| `content sits on the panel background > keeps the tint the error card carries deliberately` | `bg-destructive/5` is still there.                  | 6         |

### RED evidence

- **Extraction (4, 5).** `highlighted-source.test.tsx` failed to resolve `./highlighted-source`
  (module absent), then passed once the module existed.
- **Python highlighting (4).** `TestingLibraryElementError: Unable to find an element by:
  [data-testid="highlighted-code"]` against the bare `<pre>`; green after the swap.
- **Appearance (2, 3).** Four of the five new sandbox tests failed against the pre-change
  component, each showing the appearance keys present in `Expected` and absent from
  `Received`. The fifth (`sends no restyle …`) is a guard and passed from the start; it
  covers the `!readyRef.current` branch, without which `postToFrame` throws.
- **`useFrameAppearance` (2).** The module-absent red, then a **mutation check**: with the
  hex guard replaced by a raw read and `mode` ignored, `follows the app to the other theme,
  colours and all` and `leaves out a token the wire cannot carry` both failed — so both
  load-bearing tests fail for their own reason, not merely on the module's absence.
- **The fills (6, 7).** Three of the four failed on `bg-muted/50` / `bg-background/85`; the
  error-card guard passed from the start, which is its job.
- **Sizing.** The only red available was the absence of the class I had just decided to add.
  See "Sizing — the diagnosis does not hold".

## Self-gate

| Command                                                        | Result                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/web` → scoped `vitest run src/components/document-panel/` | pass — 5 files, 143 tests; 0 `act` warnings under `--disableConsoleIntercept`                                              |
| `pnpm test:web` (full package, coverage gate)                   | **393 test files passed**; gate failed on one file that is not mine — below |
| `apps/web` → `npx tsgo --noEmit`                                | fails on one `apps/api` file from a concurrent workstream — below; zero errors in files I own |
| `apps/web` → `npx eslint src/components/document-panel/` (after the last edit) | pass — exit 0, no output                                 |
| Duplication over owned files                                    | pass — `buildFencedCodeBlock`/`maxRun` exist in exactly one file        |

### The one typecheck error is not mine

`apps/web`'s typecheck passed twice during this task and now reports one error:

```
../api/src/slices/notifications/adapters/email-sender-factory.ts(63,63): error TS6133: 'db' is declared but its value is never read.
```

`apps/web` typechecks `apps/api` because the RPC client's `AppType` is imported from it. That
file is modified in the working tree by the concurrent notifications workstream, is not
touched by this task, and `npx tsgo --noEmit | grep -c document-panel` is **0** — no error in
any file I own.

### The coverage failure is not mine

```
ERROR: Coverage for lines (73.48%) does not meet global threshold (95%) for src/components/chat/input/prompt-input.tsx
Error: [vitest-pool]: Failed to start forks worker for test files .../chat/input/prompt-input.test.tsx
Error: [vitest-pool]: Failed to start forks worker for test files .../document-panel/document-panel.streaming-preview.test.tsx
```

`prompt-input.tsx` is neither touched by nor imported from anything in this task. Its
shortfall is the second line's consequence: its own test file never started, so its coverage
was measured with no test exercising it. Re-running that file explicitly puts it at
`95.89 / 97.43 / 94.73 / 96.21` — i.e. the file is fine and the run hit a worker-start flake
under load. `document-panel.streaming-preview.test.tsx` was collateral of the same flake and
passes in every scoped run.

### Per-file coverage, every file touched

| File                     | lines | branches | functions | statements |
| ------------------------ | ----- | -------- | --------- | ---------- |
| `document-panel.tsx`     | 100   | 100      | 100       | 100        |
| `document-sandbox.tsx`   | 99.16 | 97.95    | 100       | 99.27      |
| `frame-appearance.ts`    | 100   | 100      | 100       | 100        |
| `highlighted-source.tsx` | 100   | 100      | 100       | 100        |

(`document-render-status.tsx`, in the same directory and untouched, is 100 across the board.)

### `TEST_IDS` — unchanged

`git diff HEAD -- packages/shared/` shows only `env.config.ts`, a concurrent workstream's
file. `packages/shared/src/test-ids.ts` is untouched by this task: no id was added, removed,
or renamed, and `documentPanelScroll` / `highlightedCode` keep their values. The two E2E
specs that drive this surface are unaffected. The new tests reach untestid'd elements through
`getByRole` and `container.querySelector`, precisely to avoid touching the registry.

### The transport is undisturbed

`document-sandbox.tsx`'s handshake block is byte-identical to its committed form:
first-ready-wins (`if (portRef.current) return`), the `event.source` gate, `port.start()`
after `addEventListener`, and the staleness drop in `handleFrameMessage` are all untouched.
The only additions are one `useEffect` that posts a `theme` message through the existing
`postToFrame`, and a spread of the appearance into the two existing `init` payloads. No new
listener, no new port, no new window post.

## Deviations

1. **The sizing change is not shipped.** Reasoned above. Acceptance criterion 1 (and its half
   of criterion 8's "verify both") is **not met**, deliberately, and needs an orchestrator
   ruling.
2. **Six existing exact-match `init` assertions gained the appearance.** `toHaveBeenCalledWith`
   is exact, so a message that now carries `theme` cannot pass an expectation that omits it.
   The assertions are strengthened, not weakened: each still pins the full payload, via a
   named `UNPAINTED` constant that says what a test with no stylesheet expects. The plan's
   criterion 8 asks for "assertions intact" — this is the minimum edit that keeps them exact.
3. **`document-sandbox.test.tsx` now stubs `streamdown`,** the same stub
   `document-panel.test.tsx` has always used and for the same reason (Shiki lazy-loads, so
   nothing it highlights is visible synchronously). Without it the pre-existing
   `shows the source alongside the Run control` would have broken on the python swap.
4. **`useFrameAppearance` and `HighlightedSource` are new files** not named in the plan's
   ownership list, which says "new `HighlightedSource` file". Both are inside my directory.
   The appearance hook is its own module because it is the only thing in the panel that
   touches app-wide theme state, and testing it through the real `ThemeProvider` in isolation
   is what made the hex guard and the theme-follow provable.
5. **The authorised `useA11yStore` export was not taken.** Reasoned under "The contrast-tier
   gap, closed": a store subscriber renders before `A11yProvider`'s effect writes the class,
   so it would read stale computed values. `packages/ui` is untouched.
6. **`useFrameAppearance` no longer imports `useTheme`.** The brief asked me to read the
   app's real theme state and not invent a second source. The colour scheme is now read from
   the `dark` class on the root element instead — which is that state's own output (three
   writers, all the app's own), and the selector the two colours resolve through. The
   measurement under "The view-transition ordering" is why: React state is not readable at
   the instant the colours change. The provider remains the single source; this reads its
   output rather than its state, because only its output is atomic with the colours.
7. **The `p-3` and `rounded-md` on the console strip and the result block were kept** even
   though `rounded-md` is inert without a fill. Only the fill token was asked for; removing
   more would be adjacent cleanup.

## Concerns and limitations

- **Sizing is unresolved, not done.** See above. If the orchestrator has a real reproduction
  of the collapse (a screenshot, a measurement in the running app), I will take it — the
  fix is one class and I have it ready.
- **The contrast-tier gap is closed** (see above). What remains is the observer's scope: it
  watches `class` and `style` on the root element only. A restyle delivered some other way —
  a stylesheet swapped at runtime, a token moved on a non-root element — would not be seen.
  Nothing in the app does either today.
- **The memo-discard concern from the first pass is gone.** The appearance is state compared
  by value, not a `useMemo`, so no redundant `theme` message can arise from React dropping a
  cache.
- **The overlay lost its wash entirely.** With the frame now painted the app's own
  background, `bg-background/85` over `bg-background` was a no-op colour anyway; without it,
  an error card over an already-painted document is translucent against that document. That
  is what "no slab" means, but it is a judgement the founder may want to see.
- **No end-to-end run against the real frame.** The dev stack is down, and I did not start it
  with two other workstreams live. The panel half is unit-proven, the frame half is P1's
  browser-proven, and the seam between them is checked by running the exact emitted messages
  through the shared parser the frame uses. What no one has yet done is look at it.

## Confidence

**High on the code, medium on the whole.** Every shipped change is pinned by a test watched
failing for its own reason — including two mutation checks, one on the colour guard and one
on the contrast-tier path — with every touched file at or above the coverage gate and both
lint and typecheck clean after the last edit. The sizing criterion is now formally withdrawn
rather than outstanding. The one reservation left is that nothing in this task has been seen
in the running app, which is the thing the founder will actually judge it by.
