# F2 — implementation report 2 (fix pass)

## Objective

Two validated comment-accuracy findings. No logic change, no test-behaviour change:

1. Four docblocks asserted client↔server "cannot drift" on the who-pays decision — false
   after F2's change (and false before it, less sharply) — and one of them credited the
   contract test with pinning that impossibility, which it cannot do.
2. `chat/domain/turn-context.ts` cited BILLING §Group Funding 6(b) as sanctioning
   admission's refusal. 6(b) rules the **race**; this path is **deterministic**, and
   priority 1 + §6(a) rule a signed-in member falls through. The shipped comment carried
   only the half that made the gap look settled.

Both findings are about what the next reader (C3, E1, B7) concludes from the code alone.

## Executable lines changed: none

Verified, not asserted. For the two **tracked** files, `git diff -U0` filtered to
non-comment lines across the *entire* F2 diff (report 1 + this pass) returns exactly two
lines, both from report 1:

```
+        turnEstimateNanoUsd: undefined,      (turn-context.ts:368)
+      turnEstimateNanoUsd: undefined,        (turn-context.ts:406)
```

`packages/shared/src/affordability/billing/` is untracked at HEAD (`??` — the directory is
new from the affordability restructure), so `git diff` cannot prove it there. Evidence
instead: all three edits in that directory were exact-string replacements whose before and
after text (reproduced in full below) consist only of block-comment lines, plus one
inserted `//` block; the contract matrix still holds **12 rows** (no row added, removed or
renamed), and the four billing test files still report **104 tests passed** — the same
tests, same names.

No test name changed anywhere in this pass. Nothing was re-run for logic; the suites below
are regression insurance only.

## Site-by-site before → after

### 1. `packages/shared/src/affordability/billing/funding-decision.ts` (module docblock)

**Before** (the replaced fragment):

```
 * their own way and then call THIS function, so the two sides can never drift on
 * the decision itself. The chat slice's `resolvePayerWallet` and route tier gate
 * are its imperative shells; a contract test pins the §2.K funding-scenario
 * matrix against it.
```

**After**:

```
 * their own way and then call THIS function. The chat slice's
 * `resolvePayerWallet` and route tier gate are its imperative shells; a contract
 * test pins the §2.K funding-scenario matrix against it.
 *
 * The RULE is shared; the INPUTS are not, so the two sides do NOT always reach
 * the same verdict today. The send path freezes the payer before the turn is
 * priced (see `turnEstimateNanoUsd` below) and therefore supplies no estimate,
 * which makes priority 1's estimate clause client-only: for a group member whose
 * headroom is positive but below the estimate, the client resolves `self` with a
 * `payerSwitch` while `resolvePayerWallet` resolves `owner`, and admission's
 * per-scope check then refuses the send. That divergence is a spec violation, not
 * a documented stop — §Funding Decision Matrix priority 1 and §Group Funding 6(a)
 * fall a signed-in member through to personal funds, and 6(b)'s hard refusal
 * covers only the race where the client's retry re-resolves, whereas this case
 * re-resolves to the same refusal forever. The contract test cannot catch it: it
 * hands both legs the same inputs by construction, so it pins the shared rule and
 * never the callers' input parity.
```

The divergence is stated as a present-tense fact anchored to its cause (the payer freeze
precedes pricing). No sentence promises a fix, names an owner, or says when the freeze will
be reordered — the STOP-AND-ASK condition in the brief did not trigger, because accuracy
here needs the cause, not the remedy. The orchestrator's recommended remedy (price a
minimum turn ahead of the freeze) is deliberately **absent**: it is unruled, and a comment
asserting it would be the same over-claim in the other direction.

### 2. `packages/shared/src/affordability/billing/client-billing.ts` (module docblock)

**Before**:

```
 * sides feed the SAME pure core, so who-pays + premium-tier decisions can never
 * drift between client and server (pinned by `funding-decision.contract.test.ts`).
```

**After**:

```
 * sides feed the SAME pure core, so the who-pays + premium-tier RULE is shared —
 * but the inputs are not, and the verdicts can differ. This shell passes the
 * turn's estimate into the core; the server's payer freeze passes none (it
 * chooses the payer before the turn is priced), so §Funding Decision Matrix
 * priority 1's estimate clause applies here and not there. A member whose group
 * headroom is positive but below the estimate is told here that personal funds
 * will pay, while the server still resolves the owner as payer and admission
 * refuses the send. `funding-decision.contract.test.ts` pins the rule both sides
 * run, not the inputs they feed it.
```

This is the site whose "(pinned by …)" parenthetical was the specific over-claim; the pin's
actual scope now replaces it.

### 3. `packages/shared/src/affordability/billing/funding-decision.contract.test.ts`

**3a — table docblock. Before**:

```
 * call {@link resolveFundingDecision}. Because there is a single decision
 * function, a scenario can be pinned once here and both sides are bound to it;
 * a future divergence becomes a failure of this table, not a silent
 * client↔server drift (GB-1).
```

**After**:

```
 * call {@link resolveFundingDecision}. Because there is a single decision
 * function, a scenario can be pinned once here and both sides are bound to the
 * same RULE; a change to that rule that split the two verdicts becomes a failure
 * of this table.
 *
 * What this table does NOT pin: that the two sides FEED the core the same inputs.
 * Every row hands the server leg a hand-written {@link FundingInputs} literal, so
 * a row's server inputs are what the chat slice COULD pass, never evidence of
 * what it does pass. The `turn estimate` rows are where that matters — see the
 * note above them.
```

`(GB-1)` — an audit-plan finding identifier, i.e. a Global Constraint 8 violation — sat
inside the exact sentence being replaced and is dropped rather than re-authored. It is the
only incidental removal in this pass; I did not touch the pre-existing `§2.K` reference
(same file, `describe` title and two docblocks) because that is not one of the two findings
and it is a dangling doc reference with a different owner — flagged, not edited.

**3b — row labelling. Before**: nothing between the `link guest, headroom ≤ 0` row and the
first `turn estimate` row. **After**, inserted immediately above the three rows:

```
  // The three rows below exercise §Funding Decision Matrix priority 1's estimate
  // clause as the CLIENT applies it. Their SERVER leg is hypothetical: the send
  // path freezes the payer before the turn is priced and passes
  // `turnEstimateNanoUsd: undefined`, so production's `resolvePayerWallet` never
  // reaches this comparison and still resolves `owner` where these rows resolve
  // `self`. Passing rows here are not evidence that the server behaves this way.
```

### 4. `apps/web/src/hooks/billing/use-resolve-billing.ts`

**Before**:

```
 * core the server uses (so the two sides cannot drift) and layers the
```

**After**:

```
 * core the server uses — the same rule, not necessarily the same verdict: this
 * path feeds the core the turn's estimate and the server's payer freeze feeds it
 * none, so a group member whose headroom is positive but below the estimate
 * resolves to personal funds here while the server resolves the owner and
 * admission refuses the send. It layers the
```

### 5. `apps/api/src/slices/chat/domain/turn-context.ts` (the §6(b) mis-citation)

**Before**:

```
    // No turn estimate is available here, and the ordering is why: the payer
    // must be frozen BEFORE the turn is priced, because the turn's output
    // ceiling is bounded by what the payer can pay. So the send path resolves
    // who pays and leaves the group headroom's per-scope check to admission,
    // whose refusal is the spec's hard stop for a headroom that cannot cover
    // the turn (BILLING §Group Funding 6b).
```

**After**:

```
    // No turn estimate is available here, and the ordering is why: the payer
    // must be frozen BEFORE the turn is priced, because the turn's output
    // ceiling is bounded by what the payer can pay. The consequence, which this
    // ordering does not excuse: priority 1's estimate clause cannot run here, so
    // a member whose group headroom is positive but too small for the turn is
    // frozen as owner-funded and then refused by admission's per-scope check,
    // while the same shared core on the client falls that member through to
    // personal funds — the two verdicts differ. BILLING §Funding Decision Matrix
    // priority 1 and §Group Funding 6(a) rule the fall-through; 6(b)'s hard
    // refusal covers only the race case, where the client's retry re-resolves,
    // and this case is deterministic — the retry re-resolves to the same refusal.
```

The ordering fact (payer freeze precedes pricing) is kept verbatim; the absolution is
replaced by the consequence. §6(b) is now cited for what it actually rules and explicitly
excluded from this path.

## What I did about the contract test's over-claim, specifically

**Both**, and deliberately so:

- The **table docblock** now separates the two claims — it pins the shared *rule*, and
  explicitly disclaims pinning *input parity*, naming the hand-written `FundingInputs`
  literal as the reason.
- The **three new rows** carry a note directly above them saying their server leg is
  hypothetical, that production passes `turnEstimateNanoUsd: undefined`, and that
  production resolves `owner` where the rows resolve `self`.

Why two placements rather than one: the docblock is what a reader hunting for "is the
divergence pinned?" reads, while the row note is what a reader arrives at from a test
failure or from copying a row as a template for a new scenario. The finding's failure mode
was a reader concluding "already pinned" — the docblock now denies it in the same paragraph
that makes the pin's positive claim, and the row note denies it at the exact rows that
would otherwise look like server evidence.

Why I did **not** rename the three rows: a row `name` is an executable string that becomes
the test title, and renaming would have broken the "no executable line changed" property
that makes this pass auditable as comment-only. The note sits inside the array immediately
above the rows it labels, so it is not further from the reader than a title suffix would
be, and it carries the whole fact rather than a parenthetical.

## Self-gate

| Command                                                                  | Result                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `npx eslint` × 3 shared files, from `packages/shared` (after last edit)   | **pass** — exit 0                                     |
| `npx eslint src/slices/chat/domain/turn-context.ts`, from `apps/api`      | **pass** — exit 0                                     |
| `npx eslint src/hooks/billing/use-resolve-billing.ts`, from `apps/web`    | **pass** — exit 0                                     |
| `vitest run --root packages/shared src/affordability/billing/`            | **pass** — 4 files, 104 tests                         |
| `vitest run src/slices/chat/domain/turn-context.test.ts` (`apps/api`)     | **pass** — 19 tests                                   |
| `vitest run src/hooks/billing/` (`apps/web`)                             | **pass** — 12 files, 237 tests                        |

**Repo-wide typecheck deliberately not re-run.** Global Constraint 10's trigger is a
contract change; this pass changes no signature, no type, no required member — the diff is
comment text only (proven above). The prior pass gated it at 16/16 uncached, and syntactic
validity of all five files is established by the three lint runs (typescript-eslint parses
each file). Nothing here can move a type.

Coverage was not re-measured: no executable line, no test, and no branch changed, so the
prior pass's 100% over `src/affordability/billing/**` stands unchanged. Per the brief's
environment note, the full `pnpm test:web` / `pnpm test:api` coverage-aggregation ENOENT is
a concurrent-vitest artefact; scoped runs above avoid the shared reports directory
entirely.

## Acceptance criteria (this pass)

1. **Finding 1 — the four "cannot drift" docblocks state the durable fact instead** —
   **met.** All four rewritten (sites 1, 2, 3a, 4). Each now says the *core/rule* is
   single, the *inputs* are not, names the concrete divergent case
   (`0 < headroom < estimate`: client `self` + `payerSwitch`, server `owner`, admission
   refuses), and names its cause (the send path supplies no estimate because the payer
   freezes before pricing).
2. **Finding 1 — the pin stops over-claiming** — **met.** See the dedicated section above:
   docblock disclaimer plus a row-level note; the phrase crediting the contract test with
   preventing client↔server drift is gone from all three files that carried it.
3. **Finding 2 — `turn-context.ts` no longer mis-cites §6(b)** — **met.** 6(b) is cited as
   the race rule and excluded from this deterministic path; priority 1 and §6(a) are cited
   as ruling the fall-through; the differing verdicts are stated as the consequence.
4. **F2's logic and tests unchanged** — **met.** Zero executable lines changed (evidence
   at the top); all three scoped suites green with unchanged test counts and names.

## Deviations

- **`(GB-1)` dropped** from the contract-test docblock (site 3a). It is a plan/audit
  identifier in shipped code (Global Constraint 8) inside the exact sentence being
  rewritten; re-authoring it would have shipped the violation knowingly. Not a new edit
  site.
- **The remedy is not named in any comment.** The orchestrator's minimum-estimate proposal
  is unruled and provisionally routed elsewhere, so no comment states how or when the gap
  closes — only that it is open and why.

## Concerns and limitations

1. **`§2.K` is a dangling reference** in `funding-decision.ts` (docblock), and in the
   contract test's docblock and `describe` title. `2.K` resolves to nothing in `docs/` —
   it appears to point at a superseded backend-redesign section. Left untouched (not a
   finding, not this task's ownership); worth an owner, since a reader chasing the spec for
   the funding matrix will not find it. The correct live citations are §Funding Decision
   Matrix and §Group Funding, both of which the new text uses.
2. **The divergence itself remains open** — unchanged by this pass, by design. The comments
   now describe it; only a send-path reordering removes it, and that stays unruled. Every
   new sentence is anchored to the payer-freeze cause, so whoever closes the gap has a
   mechanical signal for which comments must change with it.
3. **The word "today"** appears once (site 1). It is load-bearing only as a hint that the
   sentence is about current behaviour, not a design invariant; the anchoring clause that
   follows is what makes it falsifiable.
4. **Two surviving "can never drift" comments are correct and were left alone**:
   `client-billing.ts:161` and `client-billing.test.ts:552` both claim the who-pays verdict
   and the *sizing tier* cannot drift — a client-internal consistency claim (both derive
   from the same core in the same process), not a client↔server one. A repo sweep for
   `drift` / `single source of truth` across `affordability/`, `hooks/billing/`,
   `slices/chat/`, `slices/billing/` found no other client↔server parity claim, so the
   five sites were the complete set.
5. **`packages/shared/dist/src/billing/funding-decision.d.ts`** carries the stale
   pre-restructure copy of the old docblock ("can never drift"). It is build output from an
   old path and not regenerated here; mentioned because a `grep` for the retracted claim
   will still hit it.

## Confidence

**High.** The change is comment text only, proven mechanically for the tracked files and by
exact-string replacement plus unchanged test inventory for the untracked ones; every factual
assertion in the new text is grounded in the spec sections read this pass (§Funding Decision
Matrix priority 1, §Group Funding 6(a)/(b)) and in code read this pass
(`turn-context.ts:368,406` passing `turnEstimateNanoUsd: undefined`,
`spendable.ts:337` likewise). The one judgement call — labelling the contract rows with a
block comment rather than renaming them — is stated with its reason so the re-audit can
overrule it cheaply.
