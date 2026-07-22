# T23 — R14 residual: non-admin removal + privilege-change rungs → PRIVILEGE_INSUFFICIENT

## Objective

Change the member-removal refusal for a NON-ADMIN caller (`members.ts:287-289`) — and, for
internal consistency, the sibling privilege-change non-admin rung (`members.ts:641-643`) — from
`FORBIDDEN` to `PRIVILEGE_INSUFFICIENT`, matching legacy (which mounted `requirePrivilege('admin')`
on both routes, answering `PRIVILEGE_INSUFFICIENT` for a below-admin caller). Reuse the code
+ friendly copy T05 already broadened; no new code, no error-codes.ts edit.

## Legacy anchor (quoted)

`legacy/apps/api/src/legacy/routes/members.ts`:
- `/:conversationId/remove` route mounts `requirePrivilege('admin')` (line 386).
- `/privilege` PATCH route mounts `requirePrivilege('admin')` (line 462).

`legacy/apps/api/src/legacy/middleware/require-privilege.ts:308-310`:
```ts
if (getPrivilegeLevel(member.privilege) < getPrivilegeLevel(options.minLevel)) {
  return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
}
```
So a below-admin caller on either route received `403 PRIVILEGE_INSUFFICIENT` in legacy — never a
generic FORBIDDEN. Report L380/L1072 corroborates ("a write-privilege user can never remove
anyone" → PRIVILEGE_INSUFFICIENT).

## Files changed

- `apps/api/src/slices/conversations/domain/members.ts` — two one-word refusal changes:
  - `removeMember` non-admin rung (`:288`): `'forbidden'` → `'privilege-insufficient'` (+ a
    legacy-parity comment).
  - `changeMemberPrivilege` non-admin rung (`:642`): `'forbidden'` → `'privilege-insufficient'`
    (+ a legacy-parity comment).
  - Reconciled the two existing comments (`removalGate` and the `changeMemberPrivilege` inner
    refusal) that falsely claimed the non-admin rung uses "generic FORBIDDEN" — after this change
    those rungs use PRIVILEGE_INSUFFICIENT too, so the comments now state all these rungs share the
    one code matching legacy's `requirePrivilege('admin')`. (Own-mess cleanup: my change made the
    old comment text wrong.)
- `apps/api/src/slices/conversations/domain/members.test.ts` — updated the `changeMemberPrivilege`
  non-admin unit assertion to `privilege-insufficient`; added a new `removeMember` non-admin unit
  test asserting `privilege-insufficient` (there was no such removeMember unit test before).
- `apps/api/src/slices/conversations/routes.integration.test.ts` — route assertions:
  - "forbids a write member from removing anyone" → renamed to
    "refuses a write member removing anyone as privilege-insufficient"; the test previously only
    asserted status 403 (which FORBIDDEN and PRIVILEGE_INSUFFICIENT share), so I strengthened it to
    also assert `{ code: PRIVILEGE_INSUFFICIENT }` — otherwise it would pass either way and pin
    nothing.
  - "forbids a non-admin from changing a privilege" → renamed; changed the `FORBIDDEN` body
    assertion to `PRIVILEGE_INSUFFICIENT`.

## Tests added / changed

- Unit `members.test.ts` "changeMemberPrivilege authorization ladder > refuses a non-admin caller
  as privilege-insufficient" — non-admin change-privilege caller → `{refusal:'privilege-insufficient'}`.
  Covers acceptance for the sibling rung.
- Unit `members.test.ts` "removeMember authorization ladder > refuses a non-admin caller as
  privilege-insufficient" — NEW; non-admin removal caller → `{refusal:'privilege-insufficient'}`.
  Covers acceptance for the primary rung.
- Integration `routes.integration.test.ts` two renamed tests now assert
  `{ code: PRIVILEGE_INSUFFICIENT }` at the route boundary.

## Self-gate

- `vitest run members.test.ts` (unit) — pass — 27 passed. RED first observed: the two non-admin
  assertions failed with `expected {refusal:'forbidden'} to deeply equal {refusal:'privilege-insufficient'}`;
  after the production change both GREEN.
- `vitest run routes.integration.test.ts -t "privilege-insufficient"` — pass — 3 passed / 248 skipped
  (stack up).
- `vitest run routes.integration.test.ts -t "remove member|change privilege"` — pass — 12 passed
  (confirms the OTHER rungs — self, owner, not-found, unknown-member-id — unchanged and green).
- `vitest run routes.integration.test.ts -t "link privilege change|link name change|my-name"` — pass
  — 12 passed (confirms the distinct link-path FORBIDDEN cases are untouched; no collateral / no
  collision with a legitimate FORBIDDEN case).
- `eslint` on the three owned files (from `apps/api`) — pass — exit 0.
- `tsgo --noEmit` (api) — 2 errors, both in `src/slices/models/adapters/integration-setup.test.ts`
  (`no exported member 'deriveIntegrationEnv' / 'setupIntegrationProvider'`). That file is UNTRACKED
  (`git status` = `??`), outside my ownership, unrelated to conversations — concurrent models-workstream
  WIP. My three owned files produce zero typecheck errors. Attributed out.

## Acceptance criteria

- Non-admin removal caller now gets `{refusal:'privilege-insufficient'}` → `{code:PRIVILEGE_INSUFFICIENT}`
  (was FORBIDDEN) — MET (unit + route tests green; RED→GREEN observed).
- Sibling privilege-change non-admin rung likewise → PRIVILEGE_INSUFFICIENT — MET (unit + route
  tests green; RED→GREEN observed).
- OTHER rungs unchanged (self-removal `cannot-remove-self`, owner-removal `cannot-remove-owner`,
  404 unknown-member; strictly-senior rung already PRIVILEGE_INSUFFICIENT from T05) — MET (remove-member
  + change-privilege describe blocks: 12 passed, no other assertion touched).
- Reuses T05's broadened `PRIVILEGE_INSUFFICIENT` code + friendly copy; no new code, no
  error-codes.ts edit — MET.
- Legacy parity cited and independently reproduced — MET (G1).

## Deviations

- None material. The removal route test previously asserted only status 403; I strengthened it to
  assert the specific code (necessary to actually pin the parity, since both codes are 403). The
  two route tests were renamed from "forbids …" to "refuses … as privilege-insufficient" to match
  the now-correct behavior (behavior-descriptive naming).

## Concerns and limitations

- The sibling privilege-change non-admin rung was clearly identifiable (identical
  `getPrivilegeLevel(caller.privilege) < getPrivilegeLevel('admin')` guard in
  `changeMemberPrivilege`); no NEEDS_CONTEXT trigger fired. No collision with a distinct legitimate
  FORBIDDEN case — the link-path FORBIDDEN tests are on separate routes and stayed green.
- Out-of-ownership pre-existing/concurrent typecheck failure in the untracked
  `models/adapters/integration-setup.test.ts` (see self-gate) is not mine to fix. The brief
  anticipated attributing out `pipeline-bindings.ts`; the actual concurrent breakage this run is
  the models integration-setup file — same attribution outcome.

## Confidence

High — two-line domain change on a well-understood authorization ladder, RED→GREEN verified at
both unit and route level with the live stack, legacy anchor independently reproduced, other rungs
and sibling routes proven untouched.
