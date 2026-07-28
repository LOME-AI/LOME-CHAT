# Y6 fix cycle 3 — implementation report

## Objective

Three comment defects in two files. Comments only — no code, no tests, no config.

1. `packages/shared/src/tts-hosts.ts:4` and `:33` — the false `env.backends.onnx.wasm.wasmPaths`
   property path.
2. `scripts/lib/build-seam.ts:4` — drop "Each export carries the reason it is load-bearing."
3. `scripts/lib/build-seam.ts:39` — `ortAssetsPlugin` is defined *below*, not *above*.

## Grounding established before editing

Every fact below was checked this session, not recalled.

| Claim | How verified |
| --- | --- |
| No `env.backends` tree exists; the setter is flat `wasmPaths` | `packages/ui/src/components/accessibility/lib/tts.worker.ts:41` is `env.wasmPaths = TTS_ORT_WASM_PATH`; the comment at `:32-40` states it. Pinned non-tautologically by `tts.worker.test.ts:101-110` (`'backends' in actual.env === false` against `vi.importActual('kokoro-js')`). |
| `env.remoteHost` is set nowhere in the repo | Repo-wide grep for `remoteHost` over `packages/ apps/ scripts/` returns four hits, **all of them comments**: `tts-hosts.ts:4`, `tts-hosts.ts:13`, `tts.worker.test.ts:11`, `generate-headers.ts:124`. No assignment or read. `tts.worker.test.ts:11` states the real env "has no `backends` and no `remoteHost`". |
| `OrtAsset` and `contentTypeFor` carry no comment | `build-seam.ts:14` (interface opens with no preceding comment, blank line above) and `:156` (`export function contentTypeFor`, blank line above). |
| `ortAssetsPlugin` is below `:39` | Defined at `build-seam.ts:165`. |
| `tts.worker.ts` genuinely satisfies "set `wasmPaths`" | `tts.worker.ts:41`. Only the direction word at `:39` was wrong; the rest of that clause is true, so only that word changed. |

## Files changed

- `packages/shared/src/tts-hosts.ts` — removed the false `env.backends.onnx.wasm.wasmPaths`
  claim at both sites, and (see Deviations) the equally false `env.remoteHost` claim that shared
  the sentence at `:4` and stood alone at `:12-13`.
- `scripts/lib/build-seam.ts` — dropped the unchecked "Each export carries the reason it is
  load-bearing" sentence; corrected one direction word.

## Site-by-site: old text → new text

### Site 1 — `packages/shared/src/tts-hosts.ts:1-7` (module header)

Old:

```
// Single source of truth for the network hosts the on-device Kokoro TTS model
// download reaches, and the same-origin path its onnxruntime-web runtime is
// self-hosted at. Consumed by both the TTS worker (which pins transformers.js
// `env.remoteHost` / `env.backends.onnx.wasm.wasmPaths` from these) and the SPA
// header generator (which adds the model hosts to `connect-src`). Keeping the
// engine-fetched host and the CSP allowlist derived from one constant is what
// makes drift between them structurally impossible.
```

New (now `:1-4`):

```
// Single source of truth for the network hosts the on-device Kokoro TTS model
// download reaches, and the same-origin path its onnxruntime-web runtime is
// self-hosted at. Shared so the hosts the engine fetches and the hosts the CSP
// allows cannot drift apart.
```

The named defect was the property path. The sentence containing it was an importer-reach claim
whose *other* half (`env.remoteHost`) is also false, so the whole clause went rather than half of
it. What remains — what the constants are, and the shared-constant rationale — names no file,
no importer, and no library property, so there is nothing in it that can go stale when something
moves.

### Site 2 — `packages/shared/src/tts-hosts.ts:9-14` (`TTS_MODEL_HOST` docblock)

Old:

```
 * (via a 302 redirect to the Xet CDN) weight/voice files from. CSP host form:
 * no trailing slash. The worker appends the slash transformers.js expects for
 * `env.remoteHost`.
```

New (now `:8-9`):

```
 * (via a 302 redirect to the Xet CDN) weight/voice files from. No trailing
 * slash: this is the CSP host form.
```

Deleted, not rewritten: nothing appends a slash and nothing sets `env.remoteHost`. The worker
does not import `TTS_MODEL_HOST` at all (`tts.worker.ts:28` imports only
`TTS_MODEL_DOWNLOAD_BYTES` and `TTS_ORT_WASM_PATH`). The kept clause is verifiable against the
literal on the next line.

### Site 3 — `packages/shared/src/tts-hosts.ts:29-36` (`TTS_ORT_WASM_PATH` docblock)

Old:

```
 * Same-origin absolute path the onnxruntime-web `.wasm`/`.mjs` runtime assets
 * are self-hosted at. The build plugin emits the ORT assets here (matching the
 * installed transformers version) and the worker points
 * `env.backends.onnx.wasm.wasmPaths` here, so the runtime loads same-origin
 * with no third-party CDN in the CSP. Both must agree; hence the shared
 * constant.
```

New (now `:26-28`):

```
 * Same-origin absolute path the onnxruntime-web `.wasm`/`.mjs` runtime assets
 * are self-hosted at. Shared so the path they are emitted to and the path the
 * runtime is pointed at cannot drift apart.
```

Nothing durable lost: the "no third-party CDN / not jsdelivr" rationale is already stated nine
lines up at `:20-21` in this same file and is test-pinned (`tts-hosts.test.ts:18-22`,
`generate-headers.test.ts:619-633` — the pinning the plan verified in cycle 2). The
"matching the installed transformers version" fact is a property of the emitting plugin and is
stated where it is checkable, at `build-seam.ts:148-151`; restating it here was a reach claim
this file cannot support.

### Site 4 — `scripts/lib/build-seam.ts:1-5` (module docblock)

Old:

```
 * across build surfaces, written once here and imported rather than restated
 * per app. Each export carries the reason it is load-bearing.
```

New:

```
 * across build surfaces, written once here and imported rather than restated
 * per app.
```

Dropped, per instruction — not qualified, and no comment was added to `OrtAsset` or
`contentTypeFor` to make it true.

### Site 5 — `scripts/lib/build-seam.ts:39` → now `:29`

Old: `` * which `ortAssetsPlugin` above and `tts.worker.ts` already satisfy, so the ``

New: `` * which `ortAssetsPlugin` below and `tts.worker.ts` already satisfy, so the ``

One word. `ortAssetsPlugin` is at `:165`.

## Deviation — one extra site, same file, same defect

The brief named `tts-hosts.ts:4` and `:33`. I also deleted the `env.remoteHost` clause at
`:12-13` (Site 2 above). Reasons:

- It is the identical defect class — a comment naming a library property that does not exist —
  verified false by the same repo-wide grep, in the same file, nine lines from a site I was
  editing.
- Leaving it would have reproduced, *inside one file*, exactly the failure the cycle-1 ruling
  named when it ordered this fix: "a reader who checks will find the two disagree and cannot tell
  which is authoritative."
- Half-fixing the `:4` sentence was not available: `env.remoteHost` and
  `env.backends.onnx.wasm.wasmPaths` share one clause there. Removing one false property path and
  keeping the other in the same sentence is not a defensible end state.

Comment-only, behaviour-free. Raised in the return message rather than assumed accepted.

## Out-of-scope finding — NOT changed

`scripts/generate-headers.ts:124` carries the same false claim: "Sourced from the same shared
constant the worker pins `env.remoteHost` from, so the fetched host and this allowlist cannot
drift." The worker pins nothing from `TTS_MODEL_HOST`; it does not import it. This is the fourth
site of the class and the only surviving one after this cycle. Outside my named ownership and
outside the two files in the objective, so left untouched and raised for a ruling.

Note the shape of it: the false clause is load-bearing for the *rationale* of that comment (why
`generate-headers` sources the host from the shared constant). Deleting the property name alone
leaves the sentence's argument intact and true — the CSP allowlist and the constant genuinely do
share one source, visible at `generate-headers.ts:36` and `:133`.

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint src/tts-hosts.ts` (run from `packages/shared/`, after last edit) | **pass** — exit 0, no output |
| `npx eslint lib/build-seam.ts` (run from `scripts/`, after last edit) | **pass** — exit 0, no output |
| `npx turbo typecheck --filter=@hushbox/shared --filter=@hushbox/scripts --force` | **pass** — 2 successful, 2 total, 0 cached |

`--force` on the typecheck was deliberate: a warm turbo cache would have replayed a pre-edit
result and proved nothing. Both ESLint invocations were run from the owning package directory
(a repo-root run silently no-ops under ESLint v9) and after my final edit.

Not run, per brief: any Playwright/e2e command (`e2e/global-teardown.ts` invokes
`pnpm generate:env`), `pnpm install`, `pnpm generate:env`, and any shared-dist rebuild.

`packages/shared` gate state attributable to the concurrent `src/affordability/**` workstream:
none observed. The scoped ESLint and typecheck above were both clean, so there is nothing to
attribute either way.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| `tts-hosts.ts:4` false `env.backends.onnx.wasm.wasmPaths` removed | **met** | Site 1. `grep 'env.backends' packages/shared/src/tts-hosts.ts` → no matches. |
| `tts-hosts.ts:33` false `env.backends.onnx.wasm.wasmPaths` removed | **met** | Site 3, same grep. |
| `build-seam.ts:4` "Each export carries the reason…" dropped, not qualified | **met** | Site 4. Sentence gone; no replacement claim about the exports. |
| No comment added to `OrtAsset` or `contentTypeFor` | **met** | Both untouched; diff shows no change at those lines. |
| `build-seam.ts:39` "above" → "below" | **met** | Site 5; `ortAssetsPlugin` at `:165`. |
| No new claim about file contents, importers, or collective export behaviour | **met** | Every replacement clause is either the definition of the constant on the following line or the shared-constant rationale. No new text names a file, a package, an importer, or a library property. Net: four such claims deleted, zero added. |
| Comments only; exported values untouched | **met** | `git diff` over both files: every `+`/`-` line in this cycle is inside a `//` or `/** */` block. `TTS_MODEL_HOST = 'https://huggingface.co'`, `TTS_MODEL_CONNECT_SRC = [TTS_MODEL_HOST, 'https://*.hf.co'] as const`, `TTS_ORT_WASM_PATH = '/ort/'` all appear as unchanged context lines. |
| No task IDs, plan-section labels, or run references in shipped comments | **met** | No identifier of that shape appears in any new text. |
| `turbo.json`, workflows, tests untouched | **met** | `git status` shows no change to any of them from this cycle. |

## Concerns and limitations

- **The class is not closed by this cycle.** `generate-headers.ts:124` still asserts the worker
  pins `env.remoteHost`. It needs a ruling, not my judgement.
- **Deletion was preferred over rewriting throughout**, which is why three docblocks got shorter
  rather than more precise. Anyone reading `tts-hosts.ts` now learns what the constants are and
  why they are shared, but not who consumes them. That is the intended trade: the consumer list
  was wrong twice in two cycles, and `grep` answers it correctly and forever.
- **`git diff` for `build-seam.ts` shows more than this cycle's work** — it is against HEAD and
  therefore includes cycle 1's docblock rewrite, the `verify-bundle` rename, and the
  `resolveTtsWorkerSource` / `TTS_WORKER_SCAN_ENTRY` additions. This cycle's contribution to that
  file is exactly two lines: the dropped sentence and the one-word direction fix.

## Confidence

**High.** Five comment sites, zero executable lines. Every claim kept is verifiable from a line
adjacent to it; every claim deleted was checked false by direct grep or by reading the cited
file. Both gates green from the owning package directories after the final edit.
