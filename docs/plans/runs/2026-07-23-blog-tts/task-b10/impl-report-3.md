# impl-report-3 — delete the optimizeDeps guard + reproduce the dev error

Two jobs: (1) remove the `optimizeDeps.include` guard for `onnxruntime-common` entirely
(founder ruling); (2) reproduce the founder's dev-server import error on the resulting
clean tree, diagnose only — no fix.

---

## JOB 1 — guard deleted

### Files changed

| File | Change |
|---|---|
| `scripts/lib/ort-assets-plugin.ts` | Deleted `KOKORO_ORT_COMMON_INCLUDE` and its 39-line doc block. `ORT_EXTERN_WASM_CONDITION`, `ORT_DIR`, `UI_PACKAGE_JSON`, `ortDistributionDir`, `collectOrtAssets`, `resolveOrtAssets`, `contentTypeFor`, `ortAssetsPlugin` untouched. |
| `apps/web/vite.config.ts` | Removed the `optimizeDeps: { include: … }` block; import collapsed to `import { ORT_EXTERN_WASM_CONDITION, ortAssetsPlugin } from '../../scripts/lib/ort-assets-plugin';`. |
| `apps/marketing/astro.config.mjs` | Same removal inside `vite: {}`; same import collapse. |

### Proof the guard is gone

`grep -rn "KOKORO_ORT_COMMON_INCLUDE\|kokoro-js > onnxruntime-common"` excluding
`node_modules`/`.git` matches **only** four files, all run records under
`docs/plans/runs/2026-07-23-blog-tts/` (`plan.md`, `research/dev-resolution-break.md`,
`task-b10/impl-report-1.md`, `task-b10/impl-report-2.md`). Zero source matches.
`grep -n optimizeDeps` across the three touched files: zero matches.

### Checks

| Check | Result |
|---|---|
| `turbo typecheck lint --filter=@hushbox/web --filter=@hushbox/marketing --filter=@hushbox/scripts --force` | pass — 6/6 tasks |
| `vitest run lib/ort-assets-plugin.test.ts verify-web-bundle.test.ts` (from `scripts/`) | pass — 2 files, 33 tests |
| `prettier --check` on the three files | "All matched files use Prettier code style!" |

Ambient warnings during typecheck are pre-existing and unrelated: the
`optimizeDeps.rollupOptions` deprecation, the `plugin-react-oxc` recommendation, and
rolldown's `Invalid key: "jsx"`.

### `dist/ort/` sha256 pins — unaffected

`ortAssetsPlugin.generateBundle` emits `readFileSync(asset.absPath)` verbatim, so the
emitted bytes are the resolved source bytes. Hashing what `resolveOrtAssets()` resolves:

```
08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9  ort-wasm-simd-threaded.jsep.mjs
c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39  ort-wasm-simd-threaded.jsep.wasm
```

Both match the pins exactly. Expected: `optimizeDeps` is dev-only and never reached the
build.

---

## JOB 2 — reproduction attempt

### Verdict

**No. The founder's error does not reproduce on this tree with the guard deleted.**

Four independent fresh optimizes of `kokoro-js` (two dev-server sessions) all resolved
`onnxruntime-common` and inlined it. The full founder flow — real blog post page, island
mount, click Listen — works end to end.

### What was run

1. `rm -rf apps/marketing/node_modules/.vite/deps` (plus two stale `deps_temp_*` dirs).
2. `HB_ASTRO_PORT=4399 npx astro dev`, stdout+stderr to one log. Port 4399 only; the
   other workstream's vite on :5399 was never touched.
3. Real blog slug enumerated from `apps/marketing/src/content/blog/*.mdx` →
   `/blog/what-is-opaque-authentication/`.
4. Two probes: (a) HTTP module-graph walk following the real import chain; (b) a Chrome
   session that loaded the page and clicked Listen.

### Evidence A — module-graph walk (HTTP)

Requesting the worker source through the dev server transforms it and rewrites the bare
specifier, exactly as the browser receives it:

```
import { KokoroTTS, env } from "/node_modules/.vite/deps/kokoro-js.js?v=ddf51401";
```

Fetching that emitted URL — the exact request whose import-analysis produces the founder's
error:

```
attempt 1: worker transform emitted /node_modules/.vite/deps/kokoro-js.js?v=ddf51401
attempt 1: GET /node_modules/.vite/deps/kokoro-js.js?v=ddf51401 -> HTTP 200, 4218418 bytes
on-disk prebundle copied: 4218286 bytes
```

4,218,418 bytes is byte-for-byte the size `research/dev-resolution-break.md` recorded for
the healthy prebundle. Parsing the served file for real ESM `from` specifiers yields only:

```
/@vite/client
/node_modules/.vite/deps/chunk-XkmBru0b.js?v=300b6c0e
```

Zero bare specifiers, zero side-effect imports. All 41 occurrences of the string
`onnxruntime-common` are `//#region` path comments over inlined source:

```
//#region ../../node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common/dist/esm/backend-impl.js
//#region ../../node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common/dist/esm/version.js
//#region ../../node_modules/.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/node_modules/onnxruntime-common/dist/esm/env-impl.js
```

The version inlined is the exact pin `packages/ui` declares.

### Evidence B — real browser, real click

Chrome loaded `/blog/what-is-opaque-authentication/`; the `client:visible` island mounted
and rendered the Listen button; clicking it spawned the worker pool. Network log shows
four `tts.worker.ts?worker_file&type=module` → 200 and four
`/node_modules/.vite/deps/kokoro-js.js?v=…` fetches.

After the first-click optimize settled, a second click reached the running state — the
button label became **"Pause"**, and the ORT runtime inside the prebundle emitted its own
model-fetch warning, proving the module resolved *and executed*:

```
[WARNING] Unable to determine content-length from response headers. Will expand buffer when needed.
          @ http://localhost:4399/node_modules/.vite/deps/kokoro-js.js?v=4732d74a:37423   (×4, one per pool worker)
```

The only console errors in the whole session are unrelated dev-stack absences:

```
[ERROR] Failed to load resource: net::ERR_CONNECTION_REFUSED @ http://localhost:8788/announcements/banner
[ERROR] Failed to load resource: net::ERR_CONNECTION_REFUSED @ http://localhost:7200/api/crawl?url=…
```

No `Failed to resolve import`. No `The file does not exist at … optimize deps directory`.

### Evidence C — terminal, verbatim

Second session's complete log with the three known ambient warnings filtered out:

```
`optimizeDeps.rollupOptions` / `ssr.optimizeDeps.rollupOptions` is deprecated. Use `optimizeDeps.rolldownOptions` instead. Note that this option may be set by a plugin. Set VITE_DEPRECATION_TRACE=1 to see where it is called.
13:49:37 [WARN] [vite] [vite:react-babel] We recommend switching to `@vitejs/plugin-react-oxc` for improved performance. More information at https://vite.dev/rolldown
13:49:37 [types] Generated 1ms
13:49:38 [content] Syncing content
13:49:38 [content] Astro config changed
13:49:38 [content] Clearing content store
13:49:38 [content] Synced content
13:49:38 [vite] Re-optimizing dependencies because vite config has changed
 astro  v5.18.2 ready in 1978 ms
┃ Local    http://localhost:4399/
┃ Network  use --host to expose
13:49:38 watching for file changes...
`transformWithEsbuild` is deprecated and will be removed in the future. Please migrate to `transformWithOxc`.
13:49:46 [200] /blog/what-is-opaque-authentication/ 446ms
13:49:47 [200] /blog/what-is-opaque-authentication/ 18ms
13:49:52 [vite] ✨ new dependencies optimized: kokoro-js
13:49:52 [vite] ✨ optimized dependencies changed. reloading
13:49:52 [200] /blog/what-is-opaque-authentication/ 36ms
```

The first session's optimize lines, same result three more times:

```
13:37:21 [vite] ✨ new dependencies optimized: kokoro-js
13:37:21 [vite] ✨ optimized dependencies changed. reloading
13:38:11 [vite] ✨ new dependencies optimized: kokoro-js
13:38:11 [vite] ✨ optimized dependencies changed. reloading
13:40:32 [vite] ✨ new dependencies optimized: kokoro-js
13:40:32 [vite] ✨ optimized dependencies changed. reloading
```

The prebundle left on disk at the end:

```
-rw-rw-r-- 1 dev dev 4218286  apps/marketing/node_modules/.vite/deps/kokoro-js.js
from-specifiers: ./chunk-XkmBru0b.js
inlined onnxruntime-common region markers: 14
```

---

## Diagnosis

### The recorded mechanism is confirmed, not contradicted

Every load-bearing claim in `research/dev-resolution-break.md` re-verified on the current
tree:

| Claim | Status |
|---|---|
| `onnxruntime-common` is a phantom dep of `@huggingface/transformers` | Verified — transformers 3.8.1 declares `@huggingface/jinja`, `onnxruntime-node`, `onnxruntime-web`, `sharp`; its `dist/transformers.web.js` imports `onnxruntime-common` bare |
| transformers' peer dir lacks it | Verified — `.pnpm/@huggingface+transformers@3.8.1/node_modules/` holds `@huggingface`, `onnxruntime-node`, `onnxruntime-web`, `sharp` only |
| It resolves solely through pnpm's hoist dir | Verified — `node_modules/onnxruntime-common` does **not** exist; `node_modules/.pnpm/node_modules/onnxruntime-common` **does** (symlink, created Jul 25 01:04) |
| Healthy prebundle = 4,218,418 bytes served, ORT inlined from `.pnpm/onnxruntime-common@1.22.0-dev…`, zero bare specifiers | Verified — reproduced exactly |
| Verdict "poisoned optimizer cache, NOT a design regression" | Confirmed |

Nothing differs. The doc's Option A (clear `.vite/deps`, restart) is the whole fix, and
step 1 of this reproduction procedure *was* Option A.

### Why the founder still sees it — the cache a private window cannot clear

The founder's instinct that a private window rules out caching is half right and half
wrong. A private window clears the **browser** cache, which matters because Vite serves
`.vite/deps` with `Cache-Control: max-age=31536000,immutable`. It does nothing to the
**server-side** cache — `apps/marketing/node_modules/.vite/deps/kokoro-js.js` — which is
where the poisoned artifact lives. A poisoned prebundle is re-served identically to every
window, private or not, and survives browser restarts, profile wipes, and page reloads.
Only `rm -rf` on that directory plus a dev-server restart clears it.

That is consistent with everything observed: this session began by deleting that exact
directory, and the error has not been seen since, across four optimizes and two full
browser sessions.

### Evidence limitation — state this plainly

The prescribed step 1 (`rm -rf apps/marketing/node_modules/.vite/deps`) **destroyed the
one artifact that could have proven the founder's cache was poisoned**. That directory
existed at session start alongside two stale `deps_temp_*` dirs (the signature of
interrupted optimizes). Its contents were not captured before deletion. The poisoned-cache
explanation is therefore strongly supported by consistency but not directly proven for the
founder's specific failure.

Two searches were run to recover an equivalent artifact and both came back empty:

- `apps/{web,marketing,admin,sandbox}/node_modules/.vite/deps/kokoro-js.js` — all absent.
- All 16 sibling git worktrees under `/home/popper-mobile/.superset/worktrees/HushBox/` —
  three have a marketing `.vite/deps`, none contains a `kokoro-js.js` (they sit on
  pre-TTS commits).

**Next time the founder hits this, copy the file before clearing anything:**
`cp apps/marketing/node_modules/.vite/deps/kokoro-js.js /tmp/poisoned-kokoro.js`. If its
first line is `export * from "onnxruntime-common"` the diagnosis is closed for good.

### Second observation, not the reported bug

Every first click on Listen with a cold dep cache costs a full page reload:
`new dependencies optimized: kokoro-js` → `optimized dependencies changed. reloading`
(~14 s here). The reload kills the just-spawned worker; the user must click Listen again.
This is standard Vite discover-and-reoptimize behavior, dev-only, and produces no error —
but it is a real first-use wart on the Listen flow and could plausibly be misremembered as
"Listen is broken". It is *not* the `Failed to resolve import` error and no change is
proposed for it here.

### Options (nothing applied)

| # | Option | Closes the poisoning window? | Cost |
|---|---|---|---|
| **A** | Founder runs `rm -rf apps/*/node_modules/.vite/deps` and restarts dev. Already effectively done for `apps/marketing` in this checkout. | No — remedy, not prevention | Zero. One optimize (~15 s) on next start. |
| **B** | Re-add the `optimizeDeps.include` guard | Converts silent poisoning into a named startup warning | Founder ruled it out; not re-proposed |
| **C** | pnpm `publicHoistPattern` for `onnxruntime-*`, hoisting it into the root `node_modules` | **Yes, structurally** — resolvable from every basedir including `.vite/deps`, so the window cannot open | Needs `pnpm install` (blocked here); workspace-wide blast radius; `.npmrc` currently sets no hoist config at all |
| **D** | Declare `onnxruntime-common` in each app's `package.json` | Yes for those apps | Mirrored constant across two manifests; needs install |
| **E** | Accept and document | No | The window only opens during `pnpm install` (between the lockfile write and hoist-link creation). Cost is a rare multi-hour debugging trap with an error naming neither cause nor cache. |

C is the only option that removes the failure mode rather than detecting or curing it, and
it is the one this session could not test because installs are blocked. Recommend the
founder decide between A+E (accept, document the `rm -rf` remedy) and C.

---

## Concerns and limitations

- **Concurrent-workstream interference was severe.** Another workstream rewrites
  `../../.env.development`; because `envDir: '../..'`, Vite watches it and restarts. The
  first dev session restarted ~8 times in 10 minutes, eventually wedging (process alive,
  no listener) and forcing a clean restart. Every restart also logged
  `Re-optimizing dependencies because vite config has changed`, which on the founder's
  quieter machine would not fire — meaning a poisoned cache there is *more* persistent
  than anything reproducible here (Inferred).
- Another workstream is mid-refactor of `packages/shared` (moving modules into
  `src/affordability/`). For ~3 minutes the tree was transiently broken and every blog page
  500'd with `Could not import ./fees.js` (`src/index.ts` still pointed at the old path).
  It self-resolved. Unrelated to this task; not touched.
- A 24-worker vitest suite was loading the machine throughout.
- The reproduction attempt is negative evidence. It proves the current tree optimizes
  cleanly and the Listen flow works; it cannot prove the founder's machine is in the same
  state.

## Confidence

**High** on Job 1: greps clean, all checks green, ORT pins byte-identical.

**High** on the Job 2 verdict (does not reproduce on this tree): four independent
optimizes plus a working end-to-end browser click.

**Medium** on the causal explanation for the founder's persisting error: the
poisoned-cache mechanism is fully verified and the private-window reasoning is sound, but
the founder's actual poisoned artifact was destroyed by step 1 and could not be inspected.
