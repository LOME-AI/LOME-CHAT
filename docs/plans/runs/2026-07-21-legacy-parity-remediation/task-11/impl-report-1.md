# T11 — R19: route all slice error responders through `domainWireCode()` · impl-report-1

## Objective
Stop discarding `DomainError.wireCode` in slice error responders so idempotency conflicts
surface as `IDEMPOTENCY_BODY_MISMATCH` / `REQUEST_IN_PROGRESS` instead of the generic
`CONFLICT` mapping. Converge the conversations/feedback hand-rolled third responder pattern
onto the single shared helper `domainWireCode()`.

## Approach / key constraint discovered
`domainWireCode(error)` (`lib/errors/domain-error.ts:60-62`) already prefers `error.wireCode`
and falls back to `DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]`. The task is to route every
responder through it.

Boundary constraint (`packages/config/eslint-extensions/boundaries.config.mjs`): a
`slice-routes` file may import only its own `slice-domain-barrel` + `middleware` (+
externals/internal-packages). It may **not** import `lib/errors` directly. `createErrorResponse`
is already reached through each slice's domain barrel for exactly this reason. Therefore
`domainWireCode` had to be added to each slice's domain barrel re-export line so the routes
could import it — a direct `../../lib/errors` import from a slice route would fail the
boundaries lint. `platform/dev/routes.ts` is not a slice (not under `src/slices/`), so it
imports `domainWireCode` directly from `../../lib/errors/index.js` alongside its existing
`createErrorResponse` import.

## Files changed
Responders (10) — `createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code])` →
`createErrorResponse(domainWireCode(error))`; unused `DOMAIN_ERROR_CODE_TO_WIRE_CODE` import
removed:
- `src/slices/account/routes.ts`
- `src/slices/identity/routes.ts`
- `src/slices/billing/routes.ts` (LIVE — `idempotent.byKey` on `POST /billing/login-link`)
- `src/slices/models/routes.ts`
- `src/slices/announcements/routes.ts`
- `src/slices/admin/routes.ts` (LIVE — engine constructs `requestInProgressError()`)
- `src/slices/newsletter/routes.ts`
- `src/platform/dev/routes.ts` (imports `domainWireCode` from `lib/errors` directly — non-slice)
- `src/slices/conversations/routes.ts` — collapsed: the `isIdempotencyConflict` short-circuit
  is now redundant (`domainWireCode` yields the same wire code at the same 409), so the
  responder is one line; the now-unused `isIdempotencyConflict` import removed.
- `src/slices/feedback/routes.ts` — `isIdempotencyConflict` short-circuit replaced by an
  `error.wireCode !== undefined` guard that honors carried wire codes through `domainWireCode`;
  `FEEDBACK_DUPLICATE` and the `FEEDBACK_SUBMIT_FAILED` default preserved (feedback's generic
  branch is an independent authority, NOT the domain mapping — deliberately not routed
  through `domainWireCode`).

Domain barrels (9) — added `domainWireCode` to the existing
`export { createErrorResponse } from '../../../lib/errors/index.js';` re-export line:
- `src/slices/{account,identity,billing,models,announcements,admin,newsletter,conversations,feedback}/domain/index.ts`

Test (1):
- `src/slices/billing/routes.integration.test.ts` — added `idempotencyKeys` to the
  `@hushbox/db` import and one new test (below).

## Tests added
- `POST /billing/login-link > answers IDEMPOTENCY_BODY_MISMATCH when a reused key carries a
  different body` — behavior: a first real request records the key row (to read the exact
  stored `route`), then a conflicting `request`-kind `idempotency_keys` row is seeded under a
  fresh key with a mismatching `bodyHash`; the subsequent `byKey` request detects the body
  mismatch and the responder must answer `409 { code: 'IDEMPOTENCY_BODY_MISMATCH' }`. Covers
  acceptance criterion 2 (billing `byKey` body-mismatch → `IDEMPOTENCY_BODY_MISMATCH`, not
  `CONFLICT`).
  - RED (pre-fix): `expected { code: 'CONFLICT' } to deeply equal { code: 'IDEMPOTENCY_BODY_MISMATCH' }`
    — the status was already 409, only the wire code was wrong (wireCode discarded). Correct
    failure reason.
  - GREEN (post-fix): passes.

## Self-gate
- `pnpm typecheck` (apps/api) — pass.
- `npx eslint --fix <21 owned files>` from `apps/api` — pass (exit 0), after final edit;
  ESLint reordered the new import members and rewrapped the admin/platform-dev import lines.
- `pnpm test:watch` billing routes file — pass (37/37).
- `pnpm test:watch` batch (account, identity, models, announcements, newsletter, feedback,
  platform/dev routes) — pass (347/347).
- `pnpm test:watch` admin (routes, routes-reads, engine) + conversations routes — pass
  (367/367).
- Full-coverage `pnpm test:api` not run — per plan Phase-4 note it OOMs (exit 137) in this
  sandbox; scoped coverage-free runs used instead. Per-branch coverage reasoned below.

## Acceptance criteria
1. **8 direct sites + conversations/feedback route through `domainWireCode()` — MET.** All
   8 direct responders now call `createErrorResponse(domainWireCode(error))`; grep confirms
   zero remaining `DOMAIN_ERROR_CODE_TO_WIRE_CODE` references in the 8 route files.
   conversations collapsed onto the helper; feedback converged its idempotency short-circuit
   onto the helper while preserving its two independent-authority codes.
2. **billing `byKey` body-mismatch → `IDEMPOTENCY_BODY_MISMATCH` — MET.** RED→GREEN test above.
3. **No behavior change where `wireCode` is unset (6 latent sites) — MET.** For a
   `wireCode`-unset error, `domainWireCode(error)` returns exactly
   `DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]` — byte-identical to the prior expression — and
   the status argument (`STATUS_BY_DOMAIN_CODE[error.code]`) is unchanged. The 6 latent slices
   (account, identity, models, announcements, newsletter, platform/dev) emit no
   `wireCode`-bearing errors today (research §R19: none use `idempotent.byKey`/manual claim),
   so output is identical; their existing route suites pass unchanged (347 + subsets). Where
   `wireCode` IS set (billing, admin, feedback, conversations idempotency) it is now honored —
   the intended fix, not a regression.

Feedback branch coverage (new `error.wireCode !== undefined` guard) is exercised by existing
passing tests: `IDEMPOTENCY_BODY_MISMATCH` (routes test L214), `FEEDBACK_DUPLICATE` (L226),
`FEEDBACK_SUBMIT_FAILED` default (L310).

## Deviations with reasons
- **Edited 9 domain barrel `index.ts` files, which are not in the plan §T11 Files list.**
  Necessary and mechanical: the boundaries lint forbids a slice `routes.ts` from importing
  `lib/errors` directly, so `domainWireCode` must be reached through each slice's own domain
  barrel (the same path `createErrorResponse` already travels). Each edit adds one symbol to
  an existing re-export line. Without it, "route each site through `domainWireCode()` in place"
  (the orchestrator's directed fallback) is impossible without a boundary violation. Barrel →
  `lib` is an allowed edge, so no boundary rule is broken.
- **feedback's generic branch was deliberately NOT routed through `domainWireCode`.** Its
  default is the feedback-specific `FEEDBACK_SUBMIT_FAILED` (an independent authority, like its
  `timeout: 408` status divergence noted in research §R19). Routing the default through
  `domainWireCode` would change `FEEDBACK_SUBMIT_FAILED` → `CONFLICT` for non-idempotency
  conflicts — a behavior change. Only the wire-code-carrying (idempotency) path was converged.

## Concerns and limitations
- `apps/api/CLAUDE.md` (loaded doc) states "routes map errors via `respondDomainError` with
  `DOMAIN_ERROR_CODE_TO_WIRE_CODE` + `STATUS_BY_DOMAIN_CODE`". After this change routes map via
  `domainWireCode(error)` (which still uses `DOMAIN_ERROR_CODE_TO_WIRE_CODE` as its fallback) +
  `STATUS_BY_DOMAIN_CODE`. Minor doc staleness. Not edited — `.md` edits need approval and the
  file is outside T11 ownership. Flagged for the orchestrator/human.
- `chat/routes.ts` and `media/routes.ts` already use `domainWireCode` (pre-existing work,
  present in the initial `git status` snapshot) — not touched by this task.

## Confidence
High — the change is a mechanical substitution to an existing shared helper; the load-bearing
behavior change (billing `byKey` → `IDEMPOTENCY_BODY_MISMATCH`) is pinned by a RED→GREEN test;
751 tests across all affected slices pass; typecheck and lint clean.
