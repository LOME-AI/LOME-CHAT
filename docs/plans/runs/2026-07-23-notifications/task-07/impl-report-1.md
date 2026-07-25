# Task 07 — Service worker + manifest + build wiring — impl-report-1

## Objective

Push-only TypeScript service worker compiled to a stable, unhashed `/sw.js`; a
hand-written `manifest.webmanifest`; the `/sw.js` `Cache-Control` entry in the headers
source; a second (SW) build entry in the Vite config; and a `!isNative()`-gated
registration helper. No `fetch` handler, no precache, ever.

## Files changed

New:
- `apps/web/src/sw/notification-copy.ts` — the fixed, content-free per-category
  notification title/body (generic-payload law); the only place a category becomes words.
- `apps/web/src/sw/handlers.ts` — pure `handlePush` / `handleNotificationClick` /
  `handlePushSubscriptionChange` over an injected scope; narrow structural
  service-worker-API interfaces (see deviation). Imports the shared validators.
- `apps/web/src/sw/register-listeners.ts` — wires the three push listeners; registers no
  `fetch`.
- `apps/web/src/sw/sw.ts` — entry: `registerServiceWorkerListeners(globalThis as …)`.
- `apps/web/src/sw/*.test.ts` — unit tests for each of the above.
- `apps/web/src/lib/register-sw.ts` (+ test) — `registerPushServiceWorker()`, gated
  `!isNative()`, registers `/sw.js`.
- `apps/web/public/manifest.webmanifest` — name, icon, `display: standalone`,
  `start_url: /chat`.

Modified:
- `apps/web/index.html` — `<link rel="manifest">` + `<link rel="apple-touch-icon">`.
- `apps/web/vite.config.ts` — `pwaIconPlugin` (emits `/icon.png` from the canonical
  `resources/assets/icon-only.png`) and `serviceWorkerBuildPlugin` (a second Vite lib
  build → stable unhashed `dist/sw.js`, IIFE, `emptyOutDir:false`, `treeshake:
  {moduleSideEffects:false}`).
- `scripts/generate-headers.ts` — `formatServiceWorkerBlock()` emits a `/sw.js`
  `Cache-Control: no-cache` block (headers SOURCE, never a dist edit).
- `scripts/generate-headers.test.ts` — updated block-count expectation; added `/sw.js`
  no-cache assertions.

## Tests added

- `handlers.test.ts` — push→showNotification with generic per-category text; push→postMessage
  `{type:'push-event', payload}` when a focused client exists (and skips the notification);
  push dropped on no-data / non-JSON / unknown-key (strict schema) / non-uuid id; tag set to
  the conversationId; payload stored as notification data. notificationclick→focus+navigate
  existing client / openWindow when none; closes the notification; invalid or missing id
  dropped (no navigation, no window). pushsubscriptionchange→re-subscribe with the stored
  applicationServerKey + postMessage each client; no-op when no stored key.
- `register-listeners.test.ts` — registers exactly push/notificationclick/pushsubscriptionchange;
  **asserts NO `fetch` listener**; each listener routed through `waitUntil`.
- `sw.test.ts` — importing the entry registers the three listeners on the worker global and
  never `fetch`.
- `notification-copy.test.ts` — a generic title/body per category; one entry per category.
- `register-sw.test.ts` — native → no registration; no `serviceWorker` support → null; web →
  `register('/sw.js')` returns the registration.
- `generate-headers.test.ts` — `/sw.js` resolves to `Cache-Control: no-cache`; other routes
  carry no such directive.

TDD: each module's test was written and watched fail (import/feature missing) before the
implementation, then watched pass. The lint-driven refactor of the test mocks (repo's
`() => Promise.resolve()` convention) happened after green and kept the same assertions.

## Self-gate

- `vitest run src/sw src/lib/register-sw.test.ts` — pass (24 tests, 5 files).
- Coverage on owned files (`src/sw/**`, `src/lib/register-sw.ts`) — 100% stmts/branch/func/lines
  (53/53, 22/22, 12/12, 46/46); perFile-95 satisfied.
- `eslint src/sw/ src/lib/register-sw.ts src/lib/register-sw.test.ts` (from apps/web) — exit 0.
- `eslint generate-headers.ts generate-headers.test.ts` (from scripts) — exit 0.
- `vitest run --config scripts/vitest.config.ts scripts/generate-headers.test.ts` — pass (83).
- `vite build apps/web` — green; emits stable unhashed `dist/sw.js` (60 KB IIFE,
  self-contained, no imports), `dist/manifest.webmanifest`, `dist/icon.png`; built
  `index.html` carries the manifest link. Built `sw.js` registers only push/notificationclick/
  pushsubscriptionchange — **no fetch/install/activate**.
- `tsgo --noEmit` (web) — my files are clean; the run reports 4 errors, ALL in
  `apps/api/src/slices/notifications/**` (see concerns) — none in any file I own.

vite.config.ts is in ESLint's ignore set (not part of `eslint .` / `turbo lint`), so it is
not lint-gated; my additions there match the existing `sharedFaviconPlugin` style.

## Acceptance criteria

- SW handlers unit-tested as pure functions over injected deps — MET (handlers.test.ts).
- push→generic per-category strings / push→postMessage on focused client / click focus-or-open
  with invalid-id drop / tag from payload / pushsubscriptionchange — MET (with the tag deviation
  below).
- No fetch handler; a test asserts it — MET (register-listeners.test.ts + sw.test.ts + grep of
  built bundle).
- Manifest name/icons/standalone/start_url, linked from index.html, icon from existing assets —
  MET.
- Build produces stable `dist/sw.js` + manifest; headers rule present; `pnpm build` green — MET.
- Registration helper gated `!isNative()` via the platform util — MET.
- Validator imported from `@hushbox/shared` (single shared impl, no second copy) — MET
  (`handlers.ts` imports `pushEventPayloadSchema` + `conversationIdSchema`; grep confirms no
  local uuid regex).

## Deviations with reasons

1. **Notification `tag` = raw `conversationId`, not a server "alias".** The brief says "tag from
   the payload alias", but the consumed I1 schema (`pushEventPayloadSchema`, Task 01, CLEAN) is a
   strict `{category, conversationId}` with **no alias field** — and the SW validates with that
   strict schema, so it can neither receive nor (per G3/G6) compute the server-only HMAC alias.
   The only per-conversation value available to the SW is `conversationId`. The notification
   `tag` is set client-side in `showNotification` and is **never sent to any push service**, so
   using the raw id here does not violate G1 (whose prohibition is scoped to push-service-visible
   headers — the `Topic`/`collapse_key`, owned server-side by Tasks 03/04). Collapse works
   correctly. See RAISED — this couples with Task 09's tag-based clearing.
2. **SW typed against narrow structural interfaces, not the ambient WebWorker lib.** G6 says
   "WebWorker lib types", but the app compiles under a single DOM-lib tsconfig; adding
   `lib: webworker` to one file collides with DOM globals, and I may not add a separate tsconfig
   (that edits `package.json`'s typecheck script — Task 11's file). The structural interfaces
   keep the handlers fully typed and make them trivially testable.
3. **`pushsubscriptionchange` uses the postMessage-to-client fallback** (not SW→API fetch). The
   API is a different origin in production (`VITE_API_URL`), so the SW cannot carry the iron-session
   cookie to it; the worker re-subscribes with the stored `applicationServerKey` and posts
   `{type:'pushsubscriptionchange', subscription}` to open clients. Next-app-start re-registration
   and server 404/410 pruning are the backstops when no client is open (matches research §2).

## Concerns and limitations

- **Web typecheck is red from a sibling task, not this one.** `apps/web/src/lib/api-client.ts`
  imports `AppType` from `@hushbox/api`, so web's typecheck compiles the api route graph. The
  concurrent notifications-API workstream (Task 03/04) modified
  `apps/api/src/slices/notifications/ports/push-sender.ts` + `ports/index.ts` (the
  `PushRecipient`/`PushDeviceRef` types) but the committed consumers `push-fcm.ts` /
  `notify-message.ts` (unmodified) now mismatch → 4 type errors. Outside Task 07's ownership;
  attribute to the pipeline/sender workstream.
- **`register-sw.ts`'s export is not yet imported** — Task 08's web adapter consumes it (I6).
  Until then, Phase-4 `knip` will flag it as unused. Expected; not wired here to avoid touching
  Task 08-owned files.
- **SW bundle is ~60 KB** (essentially zod). `@hushbox/shared` has no `sideEffects:false` flag
  and no `./notifications` subpath export, so importing the barrel pulls the graph; I forced
  `treeshake:{moduleSideEffects:false}` in the SW child build, which drops the billing/estimate
  code (121 KB → 60 KB). A future `./notifications` subpath export would slim it further.
- **Dev `vite serve` does not emit `/sw.js`** (the SW is a build-time artifact, like the headers
  plugin which is preview-only). Preview/Pages/`cap sync` all consume the built `dist/sw.js`;
  Task 13's Playwright runs against `vite preview`, so the SW exists there. If Task 08 needs a
  dev-serve SW, that is a follow-up.
- `manifest` icon is a single 1024×1024 `purpose:"any"` entry (the one existing app icon,
  `icon-only.png`); sufficient for installability. Maskable padding is not claimed (icon-only is
  not guaranteed safe-zone), so no `maskable` purpose is declared.

## Confidence

Medium — implementation, coverage, lint, and build are all green and verified, and the two
web-typecheck errors are cleanly attributable to a concurrent task. Medium (not high) because
the notification-`tag` deviation (#1) resolves a genuine plan-internal contradiction (brief's
"payload alias" vs. the CLEAN I1 schema) with my best judgment and directly affects Task 09's
clearing design — the orchestrator should confirm the coordination.
