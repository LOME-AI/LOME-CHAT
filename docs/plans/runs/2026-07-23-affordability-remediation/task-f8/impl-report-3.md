# F8 — `usage_records` records the payer, unambiguously (impl report 3)

## Objective

Close the four validated auditor findings on cycles 1–2, plus one comment correction.
Nothing else: the rename, the `payer ≠ sender` derivation and the migration are
untouched.

1. Key-row scope moved off the mutable payer onto the stable sender principal, with the
   stability property pinned directly.
2. The fourth stale fixture (`seedGroupFixture`) corrected to the production shape, and
   its comment corrected to what is now true.
3. The byte-identical `runtime.integration.test.ts` pair differentiated — the
   payer-named test given the scope-emission assertion it exists for.
4. `runUsageSenders`' `userId:` alias for the payer column retired.
5. The under-stated `runtime.ts` comment about the payer widened.

---

## 1 — Key-row scope: payer → sender (finding 1)

### What was wrong

Nothing in cycle 1's diff touched `createClaimRun`; the **meaning of the value it reads**
changed underneath it. Before F8, `resolveTurnContext` returned
`payerUserId: args.sender.kind === 'user' ? args.sender.userId : facts.ownerUserId` — the
SENDER for every user turn — and that value rides `PaidRunIdentity.userId` into the key-row
scope. After F8 it is `payer.wallet.payerUserId`, so the scope silently became the payer,
which the route re-resolves from live funding state on every POST.

### The pin, watched red first

Two tests added to `describe('conversation runtime — claimRun')`, holding one stable
sender against the payer's two values (`OWNER_FUNDED` → `SELF_FUNDED`):

- `attaches a resubmit of a live run key whose payer changed between attempts`
- `replays a settled run key whose payer changed between attempts`

Verbatim red, before the fix (`vitest run … -t "payer changed between attempts"`, EXIT=1):

```
 ❯ src/slices/chat/domain/runtime.integration.test.ts (32 tests | 2 failed | 30 skipped)
     × attaches a resubmit of a live run key whose payer changed between attempts
     × replays a settled run key whose payer changed between attempts

AssertionError: expected 'executor' to be 'attach' // Object.is equality
Expected: "attach"
Received: "executor"
 ❯ src/slices/chat/domain/runtime.integration.test.ts:370:30

AssertionError: expected { Object (outcome, fence) } to deeply equal { outcome: 'replay', …(1) }
  {
-   "outcome": "replay",
-   "response": {
-     "ok": true,
+   "fence": {
+     "claims": 1,
+     "executorId": "e1755caf-223b-4113-b3af-55736b3d8131",
+     "id": "019faeab-af0e-7fc0-9ab3-5f914abd6e23",
    },
+   "outcome": "executor",
  }
```

That is the finding's exact shape: the resubmit claimed a **fresh row as executor** — the
mid-run new-executor claim (which the one-run-per-conversation block rejects instead of
attaching) and the post-settle re-execution (which spends provider money, then aborts on
the duplicate client-supplied message id). Green after the fix: 32/32.

### The fix

`apps/api/src/slices/chat/domain/runtime.ts`, `createClaimRun`:

```ts
const scopeUserId =
  request.identity.mode === 'paid' ? request.identity.senderId : request.identity.sessionId;
```

### Which principal the row is now scoped on, and why it cannot change between attempts

`PaidRunIdentity.senderId` — the **sender principal id**: a member's `users.id`, a link
guest's `sharedLinks.id`. It is minted once at route time from the authenticated
credential (`turn-context.ts:496` — `args.sender.kind === 'user' ? args.sender.userId :
args.sender.linkId`) and reads **nothing** from wallets, balances, budgets or group
headroom. A retry presents the same session cookie or the same `X-Link-Public-Key`, so it
resolves to the same principal by construction; the funding decision that moves the payer
has no input to it. Trial runs are untouched (still the session id).

Column fit and uniqueness: `idempotency_keys.userId` is `uuid` and **deliberately carries
no FK** (`packages/db/src/schema/idempotency-keys.ts:20-22` — "trial requests scope by the
trial-session principal, which has no users row"), so a `linkId` is as legal there as a
trial session id already is. The unique scope is `(userId, route, key)` with a
client-minted uuid `key`, so narrowing the scope from payer to sender cannot collide two
distinct runs.

### Sweep

`CHAT_TURN_ROUTE` is built into a scope in exactly one production site (`runtime.ts:857`);
the other hits are test helpers that pass their own scope. `claimRun`'s other integration
callers (`media-turn.integration.test.ts:224`, `regenerate.integration.test.ts:252,441`)
already set `senderId === userId` (self-funded), so their behaviour is unchanged.
`chat/routes.ts` (F5's file) was read only — **no edit there was needed**. Nothing in
`e2e/` or `scripts/` keys on the chat key-row scope.

---

## 2 — The fourth stale fixture (finding 2)

### Comment, before → after

Before:

```
   * A GROUP turn fixture: a distinct owner (the payer, with the wallet) and a
   * distinct sender (a member the owner funds for). The returned `Fixture` binds
   * `userId` to the SENDER and `walletId` to the OWNER's wallet — exactly the
   * split production wires (owner pays, sender is attributed).
```

After:

```
   * A GROUP turn fixture: a distinct owner (the payer, with the wallet) and a
   * distinct member who sends, whom the owner funds. The returned fixture binds
   * `userId` AND `walletId` to the OWNER — the payer is by definition the owner
   * of the wallet the turn debits — while the sending member rides `sender`.
   * That is the shape the route freezes onto an owner-funded run; a payer who is
   * not the debited wallet's owner is not a state the system can reach.
```

### Fixture, before → after

```diff
     return {
-      userId: senderId,
+      userId: owner.userId,
       walletId: owner.walletId,
       conversationId: owner.conversationId,
       memberId,
       epochPrivateKey: owner.epochPrivateKey,
       epochPublicKey: owner.epochPublicKey,
+      sender: { kind: 'user', userId: senderId, memberId },
     };
```

Return type `Fixture` → `GroupFixture`. Two local types added beside the describe:

```ts
type GroupFixture = Fixture & { readonly sender: SenderPrincipal };
type MaybeGroupFixture = Fixture & { readonly sender?: SenderPrincipal };
```

`settleTurn` now takes `MaybeGroupFixture` and threads the principal into `commitFor`
(`...(fixture.sender === undefined ? {} : { sender: fixture.sender })`), so a solo fixture
is unaffected. The two tests that build their hook directly rather than through
`settleTurn` (the persist-rollback and the group-attribution-read-rollback tests) each
gained `sender: fixture.sender` on their own `commitFor` call — without it the corrected
payer would read as a SOLO turn and both of their "no group spend" assertions would pass
vacuously.

### Behavioural equivalence of the correction

`settlementSenderUserId`, `settlementSenderId`, `settlementCaller` and
`settlementChargeSender` all previously fell back to `payerUserId` (= the member) because
`sender` was absent; they now read the same member out of `sender`. `senderCaller` for a
user yields `{ kind: 'user', userId }` — identical to the fallback — so the membership
gate and the epoch-key resolution take the same path. The one value that moves is the one
the task exists for: `usage_records.payerUserId` now names the OWNER on these turns, and
the debited wallet is (still) the owner's.

### Proof the six dependent tests still discriminate

All six are green after the correction (file: 64/64, unchanged count). Discrimination
probed by flipping the input each one's assertion rests on:

**Probe C — `settleTurn`'s `ownerFunded` default flipped `true → false`** (the injected
funding decision the finding names). Four of the six redden, EXIT=1:

```
     × accrues the charge cumulatively to the member and conversation rows (no period) and preserves the owner-set cap
     × creates the member row with the zero insert-default cap when none was pre-configured (insert path)
     × accumulates across successive turns so the admission read refuses once the per-member cap is reached
     × attributes a multi-model turn as the sum of its siblings under one member row and one conversation row
      Tests  4 failed | 7 passed | 53 skipped (64)

AssertionError: expected 0n to be 10450n
AssertionError: expected undefined to be 0n
AssertionError: expected 0n to be 20900n
AssertionError: expected 0n to be 18750n
```

Those are real accrued values against zero — the group path is live under the corrected
fixture, not merely reached.

**Probes D and E — the two rollback tests' injected faults removed** (`persist boom`;
the faulting `conversations.get`). Both redden, EXIT=1:

```
     × writes no member spend when the settlement transaction rolls back (saved ⟺ billed)
     × rolls the whole settlement back when the group-attribution read fails
AssertionError: promise resolved "undefined" instead of rejecting
```

Stated precisely, because the probe reddens at the `rejects.toThrow` line rather than at
the spend assertion: the input that flips **their spend assertions** is the settlement
transaction committing instead of rolling back, and the first probe-C test shows that the
*same fixture, same `ownerFunded: true`* commits `perTurnCharge` to that member row when
it does commit — so `0n` is a discriminating value here, not a value the fixture can
only produce.

All probes reverted; `git diff` re-verified clean of them.

---

## 3 — The near-identical pair, differentiated (finding 3)

`runtime.integration.test.ts`, the payer-named test. Its seeding had to change from an
**exhausted** member cap to a funded one: a refusal returns no hold, and `scopeIds` is
carried on the hold, so the ruled assertion is unobservable on the refusal path.

- Name: `refuses an owner-funded group turn over the member cap when the run identity
  names the PAYER` → `binds an owner-funded group turn to BOTH group scopes when the run
  identity names the PAYER`.
- Seeding: `budgetNanoUsd: 1000n, spentNanoUsd: 2000n` → `budgetNanoUsd: 1_000_000n,
  spentNanoUsd: 0n`.
- Assertion: `expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' })`
  → admitted, plus

```ts
expect(decision.hold.scopeIds).toEqual([
  `member:${memberId}`,
  `conversation:${conversationId}`,
]);
```

### Evidence the two now fail for different reasons

**Probe A — the conversation scope dropped from `resolveMemberBudgetScopes`** (production
mutation in `runtime.ts`, reverted). The scope-emission test reddens; the cap-refusal test
stays green:

```
 ❯ (32 tests | 1 failed | 26 skipped)
     × binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER
AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]
  [
    "member:019faeae-59d1-7008-94ce-252961c5790e",
-   "conversation:019faeae-59cf-7716-9811-e4a04a0de872",
  ]
      Tests  1 failed | 5 passed | 26 skipped (32)
```

**Probe B — the cap test's member budget relaxed** (`1000n/2000n` → `9_000_000n/0n`, the
input its verdict rests on; reverted). The cap-refusal test reddens; the scope-emission
test stays green:

```
     × refuses a group turn when the sender is over their durable per-member budget
AssertionError: expected { admitted: true, …(3) } to deeply equal { admitted: false, …(1) }
+   "hold": { "holdId": …, "scopeIds": [ "member:…", "conversation:…" ], "walletId": … },
      Tests  1 failed | 5 passed | 26 skipped (32)
```

Each reddens under an input that leaves the other green. The bodies are no longer
byte-identical: one asserts a verdict, the other asserts the scopes the hold carries.

---

## 4 — `runUsageSenders`' payer alias (finding 4)

`select({ userId: usageRecords.payerUserId, … })` → `select({ payerUserId:
usageRecords.payerUserId, … })`, and the three assertion sites that read it
(`:2298`, `:2347`, `:2356`) now spell `payerUserId`. The two-sided pin in this file no
longer names the payer column `userId` anywhere.

---

## 5 — Comment widened (`runtime.ts`)

Before: "never from the payer `userId` — **which is the OWNER for a guest turn**".
After: "never from the payer `userId` — **which names the OWNER on EVERY owner-funded
turn, a member's as much as a guest's**". The narrower sentence invited exactly the reading
that was the defect.

**Brief ambiguity, flagged rather than resolved silently:** the brief introduced this item
with "Also correct in report 3, not in code", then "Widen it." I read the imperative as
governing and edited the comment (a one-line comment change, zero blast radius); if
report-only was intended, the edit is still correct under CODE-RULES' wrong-comment rule.

---

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/chat/domain/runtime.ts` | Key-row scope moved onto `identity.senderId` with the reason recorded; the payer comment widened. |
| `apps/api/src/slices/chat/domain/runtime.integration.test.ts` | Two payer-stability pins added; the payer-named group test given the scope-emission assertion. |
| `apps/api/src/slices/chat/domain/settlement.integration.test.ts` | `seedGroupFixture` corrected to the production payer/sender split and its comment rewritten; `GroupFixture`/`MaybeGroupFixture` added; `settleTurn` and the two direct `commitFor` sites thread the sender; `runUsageSenders`' payer alias retired. |

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `attaches a resubmit of a live run key whose payer changed between attempts` | One key + one stable sender + two payers resolves to one row mid-run. | Finding 1's stability property (mid-run attach). |
| `replays a settled run key whose payer changed between attempts` | The same, post-settlement: replay rather than re-execute. | Finding 1's stability property (post-settle replay — the money-losing half). |

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/slices/chat/domain/runtime.integration.test.ts` | **pass** — 32/32 (baseline 30/30 + 2 new). |
| `vitest run src/slices/chat/domain/settlement.integration.test.ts` | **pass** — 64/64, count identical to the pre-change baseline taken on the same stack. |
| `vitest run src/slices/chat/domain` (30 files) | **pass** — 567/567 (baseline 565 + 2 new). |
| `vitest run src/slices/chat src/slices/conversations src/slices/billing` (118 files) | **pass** — 2152/2152. |
| `tsc --noEmit -p apps/api/tsconfig.json` | **pass** — `TSC_EXIT=0`, no output. Re-run after the final edit. |
| `eslint` on the 3 changed files, from `apps/api/` | **pass** — `ESLINT_EXIT=0`, after the last edit. |
| Scoped coverage, `src/slices/chat src/slices/workflows`, include `chat/domain/**`, reports redirected to the scratchpad | **pass** — EXIT=0, 1299/1299. `runtime.ts` 99.31 / 98.79 / 98.46 / 99.27; `settlement.ts` 98.64 / 97.08 / 100 / 99.51; `turn-context.ts` omitted (the reporter prints only shortfall rows, so an omitted file is 100). Identical to cycle 2's figures — this cycle moved no coverage. |

The first coverage attempt was scoped to `src/slices/chat/domain` alone and exited 1 on
`smart-model-turn.ts` (funcs 92, branches 94.59) — a file `git status` shows nobody has
modified, whose other exercisers that subset does not import. Widening the run to
`src/slices/chat src/slices/workflows` clears it at EXIT=0, which is the run cited above.
Attribution: scoping artifact, not this task and not a real shortfall.

Lint ordering and coverage: both the lint run and the final typecheck were issued **after**
the last source edit (the two lint fixes were themselves followed by a re-lint at exit 0).
The lint set was derived from `git status`: my three changed files are all in `apps/api`,
which is the only package this cycle touched — no `packages/**` edit exists to miss.
`git status` lists many other modified files across the repo; those belong to other tasks
and concurrent agents, and linting them would report their state, not mine.

Neither `pnpm test:api` nor `pnpm ensure-stack` was run (both forbidden by the brief); the
stack was up throughout and every figure above comes from this session on it.

## Acceptance criteria

| Finding | Status | Evidence |
| --- | --- | --- |
| 1 — key-row scope stability | **met** | Stability pinned by two tests, both watched red with verbatim output above; scope now `identity.senderId`; sweep of the single production scope site. |
| 2 — fourth stale fixture | **met** | Fixture and comment corrected (before/after above); six dependents green and probe-verified as still discriminating. |
| 3 — near-identical pair | **met** | Payer-named test carries the scope-ids assertion; probes A and B each redden one test and leave the other green. |
| 4 — `runUsageSenders` alias | **met** | Projection and three assertion sites now name `payerUserId`. |
| 5 — comment widened | **met** | Text above; ambiguity in the instruction flagged. |

## Deviations

1. **Finding 3's test had to stop being a refusal test.** The ruled assertion reads
   `decision.hold.scopeIds`, and a refusal carries no hold, so the member cap was funded
   rather than exhausted. The refusal case remains covered by the cap-named test the
   ruling told me to keep.
2. **Two rollback tests outside the named line range were edited** (`sender:
   fixture.sender` added to their `commitFor` calls). Not optional: with the corrected
   payer and no sender, both would have read as SOLO turns and asserted "no group spend"
   about a turn that never had a group path — the exact vacuity class this finding is.
3. **The comment at `runtime.ts:527-530` was edited**, under the brief-ambiguity reading
   recorded in §5.

## Concerns and limitations

- **The pair problem may have moved rather than closed.** With its new assertion, the
  scope-emission test **strictly dominates** `admits an owner-funded group turn carrying an
  explicit USER sender principal` (`:559`): same seeding, and that test asserts only
  `admitted`, which stays true under a total loss of group scopes. It is now the weaker
  member of a new near-pair. I did not touch it — collapsing a money test is the decision
  the last ruling said to hand back — but the orchestrator should rule on it.
- **The two group tests I corrected in cycle 2 still do not discriminate scope emission**;
  unchanged from cycle 2's report, and now partly superseded, since the new assertion
  gives that coverage in one place.
- **`contextSenderUserId`'s flat fallback survives** (`sender` absent ⇒ sender is
  `context.userId`). It remains test-only, since every production run-start body carries
  `sender`; the same fallback is what `MaybeGroupFixture` models. Removing the optionality
  reaches `packages/shared` and `packages/realtime` — F9's territory.
- **`test:api`'s coverage gate still cannot fire** while the standing `template-html`
  failure stands; my coverage claim above is a scoped run over the owned tree at EXIT=0,
  not the named gate.
- **The scope change is behavioural, not just naming.** Any key row already written in a
  dev database under the payer scope will not be found by a sender-scoped lookup. Global
  Constraint 7 (zero existing users, dev/CI reseeded) makes that a non-event, but it is
  worth stating that this is not a pure rename.

## Confidence

**High** on findings 1, 2 and 4. Finding 1's pin was watched red for the exact shape the
auditor described and the stable-principal argument is traced to the producer
(`turn-context.ts:496`) rather than assumed. Finding 2's correction is behaviour-preserving
by enumeration of every `identity` reader in `settlement.ts`, and the discrimination is
probe-verified in both the accrual and rollback directions.

**Medium** on finding 3 — the assertion the ruling asked for is in place and both
directions of differentiation are demonstrated, but delivering it required changing the
test's scenario from refusal to admission, which creates the `:559` subsumption named
above. That is a judgement the orchestrator may want to revisit.
