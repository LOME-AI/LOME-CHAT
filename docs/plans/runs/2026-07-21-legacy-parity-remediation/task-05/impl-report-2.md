# T05 impl-report-2 — R14 consumer-gap close (route integration test)

## Status: DONE (stack down — assertion updated by inspection; wire mapping already verified)

Scope expansion (plan.md §"T05 scope expansion"): newly in-bounds file
`apps/api/src/slices/conversations/routes.integration.test.ts`. The impl-report-1 change
flipped the member-removal not-strictly-senior refusal from `FORBIDDEN` to
`PRIVILEGE_INSUFFICIENT`; a route-level test still asserted the old code and now fails.

## Assertion updated (exactly one)

- `routes.integration.test.ts`, in `describe('conversations routes: remove member')`,
  test **`refuses a removal without a strictly higher privilege`** — the assertion at (was)
  line 1197, now **line 1194** post-context-shift:
  `expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN })` →
  `... ERROR_CODES.PRIVILEGE_INSUFFICIENT`.
  This is exactly the `canRemoveMember`-gate case my R14 change touched (adminA attempting to
  remove peer adminB; `canRemoveMember('admin','admin') === false`). The `expect(res.status)
  .toBe(403)` line above it is left unchanged and stays correct — `privilege-insufficient`
  also maps to 403 (`outcomes.ts:106`).

## Other refusal-rung assertions — confirmed NOT touched

Enumerated the entire `remove member` describe block (lines 1089→next describe) and every
`FORBIDDEN`/403 assertion in the file:

- `refuses removing yourself` (1157) → `CANNOT_REMOVE_SELF` — untouched.
- `refuses removing the owner` (1183) → `CANNOT_REMOVE_OWNER` — untouched.
- `forbids a write member from removing anyone` (1200) → asserts status 403 only, no code;
  this is the non-admin-caller `:287` rung → still `forbidden` — untouched (and would stay
  green regardless, being status-only).
- `answers 404 for an unknown member id` (1223) → 404 not-found — untouched.
- Non-removal `FORBIDDEN` assertions elsewhere in the file, each verified to belong to a
  different route/rung and left as-is: `forbids a non-owner member from deleting` (607,
  delete-conversation), `forbids a non-admin from changing a privilege` (3363,
  privilege-change non-admin rung), link-privilege (3452), `forbids a non-admin caller`
  (3520), link-display-name (3571), `forbids a non-owner title update` (3615).

## Self-gate

- **Stack down** — probed: `DATABASE_URL` unset in shell; `.env.scripts` points Postgres at
  `localhost:4444`; TCP probe of `4444` and `5432` both refused. Integration tests cannot
  run here. Per the resume instruction, the assertion was updated **by inspection**: the wire
  mapping `privilege-insufficient` → `{ code: PRIVILEGE_INSUFFICIENT, status: 403 }` lives in
  the UNCHANGED `outcomes.ts:105-106`, and this same file at line 3409 already asserts
  `{ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT }` for that refusal on the privilege-change
  path — so the updated assertion matches proven behavior. **Phase-4 confirms end-to-end.**
- `npx eslint src/slices/conversations/routes.integration.test.ts` (from apps/api) — **exit 0**.
- `ERROR_CODES.PRIVILEGE_INSUFFICIENT` is an existing key already imported/used in this file
  (line 3409), so the swap is type-safe; no new typecheck surface. (The pre-existing
  `pipeline-bindings.ts` ExecutionContext error is foreign — attributed out; it did not
  surface in the earlier api typecheck either.)

## Concerns and limitations

- **Shared-file concurrency (RAISE):** this file was already `M` at my session start and
  carries edits I did NOT make — two `FORBIDDEN`→`NOT_FOUND` hunks in the
  `websocket upgrade` (@@ ~535) and `link-guest websocket upgrade` (@@ ~4242) describe
  blocks, matching T06 (R15: WS-upgrade non-member 404, SENSITIVE authz). My one-line edit
  is in the `remove member` block (@@ ~1194) and does not overlap T06's regions, so the two
  changes coexist cleanly in the working tree right now. But T05 and T06 are both editing
  `routes.integration.test.ts`; if T06 is still in flight and rewrites the file, there is a
  clobber risk. I left every T06 line untouched per "clean up only your own mess." The
  orchestrator should be aware this file lacks single-writer exclusivity this run.
- Integration run deferred to Phase-4 (stack unavailable in sandbox).

## Confidence: high — single, correctly-classified assertion updated to match a wire mapping already proven in the same file; all other rungs verified untouched; eslint green.
