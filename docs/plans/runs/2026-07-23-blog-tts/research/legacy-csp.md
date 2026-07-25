# Legacy CSP ground truth + TTS-host + testability research (T1)

Scope: ground the Kokoro TTS model-download CSP fix in the deployed legacy
`connect-src`, identify which hosts the download actually touches, and assess
how to write a real anti-regression test. No code changed by this pass.

---

## 0. Premise check — IMPORTANT

The task's premise ("the legacy/deployed app's TTS worked in production, so
its CSP is the proven-correct source of truth") does **not hold**. **Verified**:
origin/main's `connect-src` (`git show origin/main:scripts/generate-headers.ts`,
commit `fce35f4d` — the confirmed deployed baseline per prior session's remote-
baseline audit) is **byte-for-byte structurally identical** to this repo's
current `scripts/generate-headers.ts:108-116` and contains **no Hugging Face
host of any kind**. The chat "read chat replies aloud" TTS feature (same
`kokoro-js`/`tts.worker.ts` code, unchanged) already exists on origin/main
(`packages/ui/src/components/accessibility/lib/tts.worker.ts` et al. all
present there). So on the evidence available, the legacy CSP was **never**
proven correct for TTS — it's equally exposed to the same missing-host defect,
just never surfaced as a support ticket. This matches a prior analyst's note
already in this run's `plan.md` (T1 design context): "Inferred consequence:
the first-ever model download is CSP-blocked in any deployed build that ships
these headers — for the existing chat read-aloud too, not just the blog...
plausibly a latent, never-observed defect." I found nothing that refutes
that — only more evidence supporting it. **This is a pre-existing, currently-
live production bug in origin/main's chat TTS, not something introduced by
the rewrite.** Flagging per instructions rather than fixing.

---

## 1. Legacy CSP (ground truth) — verbatim

**Verified** — `git show origin/main:scripts/generate-headers.ts` (origin/main
= `fce35f4de7c8a7294c0dea2246d096595819c8a0`), function `buildSpaHeaders`,
lines 95–151 of that blob (connect-src build at lines 108–116):

```
const connectSource = [
  "'self'",
  apiOrigin.http,
  'https://*.r2.cloudflarestorage.com',
  'https://*.r2.dev',
  'https://secure.myhelcim.com',
  apiOrigin.ws,
  ...(localR2Origin === null ? [] : [localR2Origin]),
].join(' ');
```

Full CSP header value (with `apiOrigin.http = https://api.hushbox.ai`,
`apiOrigin.ws = wss://api.hushbox.ai`, `localR2Origin = null` — the production
build path):

```
default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https://api.hushbox.ai https://*.r2.cloudflarestorage.com https://*.r2.dev https://secure.myhelcim.com wss://api.hushbox.ai; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

No `worker-src` directive is set (falls back to `child-src` → `script-src`,
so dedicated-worker *creation* is governed by `script-src`, not `connect-src`
— irrelevant to the model-download question since `tts.worker.ts` is a
same-origin Vite-bundled chunk either way). No `wasm-unsafe-eval` gap either
— it's already present in `script-src` (added for `hash-wasm`/argon2id), and
since `onnxruntime-web`'s WASM execution provider also calls
`WebAssembly.instantiate`, that token already covers it. **The only missing
piece is `connect-src` hosts** for the actual model-weight and runtime-wasm
network fetches.

**Where defined:** `origin/main:scripts/generate-headers.ts` (function
`buildSpaHeaders`, `origin/main` ref). There is **no** separate legacy
`_headers` static file, no wrangler/Vercel CSP config, and no CSP text
anywhere under the repo-root `/legacy/` quarantine directory (`find
legacy -iname '*header*' -o -iname '*csp*' -o -iname '_headers' -o -iname
'wrangler*' -o -iname 'vercel*'` → zero hits, **Verified**). `/legacy/` is a
different corpus entirely (old Vercel-AI-Gateway-era backend: `openai/tts-1`,
`elevenlabs/eleven-turbo` — **server-side generated audio content**, a
wholly different feature from the on-device Kokoro accessibility reader; zero
`kokoro`/`huggingface`/`transformers` hits under `/legacy/`, **Verified**).
The `apps/api/src/middleware/security.ts` Hono middleware CSP (`connect-src
'self'` only) is a separate, unrelated policy — it decorates the API
Worker's own JSON responses, not the SPA pages the browser renders and where
the TTS worker runs; the SPA's actual shipped CSP is entirely the
`scripts/generate-headers.ts` → `_headers` file path (Cloudflare Pages).

**Diff vs. this repo's current `scripts/generate-headers.ts`:** none in
`connect-src` construction — same array, same missing HF hosts, same
comments. (One immaterial diff: current file's `FILE_BANNER` comment for
`style-src` drops a stale reference to `apps/marketing/astro.config.mjs`
present in the origin/main banner text — cosmetic, unrelated to CSP
semantics.)

---

## 2. Which hosts the TTS model download actually needs

**Verified by reading the installed `@huggingface/transformers@3.8.1` source**
(`node_modules/.pnpm/@huggingface+transformers@3.8.1/.../src/env.js` and
`.../src/backends/onnx.js`) plus **live `curl` requests** against the exact
model repo this codebase pins (`onnx-community/Kokoro-82M-v1.0-ONNX`,
`tts.worker.ts:24`). `tts.worker.ts` calls `KokoroTTS.from_pretrained(MODEL_ID,
{dtype: 'q8', device: 'wasm', progress_callback})` with **no** `env`
overrides anywhere in this repo (**Verified** — grepped the whole file, no
`env.` reference at all) — kokoro-js just re-exports `@huggingface/
transformers`'s `env` (`export{...,Mf as env}` in `kokoro-js/dist/
kokoro.web.js`, **Verified**) and this repo never touches it, so every
library default applies unmodified.

Three distinct hosts are involved:

1. **`https://huggingface.co`** — `env.js:142`: `remoteHost:
   'https://huggingface.co/'` (**Verified**, default, unmodified). Small
   files (`config.json`, tokenizer configs) are served directly from this
   host — `curl -sIL https://huggingface.co/onnx-community/Kokoro-82M-v1.0-
   ONNX/resolve/main/config.json` → `307` to a **relative** `Location`
   (`/api/resolve-cache/models/...`, same-origin) → `200`, all on
   `huggingface.co` (**Verified live**, 2026-07-24).

2. **The Hugging Face Xet-CDN redirect target for large (LFS) files** —
   the actual model weights and voice `.bin` files are large and get a
   cross-origin `302` redirect off `huggingface.co`. **Verified live**, run
   three times for stability:
   ```
   curl -sI https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx
   → 302, Location: https://us.aws.cdn.hf.co/xet-bridge-us/...  (signed URL)
   ```
   Same host (`us.aws.cdn.hf.co`) for the voice embedding file
   (`voices/af_heart.bin`) and stable across 3 repeated requests. This is
   **not** the classic `cdn-lfs.huggingface.co` host the task's candidate
   list guessed — HF has migrated this repo's large-file storage to their
   newer "Xet" CDN, which serves from a **region-specific subdomain of
   `hf.co`** (`us.aws.cdn.hf.co` observed; other regions plausible, e.g.
   `eu.aws.cdn.hf.co` — not tested, would depend on the requesting client's
   apparent region). **A single literal host is not safe here — only a
   wildcard (`https://*.hf.co`) reliably covers this CDN tier**, matching the
   task's third candidate exactly. `cdn-lfs.huggingface.co` /
   `cdn-lfs-us-1.hf.co` (the task's second candidate) were **not observed**
   for this specific repo — Xet has superseded classic git-lfs redirects for
   it, at least as of this session.

3. **`https://cdn.jsdelivr.net`** — **not** one of the task's candidates, but
   real and load-bearing. `@huggingface/transformers`'s ONNX backend sets
   `onnxruntime-web`'s `env.wasm.wasmPaths` **unless the embedder already set
   it**:
   ```js
   // backends/onnx.js:205-212
   if (!(typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope)
       && !ONNX_ENV.wasm.wasmPaths) {
     ONNX_ENV.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${env.version}/dist/`;
   }
   ```
   This repo never sets `wasmPaths`, so the default applies: `onnxruntime-
   web`'s `.wasm` runtime binary is **fetched from jsDelivr at runtime, not
   bundled locally by Vite**. **Verified live**: `curl -sI https://
   cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-
   threaded.jsep.wasm` → `200`, `content-type: application/wasm`. Without
   `https://cdn.jsdelivr.net` in `connect-src`, the ONNX runtime itself can
   never initialize in a deployed build, independent of whether the model
   weights are reachable.

**CSP redirect-hop semantics** (relevant to finding #2): browsers check
`connect-src` at each hop of a cross-origin redirect chain, not just the
initial URL — so `huggingface.co` alone is insufficient even for the LFS/Xet
files; the redirect target's origin must also be allowed. This is standard
CSP3 `fetch`-directive behavior (not independently re-verified against a live
browser in this pass — flag as **Inferred**, though it is the documented,
widely-relied-upon behavior and is exactly why `curl -I` without `-L` was
used above to observe each hop's actual host).

**onnxruntime-web `.wasm` — fetched from a CDN, not bundled** (answering the
task's explicit question): confirmed above — it is a **runtime fetch from
`cdn.jsdelivr.net`**, not something Vite inlines/bundles from `node_modules`.
An alternative fix the implementer should weigh against allowlisting
jsdelivr: pin `env.backends.onnx.wasm.wasmPaths` in `tts.worker.ts` to a
same-origin, Vite-bundled URL (e.g. importing the `.wasm` asset via Vite's
`?url` handling and pointing `wasmPaths` at it) — this would remove the
jsdelivr dependency and its host from `connect-src` entirely. That is a
design decision for the plan/implementer, not this research task, but it
changes what "correct" `connect-src` looks like, so it's surfaced here.

**Required `connect-src` additions, distilled:**
- `https://huggingface.co` (hub API + small files)
- `https://*.hf.co` (Xet-CDN redirect target for model weights + voice data;
  literal `us.aws.cdn.hf.co` is not safe to hardcode — region-variable)
- `https://cdn.jsdelivr.net` (onnxruntime-web `.wasm`, unless the fix instead
  pins `wasmPaths` to a bundled same-origin asset, in which case this host is
  not needed at all)

None of `img-src`, `media-src`, `worker-src`/`child-src`, or
`wasm-unsafe-eval` need changes — the worker script itself is same-origin
(governed by existing `script-src`), `wasm-unsafe-eval` is already present,
and `ONNX_ENV.wasm.proxy = false` (`backends/onnx.js`, **Verified**, this
repo never overrides it) means no Blob-URL proxy sub-worker is spawned that
would need `worker-src blob:`.

---

## 3. Current header generation + test harness

**File:** `scripts/generate-headers.ts` (651 lines, **Verified** current
repo state — structurally unchanged from origin/main in the relevant
sections).

- **`buildSpaHeaders(apiOrigin, localR2Origin)`** (lines 95–151) — builds the
  strict SPA policy applied to every `apps/web` route (`/*` block). The
  `connect-src` array (lines 108–116) is **inline in this function**, not
  sourced from any shared constant file — it's a plain literal array.
- **`buildDemoHeaders`** (162–177) — derives the `/demo` iframe-relaxed
  variant from `buildSpaHeaders`'s output (only `frame-ancestors`/
  `X-Frame-Options` differ); inherits `connect-src` unchanged.
- **`buildAdminSpaHeaders`** (568–594) — a **separate, independent** CSP for
  the admin SPA (`admin.hushbox.ai`), `connect-src 'self'` only, no HF/TTS
  relevance (admin has no TTS code).
- Per-marketing-page blocks (`formatMarketingBlock`) and demo blocks
  (`formatDemoBlock`) all **inherit** `spaHeaders`'s `connect-src` verbatim —
  there is exactly **one** `connect-src` value for the whole `apps/web` dist
  (web app + all merged marketing pages + demo), and a **second, independent**
  one for the admin surface. So "per-surface" in the task's phrasing reduces
  to: web+marketing share one `connect-src` (what needs the HF hosts), admin
  has its own unrelated one (doesn't).
- **Output:** `generateHeaders()` writes `apps/web/dist/_headers`
  (Cloudflare Pages `_headers` format, `DEFAULT_OUTPUT` line 81);
  `generateAdminHeaders()` writes `<adminDistDir>/_headers` separately.
  Called from `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
  and `playwright.config.ts`'s web-server command chain (per the file's own
  header comment, lines 26–29).

**Existing test:** `scripts/generate-headers.test.ts` (**Verified**,
colocated, ~700 lines by line-range sampling) — extensively covers hashing,
block ordering, unset/reset semantics, demo-route relaxation, and
`connect-src` templating for API origin (`https://api.hushbox.ai` →
`wss://...`, `http://localhost:PORT` → `ws://...`) and the local MinIO
origin gate. **No existing assertion mentions Hugging Face, jsdelivr, or any
TTS-related host** — confirmed by grep (`huggingface|hf\.co|cdn-lfs|jsdelivr`
→ zero hits in this file). This is a real, uncovered gap, not an oversight in
this research — the test file simply predates the TTS-CSP concern.

**Runner:** `scripts` is its own pnpm workspace package
(`pnpm-workspace.yaml:8`, **Verified**) with `scripts/package.json`'s own
`test` script: `tsx ./with-env.ts tsx ./run-package-tests.ts --passWithNoTests`,
which wraps `vitest run --coverage` using `scripts/vitest.config.ts`
(**Verified**, a dedicated project: `name: 'scripts'`, `environment: 'node'`,
a **95% per-file** coverage gate on `*.ts`/`lib/**/*.ts`/etc. via
`perFile: true`). `pnpm test` (root) → `turbo test` runs this like every
other workspace package (`turbo.json`'s generic `"test"` task, **Verified**
— no scripts-specific exclusion). There's also `pnpm test:watch <path>` for
a single-file coverage-free run. Root `vitest.workspace.ts` only globs
`packages/*` and `apps/*` (**Verified**, does **not** include `scripts/`) —
that file is for the aggregated UI/browser-mode runner only; `scripts/`'s
own `vitest.config.ts` + turbo's per-package `test` task is the actual CI
path, independent of that workspace file. Net: a fix's test lives and runs
exactly where `generate-headers.test.ts` already lives, via `pnpm test`
(full) or `pnpm --filter @hushbox/scripts test` (scoped); no new suite
plumbing is needed.

---

## 4. Testability — proving the fix without a 90 MB download or shipping wrong

### 4a. Can a unit test derive the required host set from an independent,
in-repo source?

**Partially, and only if the implementer changes `tts.worker.ts` first.**
Today, nothing in this repo declares the required hosts — they are all
third-party library **defaults** buried in `node_modules/@huggingface/
transformers` (`remoteHost`, the jsdelivr `wasmPaths` template) that
`tts.worker.ts` never touches (§2, Verified). `MODEL_ID = 'onnx-community/
Kokoro-82M-v1.0-ONNX'` (`tts.worker.ts:24`) is a HF **repo id**, not a host —
there is no existing constant in this codebase that names a hostname a test
could import and assert against.

Two honest options, in order of preference:

1. **(Recommended) Make the engine own its hosts explicitly, then share
   them.** Have `tts.worker.ts` import `env` from `@huggingface/transformers`
   (or via `kokoro-js`'s re-export, already confirmed to exist — `export {
   ..., Mf as env }`) and **explicitly set** `env.remoteHost` and
   `env.backends.onnx.wasm.wasmPaths` (either pinning them to the same
   literal values the library defaults to today, or — better — pointing
   `wasmPaths` at a same-origin Vite-bundled asset per §2's alternative-fix
   note, eliminating the jsdelivr host requirement entirely). Export the
   chosen host(s) as a named constant from a module both `tts.worker.ts` and
   `scripts/generate-headers.ts` can import (e.g. a small `packages/shared`
   or `scripts/lib` module, per CODE-RULES "One Implementation, Shared" —
   never re-declare the literal in both places). Then a test genuinely
   derives the required `connect-src` entries from the same constant the
   engine runs on, and a future change to the pinned host **must** change in
   both places by construction (no possible drift) rather than relying on a
   second team member remembering to update a mirrored list. This also
   removes the "an unannounced upstream `@huggingface/transformers` minor
   bump changes the default CDN and silently reintroduces this exact bug"
   failure mode (real risk: this is precisely what happened in this research
   session — the classically-documented `cdn-lfs.huggingface.co` host turned
   out to be wrong for this repo's actual traffic, because HF migrated to
   Xet; an unpinned default is a moving target).
2. **(Weaker, but explicitly permitted by CODE-RULES for genuinely external
   authorities)** Without touching `tts.worker.ts`, define the required-host
   list as a literal constant (shared once between the generator and its
   test, still satisfying "one implementation, shared" for the *test*, even
   though it can't be derived from engine code) and comment it as a pinned
   snapshot of `@huggingface/transformers`'s current defaults, with a
   citation to the exact source lines found in §2 above, so a future
   dependency bump is at least discoverable by a comment audit, though not
   caught automatically by any test.

Either way, satisfies plan.md's T1 acceptance criterion #2 ("the host list
is written once (shared constant), not duplicated per surface") — a single
constant module, imported by `generate-headers.ts`'s `connectSource` array
build and by the test.

### 4b. Is CSP enforced anywhere in the existing test stack?

**Confirmed not in unit/integration tests.** `packages/config/vitest.config.ts`
sets `BROWSER_TEST_ENVIRONMENT = 'happy-dom'` (**Verified**, repo-wide
default browser-mode environment); grepping the installed `happy-dom` and
`jsdom` package sources for any `Content-Security-Policy` handling returned
**zero matches in either** (**Verified**) — neither DOM-emulation library
implements CSP parsing or fetch-blocking at all. A vitest test asserting the
generated header *string* contains the right tokens is the only thing
possible at that layer; it cannot prove a browser would actually honor them.

**A real, cheap enforcement point already exists, and is even wired into
CI-equivalent local E2E**: `scripts/lib/headers-vite-plugin.ts`
(**Verified**, read in full) is a Vite plugin, wired into `apps/web/vite.
config.ts` for **preview only** (per its own header comment) that parses the
generated `_headers` file and applies the exact matched headers — including
`Content-Security-Policy` — to every response `vite preview` serves,
byte-for-byte replicating Cloudflare Pages' `_headers` matching semantics
(rule order, `! Name` unset-then-reset, duplicate-header array-append
intersection bug reproduction — all explicitly called out in the plugin's
own comments as deliberate parity with production). `playwright.config.ts`'s
`webServer` array spawns exactly this (`pnpm --filter @hushbox/web preview
--port ...`, **Verified**) as the server Playwright's **real Chromium/
WebKit/Firefox browsers** drive for every E2E test. This means:

- **Feasible and cheap, yes.** A Playwright test navigating to any `apps/web`
  page, then executing `fetch('https://huggingface.co/...', {mode:
  'no-cors'})` (or simpler: listening for a `securitypolicyviolation` DOM
  event) inside `page.evaluate()`, gets **genuine browser-enforced CSP**
  against the real generated policy — no 90 MB download needed; a byte-sized
  request (or even a request that 404s) is enough to prove the connection
  either was or wasn't blocked by the policy before the browser attempted it.
  A companion assertion against a still-disallowed host (e.g.
  `https://evil.example.com`) proves the test isn't vacuously passing
  because CSP is silently not applied.
- This would sit naturally as an addition to whatever suite Playwright
  E2E already runs against `apps/web` preview — not a new standalone harness.
  Whether it's *worth* an E2E test given CODE-RULES's "When to Write an E2E
  Test" bar (user-facing flow / critical path / integration-only-observable
  behavior) is a call for the plan, not this research pass — but the
  infrastructure to do it cheaply and correctly already exists and needs
  zero new plumbing.

### 4c. `pnpm verify:evidence` / existing header-verification hooks

**None exist for headers/CSP.** `scripts/verify-evidence.ts` (**Verified**,
read via grep + its own usage banner: `pnpm verify:evidence
--require=ai-gateway,hookdeck`) is scoped entirely to asserting that
integration evidence for **external API integrations** (OpenRouter/AI-
gateway cassette replay, Hookdeck webhook delivery) actually ran — it has no
concept of headers, CSP, or static-asset generation, and nothing in its
requirement-name registry references either. There is no other header-
verification script in the repo (`grep -rn 'verify.*header\|header.*verify'`
outside `node_modules` found nothing beyond the files already covered
above). A CSP assertion has no existing hook to attach to; it would live
purely in `generate-headers.test.ts` (unit-level string assertions) and,
optionally per §4b, as a new/extended Playwright spec (real browser
enforcement) — both self-contained, no new CI wiring required beyond what
already runs those two suites.

---

## Distilled summary

- **Legacy `connect-src` (verbatim, origin/main `fce35f4d`,
  `scripts/generate-headers.ts:108-116`)**: `'self' https://api.hushbox.ai
  https://*.r2.cloudflarestorage.com https://*.r2.dev https://
  secure.myhelcim.com wss://api.hushbox.ai` — **zero Hugging Face hosts**.
  **Premise contradiction, flagged**: this is structurally identical to the
  current repo's `connect-src`, so the deployed/legacy app is **not** proof
  TTS-over-CSP works — the exact same gap exists in production today
  (latent, apparently never observed/reported).
- **TTS-specific hosts needed** (Verified via `@huggingface/transformers`
  source + live `curl`): `https://huggingface.co` (hub, small files),
  `https://*.hf.co` (wildcard required — Xet-CDN redirect target for large
  files is region-variable, observed `us.aws.cdn.hf.co`; classic
  `cdn-lfs.huggingface.co` was **not** observed for this model), and
  `https://cdn.jsdelivr.net` (onnxruntime-web `.wasm`, fetched at runtime by
  default — **not bundled by Vite**, unless the fix pins `wasmPaths` to a
  same-origin bundled asset instead, which would remove this host need).
- **Current generator**: single inline `connectSource` array in
  `buildSpaHeaders()` (`scripts/generate-headers.ts`), shared by web +
  merged marketing + demo (one `connect-src` for that whole surface); admin
  has its own separate, unrelated, `'self'`-only CSP. Output:
  `apps/web/dist/_headers` (+ a separate admin `_headers`). Existing test:
  `scripts/generate-headers.test.ts`, run via `scripts`'s own workspace
  `test` script (`scripts/vitest.config.ts`, 95% per-file coverage gate),
  which `pnpm test` picks up automatically via `turbo test` — no new runner
  plumbing needed.
- **Recommended testing approach**: (1) make `tts.worker.ts` **explicitly
  set** `env.remoteHost`/`env.backends.onnx.wasm.wasmPaths` (via `kokoro-js`'s
  re-exported `env`, confirmed available) instead of relying on undeclared
  upstream defaults, and export the chosen host(s) as one shared constant
  imported by both the engine and `generate-headers.ts`'s `connectSource`
  build — turns an implicit, driftable third-party default into a single,
  testable, owned source of truth (CODE-RULES "One Implementation, Shared");
  (2) extend `generate-headers.test.ts` to assert the generated `connect-src`
  is a superset of that constant, for both the web/marketing surface (the
  only one that needs it — admin doesn't run TTS); (3) optionally, for real
  browser-level proof with no 90 MB download, add/extend a Playwright spec —
  `scripts/lib/headers-vite-plugin.ts` already makes `vite preview` (which
  `playwright.config.ts`'s `webServer` already spawns) enforce the real
  generated CSP via genuine Chromium/WebKit/Firefox, so a tiny
  `page.evaluate()` fetch (or a `securitypolicyviolation` listener) against
  an allowlisted vs. a deliberately-disallowed host is cheap, real, and
  needs zero new infrastructure — this is a call for the plan against
  CODE-RULES's E2E bar, not mandatory. No `verify:evidence` hook exists or
  applies to headers/CSP.

## Gaps / not verified

- Whether other HF regions redirect to a different `*.hf.co` subdomain than
  `us.aws.cdn.hf.co` was not tested (no way to force a different apparent
  region from this environment) — the wildcard recommendation manages this
  risk rather than resolving it definitively.
- The exact browser-side CSP redirect-hop enforcement semantics (checking
  `connect-src` at each hop, not just the initial URL) were not re-verified
  against a live browser in this pass — treated as Inferred from well-
  documented CSP3 `fetch`-directive behavior, consistent with why the model
  weight file needs both `huggingface.co` and `*.hf.co` allowlisted.
- Did not check whether a `Content-Security-Policy-Report-Only` mode or a
  CSP reporting endpoint exists anywhere that would have surfaced this gap
  in production telemetry (out of scope for this pass; Workers Logs /
  Sentry config not inspected here).
- Did not benchmark or attempt an actual full model download in this
  session — all evidence for the Xet-CDN redirect host is from `HEAD`
  (`curl -I`) requests, sufficient to observe the redirect `Location` header
  without paying the ~90 MB transfer.
