# F8 — the one handed-back item: the strictly dominated admission test (impl report 4)

## Objective

Close the single item handed back in cycle 3: decide, on evidence rather than judgement,
whether `admits an owner-funded group turn carrying an explicit USER sender principal` is
strictly dominated by `binds an owner-funded group turn to BOTH group scopes when the run
identity names the PAYER`, and act on the ruled conditional. Nothing else — every other
cycle-3 item is accepted and untouched.

---

## 1 — Which case holds, and the evidence that decides it

**CASE 1 holds: the inputs are IDENTICAL and the survivor's assertions are a strict
superset.** Established textually before anything was changed.

Comment lines stripped and the `it(...)` line dropped, the two bodies diff as follows
(`apps/api/src/slices/chat/domain/runtime.integration.test.ts`, working-tree lines 617 and
640 — the brief's `:559` is the same test at its pre-cycle-3 line number):

```
--- 617 (admits … explicit USER sender principal)
+++ 640 (binds … BOTH group scopes … PAYER)
18a19,25
>     if (!decision.admitted || decision.hold === undefined) {
>       throw new Error('expected a granted hold');
>     }
>     expect(decision.hold.scopeIds).toEqual([
>       `member:${memberId}`,
>       `conversation:${conversationId}`,
>     ]);
```

Zero difference in the first 18 lines. Concretely, both drive:

| Input | Both tests |
| --- | --- |
| Owner wallet | `seedWallet(10_000_000n)` |
| Payer wallet | `ownerWalletId(ownerId)` |
| Sender | `seedBareUser()` — a bare user, no wallet |
| Conversation cap | `seedConversation(ownerId, 1_000_000n)` |
| Member row | `addMember(conversationId, senderId)` |
| Member budget | `budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n` |
| Run identity | `paidRunContext({ userId: ownerId, conversationId, walletId, sender: { kind: 'user', userId: senderId, memberId } })` |
| Estimate | `nanoUSD(100n)` |

Same seeding, same budgets, same estimate, same principal shape — same funding path
(owner-funded, explicit USER sender). The only textual difference is the appended
scope-ids assertion, and the deleted test's sole assertion
(`expect(decision.admitted).toBe(true)`) appears **verbatim, at the same position** in the
survivor. So the implication "every input that reddens the deleted test reddens the
survivor" is true by construction, not by resemblance.

## 2 — Proof by probe, in both directions

**Probe P1 — an input that reddens the deleted test.** The member budget flipped from
funded to exhausted (`spentNanoUsd: 0n → 2_000_000n`, a `replace_all` that hit every
`{ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n }` site). EXIT=1:

```
     × admits a group turn within both the per-member and per-conversation caps (owner funds)
     × admits an owner-funded group turn carrying an explicit USER sender principal
     × binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER
AssertionError: expected false to be true // Object.is equality   (×3)
      Tests  3 failed | 29 passed (32)
```

The survivor reddens on exactly the same assertion and the same message as the test being
deleted. (The fourth site the replacement touched — the personal-fall-through test at
:529 — stayed green, which is correct: no group scope applies there.)

**Probe P2 — an input that reddens the survivor and NOT the deleted test.** The
conversation scope dropped from the admission scope set in production
(`runtime.ts`, the `conversationBudget` block removed). EXIT=1:

```
     × binds an owner-funded group turn to BOTH group scopes when the run identity names the PAYER
AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]
      Tests  1 failed | 31 passed (32)
```

P1 and P2 together are the definition of strict dominance: no input separates them in the
deleted test's favour, and one separates them in the survivor's. Both probes were reverted
and the reverts verified (the `conversationBudget` block re-read in place at
`runtime.ts:570-575`; four `spentNanoUsd: 0n` literals remaining in the test file, which is
the pre-probe five minus the deleted test's one).

## 3 — Action taken

`admits an owner-funded group turn carrying an explicit USER sender principal` deleted from
`apps/api/src/slices/chat/domain/runtime.integration.test.ts` (22 lines). Nothing else in
the file changed; no helper, import or fixture became unused (every symbol it used is used
by neighbouring tests).

## 4 — A THIRD member of the same equivalence class, NOT acted on

`admits a group turn within both the per-member and per-conversation caps (owner funds)`
(working-tree `:537`) is **byte-identical, comments stripped, to the test just deleted** —
the same diff run over that pair returns empty. It is therefore dominated by the survivor
on exactly the same evidence, and P1 reddens it identically (it is the first `×` above).

**Why it became a duplicate, which matters for whose call it is.** At HEAD the two were
NOT identical: `:474`(HEAD) built the run identity as `paidRunContext({ userId: senderId,
conversationId, walletId })` — no explicit sender — while `:549`(HEAD) carried
`userId: senderId` **plus** an explicit `sender` principal. That difference was the second
test's whole reason to exist. Cycle 2's accepted stale-fixture correction moved three sites
from `userId: senderId` to `userId: ownerId` and added the sender principal, which
collapsed the distinction. So this is a consequence of this task's change, not a
pre-existing overlap I inherited — but it is a **money test the ruling did not name**, and
this run's standing instruction is that deleting one on implementer judgement is handed
back. Reported, not deleted.

Net effect, stated plainly so it is not over-read: one of two identical copies is gone; the
survivor's dominance over the remaining copy is unchanged and closes on a one-line ruling.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/chat/domain/runtime.integration.test.ts` | The strictly dominated admission test deleted, per the ruled case-1 branch. |

## Tests added

None. This cycle deletes one test and adds none; the behaviour it covered is covered by the
survivor's identical inputs and strictly stronger assertions.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/slices/chat/domain/runtime.integration.test.ts` (baseline, before any edit) | **pass** — EXIT=0, 32/32. |
| `vitest run src/slices/chat/domain/runtime.integration.test.ts` (after deletion) | **pass** — EXIT=0, 31/31 (32 − 1 deleted). |
| `vitest run src/slices/chat/domain` (30 files) | **pass** — EXIT=0, 566/566 (cycle 3's 567 − 1). |
| `tsc --noEmit -p tsconfig.json`, from `apps/api/` | **pass** — `TSC_EXIT=0`, no output. After the final edit. |
| `eslint` on the three files this task changed, from `apps/api/` | **pass** — `ESLINT_EXIT=0`, no output. After the final edit. |
| Coverage: `vitest run src/slices/chat src/slices/workflows --coverage.enabled --coverage.include='src/slices/chat/domain/**' --coverage.reportsDirectory=<scratchpad>/cov` | **pass** — EXIT=0, 1298/1298. `runtime.ts` 99.31 / 98.79 / 98.46 / 99.27; `settlement.ts` 98.64 / 97.08 / 100 / 99.51. |

`runtime.ts`'s four figures are **identical to cycle 3's**, which is the expected result:
the deleted test drove the same code path as the survivor, so removing it moved no
coverage. The coverage include set is the widened one from cycle 3
(`src/slices/chat src/slices/workflows`), which carries `smart-model-turn.ts`'s real
exercisers; the narrower `src/slices/chat/domain` subset exits 1 on that untouched file as
a scoping artifact.

Lint set derivation: `git status` shows this task changed three files
(`runtime.ts`, `runtime.integration.test.ts`, `settlement.integration.test.ts`), all in
`apps/api` — the only package F8 has touched in any cycle. No `packages/**` edit exists to
miss. Both the lint and the typecheck were issued after the deletion, which was the last
edit.

Neither `pnpm test:api` nor `pnpm ensure-stack` was run (forbidden by the brief); the stack
was already up and every figure above was observed in this session on it. Coverage reports
were written to the scratchpad, not the shared temp directory. No git command other than
`status`, `log`, `diff` and `show` was run.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| State which case holds, with evidence, before changing anything | **met** | §1 — comment-stripped diff plus the input table, taken before the first edit. Case 1. |
| Act on the case | **met** | §3 — the dominated test deleted; no other change. |
| If deleting, probe that the survivor reddens on every input the deleted test did | **met** | §2 — P1 reddens both on the identical assertion; the general claim is constructive (identical inputs, verbatim-shared assertion, superset). P2 is the converse half, showing strict rather than mutual dominance. |
| Do not touch F4's or F5's territory | **met** | The only file changed is `chat/domain/runtime.integration.test.ts`. |

## Deviations

None.

## Concerns and limitations

- **The third duplicate (§4) survives and needs one line of ruling.** Deleting only the
  named test leaves an identical body in the file, so the "noise read as coverage" the
  ruling names is halved rather than removed.
- **The deleted test's name carried one fact its body never pinned** — "the resolved-sender
  path for a member (not the flat fallback)". The survivor's inputs exercise that path (an
  explicit `sender` principal) and its comment says so, but no assertion in the file
  distinguishes the discriminated-sender path from the flat fallback. That gap predates
  this cycle and is unchanged by it; `contextSenderUserId`'s flat fallback remains
  test-only, as reported in cycle 3.
- **`test:api`'s coverage gate still cannot fire** while the standing `template-html`
  failure stands; the figures above are a scoped run at EXIT=0, not the named gate.

## Confidence

**High.** The case determination is textual rather than a judgement — a diff of the two
bodies with comments stripped, printed above — and the deletion is backed by probes in both
directions, each observed at EXIT=1 in this session and reverted with the reverts verified.
The one residual (§4) is a reporting item by construction of this run's rules, not an
unresolved question: the evidence deciding it is the same diff.
