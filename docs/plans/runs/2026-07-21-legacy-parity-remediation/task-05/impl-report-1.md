# T05 impl-report-1 — R14: restore removal-specific refusal code

## Status: DONE

SENSITIVE (authorization). Ownership was corrected mid-task: the `friendlyErrorMessage`
copy table is in `packages/shared/src/error-codes.ts` (the `ERROR_MESSAGES` map, `:197`),
not `error-messages.ts`. Corrected Files: `apps/api/src/slices/conversations/domain/members.ts`
+ `packages/shared/src/error-codes.ts`. Coordinator confirmed `error-codes.ts` has no other
active editor this run.

## Objective

Member-removal refusal (`members.ts:370`) stops answering generic `FORBIDDEN` and answers
the removal-appropriate `PRIVILEGE_INSUFFICIENT` again (matching the sibling
privilege-change path), the friendly copy broadened to read correctly for BOTH removal and
privilege-setting, and the overclaiming comment at `members.ts:643-648` reconciled.

## Files changed

- `apps/api/src/slices/conversations/domain/members.ts` — flipped the not-strictly-senior
  removal refusal from `{ refusal: 'forbidden' }` to `{ refusal: 'privilege-insufficient' }`
  (the `!canRemoveMember` branch in `removalGate`); added a durable comment stating the
  legacy parity; reconciled the sibling privilege-change comment so it no longer frames
  `PRIVILEGE_INSUFFICIENT` as unique to privilege-setting (removal now shares the code).
- `packages/shared/src/error-codes.ts` — broadened the `PRIVILEGE_INSUFFICIENT` friendly
  copy from "You can't set a privilege at or above your own level." to "You don't have
  sufficient privilege over this member." so it reads correctly for both removal and
  privilege-setting.
- `apps/api/src/slices/conversations/domain/members.test.ts` (test) — new RED→GREEN
  parity test.

## Tests added

- `removeMember authorization ladder > refuses removing a member the caller is not
  strictly senior to as privilege-insufficient` — an admin caller attempting to remove a
  peer admin (`canRemoveMember('admin','admin') === false`) reaches `members.ts:370` and
  must answer `{ refusal: 'privilege-insufficient' }`. Covers acceptance criterion 2
  (removal refusal returns the specific code, not generic FORBIDDEN).

## RED→GREEN evidence

- RED (before flip): `AssertionError: expected { refusal: 'forbidden' } to deeply equal
  { refusal: 'privilege-insufficient' }` — failed for exactly the diagnosed reason
  (generic FORBIDDEN on the removal not-strictly-senior branch).
- GREEN (after flip): `members.test.ts` + `outcomes.test.ts` → 50 passed.

Wire-code chain (refusal → `{code: PRIVILEGE_INSUFFICIENT}`): the `privilege-insufficient`
refusal maps to `ERROR_CODES.PRIVILEGE_INSUFFICIENT` / 403 in the UNCHANGED
`outcomes.ts:105-106`, and `routes.integration.test.ts:3395-3409` already asserts
`{ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT }` on the wire for that refusal (it pins the
code constant, unaffected by the copy reword). The removal path now emits the same refusal,
so it inherits the same proven wire code. That integration file was not runnable in this
sandbox (no `DATABASE_URL`; see self-gate), but the mapping it exercises is unchanged.

## Broadened copy reads correctly for both uses

- Removal not-strictly-senior refusal (e.g. admin removing a peer admin): "You don't have
  sufficient privilege over this member." — correct.
- Privilege-change over-grant / not-strictly-below refusal (`changeMemberPrivilege`): "You
  don't have sufficient privilege over this member." — correct; the old wording
  ("...set a privilege at or above your own level") was narrower but the new wording still
  covers the privilege-setting case. Confirms the brief's NEEDS_CONTEXT trigger does NOT
  fire — one copy genuinely serves both; no new sibling code was needed.

## Overclaiming comment reconciled

`members.ts` privilege-change comment now reads: "Legacy returns the distinct
PRIVILEGE_INSUFFICIENT (403) for an over-grant / not-strictly-below refusal — the same
code the removal path uses for its own not-strictly-senior refusal — not the generic
FORBIDDEN the non-admin-caller rung above uses." It no longer implies the code is unique
to privilege-setting.

## Legacy parity anchor (G1)

`research/legacy-conversations.md:246-262`, quoting `legacy/LEGACY-BEHAVIOR-REPORT.md`:
- `:1071-1073` (remove member): "Requester privilege check via `canRemoveMember` → `403
  PRIVILEGE_INSUFFICIENT` if requester isn't strictly senior [to] target (e.g. admin cannot
  remove admin...)."
- `:1085-1086` (change member privilege): "`canChangePrivilege` gate → `403
  PRIVILEGE_INSUFFICIENT` otherwise."

Both legacy paths returned the identical `403 PRIVILEGE_INSUFFICIENT`. The auditor should
independently open the legacy report per G1.

## Self-gate

- `npx vitest run members.test.ts outcomes.test.ts` (apps/api) — pass — 50 passed.
- `npx vitest run src/slices/conversations/domain/` (apps/api) — 249 unit tests passed;
  4 files FAILED at import on `DATABASE_URL is required...` — all `*.integration.test.ts`
  (budgets, fork-tip-settlement, sequence-block, wrap-epoch), none touching removal
  authorization. Environmental (local stack not up in sandbox), pre-existing, unrelated to
  this change — attributed out.
- `pnpm test:shared` — pass (no test pins the `PRIVILEGE_INSUFFICIENT` copy string; copy
  reword breaks nothing).
- `npx eslint members.ts members.test.ts` (from apps/api) — exit 0.
- `npx eslint src/error-codes.ts` (from packages/shared) — exit 0.
- `pnpm --filter @hushbox/api typecheck` — exit 0. `pnpm --filter @hushbox/shared typecheck`
  — exit 0. (The pre-existing `pipeline-bindings.ts` ExecutionContext error the coordinator
  flagged did not surface here; nothing to attribute out.)

## Deviations

- File ownership corrected from `error-messages.ts` to `error-codes.ts` (coordinator
  approved; recorded in plan.md §"T05 file-ownership correction"). No behavioral deviation
  from the acceptance criteria.

## Concerns and limitations

- The conversations `*.integration.test.ts` suite (including the routes test that asserts
  the wire code) requires a running local stack (`DATABASE_URL`) not available in this
  sandbox. Phase-4 integration run should confirm the removal path returns
  `{ code: PRIVILEGE_INSUFFICIENT }` end-to-end; the domain unit test + unchanged
  outcomes/routes mapping make this a formality.
- `outcomes.test.ts` does not include a `privilege-insufficient` row in its `refusalToWire`
  case table (pre-existing gap; the mapping is covered by the integration test instead). Not
  in scope to add here and not in my file ownership.

## Confidence: high — RED→GREEN proven at the domain level for the exact diagnosed branch; wire code inherited from an unchanged, already-tested mapping; copy verified correct for both consumers; all in-bounds gates green.
