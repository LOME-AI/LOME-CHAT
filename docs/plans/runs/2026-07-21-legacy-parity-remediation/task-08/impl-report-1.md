# T08 impl report 1 — R4: user-only ("AI off") send loses forkId

## Objective

Fix a correctness bug: a user-only message sent while viewing a non-Main fork was
parented onto the linear (Main) tip and vanished from that fork after refetch (the fork
view is a strict tip→root `parentMessageId` walk). Make it stay on the fork it was sent
from by mirroring the paid-turn fork machinery. **This is a correctness fix, NOT legacy
parity** — the checked-in legacy `/message` route never wired `forkId` either
(`research/legacy-chat.md` §R4, DELTA + NOTES). No legacy-parity claim is made; the
acceptance target is correct new-code behavior.

## Files changed

- `packages/shared/src/schemas/api/conversations.ts` — added `forkId: z.uuid().optional()`
  to `userOnlyMessageSchema` (the branch being viewed at send time).
- `apps/api/src/slices/chat/domain/user-message.ts` — added optional `forkId` to
  `SaveUserOnlyMessageArgs`; made `writeUserOnlyMessage` fork-aware: when `forkId` is
  present it resolves the parent via the fork tip under a fork-row `FOR UPDATE` lock
  (`resolveForkTipWithinTx`) and CAS-advances that tip to the new message after persist
  (`advanceForkTipWithinTx`), mirroring `settlement.ts`. Linear behavior
  (`latestMessageIdWithinTx`, no advance) is preserved when `forkId` is absent. Kept edits
  clear of the 23505 helper (lines ~92–102, T12's region).
- `apps/api/src/slices/chat/routes.ts` — the `/message` handler now destructures `forkId`
  from the validated body and passes it into `saveUserOnlyMessage` args
  (conditional spread, `exactOptionalPropertyTypes`-safe).
- `apps/web/src/hooks/chat/use-authenticated-chat.ts` — `handleSendUserOnly` now sends the
  active fork (`...(activeForkId != null && { forkId: activeForkId })`) on the
  `message.$post` call, and `activeForkId` was added to the callback's dependency array.

### Tests

- `packages/shared/src/schemas/api/conversations.test.ts` — new `userOnlyMessageSchema`
  describe block: accepts optional UUID forkId, allows omission, rejects non-UUID.
- `apps/api/src/slices/chat/domain/user-message.integration.test.ts` — imported
  `conversationForks`; added `seedFork`/`forkTip` helpers and four cases (below).
- `apps/web/src/hooks/chat/use-authenticated-chat.test.ts` — two `handleSendUserOnly`
  cases: includes `forkId` when `activeForkId` set; omits it for a linear send.

## Tests added (name — behavior — criterion)

- `parents a fork send onto the fork tip, not the linear tip, and advances that tip` —
  seeds a linear tip (msg2) and a fork whose tip is msg1, sends user-only with the forkId,
  asserts the new message's `parentMessageId === firstId` (the FORK tip, not the linear
  tip) and the fork's tip advanced to the new message. Proves the message survives the
  tip→root fork walk after refetch. — **criterion 2 & 3**.
- `chains onto a null-tipped fork (parent null) and advances the tip` — empty branch:
  parent is null, fork tip advances. — criterion 2.
- `answers not_found for a forkId absent at persist` — missing fork → `not_found`, nothing
  persisted (covers the `resolveForkTipWithinTx` error arm). — criterion 2.
- `surfaces a conflict when the fork-tip CAS advances zero rows` — fault-injected
  `forks.updateTip → null` with the fork still present → `conflict`, whole txn rolled back
  (covers the `advanceForkTipWithinTx` error arm). — criterion 2.
- `includes the active forkId so the message stays on the viewed branch` /
  `omits forkId for a linear (Main) send` — web send path supplies the active fork. —
  **criterion 1**.

## Self-gate

- `packages/shared` test (`conversations.test.ts`) — pass — 170/170.
- `apps/api` `user-message.integration.test.ts` — pass — 18/18 (14 pre-existing + 4 new).
- `apps/api` `routes.integration.test.ts` (route change regression) — pass — 157/157.
- `apps/web` `use-authenticated-chat.test.ts` — pass — 68/68 (62 pre-existing + 6 in the
  handleSendUserOnly block, 2 new).
- typecheck: `@hushbox/api` pass, `@hushbox/shared` pass. `@hushbox/web` typecheck FAILS on
  one error — `apps/api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name
  'ExecutionContext'`. This file is NOT in my diff (git-clean), api's own typecheck passes
  on it (it has Workers ambient types), and the error is a Cloudflare Workers global
  missing under the web typecheck project's view of api sources — a pre-existing/concurrent
  cross-project config gap, unrelated to the forkId change. My web file
  (`use-authenticated-chat.ts`) is the only web source I touched and it produced no error.
- ESLint (exit 0 after last edit, run from each package dir):
  - api: `user-message.ts`, `user-message.integration.test.ts`, `routes.ts` — exit 0.
  - shared: `conversations.ts`, `conversations.test.ts` — exit 0.
  - web: `use-authenticated-chat.ts`, `use-authenticated-chat.test.ts` — exit 0.

## Acceptance criteria

1. `userOnlyMessageSchema` accepts optional `forkId`; web send path supplies active fork —
   **met** (schema field + web `...(activeForkId != null && { forkId })`; shared + web
   tests green).
2. `saveUserOnlyMessage` resolves parent via fork tip and advances the fork's tip when
   `forkId` present, mirroring paid turns; linear behavior preserved when absent —
   **met** (`resolveForkTipWithinTx`/`advanceForkTipWithinTx`, same primitives
   `settlement.ts:261,551` uses; four integration cases including the two error arms;
   linear path unchanged and its 14 pre-existing tests stay green).
3. Test: user-only send under a non-Main fork parents onto the fork tip and survives
   refetch — **met** (the fork-tip vs linear-tip case asserts parent = fork tip and tip
   advance; the fork walk therefore reaches it).

## Deviations with reasons

- **Lock order — fork lock taken BEFORE the sequence reservation (not after).** The
  existing linear path deliberately reserves the sequence (conversation-row `FOR UPDATE`)
  first. For the fork path I resolve the fork tip (fork-row `FOR UPDATE`) first, then
  reserve. This is required to match settlement's acquisition order (fork → conversation:
  `resolveWrapKey`/`resolveForkTip` then `reserveSequences`). Reserving first (conversation
  → fork) would invert settlement's order and deadlock a concurrent runless send racing a
  paid settlement on the same fork. Verified against `settlement.ts:253,261,514` and
  `resolveWrapKey`'s FOR SHARE gate. The epoch-at-persist invariant is unaffected: the
  epoch read still follows the reservation.
- **Fork-advance CAS zero-row surfaces as a domain refusal (`conflict`/`not_found`), not a
  Sentry defect.** `settlement.ts`'s `advanceForkTip` treats a CAS zero-row as an
  unreachable defect (plain Error → Sentry) with a v8-ignore. For this new runless path I
  route both `advanceForkTipWithinTx` and `resolveForkTipWithinTx` errors through
  `UserMessageWriteError` so they become clean `{code}` responses. Rationale: it is the
  forward-looking behavior R6/T09 is separately establishing for these same conflicts, and
  it makes the arm reachable by fault injection so no coverage-ignore is needed. Under the
  fork-row lock the CAS still always matches in production; the test reaches it only via an
  injected `updateTip → null`.

## Concerns and limitations

- `@hushbox/web` typecheck failure on the untouched `pipeline-bindings.ts` (ExecutionContext)
  — outside T08 ownership; raised for the orchestrator. My owned web file typechecks clean.
- No new E2E added — the behavior is fully exercised at the integration + web-hook level
  (per CODE-RULES E2E guidance; a fork-view refetch is provable via the ancestor-walk
  invariant asserted in the integration test).
- T12 will edit `user-message.ts`'s 23505 helper region next; my edits stay clear of it.
  T20 owns adding `webSearchEnabled` to regenerate — not touched here.

## Confidence

high — real-Postgres integration tests prove fork-tip parenting, tip advance, both error
arms, and the linear path unchanged; the fork-vs-linear divergence is asserted directly;
lock-order reasoning verified against the settlement path it mirrors. The only red gate is
a pre-existing/concurrent web typecheck error on a file I did not touch.
