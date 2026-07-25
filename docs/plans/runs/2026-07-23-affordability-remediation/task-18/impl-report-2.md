# Task 18 — impl report 2 (fix pass)

## Objective

Correct three source comments and one test comment that stated a false money-attribution
invariant (`usage_records.user_id` = the charged wallet's owner / the funder). Comment text
only — no behavior, schema, migration, or test-structure change.

## Ground-truth verification (done first, independently)

- `apps/api/src/slices/chat/domain/turn-context.ts:498-502` — read directly:
  `payerUserId: args.sender.kind === 'user' ? args.sender.userId : facts.ownerUserId`,
  with the existing comment at :499-501 ("The member pays for a user turn … incl.
  owner-funded user turns attributing to the initiator; the owner pays for a guest turn").
  So a **user/member sender ⇒ `payerUserId` = the MEMBER unconditionally**; a **link-guest
  sender ⇒ `payerUserId` = the OWNER**.
- `apps/api/src/slices/chat/domain/turn-context.ts:396-416` (the `decision.payer === 'owner'`
  branch) returns only `wallet: { walletId: ownerPurchased.id, … }` — it changes the WALLET
  and never `payerUserId`. Confirms the divergence: owner-funded member turn ⇒
  `usage_records.user_id` = member, debited wallet = owner's.
- Cross-confirmed at `apps/api/src/slices/chat/domain/runtime.ts:752-762`: the guest arm
  short-circuits `ownerFunded` to `true` precisely because "the wallet-ownership trick can't
  be used because a guest's payer `userId` is the OWNER", while the user arm calls
  `isOwnerFundedTurn(…, context.userId, context.walletId)` — which only works because
  `context.userId` is the SENDER on a user turn.
- `usage_records` has no wallet column (`packages/db/src/schema/usage-records.ts:15-58`), so
  the funder is recoverable only from the ledger legs — this is why the schema comment's
  claim was load-bearing and worth stating explicitly.

Conclusion: all four validated findings are correct as written by the validator.

## Files changed

- `packages/db/src/schema/usage-records.ts` — comment on `senderUserId` no longer claims
  `userId` is "always the charged wallet's owner"; states the initiator-vs-funder split and
  what a `user_id` grouping actually means.
- `apps/api/src/slices/billing/domain/charge.ts` — `ChargeSender` doc comment: the
  guest-vs-member sub-cases stated separately instead of one false "payer is the OWNER".
- `apps/api/src/slices/workflows/engine/settlement.ts` — `ChargeContext.sender` doc comment:
  same correction.
- `apps/api/src/slices/chat/domain/settlement.integration.test.ts` (one inline comment,
  ~:2147) — says what the fixture deliberately exercises (column independence) instead of
  asserting a false production invariant. Fixture untouched.

## Final comment text

**1. `packages/db/src/schema/usage-records.ts` (on `senderUserId`)**

```
    // The turn's SENDER, first-class and independently queryable beside
    // `userId`. The two resolve to different people on a group turn, and
    // `userId` is NOT the charged wallet's owner: it is the initiating member
    // on a user turn — even when an owner-funded turn debits the OWNER's
    // wallet — and the owner on a link-guest turn (a guest has no users row).
    // Grouping spend by `user_id` therefore groups by initiator; who funded it
    // is recoverable only from the ledger legs. Exactly one side is
    // written at insert, mirroring conversation_members' principal pair:
    // senderUserId for a member sender, senderLinkId for a link-guest sender
    // (a guest has no users row, so a users FK alone cannot record it). Both
    // stay nullable with ON DELETE SET NULL — financial retention survives the
    // sender's hard deletion, so a both-null row is the pseudonymized state,
    // never an insert-time state.
```

**2. `apps/api/src/slices/billing/domain/charge.ts` (`ChargeSender`)**

```
/**
 * The turn's SENDER principal, recorded on every billed row beside the payer
 * (a member's userId, or a link guest's linkId — a guest has no users row).
 * Required, never inferred from `userId`: on a link-guest turn `userId` is the
 * OWNER while the guest sent it. On a user turn `userId` is the sending member
 * itself — owner funding moves the charged WALLET to the owner, never the
 * attributed user.
 */
```

**3. `apps/api/src/slices/workflows/engine/settlement.ts` (`ChargeContext.sender`)**

```
  /**
   * The turn's SENDER principal, stamped on every charge of the run beside
   * the attributed user (`userId`). They diverge on a link-guest turn —
   * `userId` is the OWNER, the guest has no users row. On a user turn `userId`
   * is the sending member, owner-funded or not: owner funding moves only the
   * charged wallet. Both are self on a solo turn.
   */
```

**4. `apps/api/src/slices/chat/domain/settlement.integration.test.ts` (~:2147)**

```
      // Deliberately column-independent: identity.userId is the OWNER while the
      // member sends, so senderUserId cannot be a copy of identity.userId — it
      // has to be threaded from identity.sender. (In production, owner funding
      // moves only the wallet; the attributed userId stays the member.)
```

## Grep proof

```
grep -rn -i "charged wallet's owner\|payer is the OWNER\|userId\` is the OWNER on\|OWNER pays" \
  packages/db/src/schema/usage-records.ts \
  apps/api/src/slices/billing/domain/charge.ts \
  apps/api/src/slices/workflows/engine/settlement.ts \
  apps/api/src/slices/chat/domain/settlement.integration.test.ts \
  apps/api/src/slices/chat/domain/settlement.ts
```

Remaining hits, each re-read and confirmed TRUE (all are the link-guest case, where
`userId` genuinely is the owner, or the wallet sense of "pays"):

- `apps/api/src/slices/chat/domain/settlement.ts:729` — "never the paying owner (a guest
  turn's payer is the owner)" — guest case, true.
- `apps/api/src/slices/chat/domain/settlement.integration.test.ts:2062` — "The OWNER pays
  (identity.userId + walletId), the guest is the sender." — guest case, true.
- `apps/api/src/slices/chat/domain/settlement.integration.test.ts:1691` — the
  `seedGroupFixture` doc: "binds `userId` to the SENDER and `walletId` to the OWNER's wallet
  — exactly the split production wires (owner pays, sender is attributed)". Already the
  corrected model (owner's WALLET pays, sender is the attributed user). No change needed.
- The only hit in `usage-records.ts` is the new negation ("`userId` is NOT the charged
  wallet's owner").

No remaining comment in the task's files claims `userId` is the wallet owner or the funder.

## Self-gate

- `npx eslint src/slices/billing/domain/charge.ts src/slices/workflows/engine/settlement.ts src/slices/chat/domain/settlement.integration.test.ts` (from `apps/api`) — pass, exit 0, run after the final edit.
- `npx eslint src/schema/usage-records.ts` (from `packages/db`) — pass, exit 0, run after the final edit.
- `pnpm test:watch apps/api/src/slices/chat/domain/settlement.integration.test.ts` — pass, 1 file / 60 tests, 9.16s. Identical to the pre-fix count (comment-only change).

Typecheck not re-run: the change set is exclusively comment text inside existing
declarations; ESLint's TS parser accepted all four files.

## Acceptance criteria (the four validated findings)

1. `usage-records.ts:22-23` false "always the charged wallet's owner" — **met**; replaced
   with the initiator/funder split plus the query-semantics note (see text above).
2. `charge.ts:9-10` "on an owner-funded group turn the payer is the OWNER" — **met**;
   guest and member sub-cases now stated separately.
3. `workflows/engine/settlement.ts:94-95` "`userId` is the OWNER on an owner-funded turn" —
   **met**; corrected to the same formulation.
4. Test comment ~:2147 — **met**; states what the fixture deliberately exercises. Fixture and
   assertions untouched; the column-independence signal is preserved. (The test NAME was
   corrected in cycle 2 below.)

Task-18 acceptance criteria from `plan.md` §Task 18 are unaffected — no behavior, schema,
migration, or assertion changed.

## Deviations

None.

## Concerns and limitations

- Out-of-bounds observation (not changed): the test name at
  `apps/api/src/slices/chat/domain/settlement.integration.test.ts:2112` reads "owner-funds a
  member turn: records the owner as payer and the member as sender". Under the corrected
  vocabulary "the owner as payer" describes the fixture's `identity.userId` binding rather
  than production's (production would bind the member). The brief scoped this file to the one
  inline comment, so the name is untouched — raised for the orchestrator to rule on.
- Out-of-bounds observation (not changed): `apps/api/src/slices/chat/domain/settlement.ts:120`
  describes `ChatSettlementIdentity.userId` as "whose wallet is charged and whose usage the
  record attributes to". The second half is exact; the first half ("whose wallet is charged")
  is loose for an owner-funded member turn, where the charged wallet is the owner's and this
  field is the member. The parenthetical that follows ("the initiator for a user turn, the
  OWNER for a guest turn") is the accurate part the brief pointed to. That file is outside my
  bounds for this fix pass.

## Confidence (cycle 1)

High — ground truth read directly from `turn-context.ts:498-502` and its owner-funding branch
and cross-confirmed at `runtime.ts:752-762`; the change set is comment text only, lint is
exit-0 on every touched file after the final edit, and the touched test file is green at
60/60.

---

# Cycle 2 — the two ruled-in items

Both concerns raised at the end of cycle 1 were ruled in by the coordinator as the same
defect class in files this task touched. Bounds extended to exactly two sites; comment and
test-name text only, no behavior change. Reported here rather than in a separate report file
so the whole fix pass reads as one record.

## Files changed

- `apps/api/src/slices/chat/domain/settlement.ts` — `ChatSettlementIdentity.userId` doc: the
  false "whose wallet is charged" clause replaced; the field is now described as the
  attribution, with the wallet divergence stated explicitly.
- `apps/api/src/slices/chat/domain/settlement.integration.test.ts` — the `it(…)` name at
  :2112. Body, fixture, and assertions untouched.

## Final text

**`apps/api/src/slices/chat/domain/settlement.ts` (`ChatSettlementIdentity.userId`)**

```
  /**
   * The user account the run's usage is attributed to: the initiator for a user
   * turn, the OWNER for a guest turn (a guest has no account). NEVER the guest's
   * identity — that rides `sender`. Not necessarily the charged wallet's owner:
   * an owner-funded member turn debits `walletId` (the owner's wallet) while
   * this stays the member.
   */
```

**`apps/api/src/slices/chat/domain/settlement.integration.test.ts:2112`**

```
  it('stamps the sender from identity.sender even when it differs from the attributed userId', async () => {
```

Naming decision worth recording: the name deliberately does NOT say "owner-funded member
turn". This fixture binds `identity.userId` to the OWNER, which production never emits for a
member sender (production emits the member on both columns, with only the wallet moving to
the owner). A name asserting the production scenario would reintroduce the exact
false-vocabulary defect being fixed. The name therefore describes the property under test —
`senderUserId` is threaded from `identity.sender`, not derived from `identity.userId` — and
the inline comment directly below carries the production contrast. No "and" in the name; the
test asserts one row shape.

## Grep proof (all five task files)

```
grep -rn -i "charged wallet's owner\|payer is the OWNER\|whose wallet is charged\|records the owner as payer\|OWNER pays" \
  packages/db/src/schema/usage-records.ts \
  apps/api/src/slices/billing/domain/charge.ts \
  apps/api/src/slices/workflows/engine/settlement.ts \
  apps/api/src/slices/chat/domain/settlement.ts \
  apps/api/src/slices/chat/domain/settlement.integration.test.ts
```

Remaining hits, each true:

- `usage-records.ts:24` and `settlement.ts:122` — the two new **negations** ("is NOT the
  charged wallet's owner", "Not necessarily the charged wallet's owner").
- `settlement.ts:730` — "a guest turn's payer is the owner": guest case, true.
- `settlement.integration.test.ts:2062` — guest fixture, `identity.userId` genuinely is the
  owner, true.
- `settlement.integration.test.ts:1691` — `seedGroupFixture` doc, already the corrected model
  (owner's wallet pays, sender is the attributed user).

Also re-read but NOT changed (checked for the same defect, found clean): `settlement.ts:283`,
`:308-309`, `:1048-1050` use "payer" purely as the role label for `identity.userId` and make
no claim about which wallet is debited.

## Self-gate (cycle 2)

- `npx eslint src/slices/chat/domain/settlement.ts src/slices/chat/domain/settlement.integration.test.ts` (from `apps/api`) — pass, exit 0, run after the final edit.
- `pnpm test:watch apps/api/src/slices/chat/domain/settlement.integration.test.ts` — pass,
  1 file / 60 tests, 22.35s. Same 60 tests as before the rename; the renamed test is included.

## Deviations

None.

## Confidence (cycle 2)

High — both edits are text inside existing declarations, the grep sweep over all five task
files now returns only negations and true guest-case statements, lint is exit-0 after the
final edit, and the test file is green at 60/60 with the renamed test running.
