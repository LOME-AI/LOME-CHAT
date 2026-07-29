# F8 — `usage_records` records the payer, unambiguously (impl report 1)

## Objective

Make the `usage_records` user column mean the payer on every write path and for every
reader: rename it to `payer_user_id`, populate it with the owner of the debited wallet on
member turns, owner-funded member turns and guest turns alike, ship the migration with the
schema change plus an exact backfill, preserve `SET NULL` pseudonymization, and enumerate
every consumer with the role it needs.

## What the defect actually was

`resolveTurnContext` returned `payerUserId = sender.userId` for a **user** sender and the
owner only for a **guest** sender. So the column's meaning depended on the sender's session
kind, which is exactly what makes it unaggregatable: an owner-funded member turn debited the
owner's wallet and recorded the member. The column has therefore been renamed **and**
re-derived — the rename alone would have shipped a lie under a better name.

The payer is now read off the wallet the funding decision chose (`PayerWallet` carries its
owner, minted by the branch that picks the wallet), so payer and debited wallet cannot name
different people by construction rather than by agreement.

## Files changed

### `packages/db`

| File | Why |
| --- | --- |
| `src/schema/usage-records.ts` | `userId`→`payerUserId` / `user_id`→`payer_user_id`; index → `usage_records_payer_user_id_idx`; the comment block rewritten — it documented the old meaning normatively ("`userId` is NOT the charged wallet's owner"). |
| `src/schema/relations.ts` | Relation field ref; `usageRecordsRelations.user`→`payer` and `usersRelations.usageRecords`→`paidUsageRecords` (both already carried `relationName: 'payer'`; the keys did not say so). |
| `drizzle/0062_daily_silhouette.sql` (new) | The generated RENAME + FK/index recreate, plus the hand-appended backfill (below). |
| `drizzle/meta/0062_snapshot.json` (new), `drizzle/meta/_journal.json` | Generated. |
| `src/schema/shape-tables.test.ts` | The `SET NULL` shape pin, repointed at `payer_user_id` and strengthened with the nullability assertion. |
| `src/schema/shape-fk-indexes.test.ts`, `src/schema/schema.integration.test.ts` | Index-name allowlists; two usage-record inserts. |

### `apps/api` — write path

| File | Why |
| --- | --- |
| `src/slices/chat/domain/turn-context.ts` | **The fix.** `PayerWallet` gained `payerUserId`, set by each of the three wallet-materialization branches (self-purchased, self-free, owner); `TurnContext.payerUserId` now reads it instead of re-deriving from the sender kind. |
| `src/slices/chat/domain/runtime.ts` | Owner-funding recovery re-keyed on the sender (see the raise below); identity mapping; three comments the payer change falsified. |
| `src/slices/chat/domain/settlement.ts` | `ChatSettlementIdentity.userId`→`payerUserId` (its doc asserted the old meaning), the four sender-fallback readers, the `ChargeContext` mapping. |
| `src/slices/workflows/engine/settlement.ts` | `ChargeContext.userId`→`payerUserId` + `chargeInputFor` mapping + docs. |
| `src/slices/billing/domain/charge.ts` | `ChargeInput.userId`→`payerUserId`; the usage insert; the free-allowance spending row now keyed on the payer (= the free wallet's owner, by construction). |
| `src/slices/billing/ports/stores.ts` | `UsageRecordInput.userId`→`payerUserId`, `UsageRecordRow.userId`→`payerUserId`, and the analytics port docs now state the money role. |
| `src/slices/billing/adapters/stores.ts` | Four column references + the window comment. |

### `apps/api` — readers and tests

`src/platform/dev/reads.ts` (the `/dev/message-payers` projection — already named `payerId`,
now true), `src/platform/dev/seed-billing-history.ts`, `src/platform/dev/seed-public-stats.ts`,
`src/slices/billing/domain/usage-analytics.ts` (header doc), and the test files the rename
reaches: `platform/dev/routes.integration.test.ts`,
`platform/dev/seed-billing-history.integration.test.ts`,
`platform/dev/seed-public-stats.integration.test.ts`,
`billing/adapters/public-stats-stores.integration.test.ts`,
`billing/domain/charge.integration.test.ts`, `billing/domain/public-usage-stats.integration.test.ts`,
`billing/domain/usage-analytics.integration.test.ts`, `billing/routes-usage.integration.test.ts`,
`billing/routes.integration.test.ts`, `chat/domain/settlement.integration.test.ts`,
`chat/domain/settlement.fuzz.integration.test.ts`, `chat/domain/turn-context.test.ts`,
`chat/domain/runtime.integration.test.ts`, `identity/domain/deletion.integration.test.ts`,
`workflows/engine/settlement.test.ts`, and the new
`chat/domain/turn-context.integration.test.ts`.

## Tests added

| Test | Behavior | Criterion |
| --- | --- | --- |
| `turn-context.integration.test.ts` › "records the owner as the payer and the member as the sender, each queryable alone" | Producer→row against real rows: `resolveTurnContext` freezes the owner's wallet, `chargeWithinTx` writes the row, and the payer side and sender side are each selected by an independent `WHERE`. | Two-sided pin (§Group Funding 3) |
| `turn-context.integration.test.ts` › "records a payer that is the charged wallet owner, so the two can never disagree" | The frozen `payerUserId` equals `wallets.userId` of the frozen `walletId`. | Pins the invariant the backfill expression relies on |
| `runtime.integration.test.ts` › "refuses an owner-funded group turn over the member cap when the run identity names the PAYER" | Admission still emits the group scopes when the run identity carries the payer and the member rides `sender`. | Guards the regression the payer change would otherwise have introduced |
| `turn-context.test.ts` (2 existing owner-funded cases) | `payerUserId` is the owner, not the sending member. | Payer on every write path |
| `shape-tables.test.ts` › "survives payer deletion via SET NULL" | The renamed column is nullable with an `ON DELETE SET NULL` FK. | `SET NULL` preserved |

## Red-first evidence

Both reds below were captured **before** the local stack was restarted by a sibling agent
(the run at 10:29–10:31 in this session). The greens cited under Self-gate are from **after**
the restart, re-run from scratch. The reds have not been re-demonstrated post-restart, because
re-demonstrating them means reverting the fix while two other implementers are running —
they are cited as the earlier run, deliberately, rather than presented as one session.

### 1. The row named the sender rather than the payer (owner-funded member turn)

```
 FAIL  |api| src/slices/chat/domain/turn-context.integration.test.ts > an owner-funded member turn > records the owner as the payer and the member as the sender, each queryable alone
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0
 ❯ src/slices/chat/domain/turn-context.integration.test.ts:206:23

 FAIL  |api| src/slices/chat/domain/turn-context.integration.test.ts > an owner-funded member turn > records a payer that is the charged wallet owner, so the two can never disagree
AssertionError: expected '019fae48-dbcd-7d69-bc61-d4c2fa2f157c' to be '019fae48-dbc9-70b7-98f0-c1da309611a8' // Object.is equality

Expected: "019fae48-dbc9-70b7-98f0-c1da309611a8"
Received: "019fae48-dbcd-7d69-bc61-d4c2fa2f157c"
 ❯ src/slices/chat/domain/turn-context.integration.test.ts:233:33
```

Zero rows carried the owner (the wallet owner who was actually debited); the payer the turn
froze was the member's id, not the wallet owner's.

The producer pin failed the same way:

```
 FAIL  |api| src/slices/chat/domain/turn-context.test.ts > resolveTurnContext > funds an owner-funded group turn from the OWNER's wallet, not the sending member's
-   "payerUserId": "owner-9",
+   "payerUserId": "u1",
    "sender": { "kind": "user", "memberId": "m1", "userId": "u1" },
```

### 2. The owner-funding recovery, red before the `runtime.ts` fix

```
 FAIL  |api| src/slices/chat/domain/runtime.integration.test.ts > refuses an owner-funded group turn over the member cap when the run identity names the PAYER
+   "admitted": true,
+   "hold": { "holdId": "0faa51c4-…", "scopeIds": [], "walletId": "019fae49-81ff-…" },
 ❯ src/slices/chat/domain/runtime.integration.test.ts:593:22
```

`scopeIds: []` is the shape of the defect: no group scope emitted at all.

## The regression this change would have shipped without the `runtime.ts` fix

This is the most valuable finding in the task and it is not a footnote.

`bindChatHooks` recovered the run's funding decision as
`isOwnerFundedTurn(billing, db, context.userId, context.walletId)` — literally "the payer wallet
is **not** one of this user's wallets". That is correct only while `context.userId` is the
**sender**. Once it became the payer, the predicate is **always false**: the payer's own wallet
is trivially among the payer's wallets. Consequences, all silent:

- **no group budget scopes emitted at admission** — the member and conversation caps stop
  gating the turn entirely;
- **no group spend accrued at settlement** — `member_budgets.spentNanoUsd` and
  `conversation_spending` never advance.

Together: **a member whose budget is exhausted keeps spending the owner's money, and the spend
that would eventually stop them is never recorded.** A money-loss defect, produced by a rename
that looks purely nominal.

**Why the suite stayed green through it, which is the half that matters for judging the new
pin.** Every pre-existing runtime test builds its context with `userId === sender.userId` (or
with no `sender` at all, which falls back to `context.userId`) — precisely the shape in which
payer and sender are indistinguishable, so passing the wrong one of the two changes nothing.
Thirty runtime tests, none of which can discriminate. The new pin is the first context in the
suite where `userId !== sender.userId`, which is why it moves: with the old call site it
reports `admitted: true, scopeIds: []`, and with the fix it refuses. The input that flips the
assertion is the payer/sender split itself, not the presence of the test.

The fix keys the recovery on `contextSenderUserId(context)`, which returns `undefined` exactly
for a link guest, so the guest's always-owner-funded case is now expressed by the type rather
than by a separate `sender?.kind === 'linkGuest'` condition that could drift from it.

## Consumer enumeration — every reader of the column

The column is read only inside `apps/api` and `packages/db`. `apps/web`, `apps/admin`,
`apps/marketing`, `scripts/` and `packages/*` hold no reference to it (verified by
repo-wide grep for `usageRecords.userId`, `usage_records`, `payerId`, `payer_user_id`).

| Consumer | Role it needs | Disposition |
| --- | --- | --- |
| `billing/adapters/stores.ts` `usageWindow` (feeds `summarizeUsage`, `usageSpendingOverTime`, `usageCostByModel`, `usageTokensOverTime`, `usageSpendingByConversation`) | **Money** | Keeps the payer column. It is the "Usage" surface's spend: its KPI cards are Total Spent / Messages / Tokens / **Avg Cost per Message**, so the row set is one denominator shared with money numerators — it cannot be split by role — and it sits beside ledger reads that are already wallet-scoped (i.e. payer-scoped). A sender scope would make the two disagree on the same screen. |
| `billing/adapters/stores.ts` `aggregateUsageByModel` | **Money** | Keeps the payer column (`SUM(cost)` per model; the comment naming it the sole visibility boundary is preserved and now names the payer). |
| `billing/adapters/stores.ts` `distinctUsageModels` | **Money** | Keeps the payer column. It populates the model filter for the charts above; a different scope would offer filter options that select no rows. |
| `billing/adapters/stores.ts` `readUsageRecord` | **Money** | Projection renamed to `payerUserId`. No production caller today (port + one null-probe test), so the rename is the whole change. |
| `platform/dev/reads.ts` `listMessagePayers` (`GET /dev/message-payers`) | **Money** | Keeps the payer column — it was already named `payerId` and its comment already claimed "the wallet owner"; that claim is now true. Its e2e consumer asserts `payerId` only on **personal fall-through** cases (payer == sender), so no e2e expectation changes. |
| `platform/dev/seed-billing-history.ts` | **Money** (writer) | Writes `payerUserId`: seeded history is a solo user's own spend, and the seeded charge legs debit that user's wallet. |
| `platform/dev/seed-public-stats.ts`, `billing/adapters/public-stats-stores.ts` | **Neither** | Anonymous rows written with a null payer; the public-stats aggregates never filter by user. Rename only. |
| `identity` deletion path | **Money** | DB-level `ON DELETE SET NULL`, preserved by the rename (proof below). |
| `conversations/adapters/stores.ts` | **Neither** | Joins `usage_records` by `contentItemId`/`conversationId` only; never touches the user column. No change. |

**Reported, not decided:** none. Every consumer above resolves to money for a stated reason;
none of them is a genuine activity read, so nothing was repointed to `senderUserId`. If any
reviewer disagrees, the one worth arguing is `distinctUsageModels` ("models I have used" could
be read as activity) — I record my reason rather than claiming it was unarguable.

## The migration

`packages/db/drizzle/0062_daily_silhouette.sql`. Generated by `drizzle-kit generate` answering
its interactive rename prompt with **rename** (driven through a pty — the prompt cannot be
answered non-interactively, and answering "create" would have produced a data-dropping
DROP+ADD). It emits `ALTER TABLE … RENAME COLUMN "user_id" TO "payer_user_id"`, drops and
recreates the FK with `ON DELETE set null`, and recreates the partial index under the new name.

Appended by hand, after the index:

```sql
UPDATE "usage_records" AS ur
SET "payer_user_id" = w."user_id"
FROM "ledger_entries" le
  JOIN "wallets" w ON w."id" = le."wallet_id"
WHERE le."usage_record_id" = ur."id"
  AND le."wallet_id" IS NOT NULL;
```

**Why this is exact, not approximate.** `usage_records` carries no `wallet_id`, so "the row's
own wallet" is reached through the row's charge legs. `chargeWithinTx` writes the usage record
and its zero-sum leg pair in one transaction, and exactly one leg of that pair carries a wallet
(the other is the `revenue` house leg, and `ledger_entries_one_account` enforces exactly one
account per leg). So the join yields exactly one wallet per row, and that wallet's owner **is**
the payer by definition — the same identity the corrected write path now records. It is a
lookup, not an inference. A row whose wallet has already been pseudonymized resolves to null,
which is the state the deletion's own `SET NULL` would have left; a row with no wallet leg
(the anonymous public-stats seeds) is not matched and stays null.

Applied and verified: `db:migrate` succeeded, and the migration is still the latest
(`_journal.json` ends at idx 62, 63 rows in `drizzle.__drizzle_migrations`) after a sibling
agent's `ensure-stack` ran mid-task.

**The backfill was executed against real rows, not merely reasoned about.** In a rolled-back
transaction I built exactly the shape it exists to repair — a usage row whose payer column named
the **member** while its charge leg debited the **owner's** wallet — and ran the statement
verbatim:

```
 phase  |            payer_user_id             |            sender_user_id
--------+--------------------------------------+--------------------------------------
 before | 00000000-…-0000000000a2 (the MEMBER) | 00000000-…-0000000000a2
UPDATE 942
 phase  |            payer_user_id             |            sender_user_id
--------+--------------------------------------+--------------------------------------
 after  | 00000000-…-0000000000a1 (the OWNER)  | 00000000-…-0000000000a2
ROLLBACK
```

The payer moves to the debited wallet's owner and the **sender column is untouched** — the two
sides stay independent, which is the whole point of the row.

A consistency check over the dev database after the real migration: of 941 usage rows that have
a wallet-bearing charge leg, **0** disagree with their wallet's owner. All 1178 rows currently
read a null payer because their users were hard-deleted by test cleanup — which is itself a live
demonstration of both the `SET NULL` path on the renamed column and the "rows whose wallet is
already null stay null" clause.

## `SET NULL` preserved — three independent proofs

1. **Live schema** (`\d usage_records`):
   `"usage_records_payer_user_id_users_id_fk" FOREIGN KEY (payer_user_id) REFERENCES users(id) ON DELETE SET NULL`
   and `payer_user_id | uuid | | |` (nullable).
2. **Shape pin**: `shape-tables.test.ts` › "survives payer deletion via SET NULL (financial
   retention)" asserts nullability + `onDelete === 'set null'` on `payer_user_id`.
3. **Behavioral pin**: `identity/domain/deletion.integration.test.ts` deletes the account and
   asserts the surviving usage row reads `{ payerUserId: null }`.

## Self-gate

All runs below are **after** the stack restart, re-run from scratch with `--force` (no turbo
cache).

| Command | Result |
| --- | --- |
| `turbo test --filter=@hushbox/db --force` (= `pnpm test:db`, coverage gate included) | **pass** — 27 files / 532 tests, plus 2/2 workers tests. `TESTDB_EXIT=0`, captured to its own file. |
| `tsc --noEmit -p packages/db/tsconfig.json` | **pass** — `TSC_DB_EXIT=0`, no output. |
| `tsc --noEmit -p apps/api/tsconfig.json` | **pass** — `TSC_API_EXIT=0`, no output. |
| `turbo test --filter=@hushbox/api --force` (= `pnpm test:api`) | `TESTAPI2_EXIT=1` — **10 failed / 6558 passed / 3 skipped**, in 2 files, **none of them mine** (below). Every failure my change caused is fixed. |
| `eslint --fix <my 27 api files>` from `apps/api/` | **pass** — `EXIT=0` after fixing two real violations it caught (`unicorn/no-await-expression-member` in my new test file, resolved by extracting the resolve-and-unwrap into a named helper). |
| `eslint --fix <my 5 db files>` from `packages/db/` | **pass** — `ESLINT_DB_EXIT=0`. |
| `eslint .` from `packages/db/` (whole package) | **pass** — `ESLINT_DB_FULL_EXIT=0`. |
| `eslint .` from `apps/api/` (whole package) | `ESLINT_API_FULL_EXIT=1` — **none of it mine**: the only three files reported are `billing/domain/spendable.ts`, `billing/domain/spendable.integration.test.ts` and `conversations/domain/guest-funding.ts`, all F4's and all mid-edit. Zero of my 27 files appear. |

Lint ordering: the last code edit anywhere was `turn-context.integration.test.ts`; both package-wide
lints were run **after** it, from each package's own directory, with the status captured on the
command itself (`cmd > log 2>&1; echo "EXIT=$?" > status`), never through a pipeline.
| Migration drift | Regeneration produces no new file; the snapshot was written by the generate run itself. |

### Typecheck: two errors seen mid-task, both now resolved by F4

At the time of my first sweep, `apps/api` typecheck carried two errors. Both are now gone
without any edit of mine — recorded because the audit trail should not imply I fixed them:

1. `slices/conversations/routes.integration.test.ts(2860)` — **caused by my rename** but inside
   F4's `conversations/**` grant. Reported, not edited; the orchestrator routed the exact line
   to F4, which has applied it (`payerUserId: userId,` at 2861). **Routed and closed**, not
   outstanding.
2. `slices/chat/domain/turn-ceiling.clamp-order.test.ts(106)` — `'tier' does not exist in type
   'FundingSnapshot'`, from F4's `FundingSnapshot.tier`→`payerTier` rename in
   `packages/shared/src/affordability/turn-types.ts`. F4 has since swept it (`payerTier: 'paid'`).

### The 10 remaining `test:api` failures, attributed

**3 in `billing/routes.integration.test.ts` › `GET /billing/spendable` — F4's, in flight.** The
verbatim diff is the field rename itself, nothing to do with `usage_records`:

```
AssertionError: expected [ 'heldNanoUsd', 'payer', …(2) ] to deeply equal [ 'heldNanoUsd', 'payer', …(2) ]
+   "payerTier",
-   "tier",
```

**7 in `notifications/domain/templates/template-html.test.ts` — pre-existing, unrelated.**

All 7 are snapshot mismatches
(welcome, account-deleted, account-locked, chargeback-lock, password-changed,
two-factor-enabled, two-factor-disabled). The single diff line in every one is a Google Fonts
`<link>` present in the committed snapshot and absent from the emitted HTML.

Attribution, with evidence rather than assertion: `base.ts` (the template builder) contains no
`fonts.googleapis` reference **at `HEAD`** or in the working tree, while the snapshot file
still expects one; `git status` reports **both files clean** — neither is modified by me or by
any concurrent agent — so this is a committed inconsistency between `base.ts` (last touched in
`a0a0f4c6`) and its snapshot (last touched in `2ab91d7a`). It fails identically for anyone who
runs `test:api` and has nothing to do with `usage_records`. Not fixed, not in scope.

An earlier sweep of the same suite also showed 10 failures in
`billing/domain/spendable.integration.test.ts` + `billing/routes.integration.test.ts`
(`served.tier` undefined) from F4's in-flight `spendable.ts`; those had cleared by the final run
as F4 progressed. Recorded so the two runs are not confused with each other.

## Deviations

1. **The shared wire field `PaidRunIdentity.userId` / `RunStartBody.userId` was NOT renamed.**
   Its meaning is now correct (its doc already said "who pays"), but renaming it would reach
   `packages/shared`, `packages/realtime` and `apps/api/src/slices/chat/routes.ts` — the last
   of which F5 holds. Recorded as the one residual naming gap; the value crossing it is the
   payer.
2. **The backfill was written although Global Constraint 7 says "zero existing users, no
   data-migration backfill".** F8's own criterion requires it explicitly, and the more specific
   instruction wins; the statement is idempotent and a no-op on an empty table.
3. **`isOwnerFundedTurn` was kept rather than replaced.** With the payer now correct, owner-funding
   is derivable with no I/O at all as `payerUserId !== senderUserId` (a guest has no sender user id,
   so it is always owner-funded). I did not make that change — it deletes a mechanism on the money
   path, which is not mine to rule — but it would remove a DB read and the whole drift class.

## Concerns and limitations

- **The idempotency key-row scope silently changed principal.** `createClaimRun` keys the run
  key row on `request.identity.userId`, commented "the paying user" — which is now literally
  true, where before it was the sender for a user turn. Uniqueness properties are unchanged
  (the run key is a fresh client uuid per turn), so I judged this in-scope and correct rather
  than a behavior regression, but it is a principal change on an idempotency boundary and I
  would rather it were seen than inferred.
- **The class sweep the orchestrator asked for.** I looked for other consumers recovering a
  role by comparing identities instead of reading a stated field. Result: one instance, the one
  fixed (`isOwnerFundedTurn`'s call site). One near-instance that stayed correct:
  `runtime.ts`'s `freeTierScopes` recovers "the payer is free-tier" by finding the payer wallet
  inside a wallet list read for `context.userId` — under the old meaning that list was the
  sender's and the check silently returned false for owner-funded turns (right answer, wrong
  reason); under the new meaning it is the payer's own list and the check is direct. Everything
  else that compares identities (`sender === owner` for solo, in `turn-context.ts`,
  `runtime.ts`, `settlement.ts`, `conversation-funding.ts`) compares two **stated** fields to
  express a definition, not to recover a decision from a field whose meaning I changed.
- **Seeded dev history writes no sender.** `seed-billing-history.ts` sets the payer and leaves
  both sender columns null, so seeded rows do not match the production shape (which always
  writes a sender). Pre-existing; not changed, since seeding a sender is not in these criteria.
- **No E2E was added or changed** (Global Constraint 11 forbids execution, and `e2e/` is being
  touched by another workstream). Worth a follow-up: `e2e/group/group-chat-billing.spec.ts`'s
  **owner-funded** case asserts only the owner's balance movement, so it would now be the
  natural place to assert `payerId === alice.userId` — the product-level form of the two-sided
  pin. Its two existing `payerId` assertions are on personal fall-through and are unaffected.
- `packages/shared/src/pre-inference/types.ts` and `events.ts` describe a
  `usage_records.source_id` column that does not exist in the schema. Pre-existing stale
  comments, outside this task; reported, not touched.

## Which run each gate was taken from

The local stack was down and restarted (`ensure-stack`) by a sibling implementer partway
through this task. Everything in the Self-gate table is from **after** that restart, re-run
from scratch with `--force`. The only pre-restart artifacts cited anywhere in this report are
the three red-first excerpts, and they are labelled as such in their own section.

## Confidence

**High** on the schema, the migration, the backfill's exactness, and the consumer enumeration:
the compiler enumerated every reference site, and the two blocking-and-attributed typecheck
errors are the complete residue.

**Medium-high** on the blast radius of the meaning change through the run identity. Two
consumers needed the sender rather than the payer and both are handled, but the discovery
method was reading every `context.userId` / `identity.userId` site by hand rather than anything
the compiler could check — a rename cannot type-check a change of meaning. The auditors' sharpest
question should be whether a third such consumer exists; the sites I inspected are listed above.
