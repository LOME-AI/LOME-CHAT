# Task T4 — App integration (panel UX) — impl report 1

## Objective

Make runnable documents live in the web app, one codepath on web + Capacitor: extend the
document type union/parser to consume `RunnableDocumentKind`, dispatch mermaid→MermaidDiagram
and html/js/react/python→a sandbox-origin iframe driving the typed bridge, generalize the
Rendered/Raw toggle, auto-render html/js/react, python Run/Stop + console + PNG outputs,
loading/error cards, `document-render-status` element, and the mobile app-origin CSP.

## Files changed

New:
- `apps/web/src/lib/sandbox-origin.ts` — reads `VITE_SANDBOX_ORIGIN_URL` (fail-fast) and maps a
  runnable kind to `/render.html` (html/js/react) or `/python.html` (python).
- `apps/web/src/lib/sandbox-origin.test.ts` — origin fail-fast + page-URL mapping.
- `apps/web/src/components/document-panel/document-sandbox.tsx` — the iframe embed: drives
  `init`/`run`/`stop`, handles `ready`/`rendered`/`console`/`result`/`error`/`loading`,
  render-status element, python controls, teardown-via-remount. Reducer-based state.
- `apps/web/src/components/document-panel/document-sandbox.test.tsx` — 29 tests (attrs, auto-run,
  render-status, message hygiene, python lifecycle, stop teardown).
- `apps/web/src/lib/app-frame-csp.test.ts` — pins the index.html mobile frame-src policy.

Modified:
- `apps/web/src/lib/document-parser.ts` — `Document['type']` now `'code' | 'mermaid' |
  RunnableDocumentKind`; `getDocumentType` maps `js`/`javascript`→'js', `python`→'python'; added
  `isRunnableDocument` type-guard.
- `apps/web/src/lib/document-parser.test.ts` — new type + guard cases (python was 'code', now 'python').
- `apps/web/src/components/document-panel/document-panel.tsx` — dispatch seam (runnable+Rendered →
  `DocumentSandbox`), `supportsRawToggle` extended to runnable kinds, content keyed by
  `activeDocumentId` so a document switch tears the iframe down.
- `apps/web/src/components/document-panel/document-panel.test.tsx` — html/react now render the
  sandbox preview by default (was highlighted code); added raw-toggle, js, python cases + env stub.
- `apps/web/src/components/chat/media/document-card.tsx` — js/python icon cases (reuse `codeIcon`
  test-id — a new registry entry is out of my bounds; the icon is the visual, the id is the hook).
- `apps/web/src/components/chat/media/document-card.test.tsx` — js/python icon cases.
- `apps/web/index.html` — `<meta http-equiv="Content-Security-Policy" content="frame-src 'self'
  %VITE_SANDBOX_ORIGIN_URL%">` for the bundled Capacitor WebView.
- `packages/shared/src/env.config.ts` — added `VITE_SANDBOX_ORIGIN_URL` (Frontend mirror of
  `SANDBOX_ORIGIN_URL`, value-identical per mode). This is the "web env registry entry" the brief
  scopes in.

Regenerated (`pnpm generate:env`, deterministic from the registry): `.env.development`,
`.env.scripts`, `apps/api/.dev.vars` (all gitignored); TRACKED: `.github/workflows/{ci,release,
build-android,run-ops-script}.yml` + `apps/api/wrangler.toml` — see Deviations.

## Tests added (behavior — criterion)

- iframe src=/render.html (html/js/react) and /python.html (python); title present — dispatch/pages.
- sandbox attribute is exactly `allow-scripts`, and NOT `allow-same-origin`/`allow-popups`/
  `allow-top-navigation`/`allow-modals` — G3 attribute pinning.
- ready→posts `init{kind,code,requestId}` (auto kinds); never posts with targetOrigin `'*'` — auto-render.
- render-status starts non-rendered; a `loading` does not flip it; `rendered` flips it; stable id — A4.
- foreign source ignored; malformed message ignored; stale requestId ignored — message hygiene.
- loading phase announced as text; error card friendly text; `input_unsupported` friendly — loading/error.
- python does not auto-run; Run disabled until ready; Run posts init→run; source shown; console into
  aria-live log; PNG result via `<Img>`; text result; result marks `complete` (not `rendered`) — python.
- Stop tears down the frame: post-stop console from the killed frame is dropped and the log clears —
  the assertion T3 could not make (needs a real iframe).
- toggle default Rendered + reset on document change (existing effect); raw reveals source — toggle.
- app-origin frame-src present, `'self'` + `%VITE_SANDBOX_ORIGIN_URL%`, no wildcard, no default-src — A8.

## Self-gate

- `pnpm test:web` — pass (exit 0; full web suite + perFile coverage gate, Tasks: 1 successful).
- `pnpm typecheck` (apps/web) — pass.
- `eslint <all 11 owned files>` from apps/web after last edit — pass (exit 0).
- `jscpd` on changed dirs/files — pass (0 clones).
- Per-file coverage on changed source: document-sandbox.tsx 98.9% lines / 96.9% branch;
  document-parser.ts, sandbox-origin.ts, document-card.tsx 100%; document-panel.tsx ~99% (all ≥95).

## Acceptance criteria

- Parser/type union consumes `RunnableDocumentKind`, no "artifact" naming — met.
- Dispatch per kind (mermaid→MermaidDiagram; runnable→sandbox iframe to correct page) — met.
- Toggle generalized, Rendered default, reset on document change — met (reuses existing reset effect).
- Auto-render html/js/react; python Run/Stop + console (aria-live) + PNG via `<Img>`; loading/error
  cards; teardown on switch/close — met.
- iframe `sandbox="allow-scripts"` exactly + title + env-driven src — met (attribute-pinning test).
- `document-render-status` literal id, flips to rendered ONLY on bridge `rendered` — met.
- Python drive `init`→`run`, terminal `result{outputs}` (not rendered), `input_unsupported` friendly — met.
- Stop teardown drops further console/result from the killed run — met.
- Mobile app-origin CSP delivered; child self-navigation to off-allowlist host VERIFIED blocked — see
  Concerns: delivered + statically pinned; runtime CSP enforcement is a browser behavior not
  reproducible in jsdom (verified by shape, not runtime).

## Deviations with reasons

- **Import path from the barrel-inclusive subpath.** Brief said consume via
  `@hushbox/shared/documents`; I import from that narrow subpath (document-sandbox.tsx,
  sandbox-origin.ts) AND document-parser.ts imports `RUNNABLE_DOCUMENT_KINDS` from the subpath.
  A9's narrow-import requirement exists to keep the credential-free SANDBOX bundle from embedding
  backend env; the web app already bundles the `@hushbox/shared` barrel everywhere (e.g.
  `capacitor/platform.ts`), so that rationale does not apply to the web app and the subpath is used
  as directed — no deviation in intent. (Early investigation showed a false alarm where subpath+
  platform failed under raw `npx vitest`; root cause was the invocation not loading
  `process.env.VITE_PLATFORM`, unrelated to the import path — resolved by running via the env harness.)
- **`pnpm generate:env` was run** to propagate the new frontend var. It is deterministic from the
  registry and also materialized pre-existing registry drift (VAPID_* / VITE_VAPID_PUBLIC_KEY were in
  env.config.ts but not yet in the workflow files) into the tracked workflow/wrangler files. See RAISED.
- **js/python card icons reuse `codeIcon`** rather than new test-ids (adding a shared registry entry
  is out of my apps/web bounds).

## Concerns and limitations

- **CSP enforcement not runtime-verified.** jsdom does not enforce CSP; `app-frame-csp.test.ts` pins
  the directive's presence, `'self'`+sandbox membership, absence of wildcard, and absence of
  default-src. Actual child-frame-navigation blocking is confirmable only on a real browser (T7) and
  the Android WebView (T9). Stated honestly: I verified the policy is present and correctly shaped,
  not that a WebView enforces it.
- **The meta CSP applies on web too** (index.html serves everywhere). Verified this does not regress:
  the deployed web `_headers` already sets `frame-src 'self' <sandbox>` (generate-headers.ts:169), and
  the only app iframes are same-origin (`dev.emails` srcDoc, the `/demo` iframe) — covered by `'self'`.
  So the meta mirrors the web policy exactly; no third-party frame is broken.
- **`%VITE_SANDBOX_ORIGIN_URL%` in index.html** relies on Vite's standard HTML env substitution; the
  var is defined for every mode, so no empty-substitution case. Per-worktree dev port offset is applied
  by generate-env's `applyWorktreePorts` (mirror shares the `localhost:7400` literal with SANDBOX_ORIGIN_URL).

## Confidence

High — all self-gates green, the sandbox lifecycle is exercised by a real iframe in tests, and the
one item I could not fully close (runtime CSP enforcement) is inherently a browser/on-device concern
owned by T7/T9, and I pinned its static shape.
