# T12 (R20) — impl-report-1

## Objective
Replace 4 drifted copies of the Postgres 23505 unique-violation cause-chain walk with ONE
shared helper carrying the union of all four behaviors (depth cap + constraint-name
matching + message fallback). Parity anchor: `legacy/apps/api/src/legacy/lib/unique-violation.ts:64-79`.

## Files changed
- `apps/api/src/lib/errors/unique-violation.ts` (NEW) — one shared implementation. Exports
  `isUniqueViolationOn(error, constraintName)` (constraint-name match OR, when the
  structured `constraint` field is absent on an `Error` layer, message-substring fallback)
  and `isUniqueViolation(error)` (any 23505 anywhere in the chain). Both walk the wrapped
  `.cause` chain via a shared `causeChain` generator capped at `MAX_CAUSE_DEPTH = 16` (the
  legacy value).
- `apps/api/src/lib/errors/index.ts` — barrel re-exports the two helpers.
- `apps/api/src/slices/conversations/adapters/stores.ts` — deleted local `isUniqueViolationOn`;
  imports it from `lib/errors`. Call sites (fork insert/rename `name-taken`) unchanged.
- `apps/api/src/slices/identity/adapters/stores.ts` — deleted local `uniqueViolationConstraint`;
  `insertRegisteredUser` now calls `isUniqueViolationOn(error, 'users_email_unique')` then
  `'users_username_unique'` (email-first precedence preserved). This **regains the message-text
  fallback** the local copy had dropped.
- `apps/api/src/slices/admin/adapters/stores.ts` — deleted the inline 23505 walk inside
  `isUndoUniqueViolation`; the exported `isUndoUniqueViolation` is now a one-line delegation to
  `isUniqueViolationOn(error, UNDOES_UNIQUE_CONSTRAINT)`. Kept as a named export because its
  unit test (`admin/adapters/stores.test.ts`) is out of my file bounds and imports it.
- `apps/api/src/slices/chat/domain/user-message.ts` — deleted local `isUniqueViolation`;
  imports it from `lib/errors`. Behavior (any 23505 = converge/duplicate) preserved. The
  durable rationale comment was moved from the deleted function to the call site. T08's
  fork/save logic untouched.

## Tests added
`apps/api/src/lib/errors/unique-violation.test.ts` (13 cases):
- exact constraint match; message-fallback match when `constraint` absent (criterion:
  matched + fallback); non-Error carrier with no constraint → no fallback; constraint
  present-but-different → no message fallback; message lacking the name → false; cause-chain
  walk; non-23505 code / non-object / null → false; depth-cap: 23505 past depth 16 → false;
  23505 exactly within the cap → true — covers depth-cap.
- `isUniqueViolation`: any 23505 (with/without constraint); nested; no-23505 false cases;
  depth cap.

## Self-gate
- `pnpm typecheck` (apps/api) — pass.
- `pnpm test:watch src/lib/errors/unique-violation.test.ts` — pass (13/13).
- unit: `admin/adapters/stores.test.ts`, `conversations/adapters/stores.test.ts` — pass (30/30 with helper test).
- integration: `admin`, `identity`, `conversations` `stores.integration.test.ts` +
  `chat/domain/user-message.integration.test.ts` — pass (72/72).
- `eslint` on all 7 owned files, run from `apps/api` after the last edit — exit 0.
- coverage (new file): 100% stmts/branch/funcs/lines.
- `jscpd --min-tokens 20 --mode strict` on the affected files (see below).

## Acceptance criteria
1. **One helper, four callers import it, inline copies deleted** — MET. `grep` confirms zero
   local `while (typeof current === 'object'` walks remain in the four files; all four import
   from `lib/errors`. (admin keeps a one-line delegating `isUndoUniqueViolation` wrapper — the
   inline walk is gone.)
2. **No caller loses a feature** — MET. conversations/admin keep constraint-match + message
   fallback; identity **regains** the message fallback it had dropped; chat keeps any-23505.
   All four **gain** the `MAX_CAUSE_DEPTH=16` cap none had. Parity with legacy 64-79 (depth
   cap + message fallback) confirmed.
3. **Tests cover matched / unmatched-fallback / depth-cap** — MET (see tests above).

### jscpd evidence (duplication dropped)
- BEFORE (HEAD versions of the 4 files, `--min-tokens 20 --mode strict`): 3 clones, one of
  which is the **cross-file** R20 walk clone `admin/stores.ts[23:6-29:80] ↔ chat/user-message.ts[84:49-90:7]`
  (the two 23505 cause-walks).
- AFTER (current 5 files incl. new helper, same settings): the cross-file walk clone is
  **gone**. The 2 remaining clones are pre-existing intra-file duplications unrelated to R20:
  `user-message.ts` internal `.match(… throw UserMessageWriteError)` blocks (T08's code) and
  `identity/stores.ts` internal lock/unlock blocks. (min-tokens 20 is far more aggressive than
  the project's `lint:duplication` gate; these were never gate failures.)

## Deviations with reasons
- **No generic `getUniqueViolationConstraint(error): string | null` extractor / `''` sentinel.**
  The R20 research suggested one to preserve identity's constraint-name distinction, but every
  one of the four call sites is expressible as a boolean (`isUniqueViolationOn` or
  `isUniqueViolation`), and identity's email/username precedence + message fallback is cleanly
  served by two `isUniqueViolationOn` calls. Adding an unused string-returning extractor +
  `''` outcome would be speculative (CODE-RULES "Simplicity First"). The union of *behaviors*
  (depth cap, constraint matching, message fallback) is fully carried.
- **admin `isUndoUniqueViolation` retained as a thin exported wrapper** rather than inlining
  `isUniqueViolationOn(...)` at its single call site — because `admin/adapters/stores.test.ts`
  imports it and that file is outside my bounds. The inline walk (the duplication) is deleted.

## Concerns and limitations
- **Brief/plan wording "chat regains constraint-name matching":** chat never performed
  constraint-name matching (its local copy deliberately treated any 23505 as convergence, per
  its own comment and the R20 research). I preserved that exact behavior via `isUniqueViolation`
  and did NOT narrow chat to specific constraints — narrowing would change behavior and risk
  T08's integration tests. I read the parenthetical as "the shared helper now *carries*
  constraint matching (undoing chat's local drop of it)", not "chat's call site must match
  constraints". Flagging in case the intent was the stronger reading.

## Confidence
High — one shared implementation, each caller's observable behavior preserved (or improved to
legacy parity for identity), full unit coverage, all affected unit+integration suites green,
typecheck + lint clean, cross-file duplication provably eliminated.
