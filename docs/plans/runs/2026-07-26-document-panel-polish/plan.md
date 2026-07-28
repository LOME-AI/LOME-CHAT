# Document panel polish

**Tier 2.** Three tasks. Fixes how runnable documents look and adds showcase content worth showing.

## What is wrong, with evidence

**The frame has no CSS at all.** Measured inside a real opaque-origin frame against the running dev
sandbox: `html`/`body`/`#document-root` all report `background-color: rgba(0,0,0,0)`,
`color: rgb(0,0,0)`, `color-scheme: "normal"`, and `body`/`#document-root` have **height 0**. A grep of
`bootstrap.ts` for `style`/`height`/`width` returns zero matches, and `render.html` has no `<style>`
block. This single defect produces two of the reported symptoms:

- Documents render **light-mode with black text** on the browser's default canvas, ignoring the app
  theme — the "large grey rectangle from left to right".
- Documents **collapse to content height** inside the iframe, so they occupy only the top of the panel.

> **WITHDRAWN — the paragraph below is wrong.** P2 measured the real chain in Playwright: Chromium,
> WebKit and Firefox **all** fill the iframe (644px) and still scroll raw source with **no class on the
> wrapper at all**. Its isolated repro shows `height:100%` resolving against the nearest *definite*
> ancestor, walking past an auto-height in-flow block in all three engines — so the CSS 2.1 rule this
> paragraph assumed no longer holds. My own pre-planning probe recorded `innerHeight: 520` beside a
> zero-height `body`, which was already direct evidence the iframe was sized correctly and only its
> contents collapsed; I failed to read it. **P1's frame CSS is the entire fix for the founder's symptom.**
> P2 implemented the class, went red/green, then reverted it rather than ship an inert class under a false
> comment. Kept here because the reasoning error is worth seeing.

**The panel's sizing chain is broken independently.** `document-panel.tsx:371` is a `<div>` with no
className and no style, between the `flex-1 overflow-auto` scroll container and `DocumentContent`. It is
a plain block at `height: auto`, so every `h-full`/`flex-1` below it — `RenderSandboxView` at `:377`, the
iframe at `:588` — resolves a percentage height against an ancestor that has none. **Both breaks must be
fixed; either alone leaves documents collapsed.**

**Python source is a bare `<pre>`** (`document-sandbox.tsx:330`), while the raw-toggle path already
renders python through `Streamdown` + `@streamdown/code` with `language="python"` — and Shiki bundles
python. The highlighter works; the default view simply never calls it.

**CSP permits the fix:** `apps/sandbox/src/csp.ts:37` carries `style-src 'self' 'unsafe-inline'`, so an
inline `<style>` block in `render.html` and document style attributes are both allowed. Verified, not
assumed — `default-src 'none'` would otherwise have made the obvious fix silently do nothing.

## Global Constraints

1. **Nothing about the bridge transport changes.** The frame-minted `MessageChannel`, the one-shot `ready`
   carrying `port2`, first-ready-wins, and `port.start()` on every capture path all stay exactly as they
   are. Adding a field to a message is not a transport change; removing or reordering the handshake is.
2. **`port.start()` is mandatory wherever a port listener is registered with `addEventListener`**, and no
   unit test in this repo can see a missing one — both vitest environments supply Node's auto-starting
   `MessagePort`. Verify by reading, never by a green suite.
3. **The sandbox CSP, the `sandbox="allow-scripts"` attribute, and the credential-free origin do not
   weaken.** No new CSP source, no `allow-same-origin`, ever.
4. Both bundles are esbuild IIFEs; module state must stay unreachable from `window`/`globalThis`.
5. Bundle drift is byte-exact — any bootstrap edit requires regenerating that bundle.
6. No plan or task identifiers in shipped code, comments, or test names.
7. Re-run `eslint <owned files>` from the package directory after the LAST edit; exit 0 required.
8. **Do not run E2E or `pnpm mobile:test`** — the founder runs those.

## Tasks

### P1 — Frame styling and theme

**Objective.** Give the frame real CSS so documents fill it and match the app's theme.

**Design context.** The frame is cross-origin and cannot read the app's CSS variables, so the theme must
be told to it. A transparent frame background would inherit the panel's colour for free, but text colour
would still be wrong — `prefers-color-scheme` follows the OS, not the app's own toggle. Passing the theme
on the typed init message is therefore the approach: it is live (no frame remount, so a theme change
never kills a running document) and it cannot drift, because it rides the schema both sides already
share.

**Acceptance criteria.**

1. `InitMessage` in `packages/shared/src/documents/bridge.ts` gains a `theme` field constrained to a
   closed set (`'light' | 'dark'`). Schemas stay transport-agnostic — no window, origin, or port concept.
2. `render.html` carries a `<style>` block giving `html`/`body` full height and zero margin, and
   `#document-root` a `min-height` that fills the frame, so a document can occupy the whole panel.
3. Both bootstraps apply the theme on `init`: `color-scheme` set to match, plus background and text
   colour, so a document is legible in both themes and its canvas matches the panel rather than the
   browser default. A document that sets its own colours still wins.
4. Re-initialising with a different theme restyles the live frame without a remount.
5. A browser test asserts a rendered document's root **fills** the frame (height within a small tolerance
   of the viewport, not content height) — the assertion that would have caught the original collapse.
6. A browser test asserts the applied `color-scheme` and background differ between the two themes.
7. Both bundles regenerated; all four drift tests byte-exact.

**File ownership.** `packages/shared/src/documents/bridge.ts` (+ its test) · `apps/sandbox/public/render.html` ·
`apps/sandbox/src/render/bootstrap.ts` · `apps/sandbox/src/python/bootstrap.ts` ·
`apps/sandbox/src/render/render.browser.test.ts` · `apps/sandbox/public/render.js` · `public/python.js`.

**Interfaces.** *Produces* the `theme` field on `InitMessage` — P2 consumes it.

**Scoped checks.** `pnpm test:shared` · `pnpm --filter @hushbox/sandbox test` ·
`turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/sandbox`.

**Sensitive?** Yes — it edits the shared bridge schema and both frame bootstraps. 3-lens panel.

---

### P2 — Panel sizing, python highlighting, and the grey

**Objective.** Reconnect the panel's height chain, send the theme, highlight python source, and drop the
muted fills.

**Design context.** The four sub-changes all live in the same two files, so they are one task rather than
four racing for the same lines. `HighlightedSource` currently sits inside `document-panel.tsx`; both it
and the sandbox view need it, so it moves to its own file and both import it — one implementation, never
a second copy.

**Acceptance criteria.**

1. The unstyled wrapper at `document-panel.tsx:371` gets a definite height so the chain resolves, and a
   rendered document fills the panel's content area. The raw-code view still scrolls when taller than the
   panel.
2. The parent passes the app's current theme on every `init`, read from wherever the app's theme state
   actually lives (find it; do not invent a second source of truth).
3. A theme change restyles the live frame — no remount, no lost document.
4. Python source renders through the shared `HighlightedSource` with `language="python"`, the same path
   the raw toggle already uses.
5. `HighlightedSource` lives in one file, imported by both consumers.
6. The three `bg-muted/50` fills (console strip, results `<pre>`, python source) are removed; that content
   sits on the panel's own background. **The error card keeps its `bg-destructive/5`** — the founder
   explicitly excluded it.
7. The loading/error overlay no longer reads as a grey slab over the document.
8. All existing tests in `document-panel.test.tsx`, `document-sandbox.test.tsx` and
   `document-panel.streaming-preview.test.tsx` pass with assertions intact; per-file coverage holds.

**File ownership.** `apps/web/src/components/document-panel/document-panel.tsx` ·
`document-sandbox.tsx` · the new `HighlightedSource` file · the three colocated test files.

**Interfaces.** *Consumes* P1's `theme` field.

**Depends on** P1.

**Scoped checks.** `pnpm test:web` · `turbo typecheck lint --filter=@hushbox/web` · jscpd over owned files.

**Sensitive?** No — single auditor, but the auditor must confirm the transport was not disturbed.

---

### P3 — Showcase documents worth showing

**Objective.** Make the seeded showcase demonstrate real capability, and label the two intentional
failures as intentional.

**Design context.** Today's showcase is thin: an HTML counter, one React component importing one npm
package, one numpy/matplotlib plot, one Mermaid flowchart, two deliberately broken documents, and an
untagged log. **No `js`-kind document exists at all**, so one of the four runnable kinds is entirely
undemonstrated. The founder read the two intentional failures as real bugs, which is a signal they do not
announce themselves.

**Acceptance criteria.**

1. The two intentional failures are clearly labelled as deliberate — in their titles and their lead-in
   prose — so no reader mistakes them for breakage. Their **breakage itself is unchanged**: the existing
   tests pinning the unclosed `<div>` and the `config.palette.accent` read must still pass.
2. A `js`-kind document is added, exercising the `renderJs` path.
3. The HTML, React and Python documents are replaced with substantially more capable programs — real
   state, multiple interacting parts, visual polish. They should read as small applications, not snippets.
   The Python one should do genuine analysis (pandas alongside matplotlib).
4. Every document actually runs. Verify each by executing it the way the frame does — transpile through
   the repo's installed Sucrase for react/js, and confirm imports resolve — rather than assuming.
   A showcase document that fails is worse than no showcase document.
5. Every non-mermaid block clears `MIN_LINES_FOR_DOCUMENT`; the existing seed tests still pass.
6. Documents stay within the sandbox's real constraints: CSP `connect-src` is `'self'` plus the two PyPI
   hosts, so **no document may fetch from the network**; npm imports resolve through esm.sh at transpile
   time; WebRTC constructors are deleted.

**File ownership.** `scripts/lib/seed-documents.ts` · `scripts/lib/seed-documents.test.ts`.

**Scoped checks.** The seed tests plus `turbo typecheck lint` for the scripts package.

**Sensitive?** No — single auditor.

## Amendments

### A1 — collapse the palette mirror; the enum keeps only the job that is genuinely its own

Two lenses disagreed and the conventions lens resolved it. **Ruling: collapse, in the shape below.**

The security lens objected that passing colours replaces a closed enum with an attacker-shaped string
flowing into a CSS sink. That objection is real and is **answered by constraint, not dismissed**: a Zod
pattern of `^#[0-9a-fA-F]{6}$` excludes `;`, `{` and `}`, which makes breakout from the `:root{…}`
declaration list impossible. Every relevant token is plain 6-digit hex today, so the pattern is exact
rather than lossy. If the palette ever moves to `oklch()`, widen deliberately — but whatever it widens to
must still exclude those three characters.

The decisive fact is that **there is no detector today**. The browser test's `rgb(26, 24, 22)` literal
fails when `THEME_COLOURS` changes and never when the Tailwind token changes, so the drift this mirror
risks is silent in CI by construction. Applying the rule's own test — *if these two drift, does something
break?* — yes, visibly: the frame paints a canvas that no longer matches the panel it sits in, which is
the exact defect class this run exists to fix. There is no defence-in-depth reading available; the frame
is trying to **agree** with the app, and only agreement makes it correct.

And unlike the repo's three other mirrors of these tokens, this one is **not structurally forced**. The
pre-paint block in `apps/web/index.html` mirrors because the token does not exist yet; `use-cipher-wall`
mirrors only as a fallback after reading the token fails. The frame cannot read the token — but **its
parent can, and is already sending it a message.** The mirror exists only because I fixed the wire field
to an enum. That is a wire-shape choice, and choices are collapsible.

**The shape:**

1. **Keep `theme: 'light' | 'dark'`.** Its remaining job is `color-scheme`, a standard CSS keyword rather
   than an app token — so it mirrors nothing.
2. **Add resolved `background` / `foreground`**, read by the parent from the computed value of the
   `--background` / `--foreground` custom properties. `packages/config/tailwind/index.css` stays the single
   source of truth, and the public credential-free bundle stops shipping HushBox's palette at all.
3. **Constrain both to `^#[0-9a-fA-F]{6}$`** in the schema.
4. **Do not move to an inline style on the root.** It looks like it removes the injection concern but
   raises specificity above a document's own rule, breaking the override guarantee. Keep the
   `<style id>` + no-`!important` shape.
5. **Keep every new field optional**, for the same deploy-skew reason `theme` is optional.

Out of scope and explicitly not blocking: the other three mirror sites remain. The honest full collapse —
deriving the CSS custom properties and the TS literals from one token module — is a larger change.

### A2 — a document's own colours must actually win

The frame's rule uses `:root` (specificity 0,1,0), which outranks a document's `html { … }` (0,0,1)
regardless of order — measured, not reasoned. Criterion 3's guarantee is therefore false as shipped. Use
`html { … }` so the frame's styling loses on order to any document root-level rule.

### A3 — restyling must not re-execute a document

Theme rides on `init`, and `handleInit` unmounts the previous React root and re-renders — so a theme
toggle **restarts** an html/js/react document and discards its in-document state. Criterion 4 as written
is met (no frame remount) and the shape was the plan's own instruction, so this is not a P1 defect. It is
still wrong: restyling should never cost a running program. Add a dedicated parent→frame theme message
that applies colours without touching the document. Python is unaffected — its `init` branch only stashes
code and applies colours.

## Dependency graph

```
P1 ── P2
P3 (independent)
```

## Related E2E

`e2e/chat/runnable-documents.spec.ts` and `e2e/ui/document-panel.spec.ts` both drive this surface. Neither
is run by this workflow — the founder runs them. P2 must not change any `TEST_IDS` those specs depend on.
