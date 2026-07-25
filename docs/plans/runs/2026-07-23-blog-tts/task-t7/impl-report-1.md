# T7 — TTS download-size copy unification — impl report 1

## Objective

The first-listen download figure disagreed three ways (widget "88 MB", blog "about 90 MB",
`tts-download-progress.ts:7` comment "80 MB"). Verify the real size, standardize both
user-facing surfaces on it via ONE shared constant, and fix the stale comment.

## Verified size

Engine dtype is `q8` on WASM (confirmed `tts.worker.ts:41` `DTYPE = 'q8'`, `DEVICE = 'wasm'`;
`MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'`). In transformers.js `q8` resolves to the
`_quantized` ONNX file. First-listen download = the sum of the files the browser actually fetches
from the Hugging Face hub.

Byte sizes pulled from the HF tree API
(`https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main?recursive=true`,
fetched this session):

| File | Bytes |
| --- | --- |
| `onnx/model_quantized.onnx` (dtype `q8`) | 92,361,116 |
| `config.json` | 44 |
| `tokenizer.json` | 3,497 |
| `tokenizer_config.json` | 113 |
| one `voices/*.bin` (e.g. `af_heart.bin`) | 522,240 |
| **Total** | **92,887,010** |

= **88.58 MiB** (÷2^20) = **92.89 MB** (÷1e6).

Voice sourcing was verified against the installed `kokoro-js@1.2.1` dist: in the browser it
fetches the selected voice from
`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/{name}.bin`
(one 522,240-byte file per voice); it reads the package's bundled `voices/` copies only under
Node (`fs.readFile`). So exactly one voice `.bin` is part of the first-listen web download. The
model term (92.4 MB) matches the research doc's "8-bit (q8): 92.4 MB" (`research/tts-landscape.md`
§1.1). The self-hosted onnxruntime-web WASM (T1) is a same-origin app asset cached with the app,
so it is deliberately excluded from this hub-download figure (matches the STEPS list).

**Friendly figure: "about 90 MB"** — rounds the 92.89 MB decimal total to the nearest 10 (and
sits within ~1.4 MB of the 88.58 MiB reading), so it is honest under both the decimal and binary
conventions, and it matches the founder's G6-amended blog copy.

## Files changed

- `packages/shared/src/tts-model-download.ts` (new) — the single source constant
  `TTS_MODEL_DOWNLOAD_MB = 90`, with the verified byte-sum rationale in its doc comment.
- `packages/shared/src/tts-model-download.test.ts` (new) — asserts the value (90) and that it is a
  whole number.
- `packages/shared/src/index.ts` — barrel re-export of the new module (beside `tts-hosts.js`).
- `packages/ui/src/components/accessibility/sections/audio.tsx` — `DOWNLOAD_SIZE_TEXT` now built
  from `TTS_MODEL_DOWNLOAD_MB` (`` `${...} MB` `` → "90 MB"); the widget sentence phrasing is
  unchanged. Stale "88 MB / IndexedDB cache" comment replaced with a sizing-lives-with-the-constant
  note.
- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — `DISCLOSURE_LINE_2` interpolates
  the constant into the exact required sentence `First listen downloads the voice model (about 90
  MB, one time).` (no em dash); only the number is sourced from the constant.
- `packages/ui/src/components/accessibility/lib/tts-download-progress.ts` — the `formatBytesProgress`
  doc comment no longer asserts a wrong "80 MB" disclosure figure; it now states the readout shows
  the engine's actual bytes, not the friendly figure. (Comment-only change, as bounded.)
- `packages/ui/src/components/accessibility/sections/sections.test.tsx` — the three disclosure
  assertions now match a regex built from `TTS_MODEL_DOWNLOAD_MB` (anti-drift); one test name
  de-hardcoded from "~88 MB".
- `packages/ui/src/components/blog-reader/blog-read-aloud.test.tsx` — the disclosure assertion now
  builds the expected string from `TTS_MODEL_DOWNLOAD_MB` (anti-drift).

## Tests added / changed

- `tts-model-download.test.ts` — "is the verified friendly first-listen size, in whole MB" and
  "is a whole number of MB": pin the constant. (Watched RED — module missing — then GREEN.)
- Anti-drift: both surfaces' tests (`sections.test.tsx`, `blog-read-aloud.test.tsx`) now assert the
  rendered copy against a string/regex derived from the shared constant. A future hardcoded literal
  on either surface that diverges from `TTS_MODEL_DOWNLOAD_MB` fails its test — they cannot silently
  drift again. The audio-surface change was TDD: the sections assertions were rewired to the constant
  (RED, audio still emitted "88 MB"), then `audio.tsx` was switched to the constant (GREEN).

## Self-gate

- `pnpm test:shared` — pass (coverage gate: 1 successful; `tts-model-download.ts` fully covered).
- `pnpm test:ui` — pass (coverage gate: 1 successful; `audio.tsx` 100% lines / 97.36% branch;
  affected files `sections.test.tsx` 107 passed, `blog-read-aloud.test.tsx` 26 passed,
  `tts-download-progress.test.ts` 21 passed).
- `turbo typecheck lint --filter=@hushbox/ui --filter=@hushbox/shared` — pass (4/4 tasks).
- `eslint` on the five owned source files (run from each package dir, after the final edit) — exit 0.
- `jscpd --threshold 2` on owned files — 0 clones (0%).

(The `Failed to resolve dependency: @hushbox/db … optimizeDeps.include` line printed by both vitest
runs is pre-existing environment noise unrelated to these files; both suites still report success.)

## Acceptance criteria

- Real size verified and summed with cited byte figures + source — met (see above).
- ONE shared constant, both surfaces import it — met (`TTS_MODEL_DOWNLOAD_MB` in
  `packages/shared`, imported by `audio.tsx` and `blog-read-aloud.tsx`).
- Each surface keeps its own phrasing, only the number comes from the constant — met. Blog line is
  exactly `First listen downloads the voice model (about 90 MB, one time).`, no em dash.
- Stale `tts-download-progress.ts:7` comment fixed (no longer asserts "80 MB") — met.
- Anti-drift test so surfaces cannot diverge — met.
- Coverage gates (G7) maintained — met.

## Deviations

None. The shared constant was placed in a new `tts-model-download.ts` (not folded into
`tts-hosts.ts`, which is scoped to CSP hosts / WASM path); the brief BOUNDS names "a new shared
size constant" and does not list `tts-hosts.ts`, so a new file is the correct home.

## Concerns and limitations

- The number is friendly-rounded, not exact: the real total is ~92.9 MB decimal / ~88.6 MiB. "about
  90 MB" is the single figure closest to honest under both conventions and is the founder's G6 copy.
- The widget sentence is "90 MB, one-time download." (no "about"), per the instruction to keep each
  surface's phrasing and change only the number. If the founder wants the widget to also say "about"
  for precision-honesty, that is a one-word copy change outside this task's number-only mandate.
- `blog-read-aloud.tsx`/`.test.tsx` live in T4's still-untracked `blog-reader/` dir; my edits are in
  place and the file is left clean for the later T6 (iOS) edit, per COORDINATION.

## Confidence

High — figures verified from the authoritative HF API and the installed kokoro-js dist; all scoped
gates green; drift now structurally guarded by both surfaces' tests.
