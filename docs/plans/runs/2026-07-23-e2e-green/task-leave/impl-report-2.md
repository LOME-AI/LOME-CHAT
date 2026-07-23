# impl-report-2 — task-leave (POST_LEAVE_PREFETCH_404 websocket allowance)

## Objective
Widen the `POST_LEAVE_PREFETCH_404` allowance regex in `e2e/group/group-chat-leave.spec.ts` to include the expected post-leave `404 Not Found GET /conversations/<id>/websocket` transient, so the fixture API-error guard stops tripping the sibling leave tests.

## Files changed
- `e2e/group/group-chat-leave.spec.ts` — added `websocket` to the subresource alternation in `POST_LEAVE_PREFETCH_404`; updated the preceding comment to record that the rejected post-leave WS upgrade 404s the same way as the other subresource prefetches.

## Exact regex change
Before:
```
/404 Not Found GET .*\/conversations\/[0-9a-f-]+(?:\/(?:messages|members|links|keychain|budgets))?(?=\?|\s|$)/
```
After:
```
/404 Not Found GET .*\/conversations\/[0-9a-f-]+(?:\/(?:messages|members|links|keychain|budgets|websocket))?(?=\?|\s|$)/
```
Single-token widening (`|websocket`). The `GET` literal, `/conversations/<uuid>/` prefix, optional-group, and trailing boundary anchor `(?=\?|\s|$)` are all unchanged.

## Tests added
None — this task modifies an allowance list inside an e2e spec, not product code. The behavior under test (leave flows) is unchanged; the change is that a previously-undeclared expected transient is now declared. Verification is by regex match check (below); the orchestrator runs the e2e to confirm the sibling tests pass.

## Self-gate
- `node` regex verification — pass. Confirmed OLD regex MISSES `/conversations/<uuid>/websocket` (the gap), NEW regex matches it plus all previously-covered routes (`messages`, `members`, `links`, `keychain`, `budgets`, bare conversation id, both with `?query` and boundary-terminated). NEW regex still rejects: non-conversation URLs (`/catalog/models`), a `/websocketX` sibling-prefix impostor, and a non-GET verb line.
- `prettier --check group/group-chat-leave.spec.ts` — pass (all files formatted correctly).
- `eslint group/group-chat-leave.spec.ts` — pass (no issues found).
- `turbo typecheck lint --filter=@hushbox/web` — N/A per brief (this is an e2e spec, not web source).

## Acceptance criteria
- Add `websocket` to the alternation, no broader — met. Only `|websocket` added; all anchors/prefixes intact (evidence: regex diff above + match verification).
- Do not add skips, weaken assertions, or touch the modal fix — met. No `test.skip`/`.only`, no assertion changed, no other file touched; `git status` showed the file clean before edit.
- Match the established post-leave-subresource pattern and documented behavior — met; comment updated to keep the enumeration accurate (a wrong/incomplete comment is worse than none).

## Deviations
- Extended the explanatory comment above the regex (beyond the bare alternation edit) so its enumerated resource list stays accurate now that `websocket` is covered. This is within the single-file bound and keeps the comment truthful; it does not broaden the regex.

## Concerns and limitations
- The actual e2e confirmation (sibling leave tests passing on firefox/webkit/ipad-pro) can only be observed by running the suite, which is out of scope per the brief. Regex-level verification is complete; runtime confirmation is the orchestrator's step.

## Confidence
High — the gap and the fix are both mechanically verified at the regex level; both lint/format gates are green; the change is a one-token, boundary-preserving widening matching the existing pattern.
