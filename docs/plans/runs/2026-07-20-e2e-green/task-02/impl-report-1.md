# Task-02 — demo spec drives the /welcome iframe — impl report 1

## Objective

Update `e2e/demo.spec.ts` for the deliberate guard (commit a4b4483d) that redirects
top-level `/demo` → `/welcome`; the demo now runs inside a same-origin iframe on the
`/welcome` marketing page. Preserve every existing assertion's intent.

## Diagnosis verification (Verified)

- `apps/web/src/demo/bootstrap.tsx` — `mountDemo` checks `globalThis.top === globalThis.self`
  and calls `globalThis.location.replace(ROUTES.MARKETING)` (`/welcome`) for top-level visits;
  the demo boots only when embedded (`top !== self`). So the old spec's `page.goto('/demo')`
  landed on the marketing page and every locator timed out — matches the 5 iphone-15 failures
  in `e2e/report/2026-07-20T05-25-42/failed/e2e-demo-spec-ts-*`.
- `apps/marketing/src/components/AppDemo.astro` — the iframe (`title="HushBox interactive
  demo"`, `src="/demo"`) is injected into `#app-demo-slot` only when the `#demo` section
  scrolls into view (IntersectionObserver, threshold 0.2). `welcome.astro:138` owns
  `<section id="demo">`; the hero links to `#demo`.
- `apps/web/src/demo/director.ts:392` — `let visible = true` default, so a missed initial
  `hb-demo-visibility` postMessage (sent before the iframe document exists) cannot stall
  playback; the director pauses only if the section actually leaves the viewport.
- E2E serves `/welcome` and `/demo` same-origin: the Astro marketing output is merged onto
  the web app's dist and served by `vite preview` (per `e2e/marketing-leaderboard.spec.ts`
  header comment and `playwright.config.ts` Preview webServer).

## Files changed

- `e2e/demo.spec.ts` — rewrote navigation to `/welcome#demo` + `FrameLocator`-driven
  interactions; every original assertion retargeted at the frame with identical matcher,
  text, and timeout budget. Only file touched.

## Design decisions

- **Frame acquisition**: `page.getByTitle('HushBox interactive demo').contentFrame()` —
  semantic locator (satisfies `playwright/no-raw-locators`, which is `error` in specs), no
  raw CSS. Navigating to the `#demo` anchor makes the IntersectionObserver mount the iframe
  without simulating scroll.
- **`FrameLocator` type**: not re-exported by `e2e/fixtures.ts`, and specs may not import
  `@playwright/test` (lint ban). Derived locally as
  `type DemoFrame = ReturnType<Locator['contentFrame']>` from the fixtures-exported
  `Locator` — keeps the fixtures module as the sole Playwright type source without touching
  files outside ownership.
- **URL assertion**: the original `expect(page).toHaveURL(/\/demo$/)` intent is "the
  memory-history router keeps the iframe document URL at /demo; blocked actions never
  navigate away". `FrameLocator` has no `toHaveURL`, so `expectDemoFrameUrl()` uses
  `expect.poll` over `page.frames()` pathnames with a named budget (`TIMEOUTS.ASSERT`) —
  a retrying assertion, not a point-in-time read (rule 2.8), and it still fails if the
  frame ever navigates off `/demo`.
- **Helper retargeting**: `openMobileSidebarIfNeeded` (`e2e/helpers/auth.ts:204`) and
  `MemberSidebarPage.openViaFacepile` (`e2e/pages/member-sidebar.page.ts:34`) both take a
  `Page` and locate against it, so they cannot reach elements inside the frame. Their exact
  logic (including the mobile Sheet `data-state === 'open'` animation wait and its
  do-not-replace rationale comment) is mirrored in spec-local functions
  (`selectDemoConversation`, `openMemberSidebarViaFacepile`) that take the frame — the only
  duplication, kept inside the single owned file. All locators use `TEST_IDS` registry
  entries or semantic `getByRole`/`getByText`/`getByTitle`.

## Tests added

No new tests; the 5 existing demo tests were rewritten to the new navigation reality.
Assertion-intent audit (original → new): every `page.getByX(...)` assertion became
`demo.getByX(...)` with the same matcher and timeout; both `toHaveURL(/\/demo$/)` checks
became `expectDemoFrameUrl` (see above); zero assertions deleted or weakened; none were
unreachable through the iframe.

## Self-gate

- `pnpm exec eslint demo.spec.ts` (from `e2e/`, re-run after the final edit) — pass (exit 0).
- `pnpm exec tsc -p tsconfig.json --noEmit` (from `e2e/`) — pass (exit 0).
- `pnpm e2e e2e/demo.spec.ts` — pass: **90 passed (0 failed, 0 flaky), exit 0** in 2.1m.
  Report: `e2e/report/2026-07-20T06-07-16/REPORT.md`. Breakdown: the 5 demo tests green on
  all 6 browser projects (chromium, firefox, webkit, iphone-15, pixel-7, ipad-pro) = 30,
  plus the 60 dependent `auth.setup.ts` project setups.

### Spec run — environmental failures before the green run (not test defects)

Two aborted attempts preceded the green run; both were environment collisions, not spec
problems:

1. **Stale wrangler DO state crashed the API webServer.** The first run's `wrangler dev`
   died ("Terminated") after repeated uncaught
   `ConversationRoom requires a named id — reach it via idFromName(conversationId)` throws
   (`packages/realtime/src/conversation-room.ts:135`) — ConversationRoom instances
   reconstructed from persisted local DO state carry no `ctx.id.name`, the same platform
   quirk previously fixed for JobDispatcher by persisting the shard to DO storage. Every
   `auth.setup.ts` then failed against the dead API. Remediation: wiped the git-ignored
   `apps/api/.wrangler/state` + `tmp` (247 MB of stale state). Raised to the orchestrator:
   ConversationRoom is vulnerable to the same alarm-reconstruction crash class and the fix
   is outside this task's ownership.
2. **Port collision with a concurrent run in the same worktree.** A sibling agent's
   `pnpm e2e e2e/account-deletion.spec.ts` (Task-01) was running concurrently; both runs
   compute identical `HB_*_PORT` values, so Playwright aborted with
   "http://localhost:4173 / :7000 is already used" global errors. Waited for the sibling
   run to exit, verified ports free, re-ran → green. Raised: same-worktree e2e runs cannot
   overlap; the orchestrator must serialize spec-run proofs across tasks. Also raised: while
   diagnosing the dead-API state I force-killed leftover `vite preview`/`wrangler`/`workerd`
   processes before realizing the sibling run was live — its in-flight run may have failed
   for that reason and deserves a clean re-run.

## Acceptance criteria

1. Navigates to `/welcome` (`#demo` anchor) and drives the demo through a frame locator;
   all assertions preserved with identical intent — **met** (see assertion-intent audit).
2. No assertion was unreachable through the iframe — nothing to report as a finding — **met**.
3. `pnpm e2e e2e/demo.spec.ts` fully green — **met**: 90/90 passed, 0 flaky, exit 0
   (`e2e/report/2026-07-20T06-07-16/`), all 5 demo tests green on all 6 projects.

## Deviations

- Test/describe titles updated (`/demo` → `/welcome iframe` phrasing) to stay truthful to
  the new navigation; behavior descriptions unchanged.
- The two `toHaveURL` assertions are now frame-URL polls (mechanically different, same
  intent) because Playwright offers no web-first URL matcher for frames.

## Concerns and limitations

- The mirrored sidebar/facepile logic duplicates two helpers. If a future task moves demo
  helpers into `e2e/helpers`/`e2e/pages` with frame-aware signatures, this spec should
  adopt them — out of scope here (file ownership: `e2e/demo.spec.ts` only).
- TDD note: this is a test-only correction of a spec against changed-by-design app
  behavior; "watch it fail" evidence is the pre-existing failure artifacts in
  `e2e/report/2026-07-20T05-25-42/failed/e2e-demo-spec-ts-*` (the RED state), and the spec
  run above is the GREEN verification.

## Concerns and limitations (continued)

- The two environmental failure classes above (stale DO state crashing wrangler;
  same-worktree e2e port collisions between concurrent tasks) will bite any later task
  running spec proofs; both are outside this task's file ownership.

## Confidence

High — all 5 tests green across all 6 projects at retries-with-0-flakes in one clean run;
lint and typecheck exit 0 after the final edit; every original assertion mapped 1:1 to a
frame-scoped equivalent with identical matcher text and named timeout budgets.
