# Y1 — fix cycle 2: one false claim in the sandbox turbo.json comment (implementation report 3)

## Objective

Delete the false half of one comment clause in `apps/sandbox/turbo.json`. The comment claimed
`tts-hosts.ts` "needs no entry — it belongs to `@hushbox/shared`, whose build this already
depends on"; the second half is false for this package (`@hushbox/sandbox#build` does not depend
on `@hushbox/shared#build`). Apply the deletion rule, not a rewrite. Comments only, one file, no
behaviour change, nothing in `apps/admin/`.

## Files changed

- `apps/sandbox/turbo.json` — comment text only (lines 11–13). No key, value, or list changed.

Nothing else. `apps/admin/turbo.json` untouched (evidence below).

## Old and new text

Old (`apps/sandbox/turbo.json:11-13`):

```
    // `tts-hosts.ts` needs no entry — it belongs to `@hushbox/shared`, whose
    // build this already depends on. Only `inputs` is overridden; `outputs`,
    // `dependsOn` and `env` are inherited from the root task.
```

New:

```
    // `tts-hosts.ts` needs no entry — no check on this app's TTS-free guard
    // path reads it. Only `inputs` is overridden; `outputs`, `dependsOn` and
    // `env` are inherited from the root task.
```

The third line's wrap moved only because the replacement clause is shorter; its text is
unchanged word for word. No line numbers, file paths, task IDs, or run references are in the
shipped comment.

## Grounding for the clause that was kept

The kept claim is "no check on this app's TTS-free guard path reads it". Each link verified by
reading the code this session:

| step | grounding |
| --- | --- |
| this app is declared TTS-free | `scripts/verify-web-bundle.ts:51` — `['apps/sandbox', false]` in `APPS_SHIPPING_TTS`, and `apps/sandbox/src/build.ts:46` calls `verifyWebBundle(appBundleOptions(…, 'apps/sandbox'))` |
| the TTS-free branch runs exactly three checks | `scripts/verify-web-bundle.ts:459-466` — `if (!options.shipsTts)` returns `checkNoTtsArtifacts` + `checkHeadersFile` + `checkPagesLimits` |
| none of those three reads anything from `tts-hosts.ts` | `checkNoTtsArtifacts` (`:404-416`) matches on the local regexes `WORKER_CHUNK` (`:335`) and `ORT_RUNTIME_FILE` (`:131`); `checkHeadersFile` (`:428-436`) matches the literal `_headers` (`:419`); `checkPagesLimits` (`:438-453`) uses the local byte/count caps (`:38-39`) |
| the guard's only consumer of `tts-hosts.ts` is on the other branch | `scripts/lib/ort-assets-plugin.ts:21` imports `TTS_ORT_WASM_PATH`, whose only guard-side use is `ORT_DIR` (`ort-assets-plugin.ts:39`), read in `verify-web-bundle.ts` at `:198`, `:200`, `:218`, `:222`, `:239` — inside `checkSelfHostedRuntime` (`:192-212`), `checkStrayRuntimeCopies` (`:213-230`) and `checkBundledRuntimeReferences` (`:231-269`), which are called only from the `shipsTts` branch (`:470-472`) |

Deliberate wording: `ORT_DIR` is *computed* at module load even on the TTS-free path, so
"`tts-hosts.ts` is not read" without qualification would have been shaky. "No **check** on this
app's TTS-free guard path reads it" is exactly what the code shows.

Adjacent fact confirmed while checking, so the "needs no entry" conclusion is not narrower than
the comment: the sandbox does not run `scripts/generate-headers.ts` (the other `tts-hosts.ts`
consumer) at all — `grep` over `apps/sandbox/` for `generate-headers|headers-vite-plugin`
returns nothing, its `build` script is `tsx src/build.ts`, and `apps/sandbox/public/_headers` is
a committed static file covered by `$TURBO_DEFAULT$`.

## What was deliberately NOT written

No replacement explanation of turbo's global-hash mechanism. The auditor's global-hash finding
is a true observation about how the protection currently arrives, but asserting it in the file
would be a fresh reach claim of exactly the class this run has now hit eleven times, and turbo's
global-hash contents are not something a reader can check from this file.

## Self-gate

| command | result |
| --- | --- |
| `npx prettier --check apps/sandbox/turbo.json apps/admin/turbo.json` | **pass** — "All matched files use Prettier code style!", exit 0 |
| `npx eslint turbo.json` from `apps/sandbox/`, after the final edit | exit 0 — one warning, "File ignored because no matching configuration was supplied" (ESLint's config does not match `.json`; prettier is the real formatting gate here, as in cycle 1) |
| `ESM_CDN_URL=… npx turbo run build --filter=@hushbox/sandbox` | **pass** — 2/2 tasks, `✓ sandbox dist assembled` |
| same build with `apps/sandbox/public/tts.worker-probe.js` planted | **fails as designed** — `Error: Web bundle verification failed (…/apps/sandbox/dist):` / `- TTS artifact in a bundle declared TTS-free: tts.worker-probe.js (9 B) — …`; `@hushbox/sandbox#build` exited 1 |
| probe removed, build re-run | **pass** — 2/2, `>>> FULL TURBO` |

Running through `turbo` rather than `pnpm` is deliberate: that path parses the edited
`turbo.json`, so a malformed file would fail the run rather than be ignored.

Not re-run, because a comment inside `turbo.json` cannot affect them: package tests, typecheck,
`arch:check`, `lint:unused`.

## Acceptance criteria

- **The false half deleted, one file. MET.** Diff is the three comment lines above; the
  `"whose build this already depends on"` clause is gone.
- **No rewrite asserting a new mechanism. MET.** The replacement is a narrower, code-checkable
  statement about the guard's TTS-free branch, grounded file:line in the table above.
- **`apps/admin/turbo.json` untouched. MET.** `git status --porcelain apps/admin` shows only
  `M apps/admin/vite.config.ts` (pre-existing, cycle 1) and `?? apps/admin/turbo.json`
  (untracked, cycle 1). Its mtime is `2026-07-27 18:46:30`, predating this session's only edit
  (`apps/sandbox/turbo.json`, `19:19:49`); no Edit call in this task targeted it.
- **No `inputs` list changed in either file. MET.** Sandbox `inputs` re-parsed after the edit:
  `["$TURBO_DEFAULT$",".env*","../../scripts/verify-web-bundle.ts","../../scripts/lib/ort-assets-plugin.ts","../../scripts/lib/is-main.ts","../../scripts/lib/run-main.ts"]`
  — byte-for-byte the cycle-1 list. Admin's file is unmodified, so its `inputs` is unchanged by
  construction.
- **No behaviour change, no test change. MET.** Only comment bytes moved; the plant/restore
  probe shows the guard fires and clears exactly as before.

## Deviations

None.

## Concerns and limitations

- The clause is true of the code as it stands. It would silently go stale if `checkHeadersFile`,
  `checkNoTtsArtifacts` or `checkPagesLimits` ever grew a `tts-hosts.ts`-derived value — the
  same standing drift cost every named-file `inputs` list in this pair of files carries, and the
  reason the clause is phrased as a checkable statement rather than a guarantee.
- The comment no longer says *why* an edit to `tts-hosts.ts` currently perturbs this package's
  hash anyway (turbo's global hash). That is intentional per the deletion rule; the fact lives
  in the run record, not the file.
- Untouched foreign breakage, attributed not fixed: `apps/api` is broadly red from another
  workstream's refactor, two `scripts/` test files fail at module load, and knip carries foreign
  findings. None are in any path this task touched, and none were re-run.

## Confidence

**High.** The change is three comment lines; every clause kept was traced to a file:line read
this session, the build was exercised in both the passing and the failing direction through
turbo, and the untouched-admin and unchanged-`inputs` properties were measured rather than
assumed.
