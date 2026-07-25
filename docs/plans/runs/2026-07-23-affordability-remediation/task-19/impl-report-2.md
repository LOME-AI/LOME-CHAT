# Task 19 — fix cycle 1: cover the conversation-cap 0-row disambiguation tail — impl report 2

Status: DONE

## Objective

Close the single validated audit finding: `writeOwnerConversationCap`'s 0-row
disambiguation tail (`budgets.ts:204-209`) became race-only-reachable after the
authz pre-check landed, dropping `budgets.ts` branch coverage to 91.17% —
below the 95% per-file gate. Fix direction (per brief): unit tests with a
stubbed `ConversationsStores` where `updateBudget` returns null. Nothing else
reworked; `budgets.ts` untouched (orchestrator ruled the tail STAYS).

## Files changed

- `apps/api/src/slices/conversations/domain/budgets.test.ts` — NEW (the file's
  only colocated unit test file; did not previously exist). Two cases driving
  `setConversationBudget` through the race-only tail via the existing
  `fakeStores`/`conversationRecord` fixtures (`test-fixtures.ts`): first
  `conversations.get` answers the authz pre-check with the owner's row,
  `updateBudget` reports 0 rows (null), second `get` discriminates.

No production file touched. No plan/task labels in code or comments (the
header comment states the durable fact — tail reachable only via a
mid-transaction race — not task state).

## Tests added → finding

- `answers forbidden when the update misses but the row still exists
  (re-owned mid-transaction)` — row-present tail outcome ⇒
  `{ refusal: 'forbidden' }` (budgets.ts:209 right arm).
- `answers not-found when the update misses and the row is gone (deleted
  mid-transaction)` — row-gone tail outcome ⇒ `{ refusal: 'not-found' }`
  (budgets.ts:209 left arm).

Mocks are in-bounds here per the brief: this is exactly the race-only branch
real infra cannot deterministically produce (the same `fakeStores` pattern the
sibling `conversations.test.ts` zero-row-disambiguation suites use).

TDD: both cases first ran with deliberately inverted expectations and FAILED
with cross-discriminating values — the row-present stub actually produced
`forbidden` (against the wrong `not-found` expectation) and the row-gone stub
produced `not-found` (against the wrong `forbidden`) — proving the assertions
discriminate the two arms. Expectations then restored; 2/2 green.

## Self-gate (Verified, this session)

- Focused run: `budgets.test.ts` 2/2 passed.
- **Coverage (the finding's evidence):** scoped run of the FULL conversations
  + billing suites (`vitest run --project api src/slices/conversations
  src/slices/billing --coverage`) with `--coverage.include` narrowed to
  `budgets.ts` and an isolated `--coverage.reportsDirectory` (scratchpad
  `cov-budgets/`, per A1-lane environment guidance — no shared
  `coverage/.tmp` collision): 77 files / **1277 passed**, `budgets.ts`
  **100% statements (66/66), 100% branches (34/34), 100% functions (29/29),
  100% lines (59/59)** — the perFile 95 gate passes on every axis; lines
  205-209 now execute.
- `eslint src/slices/conversations/domain/budgets.test.ts` run from
  `apps/api` AFTER the final edit: **exit 0**.
- `tsc --noEmit` (apps/api): budgets.test.ts clean. The run itself is RED,
  entirely from the A1-addendum-3 out-of-run push/sandbox lane — every
  errored file (`notifications/*`, `app.ts` `NotificationsDeps`,
  `chat/routes.integration.test.ts` `PushRecipient.token`) references that
  lane's changed push types, and the notifications tree + chat test are
  git-dirty from it. Attributed around per A1 addendum 3; not edited.

## Acceptance criteria (the one finding)

- Both tail outcomes pinned (row-present ⇒ forbidden, row-gone ⇒ not-found) —
  **met** (tests above).
- `budgets.ts` per-file coverage ≥95 all axes with conversations+billing
  suites — **met** (100/100/100/100, run evidence above).
- eslint exit-0 on the touched file from apps/api after final edit — **met**.
- No plan/task labels in comments — **met**.

## Deviations

None. One test file created; nothing else changed.

## Concerns and limitations

- The scoped coverage run narrows `--coverage.include` to `budgets.ts` so the
  per-file threshold judges exactly the file in question without dragging in
  files owned by suites outside the two named packages' scope; the suites
  executed are the full conversations + billing sets the finding was measured
  against.
- apps/api typecheck remains RED from the concurrent push lane (A1 addendum
  3) — pre-attributed, out of this task's ownership, unchanged by this fix.

## Confidence

High — the finding was a pure coverage gap on a ruled-to-stay branch; the two
new cases execute both arms (100% branch coverage measured), the RED phase
proved the assertions discriminate, and no production code moved.
