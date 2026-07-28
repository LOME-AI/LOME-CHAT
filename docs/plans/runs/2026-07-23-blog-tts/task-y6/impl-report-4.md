# Y6 fix cycle 4 — implementation report

## Objective

One comment site: `scripts/generate-headers.ts:124`. Delete the clause asserting a drift
protection between the fetched model host and the CSP allowlist that does not exist. Comment
only, one file, no behaviour change, no test/constant/CSP-construction edits.

## Grounding established before editing

Every fact below was checked this session by reading the cited line, not recalled.

| Claim | How verified |
| --- | --- |
| The worker pins no model host | `packages/ui/src/components/accessibility/lib/tts.worker.ts:28` imports exactly `{ TTS_MODEL_DOWNLOAD_BYTES, TTS_ORT_WASM_PATH }` from `@hushbox/shared` — not `TTS_MODEL_HOST`, not `TTS_MODEL_CONNECT_SRC`. The only `env` write in the file is `env.wasmPaths = TTS_ORT_WASM_PATH` at `:41`. |
| The worker says so itself | `tts.worker.ts:38-40`: "The model host itself is not pinned here: transformers already defaults to https://huggingface.co, which the SPA connect-src allowlist (TTS_MODEL_CONNECT_SRC) covers." The direction of the relationship is the *opposite* of what the deleted clause asserted: the allowlist is written to cover the library default, it is not the source the fetch derives from. |
| `env.remoteHost` is assigned/read nowhere | Repo-wide grep (below). Two mentions before this edit, both comments; one after. |
| Nothing else in the file changed | `git diff -- scripts/generate-headers.ts` is a single hunk, comment lines only (quoted below). |

## Old text → new text

`scripts/generate-headers.ts`, inside `buildSpaHeaders`, the `connectSource` preamble.

Old (`:120-126`):

```
  // `TTS_MODEL_CONNECT_SRC` (huggingface.co + *.hf.co) is the on-device
  // Kokoro TTS model download: the accessibility reader and the blog "Listen"
  // control fetch model/tokenizer files from the hub, which 302-redirect large
  // weights to the Xet CDN on a region-variable *.hf.co subdomain. Sourced
  // from the same shared constant the worker pins `env.remoteHost` from, so the
  // fetched host and this allowlist cannot drift. The onnxruntime WASM runtime
  // is self-hosted same-origin (see tts.worker.ts), so no third-party CDN.
```

New (`:120-125`):

```
  // `TTS_MODEL_CONNECT_SRC` (huggingface.co + *.hf.co) is the on-device
  // Kokoro TTS model download: the accessibility reader and the blog "Listen"
  // control fetch model/tokenizer files from the hub, which 302-redirect large
  // weights to the Xet CDN on a region-variable *.hf.co subdomain. The
  // onnxruntime WASM runtime is self-hosted same-origin (see tts.worker.ts),
  // so no third-party CDN.
```

Two sentences deleted whole; the surrounding two reflowed, unchanged in wording. Nothing added.

## Why deletion, not rewrite

The clause had two halves and both were unsalvageable *as a pair*:

- `env.remoteHost` — a property that exists nowhere in the repo.
- "so the fetched host and this allowlist cannot drift" — a mechanical-link claim. Rewriting it
  to name a real property was not available, because the worker names no host property at all.
  Rewriting it to "sourced from the same shared constant" alone would still be false in the half
  that matters: the *fetched* host is not sourced from the constant, it is `@huggingface/transformers`'
  built-in default. There is no shared source, so there is no structural drift protection to
  describe — only a human convention that someone updates the allowlist if the library default
  ever changes. A security-relevant comment claiming a guarantee the code does not provide is
  worse than one that is silent, so the claim went out rather than being softened.

Net across this task's four cycles: five such claims deleted, zero added.

## Explicit confirmation — no surviving clause claims a worker↔allowlist link

The full remaining TTS paragraph is quoted above. Checked clause by clause:

| Surviving clause | Status | Grounding |
| --- | --- | --- |
| "`TTS_MODEL_CONNECT_SRC` (huggingface.co + *.hf.co)" | true | `packages/shared/src/tts-hosts.ts:23` — `[TTS_MODEL_HOST, 'https://*.hf.co']`, with `TTS_MODEL_HOST = 'https://huggingface.co'` at `:11`. Test-pinned at `packages/shared/src/tts-hosts.test.ts:11`. |
| "is the on-device Kokoro TTS model download … fetch model/tokenizer files from the hub" | true | Describes what the hosts are for; the fetching is `kokoro-js`/transformers inside the worker, no property or file named. |
| "which 302-redirect large weights to the Xet CDN on a region-variable *.hf.co subdomain" | true | Same rationale already stated and unchanged at `packages/shared/src/tts-hosts.ts:16-22`. |
| "The onnxruntime WASM runtime is self-hosted same-origin (see tts.worker.ts), so no third-party CDN." | true | `tts.worker.ts:41` sets `env.wasmPaths = TTS_ORT_WASM_PATH`; `TTS_ORT_WASM_PATH = '/ort/'` (`tts-hosts.ts`), a same-origin absolute path. This is the one surviving cross-file reference, and it is the *WASM path* link — which really is a shared-constant link and really does exist. It makes no claim about the model host. |

**Confirmed: no surviving clause in this comment asserts that the worker and the CSP allowlist
are mechanically linked.** The only remaining reference to the worker is the `wasmPaths`
same-origin fact, which is real, and it is stated as a property of the WASM runtime, not as a
drift guarantee about the model host.

## Repo-wide `remoteHost` grep

Command: `grep -rn "remoteHost" packages apps scripts e2e --include="*.ts" --include="*.tsx" --include="*.md" | grep -v node_modules`

Before this edit — two hits. After — one:

```
packages/ui/src/components/accessibility/lib/tts.worker.test.ts:11:  // settable `wasmPaths`. It has no `backends` and no `remoteHost`. Grounded
```

Why the survivor is correct: it is inside the kokoro-js mock factory and reads (`:10-14`)
"Mirrors the REAL kokoro-js `env` export: a thin wrapper exposing ONLY a settable `wasmPaths`.
It has no `backends` and no `remoteHost`. Grounded against the real module by the 'real kokoro-js
env API' test below…". It asserts the *absence* of the property — the true statement — and says
so as a documented reason the mock is shaped that way, grounded by a real-API test
(`tts.worker.test.ts:101-110`, `vi.importActual('kokoro-js')`). Correct, load-bearing, and
out of scope besides.

Hits under `node_modules` and vitest `.vite` dep caches were excluded: they are the vendored
transformers source and stale pre-edit bundles of `tts-hosts.ts`, not repo source.

## Confirmation that nothing but a comment changed

`git diff -- scripts/generate-headers.ts` — the file's entire uncommitted diff is one hunk:

```
@@ -120,10 +120,9 @@ function buildSpaHeaders(
   // `TTS_MODEL_CONNECT_SRC` (huggingface.co + *.hf.co) is the on-device
   // Kokoro TTS model download: the accessibility reader and the blog "Listen"
   // control fetch model/tokenizer files from the hub, which 302-redirect large
-  // weights to the Xet CDN on a region-variable *.hf.co subdomain. Sourced
-  // from the same shared constant the worker pins `env.remoteHost` from, so the
-  // fetched host and this allowlist cannot drift. The onnxruntime WASM runtime
-  // is self-hosted same-origin (see tts.worker.ts), so no third-party CDN.
+  // weights to the Xet CDN on a region-variable *.hf.co subdomain. The
+  // onnxruntime WASM runtime is self-hosted same-origin (see tts.worker.ts),
+  // so no third-party CDN.
   const connectSource = [
     "'self'",
     apiOrigin.http,
```

Every `+`/`-` line begins with `//`. The `connectSource` array, the `TTS_MODEL_CONNECT_SRC`
spread at `:133`, the import at `:36`, and every other CSP directive appear as unchanged
context or are untouched. No constant, no test, no other file was edited this cycle — one
`Edit` call was made in total.

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint generate-headers.ts` (run from `scripts/`, after the final edit) | **pass** — exit 0, no output |
| `npx turbo typecheck --filter=@hushbox/scripts --force` | **pass** — `tsgo --noEmit`, 1 successful, 1 total, 0 cached |

`--force` was deliberate: a warm turbo cache would have replayed a pre-edit result and proved
nothing. ESLint was run from the owning package directory (a repo-root run silently no-ops
under ESLint v9) and after the last edit.

Not run, per brief: any Playwright/e2e command (`e2e/global-teardown.ts` invokes
`pnpm generate:env`, which drives this very file), `pnpm install`, `pnpm generate:env`, and any
shared-dist rebuild. `scripts/generate-headers.ts` was never executed, directly or indirectly.

Pre-existing failures named in the brief (broken `apps/api`, two `scripts/` test files failing
at module load, two foreign knip findings) were neither touched nor investigated. Neither scoped
gate above surfaced any of them, so there is nothing to attribute either way.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| The false drift claim at `generate-headers.ts:124` is gone | **met** | Diff above; grep shows the `remoteHost` mention no longer exists in this file. |
| The "cannot drift" argument was NOT preserved with the property name merely dropped | **met** | The whole two-sentence claim was deleted. No replacement sentence about sourcing, sharing, or drift was written — see "Old text → new text". |
| Nothing kept asserts a link that does not exist | **met** | Clause-by-clause table above; each survivor grounded at a cited line. |
| Comment only, one file | **met** | Single-hunk diff, all `//` lines; one `Edit` call. |
| No behaviour change | **met** | No executable line altered; typecheck green. |
| CSP construction, constants, and tests untouched | **met** | `connectSource` unchanged in the diff; `packages/shared/src/tts-hosts.ts`, `tts-hosts.test.ts`, `generate-headers.test.ts` not opened for edit. |
| No task IDs, plan-section labels, or run references in shipped comments | **met** | Nothing was added to the comment at all — the change is purely subtractive plus reflow. |

## Deviations

None. The brief named one site; exactly that site was changed. No adjacent site of the same
class remains — the class is closed (grep above).

## Concerns and limitations

- **The class is now closed, and closed by deletion.** Five false reach/link claims removed
  across four cycles, none replaced. `generate-headers.ts`'s TTS comment now explains *what*
  the hosts are for and nothing about *who else* uses them; `grep TTS_MODEL_CONNECT_SRC`
  answers that correctly and stays correct.
- **A real gap is now undocumented, and that is deliberate.** The fetched model host genuinely
  is not linked to the allowlist — if `@huggingface/transformers` ever changes its default hub
  host, the CSP would silently block the download and no code prevents that. This cycle removed
  the comment that *falsely claimed* protection; it did not add one describing the exposure,
  because the brief is comment-only and scoped to deleting the false claim, and because a
  "watch out for X" note is not a mechanism. If the orchestrator wants that exposure guarded
  rather than merely un-misdescribed, that is a separate task — a test asserting the library
  default equals `TTS_MODEL_HOST` would make the link real. Raised, not acted on.

## Confidence

**High.** One comment, six words of reflow, zero executable lines. The deleted claim was
disproven by reading the importing line of the file it referenced (`tts.worker.ts:28`) and by
that file's own contradicting comment (`:38-40`). Every surviving clause is grounded at a cited
line. Both scoped gates green from the owning package directory after the final edit.
