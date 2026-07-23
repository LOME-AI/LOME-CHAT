# impl-report-1 — split routes-deletion.integration.test.ts

## Objective

Split the single-describe `apps/api/src/slices/identity/routes-deletion.integration.test.ts`
(17 `it()`s, ~187s coverage pole) into 2 cohesive sibling files that each import the
UNCHANGED `./routes.integration.setup.ts`, to parallelize. Behavior-preserving, coverage
unchanged. The split axis is the `it()`s (the file is one top-level describe).

## Files changed

- `apps/api/src/slices/identity/routes-deletion.integration.test.ts` — DELETED (its 17
  tests moved verbatim into the two new siblings).
- `apps/api/src/slices/identity/routes-deletion-execute.integration.test.ts` — NEW. 8 tests:
  the deletion executes or atomically doesn't — happy step-up delete + media reclaim,
  short-fumble-then-delete, no-media delete, transaction rollback, dispatcher `waitUntil`
  nudge, vanished-user defect (500), step-up+valid-TOTP delete, 2FA-no-secret defect (500).
  Carries `seedOwnedMedia`/`reclaimJobsFor` (the only conversation-seeding tests live here).
- `apps/api/src/slices/identity/routes-deletion-gate.integration.test.ts` — NEW. 9 tests:
  the deletion is gated/rejected — step-up lockout counting (registry cap, 3rd-attempt,
  24h hard lock), wrong-TOTP lockout, stolen-handshake collision, wrong confirmation phrase,
  TOTP-required, wrong-TOTP rejection, pre-tripped-TOTP-lockout.

Both new files keep the original `describe('identity routes: account-deletion request', …)`
title. Every `it()` body is copied verbatim (no assertions weakened). Shared file-local
helpers `deleteInit` and `deleteFinish` are small and replicated into both files (they are
NOT exported from setup); `seedOwnedMedia`/`reclaimJobsFor` are replicated only into the
execute file (only its tests use them). `deleteFinish` was hoisted to the top of each
describe (function declaration — hoisting-safe; original defined it mid-describe).

## Cleanup replication (the delicate part)

Both files carry the file-local `afterAll` that PREFIX-scoped-`DELETE`s `conversations`
(FK-cascading its dependents). Registered after the setup import, it runs BEFORE the setup
module's `users` delete (vitest afterAll LIFO), clearing the FK dependents first. The
cross-slice `conversations` write stays inside a `*.test.ts` file, which the
single-writer-per-table arch rule exempts.

Observation (not a deviation): with this split only `seedOwnedMedia` seeds `conversations`,
and it lives in the execute file — so the gate file's `afterAll` is a harmless no-op today.
It is retained per the brief's CRITICAL instruction (both files carry it) as a symmetry/safety
guard so either file stays self-cleaning if a conversation-seeding test later moves; its
comment states this honestly rather than claiming the gate file seeds conversations.

## Self-gate

- `pnpm exec turbo typecheck lint --filter=@hushbox/api` — PASS (2 successful, 2 total).
  The brief flagged a possible pre-existing pipeline-bindings error to attribute; it did NOT
  surface — both tasks succeeded clean, nothing to attribute.
- Clean combined run (`ensure-stack` then `vitest run --root apps/api <both files>`) — PASS,
  Test Files 2 passed (2), Tests 17 passed (17), 16.9s (was ~187s).
- Execute file twice back-to-back — PASS both (8 passed, 8 passed). No FK error, no 23505.
- Gate file twice back-to-back — PASS both (9 passed, 9 passed). No FK error, no 23505.

The twice-back-to-back green on the execute file is the cleanup-replication proof: test 1
inserts a conversation + membership + message (senderId = userId); the run's `users` delete
would FK-trip on those rows unless the local `afterAll` cascaded them first. Two clean
consecutive runs confirm the local afterAll runs first and cascades deterministically.

## Acceptance criteria

- 2 cohesive sibling files, each importing UNCHANGED setup — MET (setup untouched; both
  `import … from './routes.integration.setup.js'`).
- Every `it()` in exactly one file, none dropped, counts sum to 17 — MET (8 + 9 = 17;
  verified by grep count and by test-runner totals).
- Behavior-preserving, coverage unchanged — MET (bodies verbatim; same code exercised; only
  the file boundary changed).
- Cleanup replicated in both files — MET (both carry the PREFIX-scoped conversations delete).
- Both files green on a clean run — MET.
- Each file green twice back-to-back, no orphan leak — MET.
- typecheck+lint clean for the two files — MET.

## Deviations

None.

## Concerns and limitations

- The other modified/new files under `apps/api/src/slices/identity/` in `git status`
  (routes-2fa, routes-edge, routes-login-session, routes-2fa-disable, routes-revocation,
  routes-timing-store) are concurrent sibling-split work by other agents — not touched by me.
- Gate file's `afterAll` is a no-op today (see Cleanup replication above); kept per brief.

## Confidence

high — verbatim test-body moves, exact import scoping (no unused-import lint failures),
typecheck+lint clean, and the twice-back-to-back leak proof passed for both files.
