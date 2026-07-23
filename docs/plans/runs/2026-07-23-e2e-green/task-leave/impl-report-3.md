# impl-report-3 — task-leave (fast modal close + post-leave 403 console allowance)

## Objective
Two firefox/ipad-pro residuals after the stable-provider decoupling (impl-report-1):
1. (app) De-await the conversations-list invalidation in `useLeaveConversation.onSuccess` so `mutateAsync` (and thus the `ActionModal` auto-close) resolves promptly instead of blocking on the refetch — the source of the flaky stuck modal on firefox.
2. (test) Allow the post-leave budgets `403 Forbidden` in the `expectConsoleErrors` guard of the leave tests that navigate/redirect (ipad hard failure on "non-owner leave navigates to /chat").

## Files changed
- `apps/web/src/hooks/realtime/use-conversation-members.ts` — `useLeaveConversation.onSuccess`: the awaited `invalidateQueries(chatKeys.conversations())` is now `void`-fired; the handler dropped `async` (no remaining `await`, else `@typescript-eslint/require-await`). `removeQueries` + the member/budget `void` invalidations are unchanged. Added a comment recording why the list refetch is fire-and-forget (stable provider owns the modal).
- `apps/web/src/hooks/realtime/use-conversation-members.test.ts` — new test proving `onSuccess` settles without awaiting the conversations refetch (Change-1 TDD).
- `e2e/group/group-chat-leave.spec.ts` — added `/Failed to load resource: the server responded with a status of 403/` to the `expectConsoleErrors` array of all three leave tests (the two `testBobPage` blocks + the `authenticatedPage` block) that navigate/redirect and already allowed the 404 console error.

## Tests added
- `useLeaveConversation > resolves onSuccess without awaiting the conversations list refetch` — races the `onSuccess` settlement against a 3-hop microtask sentinel while the conversations `invalidateQueries` returns a never-settling promise; asserts `onSuccess` wins ('onSuccess', not 'sentinel') and that the conversations invalidation still fired. Covers Change 1's acceptance: modal-close no longer gated on the refetch, but the refetch still runs.

## TDD proof (Change 1)
Wrote the test first. RED against the awaited code, twice: first a `.then`-based variant (`expected false to be true` — `resolved` stayed false because `await invalidateQueries(conversations)` never settled), then the final lint-clean race variant (`winner` = 'sentinel', not 'onSuccess'). Re-applied the awaited form once more to confirm the race variant is RED for the right reason, then applied the fix → GREEN (32/32 in the file). Only production code changed between RED and GREEN.

Change 2 is an e2e console-allowance edit (no product code); no unit TDD applies. The API-error side already declared `POST_LEAVE_BUDGETS_403`; this only adds the matching console-guard pattern. The orchestrator runs the e2e.

## Verification: nothing downstream depends on the awaited invalidation
Traced the sole caller chain: `LeaveConversationProvider.handleConfirmLeave` → `leaveConversation()` (`apps/web/src/lib/leave-conversation.ts`) → `leave` = `leaveMutation.mutateAsync`. After `leave()` resolves, `leaveConversation` returns; the only post-leave step is the `isActive`-gated `void navigate({ to: ROUTES.CHAT })`, which does not read the conversations list. No sequenced key-rotation or other step waits on the list refetch. Pin/mute/add/remove/change-privilege in the same file already `void` their list/budget invalidations. De-awaiting only the list invalidation is safe; `removeQueries` (sync) and the member/budget `void` invalidations are preserved.

## Self-gate
- `pnpm exec vitest run use-conversation-members.test.ts` — pass, 32/32.
- Leave-flow consumers `leave-conversation-controller.test.tsx` + `chat-item.test.tsx` — pass, 45/45 (no regression).
- `eslint use-conversation-members.ts + .test.ts` (from apps/web) — pass, 0 problems. (First cut surfaced `require-await` + `promise/prefer-await-to-then`/`always-return`; resolved by dropping `async` and rewriting the test to a race with no `.then`.)
- `eslint .` from apps/web — clean (exit 0, no output).
- `turbo lint typecheck --filter=@hushbox/web` — typecheck fails ONLY on `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name 'ExecutionContext'` — pre-existing, apps/api (out of my ownership), not in my git-status modified set, pre-declared in the brief and impl-report-1 as not mine; it blocks web typecheck via project reference. No type error in my files. The sibling `lint` task reported failed with no eslint output — turbo cancelled it when typecheck failed; standalone `eslint .` is clean, so lint passes.
- `prettier --check` + `eslint` (from e2e pkg dir, its own `eslint.config.js`) on `group-chat-leave.spec.ts` — both pass, 0 problems.

## Acceptance criteria
- Change 1: awaited list invalidation → non-awaited `void`, refetch still fires, `mutateAsync` resolves promptly — MET (TDD test + diff). Invalidation not removed — MET. No other awaited-onSuccess ordering broken — MET (verification above).
- Change 2: 403 Forbidden resource-load console pattern added to the navigate/redirect leave tests, no broader; no skips/weakened assertions — MET. Report-2's websocket alternation preserved untouched (diff confirms).

## Deviations
- Dropped `async` from `useLeaveConversation.onSuccess` (beyond the bare `await`→`void` swap the brief described) because the handler has no remaining `await` and would otherwise trip `@typescript-eslint/require-await`. Behavior identical; react-query accepts a sync `void`-returning `onSuccess`. This is the minimal lint-clean form of the requested change.

## Concerns and limitations
- The firefox flaky-modal and ipad 403-console hard-failure can only be confirmed green by the multi-project e2e run, which is the orchestrator's step. Unit-level (Change 1) and format/lint (Change 2) verification is complete.
- The `require-await`-driven `async` removal means `onSuccess` now returns `void` rather than a `Promise`; the new test types it `void | Promise<void>` and the existing `await onSuccess(...)` call sites tolerate a non-promise return (awaiting a value resolves immediately).

## Confidence
High — Change 1 is a surgical, TDD-proven de-await with the downstream-independence traced end-to-end; Change 2 is a single-pattern console-guard widening matching the already-declared API-error class, format/lint green, report-2's work preserved.
