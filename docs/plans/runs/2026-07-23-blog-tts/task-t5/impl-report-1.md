# T5 impl report 1 — extract shared TTS download-progress bar

## Objective

Extract the accessibility widget's audio-section download-progress bar into one
standalone `packages/ui` component (borderless per G9, animation disabled under
reduced motion), and refactor the audio section to consume it behavior-preserving,
so both the widget and the blog reader card (T4) share it.

## Files changed

- `packages/ui/src/components/accessibility/tts-download-bar.tsx` (new) — the
  shared `TtsDownloadBar` presentational component.
- `packages/ui/src/components/accessibility/tts-download-bar.test.tsx` (new) —
  colocated TDD tests (9).
- `packages/ui/src/components/accessibility/sections/audio.tsx` — `DownloadProgress`
  now renders `<TtsDownloadBar>` for the track+fill; the byte/speed/ETA `<p>` line
  and the `formatBytesProgress`/`formatSpeed`/`formatEta`/`estimateEtaSeconds`
  helpers are unchanged (kept in `lib/tts-download-progress.ts` as instructed).
- `packages/ui/package.json` — added one subpath export
  `"./accessibility/tts-download-bar"` so T4's light blog-reader island can import
  the bar without pulling the engine (see "T4 consumption" below).

## Extracted component (for T4)

- Name: `TtsDownloadBar`
- Location: `packages/ui/src/components/accessibility/tts-download-bar.tsx`
- Exported signature:
  ```ts
  export interface TtsDownloadBarProps {
    readonly percent: number;      // 0–100, clamped and rounded internally
    readonly label: string;        // aria-label on the status region; also the
                                   // visible header text when showLabel is set
    readonly showLabel?: boolean;  // default false; true renders the
                                   // "{label} … {percent}%" header row (blog)
  }
  export function TtsDownloadBar(props: TtsDownloadBarProps): React.JSX.Element
  ```
- T4 consumption path: import via the subpath export
  `@hushbox/ui/accessibility/tts-download-bar` (engine-free), or relatively from
  `blog-reader/` as `../accessibility/tts-download-bar`. I deliberately did NOT add
  it to the heavy `accessibility/index.ts` barrel: that barrel transitively
  static-imports `tts-engine` (via `sections/audio.tsx`), so exporting the bar
  there would drag the Kokoro engine into T4's initial bundle and break G2. The
  dedicated subpath export mirrors the existing `./accessibility/lib/document-reader`
  precedent.

## Props → rendering (acceptance criterion 1)

`role="status"` region (aria-label = `label`) containing:
- optional header row (when `showLabel`): `<span>{label}</span>` + `<span>{percent}%</span>`;
- a thin track `bg-input h-2 w-full overflow-hidden rounded-full`;
- a percent-driven fill `bg-primary h-full` with `style={{ width: "{pct}%" }}`, plus
  `transition-all` only when motion is allowed.

`percent` is clamped to `[0,100]` and rounded once, driving both fill width and the
header readout.

## Behavior-preserving proof (criterion 2)

- The widget's `DownloadProgress` passes `showLabel` unset, so no header renders —
  the widget shows no new text. The track (`bg-input h-2 … rounded-full`) and fill
  (`bg-primary h-full transition-all`) markup are byte-identical to the previous
  inline bar under normal motion, so the widget is visually unchanged. The
  byte/speed/ETA `<p>` line is rendered by `audio.tsx` exactly as before.
- Existing audio-section tests (`sections/sections.test.tsx`, 60 tests) pass
  **unmodified** — no test edits were required. They assert the byte text
  (`4.0 / 88 MB`, `4.0 MB/s`, `21s left`), the disclosure copy, and button roles;
  none asserted the old `role="progressbar"`/`aria-valuenow`, so the role change
  (see Deviations) breaks nothing.

## Reduced motion (criterion 3)

The fill's `transition-all` class is applied only when `!useReducedMotion()` — the
established codebase pattern (`character-count-textarea.tsx`). This honors the merged
signal (OS `prefers-reduced-motion`, the a11y widget's "stop animations", and E2E
builds) self-containedly, without depending on the accessibility `motion.css` being
loaded on the blog page. Tested both ways (hook mocked).

## No borders / no background box (criterion 4, G9)

The `role="status"` container carries no border stroke and no background fill
(`flex w-full flex-col gap-1` only). The only painted surfaces are the track and its
fill (the bar itself), matching the widget and the founder G9 ruling. Pinned by a
test asserting the container className has no `border` and no `bg-` token.

## Tests added (criterion 5)

`tts-download-bar.test.tsx` — behavior : criterion:
- role="status" named by label : criterion 1
- fill width from rounded percent : criterion 1
- clamp >100 → 100% : input validation
- clamp <0 → 0% : input validation
- header hidden by default : criterion 2 (widget parity)
- header shown with showLabel : criterion 1 (blog)
- fill animates when motion allowed : criterion 3
- fill animation dropped under reduced motion : criterion 3
- no border / no bg on container : criterion 4 / G9

## Self-gate

- `pnpm test:ui` — pass (exit 0); coverage gate (perFile 95) green.
  - `tts-download-bar.tsx` — 100/100/100/100 (top-level accessibility folder row 100 across the board).
  - `audio.tsx` — 100 lines / 97.36 branches / 100 / 100 (passes; the one uncovered
    branch is the pre-existing non-`Error` catch fallback at line 99, untouched by this task).
- `turbo typecheck lint --filter=@hushbox/ui --force` — pass (both tasks). (First run
  failed on a missing `vi` import in the test; fixed by importing `vi` from `vitest`,
  matching the sibling `sections.test.tsx`.)
- `jscpd --threshold 2` on owned files — pass, 0 clones.

## Deviations with reasons

1. **Widget determinate bar role `progressbar` → `status`.** Criterion 1 mandates
   `role="status"` for the shared component, and the widget now uses it. No test
   asserted the old progressbar role or `aria-valuenow`. The byte/speed/ETA `<p>`
   line (the announced textual progress) is preserved. Net: the widget no longer
   exposes a determinate `aria-valuenow`; it exposes a named status region plus the
   same visible detail text. Judged acceptable and required by the criteria; visual
   output is unchanged.
2. **Indeterminate placeholder (`bytes === null`) left untouched** in `audio.tsx`
   (still a `role="progressbar"` `animate-pulse` block). It is not "the download
   progress bar" being extracted, and leaving it guarantees zero change to that
   widget state. Surgical.

## Concerns and limitations

- `packages/ui/package.json` was concurrently modified during this session by
  another task (it started minified with no `document-reader` export and mid-session
  became prettier-formatted with T2's `./accessibility/lib/document-reader` export
  present). My change is the single `./accessibility/tts-download-bar` line; I did
  not touch other lines. The diff-vs-HEAD therefore also shows T2's uncommitted
  document-reader export. The orchestrator should re-verify `package.json` at
  merge/commit time given the shared file has more than one in-flight writer.
- knip (`lint:unused`, not in T5's scoped checks) may flag the new subpath export as
  unused until T4 lands — same situation as the existing document-reader export.

## Confidence

High — behavior-preserving refactor proven by 60 unmodified audio-section tests
passing; new component fully covered; all scoped gates green. Minor a11y role change
documented as a criteria-mandated deviation.
