# F8 — `usage_records` records the payer, unambiguously (impl report 2)

## Objective

Two founder-ruled changes on cycle 1's own raises, and nothing else:

1. **Remove the migration backfill.** Global Constraint 7 (zero existing users, no
   data-migration backfill) governs; the criterion that demanded one was withdrawn. Leave the
   generated rename alone and confirm the drift gate still passes.
2. **Delete `isOwnerFundedTurn`.** With the column finally meaning the payer, owner-funding is
   derivable as `payer ≠ sender` with no database read — removing the recovery-by-comparison
   class rather than pinning it. The cycle-1 money-loss pin must stay green **and** stay
   red-on-inversion.

Explicitly not touched: the run-key row's scope (flagged for auditors, not ruled).

## 1 — the backfill is gone

`packages/db/drizzle/0062_daily_silhouette.sql`, in full, is now the generated rename alone:

```sql
ALTER TABLE "usage_records" RENAME COLUMN "user_id" TO "payer_user_id";--> statement-breakpoint
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "usage_records_user_id_idx";--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_records_payer_user_id_idx" ON "usage_records" USING btree ("payer_user_id") WHERE "usage_records"."payer_user_id" is not null;
```

The hand-appended `UPDATE` **and its explanatory comment block** are removed. So is the
trailing `--> statement-breakpoint` that the hand-append had introduced after the `CREATE
INDEX`: drizzle-generated files terminate on `;` with no trailing breakpoint and no trailing
newline (verified against `0059`, `0060`, `0061` byte-tails), and a dangling breakpoint would
have made the migrator split off an empty final statement. The file is now byte-shaped exactly
as `drizzle-kit` emits.

Nothing about the schema, the FK, the index or the column name changed — no `packages/db/src/**`
file was touched this cycle.

### Drift gate — proof, not assertion

`pnpm --filter @hushbox/db db:generate` → exit 0, terminal line **`No schema changes, nothing to
migrate 😴`**.

Stronger, because "it printed nothing to do" is weaker than "it wrote nothing": md5 of **every
file** under `packages/db/drizzle/` was captured, `db:generate` re-run, and the md5 set
recaptured — `diff` of the two manifests exits **0**. Regeneration is byte-identical across the
whole migration tree, which is the property CI's `git diff --exit-code packages/db/drizzle/`
actually tests.

(`git diff --exit-code packages/db/drizzle/` exits 1 in *this* tree, and that is not drift: the
tracked `meta/_journal.json` carries cycle 1's uncommitted idx-62 entry, and the `.sql` +
snapshot are untracked. CI runs the check against a commit that contains all three, where the
diff is empty. The md5 manifest above is the run-local equivalent that is not confounded by
uncommitted state — the `git diff HEAD cannot isolate your own edits in this tree` entry in
§Known Breakage applies here verbatim.)

The already-applied migration is unaffected by the edit: drizzle's migrator selects by
`_journal` `when` against the last applied row, so editing an applied file neither re-applies it
nor invalidates it. The dev database keeps the backfill's (no-op) result; nothing depends on it.

## 2 — the DB read is deleted

### What was removed, by `file:line`

| Removed | Was |
| --- | --- |
| `apps/api/src/slices/chat/domain/turn-context.ts:321-330` — `export function isOwnerFundedTurn(billing, db, senderUserId, payerWalletId): ResultAsync<boolean, DomainError>` | `billing.readWallets(db, senderUserId).map((wallets) => !wallets.some((w) => w.id === payerWalletId))` — one DB round trip per run, recovering the funding decision by comparing the frozen wallet against a wallet list. |
| `apps/api/src/slices/chat/domain/runtime.ts:788-792` (cycle-1 numbering) — the guest short-circuit + the call | `senderUserId === undefined ? okAsync(true) : isOwnerFundedTurn(...)` |
| The `ResultAsync<boolean, DomainError>` channel on `ScopeContext`, `AdmissionRunContext` and `ChatSettlementDeps`, plus the two `.andThen` consumptions | It existed only to carry the read's failure. With no read there is no failure, so keeping it would leave a dead error arm on the money path — the residue this ruling exists to remove. |

### What replaced it

`apps/api/src/slices/chat/domain/runtime.ts:491-493`:

```ts
function isOwnerFunded(context: PaidRunContext): boolean {
  return contextSenderUserId(context) !== context.userId;
}
```

Called once at `runtime.ts:790`; threaded as a plain `boolean` through `ScopeContext`
(`runtime.ts:466`), `AdmissionRunContext` (`runtime.ts:582`) and `ChatSettlementDeps`
(`settlement.ts:177`), and consumed directly at `runtime.ts:555` and `settlement.ts:1087`.

The guest case needs no branch of its own: `contextSenderUserId` returns `undefined` exactly for
a link guest, and `context.userId` is a `string`, so the comparison is true. That is the
founder's formulation literally — "a link guest has no sender id, so the comparison is true" —
and it is also better for coverage than a disjunction, which would add a branch that only a
guest fixture could reach.

Nothing else referenced `isOwnerFundedTurn`: it was never on the chat barrel, and a repo-wide
grep (`*.ts`, `*.tsx`, `*.md`) now returns only two hits, both in a dated audit record — see
Concerns.

### The equivalence argument, case by case

The invariant this rests on is cycle 1's, and it is enforced at the producer rather than
asserted: `resolveTurnContext` sets `payerUserId: payer.wallet.payerUserId`
(`turn-context.ts:500`), and all three wallet-materialization branches mint that field from the
same read that chose the wallet — `senderPayerWallet`'s purchased arm (`:285-286`) and free arm
(`:299-300`) from `userId`'s own wallets, the group arm (`:409-410`) from
`args.ownerUserId`'s. **So the payer named on a run identity is always the owner of the wallet
named on it**, which is what makes "not one of the sender's wallets" and "not the sender"
the same predicate. Pinned independently by
`turn-context.integration.test.ts` › "records a payer that is the charged wallet owner, so the
two can never disagree".

| Case | payer (`context.userId`) | `contextSenderUserId` | old: payer wallet ∉ sender's wallets | new: payer ≠ sender | equal? |
| --- | --- | --- | --- | --- | --- |
| Solo — user sender owns the conversation | the owner | the owner | the wallet is the owner's ⇒ in the sender's wallets ⇒ **false** | equal ⇒ **false** | ✅ |
| Group, owner-funded (positive headroom) | the owner | the member | the owner's wallet ∉ the member's wallets ⇒ **true** | ≠ ⇒ **true** | ✅ |
| Group, personal fall-through (headroom ≤ 0) | the member | the member | the member's own wallet ∈ their wallets ⇒ **false** | equal ⇒ **false** | ✅ |
| **Link guest** | the owner | **`undefined`** (guest holds no account) | never evaluated — the call site short-circuited to `true` | `undefined !== owner` ⇒ **true** | ✅ |
| Flat single-principal turn (`sender` absent) | the payer | falls back to `context.userId` | the payer's wallet ∈ the payer's wallets ⇒ **false** | equal ⇒ **false** | ✅ |

The guest row is the one worth stating twice: it is the only case where the two implementations
reach the same answer by *different* routes — the old one by a hand-written short-circuit that
never called the predicate, the new one through the predicate itself. That is a strengthening,
and it is observable: under the inversion probe below, the guest pin now goes red, which it
could not have done while the guest bypassed the comparison.

**The one behavioural difference, and it is a subtraction only:** the old path could fail
(a wallet read error refused the run / rolled the settlement back). The new one cannot fail.
No verdict changes; a failure mode is removed.

### The divergent input, and why it is not a counterexample

There is exactly one input on which the two implementations disagree: `sender === undefined`
**together with** `context.userId ≠ the owner of context.walletId`. Under the old predicate that
context reads owner-funded (the wallet is not among that user's wallets); under the new one it
reads self-funded (payer equals the fallback sender).

**It is not route-reachable, and I verified both halves rather than assuming them:**

- `resolveTurnContext` always populates `sender` (`turn-context.ts:496`), and all **three** paid
  run-start bodies the route builds set `sender: context.sender` unconditionally
  (`chat/routes.ts:1163`, `:1245`, `:1346` — read-only inspection; F5's file, not edited). The
  `sender?`-optional arm on the wire (`PaidRunIdentity.sender`) is documented tolerance for a
  body shape the server no longer produces.
- The payer/wallet-owner identity holds by construction at the producer, as tabulated above.

So the divergence needs a context that violates *both* properties at once. **That combination
is precisely the pre-F8 meaning of `userId`** (the sender), which is why it exists in the tree
at all — see the finding below.

### Red-on-inversion: the pin still discriminates

The inversion reintroduces the exact cycle-1 defect — key the comparison on the payer instead of
the sender, which is what `isOwnerFundedTurn(billing, db, context.userId, context.walletId)`
computed (always `false`, because the payer's own wallet is always among the payer's wallets):

```ts
function isOwnerFunded(context: PaidRunContext): boolean {
  const payerKeyed: string | undefined = context.userId;
  return payerKeyed !== context.userId;
}
```

`runtime.integration.test.ts` under the inversion: **3 failed | 27 passed**.

```
FAIL … > refuses an owner-funded group turn over the member cap when the run identity names the PAYER
AssertionError: expected { admitted: true, …(3) } to deeply equal { admitted: false, …(1) }
-   "admitted": false,
-   "code": "INSUFFICIENT_ADMISSION",
+   "admitted": true,
+   "hold": { "holdId": "9f735856-…", "scopeIds": [], "walletId": "019fae7c-…" },
```

`scopeIds: []` with `admitted: true` is the money-loss signature verbatim: no group scope
emitted, so an exhausted member keeps spending the owner's money. The input that flips the
assertion is the payer/sender split itself.

The other two reds are the corrected member-cap refusal and the **link-guest** cap refusal —
i.e. the inversion now moves three assertions where cycle 1's mechanism let it move one. The
probe was reverted by hand (no git command); the restored body is byte-identical to the version
that produced the green run recorded below, re-verified by reading the file back.

## 3 — the finding this change surfaced: three pre-F8 test fixtures

**Cycle 1's rename falsified three fixtures in `runtime.integration.test.ts` and nothing caught
it, because the recovery-by-comparison tolerated the contradiction.** Each built
`paidRunContext({ userId: senderId, …, walletId: <the OWNER's wallet> })` — a run identity whose
payer is not the owner of its wallet. That was the *correct* production shape **before** F8,
when `context.userId` meant the sender; after F8 it is unproducible. `isOwnerFundedTurn` kept
them working because it ignored `userId`-as-payer and treated it as the sender.

| Test | Under the derivation, before I corrected it |
| --- | --- |
| "refuses a group turn when the sender is over their durable per-member budget" | **Failed** — read self-funded, emitted no group scope, admitted. |
| "admits a group turn within both the per-member and per-conversation caps (owner funds)" | **Passed vacuously** — took the self-funded path and admitted on balance alone, no longer exercising the caps it names. |
| "admits an owner-funded group turn carrying an explicit USER sender principal" | **Passed vacuously**, same way, while its name claims owner-funded. |

Two of the three were silent. Had I gated on a green suite alone I would have shipped two money
tests that stopped exercising their own subject.

**Fixed by correcting the input, never the assertion**: each now carries `userId: ownerId` plus
`sender: { kind: 'user', userId: senderId, memberId }` — the shape the route actually produces.
No assertion, seeding, budget figure or estimate changed. This is not "forcing the equivalence":
the divergent input was removed because it is not a state the system can reach, and the
corrected fixtures travel the owner-funded path again.

Test count is unchanged (565 before, 565 after), so nothing was dropped to reach green.

## Files changed

| File | Why |
| --- | --- |
| `packages/db/drizzle/0062_daily_silhouette.sql` | Backfill + its comment removed; trailing statement-breakpoint removed so the file matches generated shape. |
| `apps/api/src/slices/chat/domain/turn-context.ts` | `isOwnerFundedTurn` deleted; two comments it anchored rewritten (the `resolvePayerWallet` header and the `senderPayerWallet` free-wallet note, which cited it by name). |
| `apps/api/src/slices/chat/domain/runtime.ts` | `isOwnerFunded` added; import and call site removed; `ScopeContext`/`AdmissionRunContext` carry `boolean`; the `.andThen` consumption flattened; four comments rewritten. |
| `apps/api/src/slices/chat/domain/settlement.ts` | `ChatSettlementDeps.ownerFunded: boolean`; the `.andThen` consumption flattened; two comments rewritten; the now-unused `ResultAsync` type import dropped. |
| `apps/api/src/slices/chat/domain/runtime.integration.test.ts` | Three pre-F8 fixtures corrected to the production identity shape; the cycle-1 pin's comment rewritten onto the derivation. |
| `apps/api/src/slices/chat/domain/settlement.integration.test.ts` | `ownerFunded` fixtures `okAsync(x)` → `x`; unused imports dropped; three comments rewritten (one was a false claim that owner funding "moves only the wallet"). |
| `apps/api/src/slices/chat/domain/settlement.fuzz.integration.test.ts` | Same fixture change; unused `okAsync` import dropped. |

## Tests added

**None, deliberately.** This cycle is a ruled deletion whose contract is "behaviour-preserving",
so its evidence is the *existing* pin still moving (§Red-on-inversion) rather than a new
assertion. Adding a test asserting `isOwnerFunded`'s output directly would pin the
implementation, not the behaviour, and the plan's own vacuity rule warns that a cited artifact is
not discrimination by it.

## Comment sweep

Swept by the removed mechanism's **vocabulary**, not by re-reading my hunks (the C2 rule):
`isOwnerFundedTurn`, `recover*`, `wallet ownership`, `second connection`, `read failure`,
`sender's wallets`, `threaded`, across all seven changed files. Seven falsified sites found and
corrected; four surviving hits inspected and left, because they describe mechanisms that still
exist (`freeTierScopes` recovering the free-tier decision from the wallet's *type*; the
group-scope decision keying on `context.sender`; settlement's conversation/member reads, which
can still fail).

One of the seven was a **false** comment rather than a stale one:
`settlement.integration.test.ts` claimed "(In production, owner funding moves only the wallet;
the attributed userId stays the member.)" — untrue since cycle 1, when owner funding started
moving `payerUserId` too, and it contradicted the sentence directly above it. Dropped rather
than reduced.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm --filter @hushbox/db db:generate` (drift) | **pass** — `No schema changes, nothing to migrate`; `drizzle/` md5 manifest byte-identical across a second regeneration (`diff` exit 0). |
| `tsc --noEmit -p packages/db/tsconfig.json` | **pass** — `TSC_DB_EXIT=0`, no output. |
| `tsc --noEmit -p apps/api/tsconfig.json` | **pass** — `TSC_API_EXIT=0`, no output. |
| `turbo test --filter=@hushbox/db --force` (= `pnpm test:db`, coverage gate included) | **pass** — 27 files, plus 2/2 workers tests. `TESTDB_EXIT=0`. |
| `vitest run apps/api/src/slices/chat/domain` (30 files) | **pass** — 565/565, identical to the pre-change baseline of 565/565 taken on the same stack. |
| `eslint` on the 6 changed `apps/api` files, from `apps/api/` | **pass** — `ESLINT_MINE_EXIT=0`. |
| `eslint .` from `packages/db/` (whole package) | **pass** — `ESLINT_DB_EXIT=0`. |
| `turbo test --filter=@hushbox/api --force` (= `pnpm test:api`) | `TESTAPI3_EXIT=1` — **7 failed / 6562 passed / 3 skipped**, in **one** file, none of them mine (attributed below). Obtained on the third attempt; the first two were voided. |

Lint ordering: both lint runs were issued **after** the final source edit (the comment sweep),
from each package's own directory, with the status captured on the command itself
(`cmd > log 2>&1; echo "EXIT=$?"`), never through a pipeline. Lint set derived from `git status`
grouped by package: this cycle's changes touch `apps/api` and `packages/db` only.

### `pnpm test:api` — the two voided attempts, then the run I gated on

**Attempts 1 and 2 are void, not results.** Both aborted after ~1 minute with:

```
Error: Something removed the coverage directory ".../apps/api/coverage/.tmp" Vitest created
earlier. Make sure you are not running multiple Vitests with the same "coverage.reportsDirectory"
at the same time.
Caused by: ENOENT: no such file or directory, open '.../coverage/.tmp/coverage-28.json'
```

Attributed with evidence rather than asserted: `ps` during the second abort showed a sibling
process running `vitest run src/slices/chat/routes.integration.test.ts -t 'premium-tier gat…'`
from `apps/api` — **F5's file, F5's subject** — sharing `apps/api/coverage/.tmp`. Same class as
§Known Breakage's env-regeneration entry: a concurrent agent voids an in-flight suite, the tell
is an infrastructural error rather than a coherent defect. Neither reached a test summary, so
neither is reported in either direction. **This is a new coordination hazard worth recording:
two `test:api` runs in this worktree cannot overlap at all** — the second kills the first's
coverage temp directory. It is not specific to my task.

**The gated run is attempt 3**, started after `ps` showed no vitest anywhere in the tree:
`TESTAPI3_EXIT=1` — **7 failed / 6562 passed / 3 skipped** across 474 files. The exit status was
written to its own file and read from there, never taken from the runner's completion notice
(the background wrapper reported "exit code 0" — the wrapper's status, exactly the trap
§Known Breakage names).

**All 7 failures are the standing `template-html` breakage, and the plan predicted this exact
result.** They sit in one file, `notifications/domain/templates/template-html.test.ts`, and every
diff line is the same missing Google-Fonts `<link>`:

```
-   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">
```

`git status` reports **nothing** under `src/slices/notifications/domain/templates/` — neither the
template source nor the `.snap` is modified by me or by any concurrent agent, so this is a
committed inconsistency, reproducible for anyone. §Known Breakage records it verbatim, including
the sentence "**it is the single `apps/api` failure a scoped run will show**". My run shows
exactly that failure and nothing else — no chat, billing, conversations or dev-platform red at
all. Cycle 1's run additionally carried three `billing/routes.integration.test.ts` reds from
F4's in-flight rename; those have cleared as F4 progressed.

**The `apps/api` coverage verdict was not produced by that run**, and I chased it rather than
leaving it as a shrug. Vitest suppresses the coverage report when the run fails, so the standing
`template-html` breakage costs every `apps/api` task in this run its coverage table and its
weights/pole gate. Since deletion is exactly the shape §Known Breakage warns can move coverage
unexpectedly, I measured my three changed source files directly, as a **lower bound**: coverage
over `src/slices/chat/domain` alone (green, 565/565), which under-counts because
`chat/routes.integration.test.ts` and other suites also exercise these files.

| File | % Stmts | % Branch | % Funcs | % Lines |
| --- | --- | --- | --- | --- |
| `chat/domain/runtime.ts` | 99.31 | 98.79 | 98.46 | 99.27 |
| `chat/domain/settlement.ts` | 98.64 | 97.08 | 100 | 99.51 |
| `chat/domain/turn-context.ts` | **100** | **100** | **100** | **100** |
| (`chat/domain` aggregate) | 99.14 | 97.79 | 99.16 | 99.42 |

`turn-context.ts` is read as 100% from its **absence**: the reporter omits fully-covered files —
zero rows anywhere in the table read `100 | 100 | 100 | 100`, so no file at 100 is printed, and
every listed `chat/domain` row is a shortfall row. All three files clear the 95% gate on every
axis from this lower bound alone, so the deletion did not drop any of them.

That subset run exits 1 on unrelated `src/lib/**` files the subset never imports, which is
precisely why a subset cannot substitute for the named gate — it is cited here only for the
three per-file numbers, never as a gate result.

`packages/db`'s coverage gate *did* run in full and passed.

**An instance of the documented moving flake, recorded for the auditor:** the first attempt at
that coverage run showed 2 failures in `chat/domain/regenerate.integration.test.ts`
(`expected 'failed' to be 'succeeded'`) — **verbatim** one of the four moving chat-integration
flakes §Known Breakage names (`regenerate succeeded→failed`, mechanism: shared `model_catalog`
contention). The identical command minutes earlier and minutes later both returned 565/565, and
the full `test:api` run between them also passed that file. Not chased, not fixed.

## Deviations

1. **`ownerFunded` was narrowed from `ResultAsync<boolean, DomainError>` to `boolean`** through
   `ScopeContext`, `AdmissionRunContext` and the barrel-exported `ChatSettlementDeps`, rather
   than keeping the wrapper and passing `okAsync(...)`. The wrapper existed only to carry the
   deleted read's failure; keeping it would have left a dead error arm plus three comments
   describing a read that no longer happens. Read as the ruling's "delete anything that existed
   only to support it". It is an `apps/api`-internal type — no package boundary is crossed, and
   full `apps/api` typecheck is green.
2. **Three test fixtures outside the ruled scope were corrected** (§3). Not optional: two of
   them had silently stopped exercising their own subject.

## Concerns and limitations

- **The two corrected `admitted: true` group tests still do not discriminate scope emission.**
  With both caps generous they pass whether or not group scopes are emitted. That was equally
  true before this cycle — I did not weaken them, and I did not strengthen them either, since
  adding assertions is outside the ruled change. The discriminating coverage is the two refusal
  tests plus the cycle-1 pin. Worth a follow-up decision, not a silent edit.
- **The corrected member-cap refusal test is now near-identical to the cycle-1 pin** — same
  seeding, same budgets, same estimate, same assertion; they differ only in name and comment
  emphasis. I did **not** delete either: dropping a money test on my own judgment is the highest-
  risk move available here, and the founder's instruction was explicitly to prefer the report
  over the deletion. Flagging it so the collapse is a decision rather than an accident.
- **`contextSenderUserId`'s flat fallback (`sender` absent ⇒ the sender is `context.userId`) is
  a pre-F8 assumption that survives in the code.** It is now only reachable from tests, since
  every production run-start body carries `sender`. It is *consistent* with the payer meaning
  (absent sender ⇒ self-funded ⇒ payer is the sender), and `settlementSenderUserId` documents
  exactly that reading — so it is correct, not a defect. But it is the residue that let the three
  stale fixtures look valid, and removing the optionality reaches `packages/shared` and
  `packages/realtime`, which is F9's territory. Reported, not touched.
- **`docs/plans/CODEBASE-AUDIT-2026-07-18.md` cites `isOwnerFundedTurn` twice** (`:172`,
  `:1122`) with line references into `turn-context.ts`. `.md` is read-only to me and that file
  is a dated audit record rather than a current-system doc, so I left it. Naming it because the
  Doc Lifecycle rule makes staleness someone's problem.
- **The run-key row's payer scope was not touched**, per the brief — recorded here only so its
  absence from the diff is deliberate rather than overlooked.
- **`test:api`'s coverage gate cannot fire while `template-html` is red** — vitest suppresses
  the coverage report on failure, so no `apps/api` task in this run can obtain a per-file
  coverage verdict from the named gate. I closed it for my own files with a lower-bound
  measurement (all three ≥95, one at 100), but the gate itself stays blocked until that
  standing breakage gets the owner §Known Breakage says it needs.
- **Two `test:api` runs cannot overlap in this worktree.** They share
  `apps/api/coverage/.tmp`, and the second aborts the first within a minute. This cost me two
  runs; it will cost every remaining `apps/api` task the same unless the run serializes them.

## Which run each gate was taken from

Every figure above is from the current session on a stack that was up throughout — no
`ensure-stack` was run by me (the brief forbids it). The pre-change baselines
(`runtime.integration` 30/30, `chat/domain` 565/565) and the post-change runs were taken on the
same stack minutes apart, which is what makes the "identical count" comparison meaningful. The
inversion probe was run and reverted between the two, with no background suite of mine in
flight.

## Confidence

**High** on the migration change: it is a deletion, the file now matches generated shape
byte-for-byte in its terminator convention, and drift is proven by manifest comparison rather
than by reading a success message.

**High** on the equivalence. The one divergent input was found by the suite rather than by
argument, then traced to unreachability through the producer invariant and all three route call
sites — and the pin's red-on-inversion is verbatim rather than claimed.

**High** on the absence of a wider regression. `test:api` reached a full summary with 6562
passing and its only 7 failures in the one file §Known Breakage names as the single expected
`apps/api` red, in a directory `git status` shows nobody has touched; `chat/domain` — the entire
blast radius, since every file this cycle touched lives there — is 565/565, matching its own
pre-change baseline exactly; and the compiler enumerated every `ownerFunded` site. The one
residual is that the named gate produced no coverage verdict for `apps/api`; I closed that for
my own files with a lower-bound measurement (99.31 / 98.64 / 100 statements), so the deletion is
shown not to have dropped any of them, but the gate itself did not run.
