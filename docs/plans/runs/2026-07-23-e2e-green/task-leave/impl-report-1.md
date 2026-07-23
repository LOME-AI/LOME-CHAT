# impl-report-1 — Fix stuck leave-confirmation modal (non-active sidebar leave, mobile)

## Objective
Fix `e2e/group/group-chat-leave.spec.ts` "leave from sidebar of a non-active chat leaves URL unchanged": on touch devices the `leave-confirmation-modal` stays stuck after Confirm because the modal is owned by the `ChatItem` row that the leave removes. Decouple the modal (and the leave flow) from the removed row (analyst Fix A).

## Root cause (confirmed)
`LeaveConfirmationModal` (a vaul `Drawer` on touch) was rendered inside `ChatItem`. Confirm → `leaveConversation` → `useLeaveConversation.onSuccess` awaits `invalidateQueries(chatKeys.conversations())`; the refetch drops the row, so `ChatItem` and its still-open modal unmount before `ActionModal`'s auto-close `onOpenChange(false)` runs. On mobile, unmounting an open vaul drawer leaves its portaled node stuck in the DOM.

## Structural change
Introduced `LeaveConversationProvider` (`apps/web/src/components/sidebar/leave-conversation-controller.tsx`) — a stable ancestor of every sidebar row that owns the leave-confirmation modal and the entire leave flow. Rows now call `requestLeave(conversation, isActive)` (via `useRequestLeave()` context) instead of rendering their own modal. The provider is mounted once in `SidebarContent` (wrapping the `<nav>`), so it survives the list invalidation that removes the row; the auto-close then lands on a still-mounted component.

The confirm logic (`handleConfirmLeave`: auth/key guards, `leaveConversation` with `ensureKeysCached`, and the `isActive`-gated redirect) moved verbatim from `ChatItem` into the provider. Behavior preserved: URL unchanged for a non-active leave, redirect to `/chat` only for the active chat, row still disappears after refetch.

## Files changed
- `apps/web/src/components/sidebar/leave-conversation-controller.tsx` (new) — context + `LeaveConversationProvider` owning the modal and leave flow.
- `apps/web/src/components/sidebar/leave-conversation-controller.test.tsx` (new) — TDD tests (below).
- `apps/web/src/components/sidebar/chat-item.tsx` — removed local `showLeaveDialog` state, `handleConfirmLeave`, the `<LeaveConfirmationModal>` render, and now-unused imports (`useQueryClient`, `useLeaveConversation`, `useAuthStore`, `keyChainQueryOptions`, `processKeyChain`, `leaveConversation`, `LeaveConfirmationModal`); `handleLeaveClick` now calls `requestLeave(conversation, isActive)`.
- `apps/web/src/components/sidebar/sidebar-content.tsx` — wrap `<nav>` in `<LeaveConversationProvider>`.
- `apps/web/src/components/sidebar/chat-item.test.tsx` — render wrapper now includes `LeaveConversationProvider` (its Leave-behavior tests now exercise the provider through the row, preserving coverage of executeWithRotation/navigate/no-user/no-key/cancel).

## Tests added (leave-conversation-controller.test.tsx)
- `keeps the confirmation modal mounted when the row that opened it is removed` — structural fix, touch override forcing the vaul bottom sheet; opens Leave, removes the conversation from the list, asserts the modal survives (owned by the stable provider). Covers the failing e2e's class.
- `runs the leave flow and closes the modal on confirm` — non-touch (Radix, reliably unmounts in jsdom); asserts `executeWithRotation` runs and the modal closes.
- `throws when requestLeave is used without a provider` — covers the fail-fast default context.

## TDD proof
Wrote the structural test first, ran it against the pre-refactor tree (modal still in `ChatItem`, `requestLeave` not yet called): RED — after removing the row, `getByTestId('leave-confirmation-modal')` failed with "Unable to find an element by [data-testid=leave-confirmation-modal]" (the modal unmounted with the row — exactly the bug). After moving the modal to the provider and wiring `ChatItem` to `requestLeave`: GREEN. Between RED and GREEN only production code changed, not the test's intent.

Note (per brief caveat): jsdom does NOT reproduce vaul's stuck-portal on *close* (the sheet lingers on `open=false`), so the "modal closes" assertion uses the non-touch Radix path; the touch stuck-portal case remains the iphone-15 e2e oracle. The structural survival assertion is deterministic in jsdom for both renderers and is the authoritative unit-level guard.

## Self-gate
- `pnpm test:web` — PASS: 6004 passed / 364 files. Coverage on `leave-conversation-controller.tsx` = 100% stmts/branch/funcs/lines. One coverage failure remains: `src/hooks/models/use-resolve-default-model.ts` branches 87.09% — NOT mine (unmodified working tree, last committed 92785bc4, unrelated to sidebar); pre-existing/outside ownership.
- `turbo typecheck lint --filter=@hushbox/web` — lint PASS (`eslint .` clean on all web). typecheck surfaces only `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name 'ExecutionContext'` — the pre-existing error flagged in the brief as not mine (apps/api; blocks web typecheck via project reference). No type errors in my web files.
- `jscpd --threshold 2` on the new + changed files — 0 clones.

## Acceptance criteria
- Modal owned by a stable sidebar-level owner, driven by `leaveTargetId`-equivalent state (`target`) — MET (`LeaveConversationProvider`).
- Per-row Leave sets the target at the owner level instead of rendering the modal in the row — MET.
- Confirm runs the existing `leaveConversation` flow; modal closes cleanly — MET (logic moved verbatim; provider stays mounted).
- URL unchanged for non-active leave, redirect only for active leave, row still disappears — MET (isActive-gated navigate preserved; covered by chat-item.test navigate tests).

## Deviations
- The leave-behavior tests remain in `chat-item.test.tsx` (now wrapped in the provider) rather than being migrated to the controller test, to preserve existing coverage with minimal churn; they exercise the same moved logic through the real row→provider wiring.

## Concerns / limitations (flagged follow-up — NOT fixed, per scope)
- Delete and Rename dialogs (`DeleteConversationDialog`, `RenameConversationDialog`) are still rendered inside `ChatItem`. The owner-delete path removes the conversation (row unmounts), so it shares the same "modal-inside-the-removed-row" shape and is a latent mobile stuck-portal bug. Left untouched per scope; flagged for a future task. No comment was added claiming they are fixed.
- The e2e "may newly surface expected post-leave transient errors" allowances were NOT needed: the failing test (`leave from sidebar of a non-active chat leaves URL unchanged`) does not navigate back into the left conversation, so it declares no `expectApiErrors`/`expectConsoleErrors`, and nothing in the fix introduces new post-leave prefetch/WS noise. No allowance changes made. (The iphone-15 e2e is the authoritative oracle — only the orchestrator runs it.)

## Confidence
High — root cause is precisely reproduced and fixed at the component level (RED→GREEN structural test), full web suite green, my file at 100% coverage, lint/duplication clean. Residual: the touch stuck-portal itself is only provable in the real iphone-15 e2e (jsdom limitation), which the orchestrator runs.
