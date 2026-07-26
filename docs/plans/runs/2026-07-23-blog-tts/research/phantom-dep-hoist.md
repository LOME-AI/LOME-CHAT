# Phantom `onnxruntime-common` dependency — permanent fix analysis

Analyst, 2026-07-25 (written up by the orchestrator; the analyst has no write tools).

## Q1 — does `publicHoistPattern` reach the failing path? YES (Verified)

`publicHoistedModulesDir` **is** the workspace root `node_modules` (pnpm source `pnpm.mjs:187710, 189510, 189604`), and root `node_modules` **is** on the node-resolution walk from `apps/<app>/node_modules/.vite/deps/` — the exact basedir that fails today.

Proven empirically, not from spec: three packages that exist ONLY in root `node_modules` resolve fine from that basedir, while `onnxruntime-common` does not.

```
marketing  onnxruntime-common   ERR MODULE_NOT_FOUND
marketing  seedrandom           .../.pnpm/seedrandom@3.0.5/...
marketing  tsx                  .../.pnpm/tsx@4.22.4/...
marketing  drizzle-orm          .../.pnpm/drizzle-orm@0.45.2.../
```

`symlinkHoistedDependencies` writes to ONE target dir (`pnpm.mjs:181908`), so the link **moves** from `.pnpm/node_modules/` to `node_modules/` — a strict reachability superset (root is an ancestor of everything inside `.pnpm/**`), same realpath.

## Q2 — blast radius on the exact pin: provably NIL (Verified from pnpm source)

`createGetAliasHoistType` (`pnpm.mjs:181799-181812`) consults the pattern ONLY to choose the destination directory; `hoistGraph` (`:181847-181880`) sorts by depth then `lexCompare(nodeId)` and the first occurrence of an alias wins. With `hoistPattern: ['*']` already in force, `onnxruntime-common` flips `private`→`public`; both are truthy, so **traversal order and winning nodeId are byte-identical**. `packages/ui`'s depth-0 declaration still wins; 1.21.0 (via `onnxruntime-node`, depth 1) still loses.

- **Lockfile NOT invalidated.** `getOutdatedLockfileSetting` (`pnpm.mjs:189044`) keys on catalogs, overrides, packageExtensionsChecksum, ignoredOptionalDependencies, patchedDependencies, autoInstallPeers, dedupePeers, excludeLinksFromLockfile, peersSuffixMaxLength, pnpmfileChecksum, injectWorkspacePackages — `publicHoistPattern` is absent. A pattern change sets only `includeUnchangedDeps: true` (relink, not re-resolve). CI's `--frozen-lockfile` stays valid.
- No interaction with `overrides`/`patchedDependencies` (resolution-graph inputs; hoisting runs after the graph is fixed). The `vite: npm:rolldown-vite@7.3.1` override is unaffected.
- **Narrow the pattern to exactly `onnxruntime-common`** — `onnxruntime-*` would also public-hoist `onnxruntime-web` and `onnxruntime-node` (native binaries) for no benefit.

## Q3 — cannot move shipped bytes, and TWO premises corrected

1. **The two `dist/ort/` sha256s are NOT pins in code.** `checkSelfHostedRuntime` (`scripts/verify-web-bundle.ts:120-140`) compares `dist/ort/*` against `resolveOrtAssets()` — the *installed* files — so it guards staleness/partial copies, not version drift. Those files come from **transformers' own dist**, reached via a real dependency edge, so a hoist change cannot touch them.
2. **The real drift guard is `checkOrtCommonVersion`** — it reads every `versions: { common: … }` site in the built chunks and compares against `declaredOrtCommonVersion()`, read live from `packages/ui/package.json`. A hoist-order change that swapped the shipped ORT **would fail the build**, naming that cause. It also fails on zero sites (no vacuous pass). This is the safety net that makes acting here low-risk.

## Q4 — options

| | Option | Removes the failure mode? | Install / lockfile write? | Verdict |
|---|---|---|---|---|
| **A** | `publicHoistPattern: ['onnxruntime-common']` | Yes (removes the *sticky* property) | Install: yes (relink only). Lockfile: **no** | **Recommended** |
| B | Declare in each app's `package.json` | Yes | Install **and** lockfile write | Rejected — mirrored constant |
| B′ | Same via a `catalog:` entry | Yes | Lockfile write; **breaks `declaredOrtCommonVersion`'s exact-version regex** | Rejected |
| C | `shamefullyHoist` / `['*']` | Yes | Install, huge relink | Rejected — hides the bug class repo-wide |
| D | Accept + document `rm -rf apps/*/node_modules/.vite/deps` | No — symptom only | No | Viable fallback |
| E | Declare in the root `package.json` | Yes | Install + lockfile write + second literal + knip ignore | Rejected — dominated by A |
| F | `patchedDependencies` on transformers to declare the dep | **No** (fixes the phantom, not the dev symptom) | Install + lockfile write | Separate decision |
| G | Relocate Vite `cacheDir` inside `.pnpm` | Accidentally | No | Rejected — pnpm owns that dir |

B/B′/E each create a second copy of `1.22.0-dev.20250409-89f8206ba4` that must agree with `packages/ui`'s or dev silently prebundles a different ORT than prod ships — the banned mirrored-constant class, with no test to catch the drift (`declaredOrtCommonVersion` reads only `packages/ui`).

## Q5 — is it worth doing? Yes, with honest framing

`publicHoistPattern` does **not** close the poisoning window (the trigger is a window where the hoist link exists nowhere). What it removes is the **sticky-forever** property: once the install completes, `vite:import-analysis` resolving from `.vite/deps` would now *succeed* against the root copy and rewrite the import instead of throwing. `onnxruntime-common` is pure ESM (`type: module`), so it serves directly in dev, and in that degraded-but-working state there is still exactly one externally-served ORT module — `instanceof Tensor` holds.

So: **a multi-hour unexplained dev failure that survives every restart becomes a transparent no-op**, for one line of config, no code, no test, and no new warning to ignore. Categorically different from the deleted `optimizeDeps.include` guard (62 lines across three files producing a non-fatal warning that neither prevented nor diagnosed the failure). This deletes a failure mode instead of annotating it.

**Option D remains defensible**: the failure has fired once, is dev-only, and prod is provably unaffected. If the standing prior is "no new machinery without a second occurrence," D costs nothing today.

## Verification order if A is approved (an install cannot be run casually here)

*Before:* record `git diff --stat pnpm-lock.yaml` (existing foreign drift), `readlink node_modules/.pnpm/node_modules/onnxruntime-common`, and `ls node_modules/ | grep -c onnx` (expect 0).

*Change:* add to `pnpm-workspace.yaml` beside `overrides:`, with a comment stating the durable fact (transformers imports `onnxruntime-common` as an undeclared bare specifier; the dev optimizer's output directory cannot see the private hoist dir):
```yaml
publicHoistPattern:
  - onnxruntime-common
```

*After:*
1. `pnpm install --frozen-lockfile` — the safe form: fails rather than writes if out of sync, and since `publicHoistPattern` is not a lockfile setting, a clean run proves no rewrite.
2. `git diff --exit-code pnpm-lock.yaml` must show only the pre-existing foreign drift — zero new lines.
3. `ls -l node_modules/onnxruntime-common` → symlink into `.pnpm/onnxruntime-common@1.22.0-dev…`; `.pnpm/node_modules/onnxruntime-common` expected **gone** (moved, not copied) — correct, not a regression.
4. Resolution probe from `apps/marketing/node_modules/.vite/deps/` must now succeed (MODULE_NOT_FOUND today).
5. `rm -rf apps/*/node_modules/.vite/deps`, start both dev servers, drive the TTS worker, confirm the `kokoro-js` prebundle is still **4,218,418 bytes with zero bare specifiers** — i.e. ORT still *inlined*, not split into a second chunk. **This is the one Inferred item and the only way A could regress dev** (`instanceof Tensor` across two ORT copies).
6. Prod build + `verify:web-bundle`: `dist/ort/*` hashes unchanged and `checkOrtCommonVersion` still reports `1.22.0-dev.20250409-89f8206ba4`.

## Raised
- **Option F is the only option attacking the root cause**: patching `@huggingface/transformers` to declare `onnxruntime-common` would convert a hoist lottery into a real dependency edge and could retire the pin-as-hoist-hack framing (the pin, its knip ignore, and `checkOrtCommonVersion` are three pieces of machinery containing one upstream defect). `patchedDependencies` is already established here (`astro@5.18.2`). It does NOT fix the dev symptom and it does write the lockfile — a separate founder decision, not to be bundled with A.
- `apps/admin` exposure remains unverified; A would cover it automatically if it ever mounts the full accessibility panel, B/E would not.
