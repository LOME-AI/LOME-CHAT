# impl-report-1 — T06 (R15): align WS-upgrade non-member response to 404

## Objective

WS-upgrade for a non-member returns an existence-hiding 404 (was existence-revealing 403),
matching the sibling `GET /:conversationId` and legacy. SENSITIVE authorization change.

## Files changed

- `apps/api/src/slices/conversations/routes.ts` — the two WS-upgrade refusal sites swapped
  from `createErrorResponse(ERROR_CODES.FORBIDDEN), 403` to
  `createErrorResponse(ERROR_CODES.NOT_FOUND), 404`:
  - `userUpgradePrincipal` (`member.value === null` — non-member session).
  - `guestUpgradePrincipal` (`guest.value === null` — revoked guest whose member row is left).
  - The `resolveUpgradePrincipal` doc comment (which stated the revoked guest "is denied 403")
    reconciled to state the existence-hiding 404. Comments added at both sites recording the
    existence-hiding rationale and the sibling-GET precedent (durable facts).
- `apps/api/src/slices/conversations/routes.integration.test.ts` — the two existing tests that
  pinned the regressed 403 updated to assert the correct 404 + `ERROR_CODES.NOT_FOUND`
  (test level: integration, the only level that reaches these unexported route helpers).

## Tests added / changed

- `hides an existing conversation from a non-member with 404 before proxying` (was
  `refuses a non-member with 403 before proxying`) — non-member **user** upgrade → 404 +
  `{ code: NOT_FOUND }`. Covers `userUpgradePrincipal`.
- `hides the conversation from a revoked guest whose member row is left with 404` (was
  `denies the upgrade to a revoked guest whose member row is left`) — non-member **guest**
  upgrade (revoked, row left) → 404 + `{ code: NOT_FOUND }`, still no upgrade forwarded.
  Covers `guestUpgradePrincipal`.
- Member-success paths left unchanged and green: `proxies the upgrade to the DO for an active
  member`, `upgrades a full-session member with isGuest false`, `upgrades an active guest with
  isGuest true …` — a valid member/guest upgrade still succeeds (200).

## TDD evidence (RED → GREEN)

- RED: with the two tests updated to expect 404 but code unchanged, both failed for the right
  reason — `AssertionError: expected 403 to be 404` at the two upgrade sites (status mismatch,
  the exact regression), not an error/typo.
- GREEN after the two code swaps: all 20 `websocket upgrade` tests pass; full
  `routes.integration.test.ts` = 251/251 pass.

## Self-gate

- `vitest run routes.integration.test.ts -t "websocket upgrade"` — pass (20 passed, 231 skipped).
- `vitest run routes.integration.test.ts` (full file) — pass (251/251).
- `eslint src/slices/conversations/routes.ts routes.integration.test.ts` (from `apps/api`, after
  last edit) — pass (exit 0).
- `turbo typecheck --filter=@hushbox/api --force` — pass (exit 0).

## Acceptance criteria

- **Both upgrade sites return 404 mirroring the sibling GET** — met. `userUpgradePrincipal` and
  `guestUpgradePrincipal` now emit `ERROR_CODES.NOT_FOUND`/404, matching the sibling GET's
  `{ refusal: 'not-found' }` → `NOT_FOUND`/404 (`outcomes.ts:49-54`) and legacy's
  `CONVERSATION_NOT_FOUND`/404 (report L3462-3465). Chose the generic `ERROR_CODES.NOT_FOUND`
  the sibling GET emits (the closest in-repo precedent) over a conversation-specific code, per
  the research note.
- **Member upgrade still succeeds** — met (member/guest-success tests unchanged and green).
- **A test covers non-member → 404 for both user and guest upgrade** — met (the two tests above).

## Parity anchors quoted

- Legacy (report L3462-3465, authenticated-user WS upgrade): "If no row found → `404` error code
  `CONVERSATION_NOT_FOUND` (`ERROR_CODE_CONVERSATION_NOT_FOUND`)." Legacy hides existence behind a
  404 for a non-member.
- Sibling GET pattern mirrored (`domain/outcomes.ts:49-54`):
  `.with({ refusal: 'not-found' }, (): WireRefusal => ({ code: ERROR_CODES.NOT_FOUND, status: 404 }))`,
  reached by `getConversation` for a non-member caller (`member === null` →
  `{ refusal: 'not-found' }`) exactly as for a genuinely absent conversation.

## NEEDS_CONTEXT trigger check

Trigger: report if the current 403 path carries a distinction a 404 would erase for anything
other than a non-member. Not triggered. Both null branches are strictly non-member cases:
`userUpgradePrincipal` fires only when `activeByUser` returns null (no active member row — an
active member with a rotated epoch still has a row and never reaches this branch);
`guestUpgradePrincipal` fires only when `activeLinkGuest` returns null (member row left =
revoked guest = non-member). No epoch-rotation or other member-state distinction lives on either
403 path.

## Deviations

None.

## Concerns and limitations

- COORDINATION for T11 (edits this same file after me): my change is localized to the two
  upgrade sites (`userUpgradePrincipal`/`guestUpgradePrincipal`) plus one doc comment; it does
  not touch `respondDomainError`, `domainWireCode`, or any idempotency-conflict responder T11
  will converge — no overlap expected.
- The repo is mid-`git rebase` (pre-existing, unrelated to this task); the two files I touched
  (`routes.ts`, `routes.integration.test.ts`) were clean in the working tree before my edits, so
  the diff is fully attributable to this task.

## Confidence

High — RED confirmed the regression, GREEN + full-file (251/251), typecheck and lint all pass;
change is a two-site literal swap mirroring an existing in-repo pattern and legacy.
