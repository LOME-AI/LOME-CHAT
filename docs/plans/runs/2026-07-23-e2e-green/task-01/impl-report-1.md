# impl-report-1 — Task-01: Fix chat-payload capture glob (cluster B)

## Objective
Make `captureChatRoutePayload` actually intercept `POST /chat` so the 3 media-payload
assertions can read the request body. Single edit site: `e2e/helpers/route-payload.ts`.

## Files changed
- `e2e/helpers/route-payload.ts` — replaced the `page.route` matcher `'**/chat/**'`
  (glob) with the RegExp `/\/chat(?:\/|\?|$)/`; rewrote the leading JSDoc paragraph to
  state the durable why (glob compiles to a pattern requiring the literal `chat/`
  segment, so a bare `POST /chat` is missed). No behavioral change to the
  `postData`/`route.continue()` body or the `.get()` contract.

## Tests added
None persisted. The e2e package has no unit-test runner (package.json exposes only
`lint` + `typecheck`; no vitest, zero `.test.ts` files under `e2e/`). A committed
`*.test.ts` would be swept into the Playwright suite by the default `testMatch`
(`**/*.@(spec|test)...`) and run redundantly across every browser project — undesirable
and outside the "no e2e run" boundary. Instead the matcher was self-gated by a
standalone script that imports and exercises the REAL shipped helper (see self-gate).
The matcher is now a single inline RegExp; if a unit runner is ever added to `e2e`, it
can be asserted directly.

## Self-gate
- Red/green matcher proof — script drives the real `captureChatRoutePayload` with a fake
  `page.route` that captures the matcher argument, then tests it against representative
  URLs. For the RED phase (unmodified helper, string glob) it reproduces Playwright
  1.60's exact `globToRegexPattern` (verified from `coreBundle.js:4514`) to compile the
  glob faithfully.
  - RED (before fix): `**/chat/**` → `http://host/chat` => **false** → gate FAILED
    (`expected match: .../chat`). Confirms the diagnosed bug: compiled pattern
    `^(.*/)chat/(.*)$` requires the literal `chat/`.
  - GREEN (after fix): all 5 should-match URLs true (`/chat`, `/chat/regenerate`,
    `/chat/trial`, `/chat/guest`, `/chat?x=1`); all 3 should-not-match false
    (`/chatter`, `/chats`, `/conversations`). `ALL ASSERTIONS PASSED`, exit 0.
- `prettier --check e2e/helpers/route-payload.ts` — pass.
- `eslint helpers/route-payload.ts` (run from `e2e/` package dir; ESLint v9 requires it)
  — pass, 0 warnings.
- `tsgo --noEmit` (from `e2e/` package dir) — pass, exit 0.

## Acceptance criteria
- Matcher matches `POST http://<host>/chat` (no trailing slash) AND `/chat/regenerate`,
  `/chat/trial`, `/chat/guest` sub-paths — **met**: all five assert true in the green
  self-gate; `/chat?x=1` (query) also matches.
- Does not break on `/chat` navigation GETs (they carry no postData) — **met**: the
  matcher matches `/chat` GETs too, but the handler's `if (postData)` guard is unchanged,
  so GET navigations (no postData) capture nothing and are continued unmodified. Does not
  over-match `/chatter`/`/chats` (asserted false).
- The 3 tests reach and pass their `toContain('16:9'|'1080p'|'9:16')` assertions when the
  media turn succeeds — **not independently verifiable here** (out of scope: e2e not run
  by implementer; these cases also depend on media generation, a separate open issue
  Task-media). The capture side — the sole blocker this task owns — is fixed and proven.
- No other e2e helper behavior changes — **met**: only `route-payload.ts` touched (git
  status confirms one modified file); `.get()` contract and body-parse logic unchanged.

## Deviations with reasons
- No persisted colocated test (plan's TDD/checks offered "a colocated helper test" OR "a
  helper-level unit assertion"). Chose the unit-assertion route via a scratchpad script
  because `e2e` has no unit-test runner and a committed `*.test.ts` would be picked up and
  multiplied across the Playwright browser matrix. The self-gate still exercises the real
  shipped helper (not a copy of the regex) and demonstrated genuine red→green.

## Concerns and limitations
- The 3 payload e2e cases remain gated behind media generation working (Task-media); a
  green capture matcher is necessary but not sufficient for those tests to pass. Flagged
  in the brief; not this task's scope.

## Confidence
High — root cause reproduced (glob compiled pattern verified against Playwright 1.60
source), fix proven red→green against the real helper across bare/sub-path/query/negative
cases, all scoped static checks green, single-file surgical change.
