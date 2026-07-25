# Dev-server `onnxruntime-common` resolution failure — diagnosis

Analyst, 2026-07-25 (written up by the orchestrator; the analyst has no write tools).

Symptom (dev only, clicking Listen on a blog post):
`[plugin:vite:import-analysis] Failed to resolve import "onnxruntime-common" from "node_modules/.vite/deps/kokoro-js.js?v=836583e9"`

## Verdict: poisoned optimizer cache, NOT a design regression

Fresh dep-optimize on the current tree resolves and inlines `onnxruntime-common` correctly — Verified by driving the real TTS worker module through both dev servers: marketing (`astro dev`) served `/node_modules/.vite/deps/kokoro-js.js` at 200, 4,218,418 bytes, ORT inlined from `.pnpm/onnxruntime-common@1.22.0-dev.20250409-89f8206ba4/…`, **zero bare specifiers left**; web (`vite`) produced a byte-identical 4,218,418 output.

**Immediate unblock:** stop dev, `rm -rf apps/marketing/node_modules/.vite/deps apps/web/node_modules/.vite/deps`, restart, hard-reload the browser (Vite serves `.vite/deps` with `Cache-Control: max-age=31536000,immutable`).

## Mechanism (Verified)

`@huggingface/transformers@3.8.1`'s browser build has two external bare imports (`dist/transformers.web.js:1-2`), one of them `onnxruntime-common` — a **phantom dependency**: transformers imports it without declaring it. Its peer dir contains only `@huggingface`, `onnxruntime-node`, `onnxruntime-web`, `sharp`. It resolves solely through pnpm's hoist dir.

Two different resolution basedirs, confirmed with `createRequire().resolve()`:

| basedir | result |
|---|---|
| `.pnpm/@huggingface+transformers@3.8.1/…/transformers.web.js` | resolves (hoist dir is on the node-walk) |
| `.pnpm/kokoro-js@1.2.1/…/kokoro.js` | resolves |
| `apps/marketing/node_modules/.vite/deps/kokoro-js.js` | **MODULE_NOT_FOUND** |

The walk from a file inside `.pnpm/**` includes `.pnpm/node_modules` (the hoist dir); the walk from `apps/<app>/node_modules/.vite/deps/` does not. Production is unaffected because Rollup resolves against the *real importer file*, always inside `.pnpm`; `optimizeDeps` is dev-only.

**The trigger — two rolldown-vite behaviors, both reproduced in a scratchpad:**
1. The optimizer **silently externalizes** a bare import it cannot resolve — no error, no warning; the emitted file simply begins `export * from "<unresolvable>"`.
2. That output is then **reused forever**: re-running optimize after making the package resolvable prints `Hash is consistent. Skipping. Use --force to override.` and keeps the broken file.

**The poisoning window** (Verified timestamps): `packages/ui/package.json` edited 00:57:49 → `pnpm-lock.yaml` written **00:59:14** (Vite's cache key becomes final here) → hoist link `.pnpm/node_modules/onnxruntime-common` created **01:04**. Any kokoro-js optimize between 00:59:14 and 01:04 emitted an externalized `onnxruntime-common` stamped with the final cache key — permanently sticky.

## Why the dependency change did NOT cause it

The only dev route to `onnxruntime-common` was *always* the hoist dir, reached from transformers'/kokoro's own directory — never `packages/ui/node_modules`, which is not on the walk from `apps/*/node_modules/.vite/deps` either. So the direct declaration neither created nor removed a dev path. What it changed is **which version the hoist dir carries** (both `1.21.0` via `onnxruntime-node` and `1.22.0-dev` via `onnxruntime-web` exist in `.pnpm`; pnpm hoists exactly one). Dev worked before for the same reason it works now on a clean cache.

## Affected surfaces
- **`apps/marketing`** — the surface hit (the Listen island is `client:visible` in `[slug].astro`; Astro's cacheDir is `apps/marketing/node_modules/.vite/deps`).
- **`apps/web`** — identical exposure via the same worker (chat read-aloud); it simply hadn't optimized kokoro yet. Forced optimize succeeds.
- `apps/admin` imports only `A11yProvider`/`MotionProvider`; possible third surface if it ever mounts the full panel — unverified.

## Options

| # | Option | Fixes dev? | Shipped bytes | Keeps one converged pinned ORT? |
|---|---|---|---|---|
| **A** | Clear `.vite/deps`, restart | Verified yes | unchanged | preserved |
| **B** | `optimizeDeps.include: ['kokoro-js > onnxruntime-common']` in both app configs, constant exported once from `scripts/lib/ort-assets-plugin.ts` | yes — converts silent poisoning into a named startup error | unchanged (dev-only) | preserved (Verified: single shared chunk) |
| C | `optimizeDeps.exclude` | yes | unchanged | dev topology ≠ prod |
| D | `resolve.alias` → hoisted path | yes | **at risk — leaks into the build** | opaque override |
| E | Declare in each app's package.json | yes | unchanged | banned mirrored constant; needs install |
| F | pnpm `publicHoistPattern` | yes | unchanged | workspace-wide blast radius; needs install |
| G | Revert to `onnxruntime-web` | **no** (poisoning is orthogonal) | **changes** | **destroyed** — the `Tensor` split returns |

**Recommendation: A now, then B.** B names the phantom dependency at the one place that must resolve it, is dev-only so the verified `dist/ort/` bytes cannot move, keeps a single ORT instance in dev, and replaces a silent multi-hour debugging trap with a fail-fast named error (`Failed to resolve dependency: … present in client 'optimizeDeps.include'`). Put the entry behind one exported constant in `ort-assets-plugin.ts` so it is not a mirrored literal.

**G is strictly worse** — it does not fix dev and gives back the version split.

## Raised
- Latent and unfixed by A: `onnxruntime-common` is a phantom dep of transformers, so **any `pnpm install` run while a dev server is up can re-poison the cache** with the same unhelpful error. That is the case for B.
- The investigation regenerated both apps' `.vite/deps` (cache dirs only); both are healthy.
