# Y4 — Close the hydration race — implementation report 2 (fix cycle 1)

## Objective

Two things. Replace the vacuous criterion-3 assertion with one that cannot pass without the
`disabled` attribute, and prove that by mutation. Then extend the same disabled-until-hydrated
treatment, with the same non-vacuous pin, to the highlight toggle beside the Listen control.

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — `HighlightToggle` gains a
  `disabled` prop and the same two `disabled:` variant classes the transport control carries;
  both controls are now wired from `!hydrated`.
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — a `serverControl()`
  helper that parses the server-rendered markup into real elements, plus a rewritten
  pre-hydration block: six tests, three per control.

No other file was touched this cycle. `apps/marketing/src/pages/blog/[slug].astro` and
`apps/marketing/src/page-tests/blog-post-hydration.test.ts` carry only their cycle-1 changes.

## Finding 1 — the vacuous assertion

### Old assertion

```ts
const markup = renderToStaticMarkup(<BlogReadAloud />);
expect(markup).toMatch(/<button[^>]*aria-label="Listen to this post"[^>]*disabled/);
```

Confirmed vacuous first-hand before touching it. With the component mutated to
`React.useState(true)` at `blog-read-aloud.tsx:340` — which removes the attribute from the SSR
markup entirely — all three cycle-1 pre-hydration tests stayed green:

```
Tests  3 passed | 56 skipped (59)
```

The trailing `disabled` matches inside `class="… disabled:pointer-events-none
disabled:opacity-50 …"`, which the same edit introduced.

### New assertion

```ts
function serverControl(name: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<BlogReadAloud />);
  const el = host.querySelector<HTMLElement>(`button[aria-label="${name}"]`);
  if (el === null) throw new Error(`missing server-rendered control: ${name}`);
  return el;
}

expect(serverControl('Listen to this post')).toBeDisabled();
```

Parsed node, jest-dom `toBeDisabled()` — the class list is not markup the matcher can see.
The helper carries a comment recording *why* it parses rather than string-matches, so the trap
is documented where the next person would fall into it.

## Tests added / changed

| Test | Behavior | Criterion |
| --- | --- | --- |
| `marks the transport control disabled in the server-rendered markup` | rewritten: the SSR Listen button carries the `disabled` **attribute** | 2, 3 |
| `marks the highlight toggle disabled in the server-rendered markup` | new: the SSR toggle carries the `disabled` attribute | 2, 3 (finding 2) |
| `enables the transport control once the island has hydrated` | unchanged | 2, 3 |
| `enables the highlight toggle once the island has hydrated` | new | 2, 3 (finding 2) |
| `carries the transport control disabled look as a paint-only variant of one class list` | rewritten to use the parsed node; class list identical server vs client and carries `disabled:opacity-50` | 2 (no layout shift) |
| `carries the highlight toggle disabled look as a paint-only variant of one class list` | new; same property for the toggle | 2 (no layout shift) |

## Mutation runs — the non-vacuity proof

Two mutations, each run against the finished tests. Every SSR-disabled pin dies under the
first; every enable-after-hydration pin dies under the second.

**Mutation A — `React.useState(false)` → `React.useState(true)`** (the auditor's mutation: the
control is never disabled, so the attribute never reaches the SSR markup).

```
× marks the transport control disabled in the server-rendered markup
× marks the highlight toggle disabled in the server-rendered markup
Tests  2 failed | 4 passed | 56 skipped (62)
```

Both pins FAIL. Sample failure for the transport control, from the run made while the mutation
was in place and before the toggle was implemented:

```
FAIL  BlogReadAloud — pre-hydration > marks the transport control disabled in the server-rendered markup
```

**Mutation B — the mount effect neutered** (`setHydrated(true)` guarded behind `if (hydrated)`,
so the flip never happens).

```
× enables the transport control once the island has hydrated
× enables the highlight toggle once the island has hydrated
Tests  2 failed | 4 passed | 56 skipped (62)
```

Both pins FAIL. The component was restored to its shipped form after each mutation and the
file re-run green (62 passed) before moving on.

### RED for finding 2

With mutation A reverted and the toggle not yet implemented, exactly the two new toggle tests
failed, for the right reason:

```
× marks the highlight toggle disabled in the server-rendered markup
× carries the highlight toggle disabled look as a paint-only variant of one class list
  AssertionError: expected 'inline-flex size-9 items-center justi…' to contain 'disabled:opacity-50'
  Received: "inline-flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary"
```

`enables the highlight toggle once the island has hydrated` could not fail before the disabled
state existed (the toggle was never disabled), which is why mutation B exists to pin it.

## Built-artifact evidence

Rebuilt `apps/marketing` with the fix. Both controls carry the attribute in the production SSR
markup, on every post checked:

```html
<button type="button" disabled="" aria-label="Listen to this post"
  class="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium
         disabled:pointer-events-none disabled:opacity-50 bg-muted text-foreground">

<button type="button" aria-pressed="true" aria-label="Highlight while reading" disabled=""
  class="inline-flex size-9 items-center justify-center rounded-md
         disabled:pointer-events-none disabled:opacity-50 bg-primary/10 text-primary"
  data-state="closed" data-slot="tooltip-trigger">
```

A controlled A/B confirms the attribute is exactly what the change adds: rebuilding with only
`disabled={!hydrated}` → `disabled={false}` on the toggle emits the identical tag **without**
`disabled=""`, everything else byte-for-byte the same.

_Worth recording:_ on the toggle React emits `disabled=""` **after** `aria-label`, because
Radix's `asChild` re-orders the cloned props. So the cycle-1 regex shape would have
accidentally worked on this control and not on the other — which is the whole argument for
using one parsed-node assertion for both rather than reasoning about attribute order.

The "becomes enabled after hydration" half cannot be shown in a static artifact (the built HTML
is the pre-hydration state by definition); it is carried by the two mutation-B-checked tests.

## No layout shift

Three independent lines:

- **One class list.** Asserted per control: the server-rendered `className` is `===` the
  post-hydration `className`. Only the attribute differs, so no conditional class swap can
  change either box.
- **The two utilities are paint-only.** From the built stylesheet:
  `disabled\:opacity-50:disabled{opacity:.5}` and
  `disabled\:pointer-events-none:disabled{pointer-events:none}`. Neither is a layout property,
  so widths, heights, padding, and the byline/tags band's height are untouched.
- **The artifact is byte-identical in size.** Across all 51 emitted `dist/_astro` files, the
  build with the toggle fix and the build without it differ in **zero** byte sizes, and both
  emit the same 51 entries. Nothing grew, nothing was added.

## Worker chunk is still click-lazy

- The blog post page references 9 eager `/_astro/*.js` chunks and **zero** `modulepreload`
  links — same count as the pre-change build.
- The island chunk's static import set is `createLucideIcon, jsx-dev-runtime, react, src,
  tooltip, tts-download-bar, use-is-touch-device, use-reduced-motion`. It does not statically
  import `document-reader` or `tts-engine`; both appear only inside the click handler's dynamic
  import and its `__vite__mapDeps` preload table:
  `…await Promise.all([b(()=>import(`./document-reader.BdSd8jYN.js`…`.
- `tts.worker-CgwkGExB.js` (the chunk carrying kokoro-js / onnxruntime) is referenced by
  exactly one chunk, `tts-engine`, at exactly one site — a worker factory:
  ``function d(){return new Worker(new URL(`/_astro/tts.worker-CgwkGExB.js`,``+import.meta.url),{type:`module`})}``
  It is fetched when a `Worker` is constructed, i.e. from a click, never at load.

_Pre-existing, unchanged, recorded so it is not misattributed:_ `tts-engine` is in the static
closure of the page's eager chunks via `panel.*.js`, the accessibility widget's own
`client:load` island in `BlogLayout.astro` — not via the Listen island. The heavy megabytes
live in `tts.worker`, which stays lazy either way.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo test --filter=@hushbox/ui --force` | pass — 1 task successful; `blog-read-aloud.test.tsx` 62 tests; coverage gate green (`components/blog-reader` 98.63 stmt / 97.77 branch / 100 func / 98.52 line, unchanged from cycle 1) |
| `npx turbo test --filter=@hushbox/marketing --force` | pass — 1 task successful |
| `npx turbo typecheck --filter=@hushbox/ui --filter=@hushbox/marketing --force` | pass — 2 tasks successful; `astro check` 0 errors, 0 warnings, 2 pre-existing hints (`PillarCard.astro`, `TrustCard.astro`, untouched) |
| `npx eslint <both owned files>` from `packages/ui`, after the last edit | exit 0 |
| `npx eslint <both owned files>` from `apps/marketing`, after the last edit | exit 0 |

**The brief's expected `@hushbox/marketing` failure did not occur.** The brief said the suite
fails 5 files / 7 tests on `api-url.ts:9` throwing `VITE_API_URL is required`. Through
`turbo test` the package's own `test` script routes via `scripts/with-env.ts`, which supplies
the variable, and the suite is fully green — `api-url.ts` reports 100% coverage. The failure
presumably reproduces only when vitest is invoked without that wrapper. Nothing was done about
it either way.

## Acceptance criteria

**1. The Listen island switches from `client:visible` to `client:load` — MET (cycle 1,
unchanged).** `apps/marketing/src/pages/blog/[slug].astro:119`; the rebuilt artifact carries
`client="load"`.

**2. The control renders disabled in the SSR markup, is enabled on hydration, no layout shift,
existing disabled styling, no new UI — MET, and now for both controls.** Artifact evidence
above for the SSR half; the hydration half is pinned by two mutation-B-checked tests; three
lines of no-layout-shift evidence including a zero-delta artifact comparison. The toggle reuses
the exact two utility classes already on the transport control — no new element, spinner, copy,
or state.

**3. Verified by asserting the SSR HTML carries the disabled attribute and the control becomes
enabled after hydration — MET, and now non-vacuously.** Both SSR pins die under mutation A;
both hydration pins die under mutation B. The cycle-1 assertion's failure mode is gone: the
matcher operates on a parsed element, not on markup text.

**4. No new dependency, no inline script — MET.** No `package.json` change. No `<script>` added
to the Astro page. Nothing new imported in either file.

## Deviations

None. The scope is exactly the two findings; the explicitly-excluded controls (`ThemeToggle`,
`ShareButton`, `NewsletterSignup`, the `AccessibilityWidget` panel) were not touched.

## Concerns and limitations

- **The toggle's tooltip does not appear during the dead window.**
  `disabled:pointer-events-none` suppresses hover, and the toggle's Radix tooltip trigger
  depends on it. This is not a behaviour change: pre-hydration there is no Radix, so the
  tooltip did not appear then either. It is worth knowing the two mechanisms now agree rather
  than one of them being merely absent.
- **Accessibility, unchanged in shape from cycle 1 and now applying to both controls:** for the
  residual window neither control is focusable and both are announced unavailable. That is
  correct — they *are* unavailable — and the `aria-label` / `aria-pressed` values are untouched.
- **The window is shortened, not eliminated.** `client:load` removes the intersection wait;
  script fetch, parse, and hydrate still take real time. Both controls are now honest for the
  whole of it.
- **`apps/marketing/dist` was rebuilt three times** to gather the A/B evidence (gitignored
  build output, not a tracked change). It is left in the with-fix state.
- The one uncovered region in the component (`441-442`) is unchanged from cycle 1; this change
  neither added nor removed uncovered lines.

## Confidence

**High.** Every assertion in the pre-hydration block is now mutation-checked in both
directions — the SSR pins fail when the attribute is removed, the hydration pins fail when the
flip is removed — which is precisely the property cycle 1 lacked. The shipped behaviour is
additionally confirmed in the real production artifact for both controls, and the
no-new-weight claim rests on a controlled A/B build rather than inspection.
