# X2 — Split the accessibility barrel by weight — implementation report 1

## Objective

Make the light accessibility surface's TTS-freedom a property of the module graph, so an
app importing the providers cannot inherit the speech engine's worker chunk and ONNX
runtime wasm. Move `AccessibilityWidget` / `AccessibilityPanel` behind a new
`@hushbox/ui/accessibility/panel` subpath, remove the dormant `./accessibility/lib`
subpath, update the importers, and prove by measurement that `apps/admin` sheds the bytes
and X1's guard goes green.

## Files changed

- `packages/ui/src/components/accessibility/panel/index.ts` (new) — the heavy subpath.
  Exports both panel symbols together (the widget is a Sheet wrapper around the panel) and
  carries the doc-comment recording the durable fact: importing it pulls the TTS engine,
  its bundler-emitted worker chunk, and the ORT wasm, and that cost survives tree-shaking.
- `packages/ui/src/components/accessibility/index.ts` — reduced to the light symbols
  (`A11yProvider`, `SvgColorblindDefs`, `MotionProvider`); doc-comment states where the
  panel went and why.
- `packages/ui/src/components/accessibility/lib/index.ts` (deleted) — the dormant barrel
  whose `tts-engine` re-export was an identical copy of the same trap. See "Deviations".
- `packages/ui/package.json` — added `"./accessibility/panel"`, removed
  `"./accessibility/lib"`.
- `apps/marketing/src/layouts/BlogLayout.astro`,
  `apps/marketing/src/layouts/LandingLayout.astro` — `A11yProvider` still from
  `@hushbox/ui/accessibility`; `AccessibilityWidget` now from
  `@hushbox/ui/accessibility/panel`.
- `apps/web/src/routes/_app/accessibility.tsx` — `AccessibilityPanel` from the panel
  subpath.
- `apps/web/src/routes/__root.test.tsx` — the `vi.mock` factory for
  `@hushbox/ui/accessibility` no longer lists `AccessibilityWidget` / `AccessibilityPanel`
  (nor the never-existing `AccessibilityPage`), matching the barrel's new shape.
- `apps/web/src/routes/_app/accessibility.test.tsx` — the panel mock now targets
  `@hushbox/ui/accessibility/panel`. It no longer needs `importOriginal`: the provider
  stack `renderRoute` mounts comes from a different module now and stays real. Not listed
  in the plan's census — see "Concerns".
- `scripts/generate-headers.ts` — **not changed**, see acceptance criterion 7.

## Tests added

None, deliberately. This task is a module-graph refactor with no behaviour change, and the
amendment's enforcement doctrine forbids a source-level closure test ("a second mechanism
guarding the same failure"). The RED→GREEN cycle is X1's artifact guard:

- **RED (observed before any edit):** X1's verifier over the then-current `apps/admin/dist`

  ```
  VERIFIER FAIL: apps/admin
    - TTS artifact in a bundle declared TTS-free: assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm (21596019 B)
    - TTS artifact in a bundle declared TTS-free: assets/tts.worker-DGv4QGFc.js (2320009 B)
  ```

- **GREEN (after the graph edge was cut and admin rebuilt):** `VERIFIER PASS: apps/admin`.

Existing tests carried the behaviour: `accessibility-widget.test.tsx`,
`accessibility-panel.test.tsx`, `a11y-provider.test.tsx` in `packages/ui`, and the two
updated web route tests (8 tests, pass).

## Self-gate

| Command | Result |
| --- | --- |
| `turbo typecheck lint --filter=@hushbox/ui --filter=@hushbox/web --filter=@hushbox/admin --filter=@hushbox/marketing --filter=@hushbox/scripts --force` | **pass** — 10/10 tasks |
| `eslint` from `packages/ui` over `src/components/accessibility/index.ts`, `src/components/accessibility/panel/index.ts` | **pass** — exit 0 (run after the last edit) |
| `eslint` from `apps/web` over the three changed files | **pass** — exit 0 (run after the last edit) |
| `eslint` from `apps/marketing` over both layouts | **pass** — exit 0 (run after the last edit) |
| `turbo test --filter=@hushbox/ui --force` | **pass** |
| `turbo test --filter=@hushbox/admin --filter=@hushbox/marketing --force` | **pass** |
| `turbo test --filter=@hushbox/web --force` | **fail** — 4 failed / 6422 passed, all four in `src/components/document-panel/document-sandbox.test.tsx`. Not this task's: see "Concerns" for the attribution evidence. |
| `turbo test --filter=@hushbox/scripts --force` | **fail** — 3 files: `generate-env.test.ts`, `refresh-catalog-run.test.ts`, `seed-run.test.ts`. Exactly the set the plan's §KNOWN PRE-EXISTING FAILURES documents; `verify-web-bundle.test.ts` and `build-admin-bundle.test.ts` are in the 87 passing files. Nothing under `scripts/` was edited. |
| `turbo build --filter=@hushbox/admin --force` | **pass** |
| `turbo build --filter=@hushbox/web --filter=@hushbox/marketing --force` | **pass** (marketing build is a scoped check) |
| `knip` (not a scoped check; run because a file was deleted) | only the two pre-existing ambient items (`packages/config/vitest.package.config.ts`, a wrangler hint) — no orphan left by the deletion, and the new subpath is recognised as an entry |

## Acceptance criteria

**1. `@hushbox/ui/accessibility` exports only light symbols; closure has no `new Worker`
and does not reach `lib/tts-engine.ts` — MET.**
Two independent measurements:

- Static: a relative-import closure walk from the barrel yields 21 modules —
  `a11y-provider`, the three font assets, `lib/{apply-settings, colorblind-matrices,
  font-loader, media-pauser, motion-provider, mute, reduced-motion-broadcaster,
  svg-colorblind-defs}`, `sections/aids/{magnifier, reading-guide}`, the five `store/*`
  modules, `hooks/use-reduced-motion`. `reaches tts-engine: false`, `new Worker sites:
  none`.
- Artifact: `apps/admin` imports only this barrel and its rebuilt dist carries no worker
  and no wasm (criterion 5).

**2. Both panel symbols exported from a new `./accessibility/panel` subpath, durable fact
in the doc-comment — MET.** `packages/ui/src/components/accessibility/panel/index.ts`
exports `AccessibilityWidget` and `AccessibilityPanel`. The name encodes neither "heavy"
nor "tts". The doc-comment states that importing it pulls the engine plus the emitted
worker chunk and ORT wasm, why tree-shaking does not remove them (the worker is resolved
and emitted at transform time and emitted assets are never collected), what to import
instead, and that the build-time bundle verifier fails a TTS-free app that picks them up.

**3. The four importers updated; widget still renders and functions on marketing blog AND
landing pages — MET, verified in a browser against the rebuilt `apps/marketing/dist`
served by `astro preview`, not reasoned about.**

- Landing (`/welcome`, `LandingLayout`): the `Accessibility settings` floating button
  renders; clicking it opens the sheet with all eight sections (Quick starts, Visual, Text,
  Reading helpers, Sound, Motion, Pointer & focus, Reset), including the Sound section's
  read-aloud control and its 90 MB disclosure. Functional check: clicking "Text size"
  applied `a11y-font-scale-112` to `<html>`.
- Blog (`/blog/what-is-opaque-authentication`, `BlogLayout`): the same button renders, the
  sheet opens with the same eight sections, and the setting cycle advanced the applied
  class from `a11y-font-scale-112` to `a11y-font-scale-124`. The post's own `Listen`
  control is still present in the byline row.
- The only console errors on both pages are `ERR_CONNECTION_REFUSED` for the announcement
  banner and crawler endpoints — the API stack was not running; nothing accessibility- or
  module-related.

**4. `./accessibility/lib` subpath and its engine re-export removed — MET.** Zero importers
confirmed before removal (`@hushbox/ui/accessibility/lib` and relative `./lib` / `../lib`
barrel imports both return nothing repo-wide, excluding `/legacy/`). See "Deviations" for
why the file was deleted rather than trimmed.

**5. Admin rebuilt; bytes gone by measurement — MET.**

| | before | after |
| --- | --- | --- |
| `apps/admin/dist` total | 25,611,280 B | **1,420,567 B** (33 files) |
| `tts.worker-*.js` | `assets/tts.worker-DGv4QGFc.js` (2,320,009 B) | **none** |
| `ort-*.wasm` | `assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm` (21,596,019 B) | **none** (no `*.wasm` at all, no `dist/ort/` tree) |
| X1 verifier | FAIL, 2 violations | **PASS** |

The plan predicted "roughly 1.7 MB"; the actual is 1.42 MB — the same order, and the two
named artifacts account for 23.9 MB of the 24.2 MB drop.

**6. `apps/web` and `apps/marketing` still ship TTS and still pass X1's guard — MET.**
Rebuilt both, ran `merge-marketing-into-web`, then the verifier over the merged dist:
`VERIFIER PASS: apps/web` (baseline before the change was also PASS, so the six checks are
unchanged in outcome). The merged dist (123,384,207 B) still carries
`assets/tts.worker-D1rQBK-H.js` (web's), `_astro/tts.worker-CiKSLEKi.js` (marketing's) and
`ort/ort-wasm-simd-threaded.jsep.wasm`. `apps/marketing/dist` on its own still carries
`_astro/tts.worker-CiKSLEKi.js` and `ort/ort-wasm-simd-threaded.jsep.wasm`. Marketing is
not independently declared in `APPS_SHIPPING_TTS` — it is verified as part of the merged
web bundle, which is where it deploys.

*Secondary win, confirmed:* `apps/web/dist/index.html` modulepreloads dropped from 44 to
41 entries, and **neither `accessibility-*.js` nor `tts-engine-*.js` is preloaded any
more** — before the change it preloaded `/assets/accessibility-Aro71dNI.js` (24,977 B) and
`/assets/tts-engine-DBsjrvjO.js` (8,647 B), exactly the two chunks the plan named. Both
chunks still exist in the dist (`accessibility-Dd4A8fFv.js` 17,019 B, `tts-engine-EfUag58-.js`
8,647 B); they now load with the `/accessibility` route instead of the document. The
name-normalised preload diff is: `-accessibility`, `-tts-engine`, `-chevron` ×2,
`+reading-guide` (4,274 B — previously folded into the panel chunk, now pulled directly by
`A11yProvider`).

**7. `scripts/generate-headers.ts:643-645` comment — MET, no edit needed.** The comment
claims the admin CSP needs no `wasm-unsafe-eval` because "admin bundles no crypto/WASM and
no eval-using deps". After this task the rebuilt `apps/admin/dist` contains zero `*.wasm`
files, so the statement is true again and correcting it would make it wrong. The criterion
says to correct it "only if it still misstates the post-change reality"; it does not.

## Deviations

1. **`lib/index.ts` was deleted, not trimmed.** Criterion 4 says the subpath export is
   removed "along with the engine re-export at `lib/index.ts:17-24`". Removing the subpath
   leaves the file with zero importers repo-wide — knip derives `packages/ui` entries from
   the package.json exports map, so the trimmed file would have become an unused-file
   error, and a barrel nobody can reach is dead code by the repo's own rules. It is
   provably dead (no `@hushbox/ui/accessibility/lib` importer, no relative importer of the
   `lib` barrel; every other symbol it re-exported is imported by narrow path elsewhere in
   the package). knip after the change reports no new findings, which is the confirmation.
2. **The panel subpath is `panel/index.ts`, not `panel.ts`.** `packages/ui`'s coverage gate
   is per-file with a static `include` over `src/**`, and excludes only `**/index.ts`.
   A flat `panel.ts` re-export file would be merged into the report at 0% and fail the
   gate, and the only way to cover it would be a test that imports the real heavy tree into
   the `packages/ui` test run — the exact import the widget's own test deliberately mocks
   away. A directory barrel is also what every other `@hushbox/ui` subpath uses
   (`store/`, `banner/`, `blog-reader/`).

## Concerns and limitations

1. **Census omission (raised).** The plan's authoritative census lists `__root.test.tsx` as
   the one test touching the barrel. `apps/web/src/routes/_app/accessibility.test.tsx:10-11`
   also mocks `@hushbox/ui/accessibility` (with `importOriginal`, overriding
   `AccessibilityPanel`) and had to be repointed at the new subpath or the route test would
   have failed. Every *substantive* claim in the census checked out exactly — the same six
   source importers, the same symbols, the same lines, and `packages/ui/src/index.ts` does
   not re-export accessibility — so this is an incompleteness about test mocks, not
   evidence that the module graph moved under us. I proceeded on that basis rather than
   stopping; flagging it so the auditor does not read the extra edit as scope creep.
2. **`apps/web` suite has 4 failures that are not this task's.** All four are in
   `src/components/document-panel/document-sandbox.test.tsx`. Attribution evidence: (a) all
   four test names are **absent from `git show HEAD:` that file** — they are new,
   uncommitted tests belonging to a concurrent workstream that also added two untracked
   files (`frame-appearance.ts`, `highlighted-source.tsx`) and ~300 uncommitted lines in
   that directory; (b) the file passes standalone (63/63) and with its whole directory
   (140/140), failing only under full-suite load; (c) nothing I changed appears anywhere in
   its module graph — it imports `@hushbox/ui` (unchanged), never `@hushbox/ui/accessibility`.
   I did not touch it, per the concurrent-work rule.
3. **`@hushbox/scripts` gate is red for the three documented pre-existing reasons.** No file
   under `scripts/` was edited by this task.
4. **The admin verification ran the guard directly** (`appBundleOptions(root, 'apps/admin')`
   → `verifyWebBundle`, the exact pair `buildAdminBundle` calls) against the
   production-mode `turbo build` dist, rather than through `pnpm build:e2e:admin`. That
   wrapper regenerates env files and rebuilds in development mode; running it would have
   churned `.env*` in a checkout with other workstreams live, and would have measured the
   dev-mode artifact rather than the one that deploys. The code path exercised is identical.
5. **The static closure walk follows relative specifiers only** — it cannot see a heavy
   dependency reached through a bare package specifier. That is why criterion 1 does not
   rest on it: the authoritative proof is the admin artifact, which is the mechanism the
   amendment designates.

## Confidence

**High.** The load-bearing claim is a byte measurement, not an inference: 25,611,280 B →
1,420,567 B with both named artifacts absent, and the guard that failed before the change
passes after it. The widget's survival was verified by driving a real browser against the
built marketing output on both layouts, including a functional state change. The one gate
that is red is red for four tests that do not exist at HEAD.
