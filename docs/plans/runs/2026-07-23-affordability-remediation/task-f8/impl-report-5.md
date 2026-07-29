# F8 — the third duplicate, deleted on the ruling (impl report 5)

## Objective

One deletion: `admits a group turn within both the per-member and per-conversation caps
(owner funds)` — the third member of the equivalence class reported in cycle 4 §4 — after
confirming the transitivity holds directly rather than assuming it. Everything else in
cycle 4 is accepted and untouched.

**One thing happened that was not in the objective and is more important than the deletion:
a probe revert corrupted an unrelated test. It was detected, repaired by hand, and verified.
§5 records it in full.**

---

## 1 — The transitivity check, done directly against the survivor

The brief's requirement: cycle 4 established _third ≡ deleted_ and _deleted ≡
survivor-minus-the-scope-ids-assertion_. That chain routes through a test that no longer
exists, so it was not relied on. **The third test was diffed against the survivor
directly**, in the current working tree, comments and blank lines stripped:

```
sed -n '538,556p' runtime.integration.test.ts | grep -v '^\s*//' | sed '/^\s*$/d'   # third
sed -n '618,653p' runtime.integration.test.ts | grep -v '^\s*//' | sed '/^\s*$/d'   # survivor
diff third survivor   →   17a18,24     (DIFF_EXIT=1)
```

Numbered side by side, the result is unambiguous:

| # | third (`:537`) | survivor (`:617`) |
| --- | --- | --- |
| 1 | `const { userId: ownerId } = await seedWallet(10_000_000n);` | identical |
| 2 | `const walletId = await ownerWalletId(ownerId);` | identical |
| 3 | `const senderId = await seedBareUser();` | identical |
| 4 | `const conversationId = await seedConversation(ownerId, 1_000_000n);` | identical |
| 5 | `const memberId = await addMember(conversationId, senderId);` | identical |
| 6–8 | `await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });` | identical |
| 9–14 | `paidRunContext({ userId: ownerId, conversationId, walletId, sender: { kind: 'user', userId: senderId, memberId } })` | identical |
| 15 | `const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);` | identical |
| 16 | `const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });` | identical |
| 17 | `expect(decision.admitted).toBe(true);` | **identical, same position** |
| — | _(ends)_ | + `if (!decision.admitted \|\| decision.hold === undefined) throw …` |
| — | | + `expect(decision.hold.scopeIds).toEqual(['member:…', 'conversation:…'])` |

**The chain does hold, and it holds without the intermediate.** The third test's 17 body
lines are byte-identical to the survivor's first 17; its sole assertion is the survivor's
line 17 verbatim, at the same index. So for any input `x`: third reddens on `x` ⟺ the
assertion `expect(decision.admitted).toBe(true)` fails on `x` ⟹ the survivor's line 17 —
the same call on the same seeded state — fails on `x`. The implication is constructive, not
an inference from resemblance, and the survivor's two extra assertions can only add
reddening inputs.

## 2 — The probes: the survivor reddens on the same inputs, observed not argued

Two probes on **independent input dimensions**, each run before the deletion (expecting both
tests red) and again after it (expecting the survivor still red). All four runs observed in
this session.

**P1 — the member cap dimension.** `spentNanoUsd: 0n → 2_000_000n` against a
`budgetNanoUsd: 1_000_000n`, applied to exactly the two matching sites (`grep -c` = 2).

```
EXIT=1   Tests  2 failed | 29 passed (31)
  × admits a group turn within both the per-member and per-conversation caps (owner funds)
  × binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER
AssertionError: expected false to be true // Object.is equality
```

**P1b — the conversation cap dimension.** `seedConversation(ownerId, 1_000_000n → 0n)`,
same two sites. A genuinely different scope from P1's, so the two probes do not test one
mechanism twice.

```
EXIT=1   Tests  2 failed | 29 passed (31)
  × admits a group turn within both the per-member and per-conversation caps (owner funds)
  × binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER
AssertionError: expected false to be true // Object.is equality
```

**After the deletion, each probe re-applied to the survivor alone** (`grep -c` = 1 for P1):

```
P1  post-deletion:   EXIT=1   Tests  1 failed | 29 passed (30)
P1b post-deletion:   EXIT=1   Tests  1 failed | 29 passed (30)
  × binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER
AssertionError: expected false to be true // Object.is equality
```

Same assertion, same message, both dimensions. **Stated with the precision the run's
standard demands:** a probe exhibits reddening inputs, it cannot enumerate all of them. The
universal claim rests on §1's construction (one shared assertion, verbatim, over identical
state); P1 and P1b are the concrete instances confirming the construction describes the
running code and not just the text.

## 3 — Test count

| Point | Tests in `runtime.integration.test.ts` |
| --- | --- |
| Before this cycle (cycle 4's end state) | **31** — EXIT=0, observed as this cycle's baseline |
| After this cycle's deletion | **30** — EXIT=0 |

Across F8: 32 → 31 (cycle 4) → 30 (cycle 5). The `chat/domain` suite moved 566 → **565**.

## 4 — Cause: the duplicates were MANUFACTURED by cycle 2's fixture correction

**This is the part worth carrying forward, and it is not a pre-existing-mess story.** At
`HEAD` the three tests were genuinely distinct. The removed lines in the cumulative diff
show it directly — the third test built its run identity as:

```
-    const context = paidRunContext({ userId: senderId, conversationId, walletId });
```

`userId: senderId`, no `sender` principal. The cycle-4-deleted test carried `userId:
senderId` **plus** an explicit `sender` principal, and the survivor a third variant. Those
differences were each test's reason to exist.

**Cycle 2's accepted stale-fixture correction moved all three onto the one production shape**
(`userId: ownerId` + an explicit `sender`), because that is what an owner-funded turn
actually looks like once the payer field names the payer. Correcting the fixtures was right
and is not in question. But moving several fixtures onto a single true shape **collapses the
axis those fixtures were varying**, and tests that differed only along that axis become
byte-identical — silently, with every one still green, so nothing in the gate signals it.

**The generalizable form, for the next person correcting a fixture set:** a fixture
correction that converges N fixtures on one shape is a *duplication-creating* change, not
only a correctness-restoring one. After such a correction, diff the bodies of the tests whose
fixtures moved — comments stripped — against each other and against their neighbours. Three
of this file's tests needed that check and nobody ran it for two cycles; it was found only
because a fourth reader diffed a pair by hand. The cost of the check is one `diff`; the cost
of skipping it was two extra cycles and a hand-back.

## 5 — INCIDENT: a `replace_all` revert corrupted an unrelated test

**Recorded prominently because it is the exact failure the plan's own §Global Constraints
warns about, and I walked into it anyway.**

**What happened.** P1b's revert used `replace_all` on a five-line block anchored on
`seedConversation(ownerId, 0n)` → `1_000_000n`. The block was unique *while the probe was
applied*, but the revert's search text also matched a **third, untouched** test —
`admits a group turn on the sender OWN wallet when the conversation has no budget
(personal fall-through, no group scope)` — whose legitimate, permanent value **is** `0n`.
The revert silently raised its conversation cap to `1_000_000n`.

**Why it was nearly invisible.** The corrupted test **still passed**. Its sender has an own
wallet of `10_000_000n`, so admission succeeds at either cap; the test kept asserting
`admitted === true` and stayed green. Only its *name and comment* — "the conversation cap is
0 (none configured) → zero group headroom" — still described the input it no longer had. A
green suite is not evidence here: nothing in the file, the suite, the typecheck or the lint
would ever have reported it.

**How it was caught.** A post-revert residue grep for the probe's literals
(`grep -n "spentNanoUsd: 2_000_000n\|seedConversation(ownerId, 0n)"`) returned a hit at a
line I had not expected to be a probe site. Chasing why that line existed surfaced the
inverse: the site I *had* corrupted was the one that no longer said `0n`.

**Repair.** The correct value was established from two independent sources before touching
anything — the test's own name and comment, and `git show HEAD:…` (HEAD line 462 reads
`await seedConversation(ownerId, 0n)`). It was then restored **by hand**, with a targeted
`Edit` anchored on the surrounding `senderWalletId` lines that are unique to that test. **No
state-writing git command was run** — the prohibition has no self-inflicted-damage
exemption, and `git checkout -- <path>` would have been exactly that.

**Verified repaired.** `git diff -U0` on the file now contains **zero** `seedConversation`
lines in any hunk — every one of the file's eight sites is byte-identical to HEAD except
those inside the deleted blocks. The full removed-line list of the cumulative F8 diff was
read line by line and contains only the two deleted tests plus cycle 2's accepted fixture
lines.

**The rule this yields, sharper than "be careful with `replace_all`":** a *revert* is
strictly more dangerous than the probe it undoes. The probe's search text is narrowed by the
pre-probe value; the revert's search text is the **post-probe** value, which may be the
resting value of sites the probe never touched. Reverting the probe therefore has a **wider**
match set than applying it. The mitigation used from here: count matches on both the apply
and the revert (`grep -c`), assert the counts are equal, and residue-grep afterwards. The
apply/revert counts were checked for P1 (2, then 1) — which is why P1 was clean — and were
**not** checked for P1b, which is precisely the one that broke.

## 6 — Recorded, not fixed: the assertion gap now belongs to F9

Cycle 4 noted that the cycle-4-deleted test's *name* carried a fact no assertion in the file
pins — "the resolved-sender path for a member (**not the flat fallback**)". That remains
true and is **not a new gap**: no assertion anywhere in this file distinguishes the
discriminated-sender path from `contextSenderUserId`'s flat fallback, and none did before
F8 either.

**It is now F9's, by that task's own text**, and should not be rediscovered as new work.
`plan.md` §F9 (as amended 2026-07-29) takes ownership explicitly: *"`contextSenderUserId`'s
flat fallback (sender absent ⇒ the sender is the payer field) is a surviving pre-F8
assumption, now reachable only from tests… Removing the optionality reaches
`packages/shared` and `packages/realtime`, which is exactly F9's cut."* Once F9 lands there
is **no second path left for a test to distinguish**, so the gap closes by construction
rather than by anyone writing the missing assertion. Writing one now would create a test
whose subject F9 deletes.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/chat/domain/runtime.integration.test.ts` | The third strictly dominated admission test deleted (21 lines), per the re-ruling. Also: one line restored by hand to its HEAD value after §5's probe-revert damage. |

## Tests added

None. This cycle deletes one test and adds none. The behaviour it covered is covered by the
survivor, whose inputs are byte-identical and whose assertions are a strict superset (§1).

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/slices/chat/domain/runtime.integration.test.ts` (baseline, before any edit) | **pass** — EXIT=0, 31/31 |
| `vitest run src/slices/chat/domain/runtime.integration.test.ts` (after deletion) | **pass** — EXIT=0, 30/30 |
| `vitest run src/slices/chat/domain` (30 files) | **pass** — EXIT=0, 565/565 (cycle 4's 566 − 1) |
| `tsc --noEmit -p tsconfig.json`, from `apps/api/` | **pass** — `TSC_EXIT=0`, no output. After the final edit. |
| `eslint` on F8's three `apps/api` files, from `apps/api/` | **pass** — `ESLINT_API_EXIT=0`, no output. After the final edit. |
| `eslint` on F8's five `packages/db` files, from `packages/db/` | **pass** — `ESLINT_DB_EXIT=0`, no output. After the final edit. |
| Coverage: `vitest run src/slices/chat src/slices/workflows --coverage.enabled --coverage.include='src/slices/chat/domain/**' --coverage.reportsDirectory=<scratchpad>/cov` | **pass** — EXIT=0, 1297/1297. `runtime.ts` 99.31 / 98.79 / 98.46 / 99.27; `settlement.ts` 98.64 / 97.08 / 100 / 99.51; all files 99.48 / 98.62 / 99.72 / 99.8 |

`runtime.ts`'s four figures are **identical to cycle 4's and cycle 3's** — the expected
result, since the deleted test drove the same code path as the survivor, so removing it
moved no coverage. 1297 is cycle 4's 1298 minus the one deleted test. The include set is
cycle 3's widened one (`src/slices/chat src/slices/workflows`), which carries
`smart-model-turn.ts`'s real exercisers; the narrower `src/slices/chat/domain` subset exits
1 on that untouched file as a scoping artifact.

**Lint-set derivation (Global Constraint 9), and a correction to cycle 4's.** `git status`
shows F8's own change set spans **two** packages: `apps/api` (`runtime.ts`,
`runtime.integration.test.ts`, `settlement.integration.test.ts`) and `packages/db`
(`usage-records.ts`, `relations.ts`, `schema.integration.test.ts`, `shape-fk-indexes.test.ts`,
`shape-tables.test.ts`, plus the generated `drizzle/0062_daily_silhouette.sql` and its
snapshot). **Cycle 4's report asserted `apps/api` was "the only package F8 has touched in any
cycle" — that was wrong**; the column rename and its migration are in `packages/db` by F8's
own acceptance criteria. Cycle 4's edit was in `apps/api`, so the omission was harmless in
effect, but the derivation it stated was the exact shape Global Constraint 9 exists to
prevent. Both packages linted here, each from its own directory, both after the final edit.
The remaining dirty packages in `git status` (`apps/web`, `packages/shared`, `packages/ui`,
`e2e`, `scripts/.cache`) belong to F4/F5 and other tasks and were not linted or touched.

Neither `pnpm test:api` nor `pnpm ensure-stack` was run (forbidden by the brief); the stack
was already up and every figure above was observed in this session on it. Coverage reports
were written to the scratchpad, not the shared temp directory. No git command other than
`status`, `show` and `diff` was run.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Confirm the transitivity holds against the **survivor** directly, not via the deleted test | **met** | §1 — comment-stripped `diff` of third vs survivor in the current tree, `17a18,24`; the shared assertion verbatim at the same index. The deleted test is not in the argument. |
| Delete the third duplicate | **met** | §3 — 31 → 30 tests; the block removed from `runtime.integration.test.ts`. |
| Confirm by probe that the survivor still reddens on every input either deleted test did | **met** | §2 — two independent input dimensions, each red on both tests pre-deletion and on the survivor post-deletion, same assertion and message; the universal half is §1's construction, and the report says so rather than overclaiming the probes. |
| Attribute the cause | **met** | §4 — cycle 2's accepted fixture correction converged the three fixtures on the production shape; the removed `userId: senderId` line is the direct diff evidence. |
| Record, do not fix, the assertion gap | **met** | §6 — pre-existing, owned by F9 per `plan.md` §F9's amendment, closes by construction when the flat fallback's optionality goes. |
| Do not touch F4's or F5's territory | **met** | The only file edited is `chat/domain/runtime.integration.test.ts`. No `conversations/**`, `billing/**`, `packages/shared/affordability/**`, `apps/web/hooks/billing/**` or `chat/routes.ts` edit exists in this cycle. |

## Deviations

None from the objective. **One process failure inside it**, fully disclosed in §5: a
`replace_all` probe revert modified a line outside the two target tests. Detected by residue
grep, repaired by hand against two independent sources, verified absent from the diff. No
state-writing git command was used.

## Concerns and limitations

- **§5 is the finding of this cycle, not the deletion.** A green suite did not and could not
  detect the corruption, because the corrupted input still satisfied the assertion. Any
  reviewer's confidence in "tests still pass" as evidence that a mechanical edit was correct
  should be adjusted by that. The concrete guard is the apply/revert match-count assertion in
  §5, which would have caught it at zero cost.
- **The equivalence class is now closed** — no two tests in the admission-hook describe share
  a comment-stripped body. Verified by pairwise inspection of the four remaining
  owner-funded/group tests, which differ in principal kind (`user` vs `linkGuest`), in cap
  values, or in asserted verdict.
- **`test:api`'s coverage gate still cannot fire** while the standing `template-html` failure
  stands; the figures above are a scoped run at EXIT=0, not the named gate. Unchanged from
  cycles 3 and 4.

## Confidence

**High for the deletion, and it is the cheap part.** The domination is textual and was
verified directly against the survivor in the current tree (§1), then confirmed on two
independent input dimensions by probes observed at EXIT=1 and reverted (§2). Coverage is
bit-identical to the two prior cycles, which is the expected signature of removing a test
that drove no unique path.

**Medium on my own mechanical edits this cycle, on the evidence of §5** — I made an
unintended change and caught it by a grep I ran for another reason. It is repaired and
verified, but the auditor should re-derive the file's diff against HEAD independently rather
than take this report's word for it; that check is one `git diff` and it is the right place
to spend the scepticism.
