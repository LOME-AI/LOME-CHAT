# Y4 — Close the hydration race — implementation report 1

## Objective

A click on the blog Listen control must never silently do nothing. Two changes: hydrate the
island at first paint instead of on intersection, and render the control disabled in the
server-rendered markup so the residual hydration window is visible rather than deceptive.

## Files changed

- `apps/marketing/src/pages/blog/[slug].astro` — `<BlogReadAloud client:visible />` →
  `client:load`; removes the intersection-observer wait from the front of the dead window.
- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — a `hydrated` state that
  starts `false` on the server and on the first client render and flips in a mount effect;
  `TransportButton` gains a `disabled` prop and the shared `disabled:` variant classes.
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — three tests for the
  pre-hydration state.
- `apps/marketing/src/page-tests/blog-post-hydration.test.ts` — new; pins the island's
  hydration directive, following the existing `welcome.astro.test.ts` pattern (no DOM harness
  renders `.astro` in this app, and a test file under `src/pages/` would be built as a route).

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `[slug].astro reader hydration › hydrates BlogReadAloud at first paint, not on scroll` | The island directive is `client:load` and is not `client:visible` | 1 |
| `BlogReadAloud — pre-hydration › marks the transport control disabled in the server-rendered markup` | `renderToStaticMarkup` output carries `disabled` on the Listen button | 2, 3 |
| `BlogReadAloud — pre-hydration › enables the transport control once the island has hydrated` | After mount effects run, the control is enabled | 2, 3 |
| `BlogReadAloud — pre-hydration › carries the disabled look as a paint-only variant of one class list` | The class list is identical server-side and post-hydration and contains `disabled:opacity-50` | 2 (no layout shift, existing disabled styling) |

### TDD record

- `marks the transport control disabled…` — watched RED for the right reason: the assertion
  failed against real SSR output showing
  `<button type="button" aria-label="Listen to this post" class="inline-flex … bg-muted text-foreground">`
  with no `disabled`.
- `hydrates BlogReadAloud at first paint…` — watched RED against `[slug].astro` source before
  the directive change.
- `carries the disabled look as a paint-only variant…` — watched RED (no
  `disabled:opacity-50` in the class list before implementation).
- `enables the transport control once the island has hydrated` — cannot fail before the
  disabled state exists (pre-change the control is never disabled), so it passed on arrival.
  Verified it is **not vacuous** by deleting the `setHydrated(true)` effect from the
  implementation and re-running: the test fails
  (`× enables the transport control once the island has hydrated`). Effect restored, suite
  re-run green.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo test --filter=@hushbox/ui --force` | pass — 1 task successful; `blog-read-aloud.test.tsx` 59 tests; coverage gate green (`components/blog-reader` 98.63 stmt / 97.77 branch / 100 func / 98.52 line) |
| `npx turbo test --filter=@hushbox/marketing --force` | pass — 1 task successful (includes the new page test) |
| `npx turbo typecheck --filter=@hushbox/ui --filter=@hushbox/marketing --force` | pass — 2 tasks successful; `astro check` 0 errors, 0 warnings, 2 pre-existing hints (`PillarCard.astro`, `TrustCard.astro`, untouched) |
| `npx eslint …` from `packages/ui` over both owned files, after last edit | exit 0 |
| `npx eslint …` from `apps/marketing` over both owned files, after last edit | exit 0 |

The `@hushbox/ui` test suite was re-run after the final (prettier) edit and stayed green.

## Acceptance criteria

**1. The Listen island switches from `client:visible` to `client:load` — MET.**
Source: `apps/marketing/src/pages/blog/[slug].astro:119`. In the rebuilt production artifact
the island attribute is `client="load"` (it was `client="visible"` in the pre-change build of
the same file).

**2. The control renders disabled in the SSR markup, is enabled on hydration, causes no
layout shift, uses the existing disabled styling, adds no UI — MET.**

Production SSR markup, `apps/marketing/dist/blog/<post>/index.html` after `pnpm build`:

```html
<button type="button" disabled="" aria-label="Listen to this post"
  class="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium disabled:pointer-events-none disabled:opacity-50 bg-muted text-foreground">
```

Pre-change, the same element in the same file was rendered without `disabled`.

_No layout shift._ Two independent lines of evidence:

- The class list is a single static string in both states — only the `disabled` attribute
  differs — which is asserted by the third new test (server class list `===` post-hydration
  `className`). A conditional class swap could change the box; this cannot.
- The two utilities compile to paint/hit-test properties only. From the built stylesheet:
  `.disabled\:opacity-50:disabled{opacity:.5}` and
  `.disabled\:pointer-events-none:disabled{pointer-events:none}`. Neither is a layout
  property, so the control's width, height, padding, and the band's height are unchanged.
  (A rendered pixel measurement was not taken: the package test environment has no layout
  engine, and the criterion's guarantee is stronger when it is structural.)

_Existing disabled styling, no new UI._ `disabled:pointer-events-none disabled:opacity-50` is
copied verbatim from the shared button primitive (`packages/ui/src/components/button.tsx:8`).
No new element, spinner, copy, or state was added.

**3. Verified by asserting the SSR HTML carries the disabled attribute and that the control
becomes enabled after hydration — MET.** The two tests above, plus the built-artifact
evidence.

**4. No new dependency, no inline script — MET.** No `package.json` change in either package.
`react-dom/server` (test-only import) is already a devDependency of `packages/ui` and already
used by `src/hooks/use-is-mobile.test.ts`. No `<script>` was added to the Astro page; the
only diff there is the directive keyword.

### TTS engine and worker are still lazy (brief's explicit evidence requirement)

The page's first-load JS is unchanged apart from the island chunk's own content hash. Diff of
every `/_astro/*.js` referenced by the built blog post HTML, before vs after:

```
6c6
< /_astro/blog-reader.DZhGuIBz.js
---
> /_astro/blog-reader.CeghNuzs.js
```

Nothing added, nothing removed; zero `modulepreload` links before and after.

- The island chunk's **static** import set is byte-identical before and after
  (`createLucideIcon`, `jsx-dev-runtime`, `react`, `src`, `tooltip`, `tts-download-bar`,
  `use-is-touch-device`, `use-reduced-motion`, `react-dom`). It does **not** statically import
  `document-reader` or `tts-engine`.
- The engine is still reached only through the click handler's dynamic import, unchanged in
  the artifact: ``Promise.all([b(()=>import(`./document-reader.BdSd8jYN.js`),…)``. The
  `tts-engine` string that appears in the island chunk is inside that dynamic import's
  `__vite__mapDeps` preload list, not an import edge.
- `tts.worker-CgwkGExB.js` (the chunk that carries kokoro-js / onnxruntime) is referenced by
  exactly one chunk, `tts-engine`, and only inside its worker factory
  (`function d(){return new Worker(new URL('/_astro/tts.worker-CgwkGExB.js',…),{type:…})}`).
  It is fetched when a `Worker` is constructed, i.e. from a click — never at load.

_Pre-existing fact recorded so the auditor does not misattribute it:_ `tts-engine` **is** in
the static-import closure of the blog page's eager chunks — but via
`panel.DN8Z9M9Z.js`, the accessibility widget's own `client:load` island in `BlogLayout.astro`,
not via the Listen island. That edge exists identically in the pre-change build and is
untouched by this task. The heavy megabytes live in `tts.worker`, which stays lazy either way.

## Deviations

None from the acceptance criteria.

One judgement recorded: the criteria say "the control", and the objective names the Listen
control, so only the transport button is disabled. The adjacent highlight toggle is left
alone — see Concerns.

## Concerns and limitations

- **The highlight toggle has the same dead window and was deliberately not touched.** It sits
  next to the Listen button, is equally inert pre-hydration, and a click on it is equally
  silent. Disabling it was out of the criteria's scope (which name the Listen control) and
  would be a second visual change the founder did not rule on. Raised for the orchestrator
  rather than resolved here.
- **The window is shortened, not eliminated.** `client:load` removes the intersection wait;
  the island's script fetch, parse, and hydrate still take real time. That is exactly why
  criterion 2 exists, and after this change the control is honest for the whole of it.
- **Accessibility side effect of the disabled state:** for the residual window the control is
  not focusable and is announced as unavailable. That is correct — it *is* unavailable — and
  it does not interact with the Escape handling, which is registered in an effect and so does
  not exist pre-hydration either. The aria labels are unchanged.
- `apps/marketing/dist` was rebuilt twice to gather the artifact evidence (gitignored build
  output, not a tracked change).

## Confidence

**High.** Both halves of the fix are pinned by tests, the SSR half is additionally confirmed
in the real production artifact, and the lazy-loading property that was the main risk here is
demonstrated at artifact level with a before/after diff rather than by inspection.
