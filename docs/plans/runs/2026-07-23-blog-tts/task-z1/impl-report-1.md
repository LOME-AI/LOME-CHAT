# Z1 — Delete the false drift claim in the shared package

## Objective

Remove the sentence at `packages/shared/src/tts-hosts.ts:3-4` asserting a safety property
that does not exist, and write nothing in its place.

## Files changed

- `packages/shared/src/tts-hosts.ts` — deleted the false "cannot drift apart" sentence from
  the file-header comment. No other change of any kind.

## The touched comment block

**Old (HEAD, lines 1-4):**

```
// Single source of truth for the network hosts the on-device Kokoro TTS model
// download reaches, and the same-origin path its onnxruntime-web runtime is
// self-hosted at. Shared so the hosts the engine fetches and the hosts the CSP
// allows cannot drift apart.
```

**New (lines 1-3):**

```
// Single source of truth for the network hosts the on-device Kokoro TTS model
// download reaches, and the same-origin path its onnxruntime-web runtime is
// self-hosted at.
```

The surviving clause is unchanged from HEAD, character for character; the only edit to the
third line is truncating it after `self-hosted at.` The fourth line is gone entirely.

## Confirmation: nothing was written in its place

I added **no sentence, no clause, and no comment anywhere** — not in this file, not in a
neighbouring export's doc comment, not in any other file. The full diff is a net deletion:

```
@@ -1,7 +1,6 @@
 // Single source of truth for the network hosts the on-device Kokoro TTS model
 // download reaches, and the same-origin path its onnxruntime-web runtime is
-// self-hosted at. Shared so the hosts the engine fetches and the hosts the CSP
-// allows cannot drift apart.
+// self-hosted at.
```

Two lines removed, one line added, and that added line is a prefix of a removed line. The
file is one line shorter and contains no text it did not contain at HEAD. No replacement
wording, no corrected version, no warning comment about the gap the sentence was papering
over.

## Proof the three exported values are unchanged

The working tree file was byte-identical to its HEAD blob before my edit (`git diff HEAD --
packages/shared/src/tts-hosts.ts` produced empty output), so HEAD is the correct baseline.

Comment-stripped diff of the file against its HEAD blob (strip `//`, `/*`, ` *`, blank
lines; then `diff`):

```
$ diff head.code new.code ; echo exit=$?
exit=0
```

The surviving code lines, identical in both:

```ts
export const TTS_MODEL_HOST = 'https://huggingface.co';
export const TTS_MODEL_CONNECT_SRC = [TTS_MODEL_HOST, 'https://*.hf.co'] as const;
export const TTS_ORT_WASM_PATH = '/ort/';
```

Independently corroborated by the existing test file, which pins all three literal values
(`tts-hosts.test.ts` asserts `'https://huggingface.co'`, the exact two-element
`connect-src` array, and `'/ort/'`) — 5/5 passing after the edit. The defect this task's
constraint guards against — a changed CSP constant hiding inside a comment-only edit — is
absent by both checks.

## Self-gate

| Command                                            | Result                     |
| -------------------------------------------------- | -------------------------- |
| `npx eslint src/tts-hosts.ts` (from `packages/shared`, after last edit) | pass — exit 0, no output |
| `npx tsc --noEmit -p tsconfig.json` (from `packages/shared`)            | pass — exit 0            |
| `npx vitest run src/tts-hosts.test.ts` (from `packages/shared`)         | pass — 1 file, 5 tests   |

One command failed on a bad flag of mine and was rerun: `vitest run --reporter=basic`
errored with `ERR_LOAD_URL` because the `basic` reporter was removed in Vitest 4. That is a
CLI-flag error on my side, not a code failure; the rerun without the flag is the row above.

## Acceptance criteria

- **Remove the comment asserting a safety property that does not exist** — met. The
  sentence spanning the tail of line 3 and all of line 4 is deleted; see the diff above.
- **Write nothing in its place** — met. Net deletion, confirmed above.
- **The three exported values byte-identical** — met. Comment-stripped diff against the
  HEAD blob is empty; value-pinning tests pass.
- **Comment-only change** — met. No executable line was touched.
- **No task IDs, plan-section labels, or run references in shipped comments** — met
  trivially: no comment text was added.

## Deviations

None.

## Concerns and limitations

- The claim removed was verified false rather than taken on faith. `TTS_MODEL_CONNECT_SRC`
  and `TTS_MODEL_HOST` have exactly two readers in the repo: `scripts/generate-headers.ts`
  (builds the CSP) and this file's own test. Nothing assigns the engine's fetch host, and
  `tts.worker.ts` imports only `TTS_MODEL_DOWNLOAD_BYTES` and `TTS_ORT_WASM_PATH`. One end,
  not two — the constant cannot prevent a drift it does not participate in.
- The **similar-looking** sentence on `TTS_ORT_WASM_PATH` ("Shared so the path they are
  emitted to and the path the runtime is pointed at cannot drift apart") was deliberately
  **left alone**, and not merely because it is out of scope: I checked, and it is true.
  That constant genuinely has two readers — the build seam that emits the assets and
  `tts.worker.ts:28`, which points the runtime at it. Deleting it would have removed a
  correct comment. Flagging it only so a later reader does not mistake it for a survivor of
  this cleanup class.
- No coverage gate was run: the change adds and removes no executable line, so per-file
  coverage is arithmetically untouched.

## Confidence

**High** — a single-sentence deletion whose falsity was verified by exhaustive grep of the
constant's readers, with the byte-identity of the CSP-bearing values proven two independent
ways (comment-stripped blob diff and value-pinning tests), and lint/typecheck green after
the final edit.
