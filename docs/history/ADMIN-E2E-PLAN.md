# Admin E2E Suite — Implementation Plan

**Status:** Approved by the founder (2026-07-16). The harness is built and audited; this
plan specifies the spec suite and its two support changes. It is written for an
implementer with no prior context. Working artifact — delete (or move to
`docs/history/`) once the suite ships.

**Founder rulings baked in:** (1) admin op-target seeding joins the e2e profile;
(2) the SPA's dev-auth wrapper is enabled in CI e2e, designed so it can never
activate in production; (3) no dedicated accessibility spec — follow the existing
suite's convention (semantic locators + targeted role/focus assertions; there is no
axe anywhere in `e2e/` and none should be added).

---

## 1. What already exists (do not rebuild)

- **The `admin` Playwright project** (`playwright.config.ts:192-200`): `testDir:
  './e2e/admin'`, Desktop Chrome, `baseURL` = the admin dev server
  (`HB_ADMIN_PORT`, base 7000), no `storageState`, no auth.setup dependency. Every
  browser-matrix project carries `'**/admin/**'` in `testIgnore`, so admin specs run
  only here. The admin **webServer** entry boots `pnpm --filter @hushbox/admin dev`
  (the Vite dev server IS the surface under test: its `/api` proxy and dev-JWT
  self-auth are dev-server behaviors).
- **Fixtures** (`e2e/admin/fixtures.ts`, extends `e2e/fixtures.js`):
  - `adminApi(actor?)` → a retry-wrapped `APIRequestContext` that mints a real
    Access-shaped dev JWT from `GET /dev/admin-token?email=<actor>` and attaches it
    as `Cf-Access-Jwt-Assertion`. Hits the Worker's bare `/admin/...` paths. Actors:
    `DEV_ADMIN_ACTORS = ['admin@hushbox.test', 'ops@hushbox.test']`
    (`e2e/admin/helpers/actors.ts`). Contexts auto-dispose in teardown.
  - `adminPage` → navigates the SPA and waits for `TEST_IDS.adminShell`; the SPA
    self-authenticates in the browser via its dev-auth fetch wrapper.
- **Helpers**: `e2e/admin/helpers/dashboard.ts` (raw locators confined to helpers
  per rule 3.3 — add new raw selectors HERE or in new helper files, never in specs).
- **Smoke**: `e2e/admin/harness-smoke.spec.ts` (2 tests) proves the harness;
  keep it.
- **Scripts**: `pnpm e2e:admin` (package.json:50) = `e2e:prepare` + the admin
  project. CI: the `admin`/`chromium` matrix row exists in `.github/workflows/ci.yml`
  (~line 359); the whole e2e job is deliberately `if: false` until the Phase-4
  transport swap — do not change that gate.
- **The app under test**: seven screens (Dashboard `/`, Customer 360
  `/customer-360?q=`, Jobs `/jobs`, Audit `/audit`, Models `/models`, SQL `/sql`,
  Ops catalog `/ops`), the OpModal (form → preview diff → execute → result with
  Undo), the ⌘K palette, and a dev-only actor switcher in the shell
  (`TEST_IDS.adminActorSwitcher`). All 12 registered ops are live over HTTP. Undo =
  `POST /admin/ops/<inverse>/execute` with `{ undoes: <auditId>, input:
  <inverseInput> }` — the UI drives this through the same OpModal.

## 2. Binding doctrine (read `e2e/CLAUDE.md` in full before writing a spec)

The non-negotiables that will fail review if violated:

- **No wall-clock waits.** Wait on app-emitted signals or web-first retrying
  assertions (`await expect(...)`, `expect(async () => {...}).toPass({ timeout:
  TIMEOUTS.X })`). No `waitForTimeout`, no `networkidle`.
- **Timeouts only from `e2e/config/timeouts.ts`** — no inline numeric literals. If a
  new budget is genuinely needed, add a named constant there.
- **Isolation**: `fullyParallel`; no `describe.serial` unless the flow genuinely
  chains state (the op-lifecycle spec below is the one sanctioned serial candidate);
  no `@hushbox/db` imports in specs; cleanup via fixture teardown only (never
  `afterEach` in specs).
- **Locators**: `TEST_IDS` registry (`packages/shared/src/test-ids.ts`) and semantic
  roles in specs; raw CSS/element selectors only inside `e2e/admin/helpers/*`.
  Literal `data-testid` strings are lint-banned — add missing ids to the shared
  registry (additive).
- **Guardrails are on by default**: every page fails its test on unexpected console
  errors, unexpected API ≥400s, and any non-localhost network call. Specs that
  intentionally trigger API errors (denials, guardrail trips) must opt out via
  `expectApiErrors(page, [...])` — API-level spec