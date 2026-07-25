# Task T8 — Playwright E2E (product flow) — impl report 1

## Objective

Author the product-flow Playwright E2E proving runnable documents work end to end
through the real web app: a seeded assistant message with a fenced document becomes a
card, opening the panel embeds the real cross-origin sandbox iframe, and
html/js/react/python execute inside it — deterministic, retries=0, no live network, no
real model turn. Self-verify structure/typecheck/lint; run locally only if the stack is
up.

## Files changed

- `e2e/chat/runnable-documents.spec.ts` (new) — the product-flow suite: four seeded
  scenarios (HTML render+interactivity+toggle, React+npm-import render, Python
  run→console+figure, syntax-error→error card). Seeds via the dev `/dev/conversation`
  route (title/messages), navigates the authenticated page, asserts on app-emitted
  state.
- `e2e/pages/document-panel.page.ts` — extended the existing page object with the
  runnable-document selectors: `renderStatus()`, `expectRenderStatus()`,
  `sandboxFrame()` (FrameLocator via `iframe.contentFrame()`), `runButton()`,
  `stopButton()`, `consoleOutput()`, `figureOutput()`, `errorCard()`, plus the
  `DocumentRenderStatus` type. Raw CSS/id selectors are confined here (spec rule 3.3);
  specs use only semantic locators + these page-object methods.

## Tests added

- `html document renders inside the sandbox, is interactive, and toggles raw/rendered`
  — card appears (contains `html`, `15 lines`); panel opens; `#document-render-status`
  reaches `rendered`; content asserted INSIDE the frame (`getByText('Hello from a
  HushBox document')`, `count: 0`); a real click on the in-frame Increment button flips
  the count to `count: 1` (genuine sandbox interactivity); Raw shows highlighted source,
  Rendered re-renders. Covers objective bullets 1 and 4.
- `react document imports an npm package and renders inside the sandbox` — JSX doc
  importing `canvas-confetti` (esm-stub fixture) via bare specifier; `rendered` status
  is reachable only if the import map resolved, the default export ran, and the
  component mounted; frame shows `Rendered by React`. Covers bullet 2.
- `python document runs on Pyodide and returns a matplotlib figure` — card (`python`,
  `15 lines`); python does NOT auto-run (Run button visible); pressing Run drives
  numpy+matplotlib on the self-hosted dist; `#document-render-status` reaches `complete`;
  stdout appears in the console strip (`sample count:`); a PNG figure (`Generated
  figure`) renders. Covers bullet 3.
- `a syntax-error document shows an error card, not a blank frame` — malformed JSX →
  transpile failure → `#document-render-status` reaches `error` and a readable error
  card (`could not be compiled`) renders, never a blank frame. Covers bullet 5.

## Determinism / harness reuse

- No new sandbox-serving. The suite drives the REAL app, which embeds the sandbox origin
  served by the shared Playwright `webServer` (`pnpm --filter @hushbox/sandbox dev`,
  serving `render.html`/`python.html` under the real CSP) — the same served-real-CSP
  origin the T7 containment corpus uses. I did NOT instantiate `DocumentSandboxHarness`:
  that class serves a synthetic loopback parent for pure containment; a product-flow
  proof must go through the actual panel/card/toggle/render-status, so the real app is
  the parent. I reuse the infra (served sandbox + esm-stub fixtures + Pyodide dist), and
  reinvent none of it.
- npm imports resolve to the pinned esm-stub fixtures (`ESM_CDN_URL` test mode →
  `<sandbox-origin>/esm-stub`, serving react/react-dom/canvas-confetti); Python uses the
  self-hosted Pyodide dist (numpy + matplotlib wheels present in
  `apps/sandbox/public/pyodide/`) — no live esm.sh, no live PyPI.
- Document content is seeded via the dev route, not model-generated (the model emitting
  documents is a separate prompt concern), so there is no cassette dependence.
- E2E doctrine honored: every wait is a web-first retrying assertion on app-emitted state
  (`#document-render-status` data-status, in-frame content); no wall-clock waits, all
  timeouts are named `TIMEOUTS` budgets; no serial mode needed (each test seeds a distinct
  conversation; seeding is additive and does not mutate shared-account usage/rate-limit
  state).

## Self-gate

- `tsgo --noEmit` (from `e2e/`) — pass.
- `eslint chat/runnable-documents.spec.ts pages/document-panel.page.ts` (from `e2e/`,
  after the LAST edit) — pass (exit 0). One prettier wrap auto-fixed during iteration.
- Full E2E run — NOT run locally: the local stack is down (API health probe empty) and
  bringing up the full E2E stack is heavy; per plan A6 the related-E2E execution is
  paused for the founder at close. Everything below "acceptance criteria" that depends on
  a live browser is authored + statically validated, pending the founder's suite run.

## Acceptance criteria

- Specs green at retries=0 across the suite's browsers — AUTHORED; not executed locally
  (founder runs the suite; see self-gate). Structure/typecheck/lint validated.
- No settled-waits / no wall-clock waits — met (only `expect(...).toHaveAttribute/
  toBeVisible/toContainText` on app state, named timeouts).
- Runtime within suite budget — python uses `test.slow()` + `TIMEOUTS.XXLONG` for the
  cold Pyodide+numpy+matplotlib path; others use `LONG`.
- Prefer extending existing suites — extended the `DocumentPanelPage` page object; added
  one focused product spec under `chat/` (cleaner than folding dev-route-seeded documents
  into the existing echo-send `ui/document-panel.spec.ts`, which the brief permits).

## Deviations with reasons

- **React interactivity is proven in the HTML scenario, not React.** The brief's bullet 2
  says "renders and is interactive (e.g. a button that updates state)". The deterministic
  esm-stub React (T7/T10 infra) is a minimal functional stand-in with no hooks and no
  synthetic-event wiring (`react-dom` stub realizes the vdom once via `setAttribute`), so
  genuine React state-interactivity cannot execute offline. The React scenario therefore
  proves the load-bearing React path — JSX transpile + import-map resolution of a bare npm
  specifier + default-export invocation + mount (all gated by reaching `rendered`) — and
  genuine end-to-end user interaction is proven in the HTML scenario (a real in-frame
  button click driving a real DOM update under the sandbox CSP). This is a faithful,
  deterministic reading of the requirement given the fixture design; flagged for the
  auditor.

## Concerns and limitations

- Not executed against a live stack (see self-gate). The assertions assume, and were
  written against, the T4 app selectors observed in source
  (`apps/web/src/components/document-panel/document-sandbox.tsx`: `#document-render-status`
  `data-status`, iframe `title`, Run/Stop buttons, `role="log"` "Program output" console,
  `<Img alt="Generated figure">`, `role="alert"` error card) and the parser title/kind/
  15-line extraction rules (`apps/web/src/lib/document-parser.ts`). Static typecheck+lint
  pass; the runtime behavior of a seeded fenced assistant message extracting into a card
  is Inferred from the store-raw doctrine and the existing echo-based document-panel spec.
- Python `complete` timing on a cold, saturated host is the widest budget in the suite
  (`XXLONG`); if the founder's run shows it still lags, that is a budget-tune, not a logic
  fix.

## Confidence

Medium — structure, typecheck, and lint are Verified green and the selectors/flow trace
directly to the T4 app source; the runtime-green claim is unverified because the E2E stack
is down and execution is founder-gated (plan A6). No logic risk identified in review; the
one judgment call (React-interactivity location) is documented.
