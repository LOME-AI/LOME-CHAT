# X5a — impl report 1

## Objective

Make every admin build — including the production `vite build` that produces the deployed
`admin-dist` — run the bundle guard from admin's own config, and remove the explicit call
from `scripts/build-admin-bundle.ts` so one mechanism guards the property.

## Files changed

- `apps/admin/vite.config.ts` — the build-only dist-finalize plugin now runs
  `verifyWebBundle(appBundleOptions(rootDir, 'apps/admin'))` immediately after
  `generateAdminHeaders`, in the same `closeBundle` hook. Plugin renamed
  `adminHeadersPlugin` → `finalizeAdminDistPlugin` (vite name `generate-admin-headers` →
  `finalize-admin-dist`): the hook no longer only generates headers, and a name that says
  otherwise is a wrong comment. Local `envDir` alias folded into `rootDir` (one value, one
  name) — `rootDir` is what `appBundleOptions` needs.
- `scripts/build-admin-bundle.ts` — explicit `deps.verify(...)` call, the `verify` seam on
  `BuildAdminBundleDeps`, the `appBundleOptions`/`verifyWebBundle`/`VerifyBundle` imports,
  the CLI wiring of `verify`, and the scope comment X1's fix cycle wrote are all removed.
  The file-header doc now records *why* this script runs no guard.
- `scripts/build-admin-bundle.test.ts` — the two tests pinning the removed seam
  (`verifies the built admin dist…`, `verifies only after the build has produced the dist`)
  deleted, along with the `verify` mock. They pinned behavior that no longer exists at this
  seam; the behavior they protected is now pinned by the build itself (evidence below).

## Design decision worth recording

Verification went into the **same** `closeBundle` as `generateAdminHeaders`, not a second
plugin registered after it. Rollup runs `closeBundle` as a *parallel* hook — sibling
plugins' hooks are started together, so plugin array order does not sequence them. Two
sequential `await`s in one hook is the only ordering guarantee available, and the ordering
is load-bearing because `checkPagesLimits` counts emitted files and `_headers` is one.
Recorded in the file comment as a durable fact.

## TDD / evidence

All proof here is executable, at the level the criteria demand (a real production build);
there is no unit-level mirror, because the property under test — "the deployed artifact is
verified" — is only observable from a real build.

### RED (guard absent) — the gap this task closes, reproduced

Planted a reachable TTS import in `apps/admin/src/main.tsx`
(`import { getTtsService } from '@hushbox/ui/accessibility/lib/tts-engine'`), then ran the
production build on the **unmodified** config:

```
cd apps/admin && npx vite build      # exit 0
du -sb apps/admin/dist  ->  25,349,656
apps/admin/dist/assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm
apps/admin/dist/assets/tts.worker-CtNvlghX.js
```

The deployed build path shipped 25.3 MB of TTS artifacts and exited clean. Confirmed the
false-reach claim X1's audit raised.

### GREEN on the failing direction — same plant, guard wired

```
cd apps/admin && npx vite build      # exit 1
error during build:
Error: Web bundle verification failed (…/apps/admin/dist):
  - TTS artifact in a bundle declared TTS-free: assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm (21596019 B) — …
  - TTS artifact in a bundle declared TTS-free: assets/tts.worker-CtNvlghX.js (2324535 B) — …
    at verifyWebBundle (…vite.config.ts.timestamp-….mjs:1192:9)
    at async PluginContextImpl.closeBundle (…:1211:4)
```

`main.tsx` then restored; `git diff --stat apps/admin/src/main.tsx` is empty.

### Guard is live on the current (post-X2) app — second failing direction

With the app clean, planted `apps/admin/public/tts.worker-DECOY000.js` (8 B, copied into
dist by the build, so it exists when `closeBundle` runs):

```
cd apps/admin && npx vite build      # exit 1
  - TTS artifact in a bundle declared TTS-free: tts.worker-DECOY000.js (8 B) — …
```

This is the observable evidence that the verification **executes** on a production-mode
build of the current clean app — a passing build prints nothing. Decoy removed; `ls
apps/admin/public` is back to `favicon.ico` alone.

### Passing production build

```
cd apps/admin && npx vite build      # exit 0
du -sb apps/admin/dist   ->  1,420,819
ls apps/admin/dist       ->  _headers  assets  favicon.ico  index.html
ls apps/admin/dist/assets | grep -icE 'tts|ort-wasm'  ->  0
```

(1,420,819 B vs the 1,420,567 B quoted in the brief — a 252 B delta from other in-flight
changes in this working tree, not from this task. No worker chunk, no ORT wasm.)

### Criterion 3 — `pnpm build:e2e:admin` is still verified

The script's own call is gone. Re-planted the public-dir decoy and ran the real e2e entry
point (`NODE_ENV=development pnpm build:e2e:admin`, matching `ci.yml:419-421`):

```
@hushbox/admin:build: error during build:
@hushbox/admin:build: Error: Web bundle verification failed (…/apps/admin/dist):
@hushbox/admin:build:   - TTS artifact in a bundle declared TTS-free: tts.worker-DECOY000.js (8 B) — …
 ERROR  run failed: command  exited (1)
Command failed with exit code 1: turbo build '--filter=@hushbox/admin' -- --mode development
PIPE=1
```

So `--mode development` is verified too (`apply: 'build'` keys on the *command*, not the
mode), and the failure propagates out through turbo to the script's exit code. Decoy
removed; the clean `pnpm build:e2e:admin` then exited 0. Proven, not assumed.

### Criterion 2 — no second declaration

`grep -rn "shipsTts|APPS_SHIPPING_TTS|appBundleOptions"` over `apps packages scripts e2e`:
the only producers are `APPS_SHIPPING_TTS` and `appBundleOptions` in
`scripts/verify-web-bundle.ts`. Both call sites (`apps/admin/vite.config.ts`,
`scripts/build-web-bundle.ts`) read through `appBundleOptions`; no literal `shipsTts` value
exists outside the map and the tests. No check was reimplemented or copied.
`VerifyBundle` is still exported and still consumed by `scripts/build-web-bundle.ts`, so
removing admin's use leaves no dangling export.

## Self-gate

| command | result |
| --- | --- |
| `turbo test typecheck lint --filter=@hushbox/admin --force` | **pass** — 3/3 tasks, 0 cached |
| `turbo typecheck lint --filter=@hushbox/scripts --force` | **pass** — 2/2 tasks, 0 cached |
| `turbo test --filter=@hushbox/scripts --force` | **fail** — 88 passed / 2 failed files, 1868 tests passed; both failures foreign (below) |
| `vitest run scripts/build-admin-bundle.test.ts` | **pass** — 5/5 |
| `eslint .` from `apps/admin` | exit 0 (after last edit) |
| `eslint build-admin-bundle.ts build-admin-bundle.test.ts` from `scripts` | exit 0 (after last edit) |
| `prettier --check` on all three owned files | pass (after last edit) |
| production `vite build` of admin | exit 0 |

`apps/admin/vite.config.ts` is matched by admin's eslint ignore pattern, so `eslint .`
cannot format-check it. Ran `prettier --check` on it explicitly instead — clean.

### Attributed failures (not mine)

`scripts/refresh-catalog-run.test.ts` and `scripts/seed-run.test.ts` fail with
`[vitest] No "DESCRIPTOR_VERSION" export is defined on the "@hushbox/api/dev-seed" mock`.
The plan's KNOWN PRE-EXISTING FAILURES section already lists these two files for this gate
(it recorded a stale-`.vite`-cache cause; the current cause is a different foreign one — an
`@hushbox/api/dev-seed` export the tests' `vi.mock` does not stub, from the in-flight
`apps/api/src/platform/dev/*` work visible in `git status`). Neither file references
`build-admin-bundle` or any vite config; my diff is confined to three files that neither
imports. `generate-env.test.ts` and `lib/seed-documents.test.ts`, also listed as known-red,
are green in this run.

**Appeared mid-task, after my scoped gate had passed:**
`apps/api/src/slices/notifications/adapters/email-sender-factory.ts(63,63): error TS6133`
now breaks `@hushbox/admin`'s standalone `tsgo --noEmit` (admin devDepends on
`@hushbox/api` for `AppType`). It was **not** present when
`turbo … --filter=@hushbox/admin --force` ran green earlier in this task; the file is
foreign and untouched by me. Raised — see concerns.

## Acceptance criteria

1. **Verification runs from admin's build-only plugin, after `generateAdminHeaders`** — met.
   Same `closeBundle`, second sequential `await`; `apply: 'build'`. The rollup
   parallel-hook reason for not using a second plugin is recorded in the code.
2. **Same seam, no second declaration, nothing reimplemented** — met. Evidence above.
3. **Explicit call in `build-admin-bundle.ts` removed, scope comment removed,
   `build:e2e:admin` still verified** — met, proven by a failing e2e-entry-point build.
4. **Non-vacuous on a production-mode build** — met. RED baseline, two independent failing
   directions (reachable TTS import; planted dist artifact), and a passing clean build.

## Deviations

- Renamed the plugin (`adminHeadersPlugin`/`generate-admin-headers` →
  `finalizeAdminDistPlugin`/`finalize-admin-dist`) and folded the `envDir` alias into
  `rootDir`. Not asked for; the criteria change what the hook does, and CODE-RULES treats a
  name that no longer describes its subject as a wrong comment. `plan.md` §X5a's design
  context names the old symbol — plan.md is a run record and is not updated.
- Deleted two tests rather than writing a new failing one for the removal. The removal is a
  seam deletion; the tests pinned the deleted seam, and the guarantee they stood for is now
  pinned by the executable build evidence above.

## Concerns and limitations

- **Concurrent work in this checkout.** The brief stated nothing else was running. It is:
  between my `git status` snapshot and my final check, `apps/api/src/slices/notifications/**`,
  `apps/web/src/components/document-panel/**`, `packages/db/**` and several other run
  directories changed under me, and one of those edits currently breaks admin's typecheck
  (above). Nothing was touched or reverted on my side.
- **`pnpm generate:env` rewrote `.github/workflows/ci.yml`** while restoring local env after
  `build:e2e:admin` (which regenerates env in E2E mode as it always has). The resulting diff
  is entirely FCM env lines derived from another workstream's `packages/shared/src/env.config.ts`
  change; the file was already modified before I started, and the same regeneration happens
  in pre-commit. Flagged because **X5b edits `ci.yml` next** and should expect that diff.
- **`vite dev` / `vite preview` are not empirically re-verified.** The plugin's applicability
  is unchanged by this task — I added a statement inside an existing `apply: 'build'` hook
  that already skipped serve — so no new command can reach it. Inferred from Vite's `apply`
  semantics plus the pre-existing behavior of the headers generation, not re-measured; the
  build-mode proof was run for both production and `--mode development`.
- **Turbo caching.** A cached `@hushbox/admin#build` replays a dist without re-running the
  guard. That is sound (the cached artifact was verified when produced) but worth knowing:
  all builds in this report were forced or cache-missed.

## Confidence

**High.** Both directions of the guard are demonstrated on the real deployed build path with
observed output, the removal is proven not to lose e2e coverage, and the scoped gates are
green apart from two failures attributed to other workstreams with evidence.
