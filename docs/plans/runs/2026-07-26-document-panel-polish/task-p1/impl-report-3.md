# P1 — Frame styling and theme (impl report 3)

One item: the specificity comment in `apps/sandbox/src/render/render.browser.test.ts`, which
report 2 corrected into a second wrong statement. Comment-only; no logic, no test behaviour,
no selector touched.

## Objective

Make the comment on the `:root` browser test state the fact A2 turns on: after A2 the frame
styles `html` (0,0,1), so a document's `:root` (0,1,0) **outranks** it outright — there is no
tie and source order is irrelevant. Order matters only for the `html` case. Sweep the file's
neighbouring comments for the same staleness.

## Files changed

| Path                                             | Why                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `apps/sandbox/src/render/render.browser.test.ts` | Two comments: the false `:root` claim, and the `html` case's missing why-it-wins. |

Nothing else. No source file, no bundle, no schema.

## Before / after

### 1. The wrong one — `keeps a document's own root-level colours over the frame's` (:846)

Before:

```ts
    // The frame's theme is the canvas a document sits on, not a house style
    // imposed on it. This is the easy half of that promise: `:root` ties the
    // frame's own selector on specificity and wins on order.
```

After:

```ts
    // The frame's theme is the canvas a document sits on, not a house style
    // imposed on it. This is the unconditional half of that promise: `:root` is
    // a class-level selector (0,1,0) and outranks the frame's type selector
    // (0,0,1), so a document's `:root` rule wins wherever it sits relative to
    // the frame's — source order never enters into it.
```

"ties … and wins on order" described the pre-A2 frame, which also used `:root`. Both halves
of the sentence were false after A2: no tie, and order plays no part. The replacement states
the two specificities and the consequence, and names the case as unconditional rather than
"easy" — the distinction that actually separates it from the sibling test is *order-free vs
order-dependent*, not difficulty.

### 2. The incomplete one — `keeps a document's own html-level colours over the frame's` (:873)

Before:

```ts
    // The hard half, and the reason the frame styles `html` rather than
    // `:root`: those select the same element, but `:root` is a class-level
    // selector and outranks a type selector no matter which comes later. A
    // frame rule written at `:root` would beat every `html { … }` a document
    // ships — silently, and only for documents that style the root that way.
```

After:

```ts
    // The order-dependent half, and the reason the frame styles `html` rather
    // than `:root`: those select the same element with equal specificity, so a
    // document's `html` rule wins only by being later — which it is, because
    // the frame's style element is appended at init, ahead of the document. A
    // frame rule written at `:root` would outrank every `html { … }` a document
    // ships no matter the order — silently, and only for documents that style
    // the root that way.
```

Nothing here was false, but it never said why the document wins *this* test — the tie plus
the injection order — which is exactly the half of the fact its sibling had stolen and
mangled. With both comments rewritten the pair now reads as one statement: `:root` outranks
unconditionally, `html` ties and wins on order.

The injection-order clause is verified in code, not assumed: `render/bootstrap.ts:450` calls
`applyFrameTheme(msg)` at the top of `handleInit`, before the document is inserted, and
`frame-theme.ts:69` appends the style element to `document.head`; a later restyle reuses that
same element (`frame-theme.ts:65-69`) rather than re-appending, so the ordering property
survives a `theme` message.

## Sibling agreement

The three places that state this fact now say the same thing:

- `frame-theme.ts:33-39` — "either ties it — and wins on order … — or outranks it outright"
- `frame-theme.test.ts:48` — same wording
- `render.browser.test.ts:847-850` / `:874-880` — the two halves, each naming which case it is

A file-wide sweep for the rest of the staleness class (`grep` for `specificity`, `:root`,
`outrank`, `order`, and every comment line mentioning theme/colour/canvas/scheme in the
edited file) found no further wrong statements: the comments at `:733-734` (the frame holds
no colours of its own), `:757` (a theme change must not cost a remount), `:796` (a second
`init` would discard document state) and `:858` (the colours give the document's rule
something to beat) all describe the post-A1/A2/A3 system.

## Self-gate

| Command                                                                           | Result                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/sandbox` → `npx eslint src/render/render.browser.test.ts` (after last edit)  | pass — exit 0, no output                    |
| `apps/sandbox` → `npx vitest run src/render/render.browser.test.ts`                | pass — 35 tests                             |
| `apps/sandbox` → `npx vitest run src/render/build-bundle.test.ts src/python/build-python-bundle.test.ts` | pass — 8 tests |

## Bundles untouched — confirmed, not assumed

The claim to check was that comments are stripped from the built bundles, so no rebuild is
needed. Stronger than that holds here: the edited file is a **test** file and is not an input
to either bundle at all. Both builders take a single entry point —
`src/render/build-bundle.ts:15` → `render/bootstrap.ts`, `src/python/build-python-bundle.ts:15`
→ `python/bootstrap.ts` — and no bundled module imports a `*.test.ts`.

Evidence, in order taken:

```
before edit-verification run   5d8679a0897eaef08570d7ae618098ae  public/render.js
                               bde903c2c1c28159fd8096bc6831e593  public/python.js
drift tests (rebuild+compare)  8 passed
after                          5d8679a0897eaef08570d7ae618098ae  public/render.js
                               bde903c2c1c28159fd8096bc6831e593  public/python.js
```

Byte-identical across a rebuild-and-compare pass. The drift pair in those two files is the
`keeps the committed public/*.js in sync with the source` / `write*Bundle rewrites the
committed bundle from source` tests — a rebuild from current source reproduces the committed
bytes exactly, so the working-tree bundles are still the correct output of the working-tree
source.

Belt and braces, the new comment text does not appear in either shipped bundle:
`grep -c 'unconditional half\|order-dependent half\|class-level selector'` → `0` in
`public/render.js` and `0` in `public/python.js`.

`git status` for `apps/sandbox/` lists exactly the files report 2 listed; this round added no
path to it.

## Acceptance criteria

Criterion 3's comment is the only thing in scope. **Met** — the file now states the
post-A2 specificity relation correctly for both cases, and agrees with `frame-theme.ts` and
`frame-theme.test.ts`. Every other criterion is unchanged from report 2; no code path,
schema, selector, or assertion moved.

## Deviations

One, and it is an addition rather than a departure: the brief named a single comment, and I
also rewrote the sibling `html`-case comment. It was not false, but it was silent on the
tie-and-order mechanism its neighbour had been claiming wrongly — leaving it would have kept
the fact only half-stated in the file the ruling is about. Still comment-only.

## Concerns and limitations

- **The specificity fact is stated, not pinned.** The two browser tests pin the *outcome* (a
  document's rule wins in both shapes); nothing pins *why*, and nothing would catch a future
  frame-side selector change that kept both tests green by accident. The auditor's probe —
  a document `html` rule placed before the frame's loses (`rgb(26, 24, 22)`), a document
  `:root` rule placed before it still wins (`rgb(0, 128, 0)`) — is the order-sensitivity
  evidence, and it lives in the audit rather than in a test. Pinning it would mean a test
  that injects an author rule ahead of the frame's, which is not something the real embedder
  can do.
- Report 2's concerns all still stand unchanged; nothing this round touched them.

## Confidence

**High.** The correction is a fact-check with three independent confirmations: the auditor's
Chromium measurement, the CSS specificity of the two selectors as shipped
(`frame-theme.ts:52` emits `html{…}`), and the agreement of the two sibling files that state
it correctly. The no-rebuild claim is proven by hashes across a rebuild-and-compare rather
than by the general rule about comment stripping — and the file in question is not a bundle
input to begin with.
