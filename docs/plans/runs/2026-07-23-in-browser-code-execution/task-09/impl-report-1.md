# T9 — Maestro Android flow (impl report 1)

## Objective

One new Maestro flow proving a runnable HTML document actually RENDERS inside the
real Capacitor Android WebView on-device, asserting app-DOM state programmatically
(no screenshots, R13/A4). Plus the harness wiring that serves + adb-reverses the
sandbox origin so the emulator's WebView can reach it.

## Files changed

- `mobile-tests/flows/14-document-renders.yaml` (new) — the flow: login as `tmu` →
  open sidebar → open the seeded HTML-document conversation → open the document card
  → assert the sandbox render completed via the app-origin status mirror.
- `scripts/mobile-test.ts` — harness wiring for the flow's build mode:
  - `requireSandboxPort()` — fail-fast read of `HB_SANDBOX_PORT` (mirrors `requireApiPort`).
  - `setupAdbReverse()` / `prepareAdbServer()` — now also `adb reverse tcp:<sandboxPort>`
    on each emulator, alongside the existing API reverse, so the WebView's
    `localhost:<sandboxPort>` (the baked `VITE_SANDBOX_ORIGIN_URL`) reaches the host.
  - `startSandboxOrigin()` / `stopSandboxOrigin()` — spawn/kill the `@hushbox/sandbox`
    dev server serving the renderer pages (mirrors `startDevApi`/`stopDevApi` exactly;
    reuses an already-serving origin; polls `/render.html`).
  - `seedDocumentConversation()` + `documentSeedPayload()` + `DOCUMENT_SEED_*`
    constants — seed a conversation for the mobile persona whose assistant message
    carries a fenced, import-free HTML document, via the `dev-only` `/dev/conversation`
    route on the running API.
  - `main()` — starts the sandbox origin alongside the API, seeds the conversation
    after the API is up, and tears the origin down in the `finally`.
- `scripts/mobile-test.test.ts` — pins `HB_SANDBOX_PORT` in the top-level setup;
  adds coverage for every new function/branch and for the new sandbox adb-reverse.

## Tests added (name — behavior — criterion)

- `startSandboxOrigin` describe (5 tests) — reuse-when-ready, spawn-when-not-ready,
  survives an immediately-dying subprocess, fail-fast on missing `HB_SANDBOX_PORT`,
  throws on never-ready timeout. Covers the serve wiring.
- `stopSandboxOrigin` describe (4 tests) — null no-op, kills the process, best-effort
  on kill throw (Error + non-Error). Covers teardown.
- `document conversation seed` describe (4 tests) — payload owns the persona + carries
  the fenced HTML; the fenced body is ≥ `MIN_LINES_FOR_DOCUMENT` (15) so the web parser
  extracts it as a runnable document; POSTs to `/dev/conversation` on the API port;
  fail-fast on missing `HB_API_PORT`. Covers deterministic-document criterion.
- `startEmulator` — "also reverses the sandbox port …" — pins the sandbox adb-reverse
  (the sandbox-reachability wiring).

## Self-gate

- `npx eslint mobile-test.ts mobile-test.test.ts` (from `scripts/`) — **pass** (exit 0,
  after the final edit; repo-root eslint no-ops under v9, per the known gotcha).
- `tsgo --noEmit` (from `scripts/`) — **pass** (exit 0).
- `vitest run scripts/mobile-test.test.ts` — **pass**, 144/144.
- Coverage (`--coverage.include=mobile-test.ts`) — **pass**: 100% stmts / 100% funcs /
  100% lines / 96.35% branch (gate 95%). The 3 uncovered branches (`flowWeight`,
  `weighFlows`, `leastLoadedWithCapacity`, `parseFailedFlowNames`) are pre-existing, not
  my additions; every new function/branch is covered.
- Flow YAML — parses cleanly (config + 21 well-formed steps; `devtools` flag; final
  step asserts `Preview rendered`). Auto-discovered by `fullFlowsExcludingOta()`
  (13 flows now, includes `14-document-renders.yaml`); `flowWeight()` computes it without
  error (21 steps, 2 short `${VAR}` inputs — weights like the other login flows).

## Acceptance criteria

- **New flow in `mobile-tests/flows/`, login → open HTML-doc conversation → open panel →
  programmatic proof via devtools hierarchy** — met (structurally). The flow follows the
  suite conventions exactly (inline `tmu` login mirroring flows 10/12, `id:` selectors,
  `extendedWaitUntil`, `androidWebViewHierarchy: devtools`). The proof asserts the visible
  text `Preview rendered`, which the panel's `#document-render-status` mirror
  (`StatusMirror`, `apps/web/.../document-sandbox.tsx`) emits ONLY at `status === 'rendered'`,
  reached ONLY on a bridge `rendered` message from the sandbox iframe — proving real
  execution, not panel-open. NO screenshots.
- **Registered + weighted in the harness** — met. Registration is automatic
  (`fullFlowsExcludingOta()` = `readdirSync` of the flows dir minus OTA) and weighting is
  automatic (`flowWeight()` / `partitionByWeight()`). `mobile-tests/config.ts` holds only
  `SHARDS` and needs no per-flow entry (see deviations). Adding a flow reweights the shard
  split automatically; no `SHARDS` bump is warranted for one added flow.
- **Sandbox origin reachable from the emulator's WebView** — met (wiring authored):
  `startSandboxOrigin()` serves it on `HB_SANDBOX_PORT`; `setupAdbReverse` /
  `prepareAdbServer` bridge that port into each emulator; the web bundle already bakes
  `VITE_SANDBOX_ORIGIN_URL = http://localhost:<sandboxPort>` from `.env` (worktree-offset),
  so guest and host agree. Import-free HTML doc → no esm.sh/stub dependency.
- **Passes locally via `pnpm mobile:test`, no flakiness across 3 runs** — NOT verified.
  No Android emulator (docker-android + KVM) is available in this environment; the founder
  runs `pnpm mobile:test` at close (A6). See "what needs the founder's run".

## Deviations (with reasons)

- **Harness seeding beyond the literal BOUNDS parenthetical.** BOUNDS scoped harness
  wiring to "serve + adb-reverse the sandbox origin", but the objective requires "a
  conversation containing a simple HTML document." Maestro flows cannot make HTTP calls,
  and the dev mock provider only *echoes* the prompt (`mock-provider.ts`), so no in-flow
  turn — chip or typing — can produce a fenced document a document-capable prompt can't be
  entered on mobile (`inputText` ≈ 10 s/char). The only deterministic path is seeding via
  the existing `dev-only` `/dev/conversation` route from the harness. Implemented as
  `seedDocumentConversation()`; flagged for orchestrator validation.
- **`mobile-tests/config.ts` unchanged.** BOUNDS listed "config.ts weight/registration",
  but the codebase auto-discovers and auto-weights flows; there is no per-flow registry in
  `config.ts` (only `SHARDS`). A `config.ts` edit would be inventing an unused mechanism
  against the "surgical changes" rule. Dropping the file in `flows/` *is* the registration.

## Concerns and limitations (what needs the founder's `pnpm mobile:test` run)

I validated: YAML structure/validity, selector conventions against the app's actual
test-ids (`document-card`, `document-panel` are `data-testid`; `#document-render-status`
is a DOM `id`; the parser maps a fenced `html` block ≥15 lines to a runnable `html`
document), harness registration/discovery/weighting, and all harness TypeScript
(typecheck + lint + unit tests + coverage). The following are correct-by-construction but
**cannot be exercised without a live emulator** — the founder's run confirms them:

1. **`Preview rendered` visibility to Maestro's devtools hierarchy (primary risk).** T4
   made the status mirror an `sr-only` span (visually hidden, present in the DOM). The
   assertion keys on its text because that text appears ONLY at `rendered` — the
   `#document-render-status` element itself is always present (would prove only
   panel-open). Whether Maestro's CDP hierarchy surfaces `sr-only` text is unconfirmed by
   any existing flow (all assert on visible text). If it does not, the reliable render
   signal needs a non-`sr-only` affordance — a T4-owned change, out of my bounds.
2. **Dev-seeded conversation decrypts on mobile login.** The seed wraps the epoch key to
   the persona's device public key (same path as `hasSampleData` sample conversations),
   so `tmu`'s login-derived device key should unwrap it. Assumed working because sample
   data exists to be viewed by its persona; not verified on mobile.
3. **Sidebar navigation.** The flow opens `sidebar-trigger` then taps the first
   `chat-link`, relying on newest-first sidebar ordering (the freshly-seeded conversation
   sorts to top). If ordering differs, the tap opens the wrong conversation.
4. **Sandbox public assets present.** `startSandboxOrigin` serves `apps/sandbox/public/`
   as-is (like `pnpm dev`); `render.html`/`render.js` are T1/T2 outputs, currently
   untracked in the working tree. Present in the founder's tree; a fresh CI checkout would
   need them built (T10's concern).
5. **`/dev/conversation` reachable without extra headers** in the mobile-test env mode
   (the `-sf` curl fails the run loudly if not).

## Confidence

medium — the flow and harness wiring are structurally sound, fully typed/linted/tested,
and follow suite conventions exactly; but the end-to-end pass depends on several
app-side behaviors I cannot exercise without an emulator (especially the `sr-only`
render-status text being visible to Maestro), and on a harness-seeding step that expands
the literal BOUNDS. The founder's `pnpm mobile:test` run is the real acceptance gate.
