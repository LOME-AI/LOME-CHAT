# Plan — Affordability, Billing & Effort Remediation (Tier 2)

**Complete rewrite, 2026-07-25**, superseding the original plan and its sixteen amendments.
The design phase that followed the original plan changed the shape of the remaining work, so
the surviving amendments are folded inline here and the stale ones are gone. Task numbering
restarts under lettered lanes; the original T-numbers appear only in §Disposition so a reader
can map old ledger entries.

`docs/BILLING.md` is the specification. It is normative, it is current, and it is the only
place billing semantics live. **Every brief in this run — implementer, auditor, fixer,
validator, critic — must read it in full.**

---

## RUN STATE — paused 2026-07-27

**B8 and C2 are both implemented and in audit.** The founder lifted the pause on 2026-07-27 and both ready tasks
went out together on disjoint file sets; both are money-flagged, so each gets two independent auditors. C2 has been
through two fix cycles (the over-bill and the vacuous equivalence pin); B8 was re-scoped mid-flight after returning
NEEDS_CONTEXT against an unbuildable criterion.

**Clean — 18 of 29 lettered tasks** (26 at approval, plus B8b, B9 and F3 — all three created 2026-07-27, each because a task in flight proved that real work had no owner: deletion after the B8 split, the api-estimator rewrite, and a served funding number for free users) (each ended on an audit the orchestrator read and agreed found nothing
valid; money-flagged tasks had two independent auditors):

| Task    | What it delivered                                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1**  | the money set relocated to `affordability/` with provable behaviour identity (839 exported symbols, zero declaration-text changes, 0 of 539 runtime values moved)                                                                                                                                                        |
| **B1b** | both barrels closed against the not-exported list; **the wall is NOT yet closed** — 14 interim per-unit subpaths remain, which B8 deletes                                                                                                                                                                                |
| **A1**  | catalog admission restored (zero-price, price floor, age cutoff, top-context exemption); 25 of 207 models now excluded, verified against the live catalog                                                                                                                                                                |
| **F1**  | `GET /billing/spendable` serves the payer's hold-aware figure plus `tier` and `payer`, pinned against `admitRun` itself                                                                                                                                                                                                  |
| **B2**  | the dimension registry, the one-vocabulary collapse, the premium move, and `moneyPerToken` as a fourth resource                                                                                                                                                                                                          |
| **F2**  | funding priority 1 compares the estimate, boundary pinned by amount at three levels                                                                                                                                                                                                                                      |
| **B3**  | `getTurnOptions` — the two-set producer, the §Math vocabulary, and the presented-set family closed structurally                                                                                                                                                                                                          |
| **A2**  | catalog exclusion as a soft delete — reason marked and cleared by the refresh, `admin_disabled_at` provably independent, one exposure chokepoint                                                                                                                                                                         |
| **B4**  | every tier's wire cap fitted through the ONE canonical estimator — both ungated trial doors closed, the `apps/api` rate arithmetic deleted, per-sibling caps                                                                                                                                                             |
| **B5**  | outlier exclusion on `maxCallCost`, resolved-corner eligibility, ONE premium classifier, and trial priced without storage — both trial arms now measure the count the route builds                                                                                                                                       |
| **B6**  | one effort resolver — the other two collapsed to thin adapters, the `B + H` bound re-pinned in two independent spaces, and the classifier reserve made an upper bound by construction                                                                                                                                    |
| **B7**  | typed refusal reasons with derived copy — one wording per condition, every notice naming an action, and a composer that shows exactly one blocking demand                                                                                                                                                                |
| **C1**  | the decision envelope — classifier as an ordinary model call, streaming derived from the graph, and the three settlement properties a turn-level node breaks all closed                                                                                                                                                  |
| **C2**  | run-level settlement anchor and the classifier charge billed rather than absorbed, plus the ruled **billable ⟺ the node's value committed** — a user-facing over-bill closed at the seam with no flag, three pins each proven falsifiable by inversion                                                                   |
| **B8**  | the real public surface — `chooseFrom`/`renderOptions` **built** where no producer existed, `notices`/`wireFor` renamed with no shims, `ModelId` branded with a control that bites, premium marking on a validated injected instant, and the walled types off the models slice's public barrel without widening the wall |
| **F3**  | one tier-correct served funding number — the free tier was being served the **paid $0.50 cushion**, a 10× overstatement in the unsafe direction; the figure is now reproduced from `resolveBudgetScopes` rather than recomputed, so it cannot drift from the gate by construction                                        |
| **C3**  | the multi-model `auto` classifier WIRED — recognition derived from the graph, history/custom-instructions/preamble all withheld, storage excluded by the consumed-is-never-persisted CLASS rule, and an 8× over-hold found and closed on the way                                                                         |
| **D1**  | the resolved effort persisted per generation — a declared node field justified by a **provably lossy wire** (four rungs mint an identical `{max_tokens}`), null-versus-`off` distinguished at every layer, and a money-path row-skip removed that had been hiding billed partials from every usage aggregate             |

**In flight — E1 (fix cycle) and B9 (fix cycle). D1 is clean.** **FOUNDER INSTRUCTION 2026-07-28: dispatch NO new tasks — finish what is in flight to clean audits, then pause, update plan and ledger, and bring open questions and doc changes.** An analyst is running on the price-owner relocation question; its output is decision material for the founder, not a task. C3 closed clean after seven cycles and two auditors, unblocking both B9 (held behind it) and D1.

**The 2026-07-27 pause instruction is LIFTED** (founder, same day): B7 and C1 both reached clean audits under it,
the run reported, and the founder said continue. Normal dispatch rules resume — a task goes out the moment its
dependencies are clean and no in-flight task shares its files.

**Not started — 12 tasks:** B9, B8b · D1, D2 ·
E1 (blocked on F3), E2, E3, E4 · G1, G2, G3 · H1.

**B9 AND C3 COLLIDE, AND C3 GOES FIRST (resolved 2026-07-27 — my grants overlapped).** B9 owns
`apps/api/src/slices/models/**` for the walled-reference rewrite; C3 was granted
`models/domain/smart-model-candidates.ts` (the `_pinned` declaration) and `models/domain/estimate-run.ts` (the
classifier double-pricing fix) — both inside B9's tree. Serialised rather than split, because splitting would hand
one file to two owners, which is the rule this plan exists to keep. **C3 first**, on three grounds: it carries the
run's only user-visible interim regression (Smart Model classifies nothing until it lands), it carries two
`reserve ⊇ bill` defects that bind the moment it wires the node, and it is the original blocker this whole run was
opened to remove. B9 is cleanup toward the wall and the wall is not urgent — B8b waits on E1 and G2 regardless. B9's
behaviour-identity criterion then applies to the tree **as C3 leaves it**, not as it stands now.
Every one carries criteria amended by what the clean tasks learned; several would have been built against a
wrong premise without those amendments.

**The spine is clear.** Exactly two tasks are ready the moment the pause lifts: **B8** (needs B7 and C1, both
clean) and **C2** (needs C1). They own disjoint files — B8 the shared barrel and the 14 interim subpaths, C2
the settlement and Smart Model execution paths — so they run concurrently. Everything else stays blocked: E1
and G1 open on B8, C3 on both B8 and C2, and lane D on C2. Verified against §Dependency-graph, not assumed —
D1 in particular depends on C2 rather than C1 and is **not** ready.

### The git baseline — `ada0341c`, and the money module is tracked

**`HEAD` is `53daba72` ("billing refactor"), and it contains every clean task's code.** The founder's
commits have absorbed the run twice; an audit spanning the B5 work wants `ada0341c..53daba72`.
`packages/shared/src/affordability/` is a **tracked directory** there. Three consequences bind every
implementer and auditor from here:

- **Baseline identity claims against `HEAD` with a plain `git diff`.** "Behaviour identity", "import-path
  only" and "comment-only" are all directly provable from `git diff HEAD -- <path>`. For a comment-only
  claim, compare **comment-stripped** content between `git show HEAD:<path>` and the working file — read
  the diff and account for every hunk, rather than filtering with a pattern that only catches one comment
  syntax. Do **not** settle for mtimes, green tests, or a reconstructed pre-move twin; those were
  workarounds for a state that no longer exists, and they prove strictly less.
- **Name the commit explicitly** in any comparison you report. A bare `HEAD` resolves to whatever is
  current, so a differential that says "vs HEAD" is unreproducible once anything lands.
  **STALENESS CORRECTED 2026-07-27 (E1 caught it): this claim is no longer true.**
  `packages/shared/src/affordability/**` now carries B8's uncommitted work across dozens of files, and
  `apps/api/src/slices/{workflows,chat}/**` carries C2's. The baseline commit is still `53daba72` and nothing has been
  committed by an agent, but "nearly clean" would send the next reader looking for a tree that no longer exists.

- **The working tree is nearly clean of this run's code** — one two-line comment in
  `affordability/turn-core.ts`, plus doc files. A red suite is therefore your own or on §Known Breakage;
  it is not uncommitted run state.

A concurrent workstream owns other uncommitted files (see §Known Breakage). Nothing in this run is
committed **by an agent** — the founder's own commits absorbed it, and the no-git-writes rule stands
unchanged.

### What a resuming orchestrator must not re-derive

Four things cost multiple cycles to establish and are recorded in the sections below rather than here:
the `moneyPerToken` contract (no arithmetic converts a rate into a hold term); the ruled `getTurnOptions`
call pattern (one call, empty basis substituted internally); the presented-set family and its closure
argument (five instances, one leaf predicate, one named residual risk); and the pool-size reserve predicate
and why a presented-set version has no fixed point.

### `BILLING.md` is normative and current

The doc batch and the six rulings are **applied**. `BILLING.md` describes the system this plan builds,
including the five normative statements the rulings added: the catalog's soft-delete lifecycle, the
bounds-not-prices rule, `ceilingTokens`' best-case semantics, the structural content-free rule, and trial's
storage-free pricing. Its path citations resolve. **Read it as current and cite it as authoritative** — no
correction backlog stands against it.

**A task that invalidates a normative statement corrects it in that task** (ruling 6). **RULED 2026-07-27 — this
never means a subagent edits `.md`.** Ruling 6 means the task SURFACES the correction in its report; the
orchestrator relays it to the founder for per-file approval. The plan previously asserted both `.md` read-only to
subagents and in-task correction, and B8's NEEDS_CONTEXT was right to refuse to guess between them. The ruling
records how every `BILLING.md` correction in this run has actually been handled rather than changing practice. Do
not open a
correction backlog; a batch's cost grows with every reader who arrives before it lands.

**All six open questions are ruled. Nothing is waiting on the founder.**

---

## Handoff — read first (you know nothing about this run)

You are the orchestrator. Execute via the `subagent-driven-dev` skill: you write no
production code; every task is implementer subagent → auditor subagent(s) → your judgment;
fix→re-audit loops; ledger every transition in `ledger.md`. Re-confirm with the human only
where you must deviate from this plan; deviations are recorded here as amendments.

**What happened before you.** A prior orchestrator planned and executed 12 tasks to clean.
Work then stopped on a blocker: the spec promised classifier-resolved effort on multi-model
turns, which was not buildable as designed. A design phase followed — four adversarial
analysts, five focused agents, and a legacy-regression sweep — and produced a ruled design
now written into `docs/BILLING.md`. The design phase also disproved several things the
earlier plan assumed. Read `BILLING.md`, then this plan, then `ledger.md` for
ruling history. **Do not reconstruct the design from the ledger; `BILLING.md` wins.**

**Two documents were deleted from `research/` by an untracked-file wipe** (a git operation by
concurrent work). Their content is in `BILLING.md` and `ledger.md`. Do not recreate them:
anything durable belongs in `BILLING.md`, anything about execution belongs here.

**Non-negotiables** (from the repo's `CLAUDE.md` chain, restated because they bite here):
strict TDD — failing test first, watched red, minimal green; 95% per-file coverage is part of
`pnpm test`; schema edits ship their generated migration (CI fails on drift); no agent runs a
git command that writes state; `.md` files are read-only to subagents.

---

## The completeness contract

**When this plan is done, every aspect of `docs/BILLING.md` is realized in code.** That is the
run's definition of finished — not "the tasks passed", but "the specification is true of the
system".

Two consequences bind execution:

- **A normative clause with no owning task is a planning defect.** If an implementer or auditor
  finds a `BILLING.md` statement that no task claims, that is a gap to report, not a clause to
  ignore. It becomes an amendment with an owner.
- **A task is not done because its criteria passed.** Its criteria exist to make the relevant
  clauses true. Where a criterion could be satisfied without making its clause true, the
  criterion is wrong and the auditor should say so.

**Already-true clauses need verification, not a task.** `BILLING.md` documents the whole billing
system, most of which this run does not change — Payments, New User Bonus, Balance Consumption,
Tier derivation, Trial quota mechanics, the Billing Flow's settlement steps. A clause that is
already true of the system is realized; the correct report is "verified true at `file:line`",
not a new task. Only a clause the code contradicts, or one nothing implements, is a gap. An
auditor or critic that manufactures tasks for working behaviour has misread this section.

The close phase's completeness critic audits against `BILLING.md` directly, section by section,
rather than against this plan's task list — because the task list is the thing under suspicion.

## Global Constraints

Implicitly part of every task's acceptance criteria and every auditor's lens.

1. **`docs/BILLING.md` is required reading for every subagent, in full.** Section references
   in tasks below (§Catalog Admission, §Affordability 7, …) are normative acceptance criteria.
2. **TDD.** Failing test first, watched red for the expected reason, minimal green. A test
   that passes on first run is evidence of nothing and must be rewritten.
3. **Money is nano-USD `bigint` end to end.** `NanoUSD` strings at JSON boundaries, never
   `Number()`-coerced on any path that feeds a charge, hold, or comparison.
4. **No fee application outside the two seams** (catalog ingestion, provider-cost conversion
   at the ModelProvider port). No rate arithmetic outside the affordability module.
5. **One implementation, shared.** A `keep in sync` comment, a mirrored constant, or a test
   proving two implementations agree is a defect, not a resolution. If you are about to write
   one, the task is wrong — stop and report.
6. **Content-free money layer.** No export of the affordability module accepts a prompt, a
   message, or a history array. Counts, rates and ids only.
7. **Zero existing users.** No data-migration backfill, no coexistence windows. Schema changes
   still ship a generated migration for the drift gate.
8. **No plan or task identifiers in shipped code.** No `A1`, `B3`, `T14`, "step 2 of 3", or
   run references in comments, test names, or commit-adjacent text. Comments record durable
   facts about the code.
9. **Re-lint after the final edit — and DERIVE THE LINT SET, do not remember it.** After your last
   edit **anywhere in the repo**, take the changed-file list from `git status`, group it by package,
   and run one `eslint` per package present — from that package's directory, exit 0 required. `eslint
--fix` from the repo root silently no-ops under this ESLint version.

   Two failure modes, and only the first is obvious. **(i) Ordering:** linting before the last edit.
   **(ii) Coverage:** linting the package you were thinking about and reporting its exit 0 for
   packages you also touched. A task hit (ii) in this run — its final edit was in
   `packages/shared`, it linted only `apps/api`, and reported exit 0 for both; the lint gate fronts
   the whole CI DAG, so that shipped it red. Capturing the exit status perfectly still reproduces
   (ii) exactly, which is why the enumeration step is the rule and status-capture is only hygiene.

   **Capture the status on the command itself** — `cmd > out 2>&1` then `echo "EXIT=$?"`. A pipeline
   reports its LAST stage's status, so `eslint … | tail; echo $?` prints 0 no matter what eslint did.
   The orchestrator fell into that shape while checking this very finding.

   **Severity note, because mislabelling it invites under-investment:** a red lint gate is not Minor.
   It blocks every downstream gate in CI. Treat it as Important.

10. **Contract-change sweep.** A task changing a shared type, a Zod schema, or a cross-package
    invariant must grep repo-wide for every producer and consumer — including `scripts/`,
    `e2e/`, `apps/marketing`, `apps/admin` — list them with a disposition, and run repo-wide
    `pnpm typecheck`, not only the scoped filter.
11. **No E2E execution this run** (human ruling). E2E _code_ changes remain in scope and are
    delivered lint- and typecheck-clean but unexecuted. Running them is founder-owned.
12. **Attribute around the known failures in §Known Breakage.** Never "fix" a failure your
    task did not cause, and never claim a green run you did not observe.

---

**MOVING A DATA READ DEEPER PUSHES A MOCK REQUIREMENT UP EVERY RENDER TREE THAT CONTAINS THE LEAF — expect it, and
read the failure shape.** E1 hit this three times in one task (`model-selector-button`, `chat-header`, then
`chat.index`). The tell is a **`… is not a function` TypeError rather than a failed assertion** — a missing export on
a mocked module, not a behaviour change. Lanes E2, E3 and E4 convert further surfaces onto the same hooks and will
hit it again; it is expected work, not a regression, but it must be fixed at the mock rather than by narrowing the
suite.

**NEVER RUN A BLANKET REGEX-REPLACE ACROSS A GREP RESULT — a grep finds a NAME, and a name does not tell you which
role it is playing.** E1, 2026-07-28: sweeping every file containing `canAccessPremium` with one substitution could
not distinguish a **verdict site** (which had to go) from a **legitimate ordering input** (which had to stay), so it
damaged files it had no business touching — and the damage is what tempted the forbidden git command that followed.
Targeted per-file edits would have produced neither. **The wider the sweep, the more certain you must be that every
hit means the same thing**, and for anything carrying a role rather than a value, it does not.

**AND THE RULE THAT FAILURE STRESSES: NO AGENT RUNS A STATE-WRITING GIT COMMAND, INCLUDING TO UNDO ITS OWN DAMAGE.**
`git checkout -- <path>` is a state-writing command. The prohibition has no self-inflicted-damage exemption, because
the moment an agent is repairing a mess it is the least able to judge blast radius — which is exactly when the rule
has to hold. The two available moves are **reconstruct by hand** or **stop and ask the orchestrator**. This instance
happened to be safe (one path, that agent's own edits from minutes earlier, nine sibling modifications verified
intact, `HEAD` and reflog untouched) — and "it happened to be safe" is not the standard.

**AN ALIASED RE-EXPORT DEFEATS EVERY NAME-GREP, INCLUDING THE SWEEP RULES BELOW.** B9 found five walled re-export
sites in `models/**` where B8 had counted three — and the two it missed include `CHARS_PER_TOKEN_CONSERVATIVE`
**re-exported under the name `CLASSIFIER_CHARS_PER_TOKEN`**. No grep for the original name finds the downstream
consumers, because downstream the symbol is not called that. The vocabulary sweep and the sibling-grep rule both
assume a name survives its hops; an alias breaks that assumption silently. **When sweeping a symbol, grep its
re-export SITES as well as its name** — `export { X as Y }` and `export { X }` from a module you do not own are where
a name changes identity.

**`scripts/with-env.ts <mode> -- cmd` IS WRONG USAGE AND FAILS SILENTLY.** It takes the command directly, with no
`--`. Given the separator it exits **1 with zero output** — indistinguishable from a killed gate, which is the same
false-silence class as the timed-out-`eslint` entry above. Cost B9 one probe.

**WHEN A WIRE CODE IS ADDED, RENAMED OR SPLIT, GREP FOR ITS SIBLINGS — NOT FOR THE NEW CODE, WHICH BY DEFINITION
APPEARS NOWHERE YET.** C3's rule, 2026-07-28, and it is the actionable form of the sweep's one blind spot. A wire code
lives in **code-keyed collections** — status maps, retryable sets, refusal builders — where **nothing type-checks
membership**, so a split silently drops the new code out of every collection its sibling still sits in. Grepping the
new name finds nothing, correctly and uselessly. Grepping the **siblings** finds every collection that should have
gained it.

Two live defects came out of exactly this, one caught and one missed: `RUN_CAPACITY_REACHED` fell out of
`RUN_REFUSAL_STATUS` (whose fallthrough would have turned a 402 into a **409 for every client**) and out of
`RETRYABLE_REFUSAL_CODES` (leaving the user told to retry with the retry affordance removed). C3 found the first with
a package-scoped sweep and could not find the second, **because a wire code is a cross-package contract and its
sweep radius is the repo** — which is what Global Constraint 10 already asks for and what a package-scoped habit
quietly narrows.

**EXISTENCE OF A CITED ARTIFACT IS NOT DISCRIMINATION BY IT — the vacuity test, asked about a TEST's claimed
reach.** The run's recurring defect, in its sharpest form (B8, 2026-07-27). When a report says "this test would have
caught X", the check is **not** that the test exists, that it runs, or that its assertions are real. It is whether
**X moves that assertion the failing way**. The worked example: B8 justified a no-behaviour-change claim by citing
coverage floors that genuinely exist and genuinely run — but `greyedCount > 0` moves the _permissive_ way under the
collapse it was cited against (more greying satisfies it), `rowsWithRungs` counts rows irrespective of availability,
and two more floors were satisfiable from one tier's draws alone. Every artifact was real; none discriminated.
**This survived two wrong justifications and one wrong ledger entry** — the implementer's, its restatement, and the
orchestrator's — because each reader verified the artifacts existed. A conclusion can be true while every stated
reason for believing it is worthless, and that is the most expensive shape in this run: it looks like evidence.
The discipline: for any "this would have caught it", name the input that flips the assertion, or say you did not check.

**SWEEPING A DIFF'S OWN HUNKS DOES NOT FIND THE COMMENTS YOUR EDITS FALSIFIED — grep the vocabulary of the removed
mechanism instead.** C2 established this the expensive way on 2026-07-27: its primary money file was comment-swept
**twice** and still carried six false comments, because both sweeps re-read the diff's hunks. That method finds
comments you _edited_ and structurally cannot find comments your edits falsified **elsewhere in the file** — which
is the entire failure mode, since deleting a mechanism invalidates prose that sits nowhere near the deletion.
The reliable method, which then found two further sites the audit finding had not listed: after removing a
mechanism, grep every owned file for the removed mechanism's **vocabulary** (its type names, function names, the
words the old design used) and check each hit against current code.

**The rule predicted itself within hours, and then earned itself.** B8 hit the identical shape the same afternoon:
a comment it fixed sat _inside_ the block it had added, so re-reading its hunks reached it — while the file's
**header, fourteen lines above**, was falsified by that same addition and no number of hunk re-reads can reach it.
Applying the vocabulary method across six changed mechanisms then found a **third** site that no auditor and no
orchestrator had named: a claim that a row "stays refused however wrong the clock is", a universal quantifier over
clocks resting on two measured draws. The generalisation worth keeping: **the method keys on what you CHANGED, not
on where the diff is.** "I added instants" ⇒ grep instant-counting words wherever they sit. Minutes to run.

**And the sibling rule for the fix itself: do not replace an overstatement with a smaller one.** Both B8 corrections
dropped the falsifiable quantity rather than reducing it — "driven from one injected `nowMs`" became "every instant
here is injected", which is what the file _guarantees_ and cannot be falsified by a later test addition. A count in
prose is a sync contract with the code beside it. Applied across all ten of C2's owned files it
returned zero remaining hits. A sweep that has not been done this way is not a sweep.

## Known Breakage — attribute around, do not chase

**A CONCURRENT AGENT REGENERATING `.env.development` / `.env.scripts` VOIDS AN IN-FLIGHT SUITE RUN.** C2's first
auditor lost a full `test:api` pass to this on 2026-07-27 — 35 files / 16 tests red including trial 402s and admin
Access config errors — because another agent regenerated both env files mid-run. The tell is a burst of
configuration-shaped failures across unrelated slices at once, not a coherent defect. Do not chase it and do not
gate on that run: re-run after the churn settles, and say in your report which run you gated on. The auditor
correctly declared its own second run void rather than reporting either result.

**NO SINGLE GREEN `apps/api` SWEEP PROVES ANYTHING FOR THE REST OF THIS RUN — the chat-integration flakiness is a
MOVING SET, not a flake.** Established by C2's second auditor on 2026-07-27 across five sweeps: it saw **four
distinct** failing tests in chat integration files — trial `201→403`, regenerate `succeeded→failed`, `POST /chat`
`201→400`, trial-capacity `429→400` — **every one of which passes in isolation**, with the failing set moving
between identical commands. A deliberate pairing run of two suites reproduced a failure in the _other_ file, and one
suite passed in a sweep that excluded the routes suites. Mechanism: shared `model_catalog` contention, aggravated by
concurrent catalog wipes.
Two consequences, and the second is the one agents get wrong. (1) A red here is attributable outward **only after**
you check your own changed files for catalog fixtures — C2 did exactly that and found zero. (2) **A green sweep is
equally uninformative**: because the failing set moves, one clean run does not establish that a suite is healthy, so
never cite a single green api sweep as evidence a regression is absent. The distinguishing test is determinism — a
real compile-level defect fails in isolation, and none of these do.

**NEVER MUTATE SOURCE FOR A RED-FIRST DEMONSTRATION WHILE A BACKGROUND SUITE IS IN FLIGHT.** C2 hit this on
itself on 2026-07-27: a scoped-coverage script it had launched earlier was still on a later pass during its
inversion window, and reported the new pin as a FAIL that had nothing to do with the tree's real state. Same shape
as the stood-down-agent entry, but inside a single agent rather than between two. An auditor reading such a log
should discard the line. The discipline is sequencing, not cleanup: finish or kill background suites before
deliberately breaking the tree, and restore from a byte-exact backup with `diff` afterwards.

**`git diff` AGAINST `HEAD` CANNOT ISOLATE YOUR OWN EDITS IN THIS TREE.** B9, 2026-07-28: it reached for
`git diff` to verify what `eslint --fix` had done to a file, and could not use the result — **B8's uncommitted work
is in the same file**, so the diff shows this run's cumulative state rather than one agent's change. With ~340
uncommitted entries from several tasks and workstreams, `git diff HEAD` is a read of _the run_, not of _you_. Verify
your own edits by re-running the affected suite, or by comparing against a copy you took before the edit. This also
means the §git-baseline identity claims (which compare against `HEAD` deliberately) answer a different question from
"what did I just change" — do not borrow one method for the other.

**RUN THE SCOPED CHECK THE PLAN NAMES, NOT A SUBSET OF IT — an un-instrumented `vitest run <paths>` cannot see the
coverage gate.** E1's scoped check is `pnpm test:web`; across **eleven** reports it ran `vitest run <subset>` instead,
which passes while `pnpm test:web` **exits 1** on per-file coverage. Three E1-owned files are short, with **identical
numbers on two independent full runs** — so this is not the documented load-dependent artifact, it is a real
shortfall that eleven green self-gates never saw. CODE-RULES makes a coverage shortfall a **test failure**. The
uncovered regions are not incidental: one of them is the **pinned-effort input path**, i.e. the adapter-side half of a
criterion, never exercised.

**A TIMED-OUT GATE IS NOT A PASSING GATE.** E1, 2026-07-28: two `eslint --fix` runs were killed by the 120s tool
timeout and **reported nothing at all** — no output, no failure, no exit code to read. Silence from a killed process
is indistinguishable from silence from a clean one, and the natural reading is the flattering one. E1 re-ran narrowly
rather than trusting it. **If a gate produced no output, establish why before recording it as green**; the
`echo $?`-beside-a-pipe trap already documented in Global Constraint 9 is the same failure wearing different clothes.

**AN ASSERTION CAN PASS BECAUSE THE THING IT NAMES NO LONGER EXISTS.** Also E1: a test asserted
`not.toHaveAttribute('data-below-floor')` on a row that no longer emits that attribute at all. It passes, forever,
naming nothing — a **negative** assertion is satisfied by deletion, so removing the feature strengthens the test's
green. Replaced with the positive assertion that the premium row **is** marked. **Prefer positive assertions when
pinning a rendered state**; a negative one cannot distinguish "correctly absent" from "no longer a concept".

**`npx vitest` RUN DIRECTLY FROM `apps/web` FAILS ON ENV, NOT ON YOUR CHANGE.** E1 hit this on 2026-07-28:
`model-selector-button.test.tsx` dies with a ZodError on `VITE_API_URL` / `VITE_PLATFORM` unless the run goes through
`scripts/with-env.ts`. Env-shaped failures are the tell — a schema complaint about a variable, not an assertion.
Same class as the documented api entry, now confirmed for web. E1 nearly attributed it to its own change.

**GREEN LINT + GREEN TESTS CAN SIT ON TOP OF A RED TYPECHECK — vitest does not typecheck.** E1 hit this on
2026-07-27: a hoisted mock typed `'paid' as const` rejected `'free'` and `'trial'`, so `tsgo` was **red** while lint
and the whole suite were **green**. Nothing in the fast feedback loop can see it. Run the declared typecheck gate
before believing a green run, and run it **after the last edit**, not before. (Related: a complexity finding in the
same cycle was resolved by extracting a function, not by raising the threshold — the rule stays where it is.)

**`npx tsc` IS NOT THE WEB GATE — `tsgo` IS, and they disagree.** E1 nearly reported a phantom pre-existing break on
2026-07-27: `npx tsc -p tsconfig.json` flags `model-list-body.test.tsx`, while `tsgo` — the checker
`apps/web/package.json` actually runs — does not. Run the gate the package declares, and if you reach for a
different checker, say which one produced the output. A failure only your ad-hoc tool sees is not a failure; a
report that treats it as one sends the next agent hunting a break that does not exist.

**AND THE INSTRUMENT IS UNSTABLE RUN-TO-RUN UNDER LOAD, not merely sensitive to suite selection.** C3 strengthened
its own entry on 2026-07-27: the **same command over the same glob** returned **87.68%** then **99.60%** for one file
with nothing functional changed between the runs (the JSON showed 1 uncovered statement of 249). So a scoped
shortfall can be an artifact of machine load alone. **Read the number out of the JSON and re-run before believing
it** — C3 nearly reported a 12-point regression that does not exist. Combined with the two entries below, a coverage
figure in this repo is only evidence when it is stable across runs, taken with one include, and driven by the suites
that actually exercise the file.

**A SCOPED COVERAGE RUN MISSING THE DRIVING SUITES READS EXACTLY LIKE A REAL SHORTFALL — the false-RED counterpart
to the entry below.** C3 hit this on 2026-07-27: scoped runs of one file read **82.75%**, then **94.08%** as it added
suites, while over the whole chat slice the same file is **99.59 / 97.63 / 100 / 100**. The denominator is the file;
the numerator is whatever suites the run happened to include. Because the api coverage table never prints, there is
no signal distinguishing "this file is undertested" from "I did not run the tests that exercise it". **Before
reporting a coverage shortfall, widen to the owning slice and compare** — and when you report a scoped figure, say
which suites drove it. Together with the entry below, coverage in this repo can lie in **both** directions: a
stacked-include run passes having measured one file, and a narrow-suite run fails having measured the right file
with the wrong tests.

**VITEST `--coverage.include` DOES NOT ACCUMULATE — a scoped coverage gate can be vacuous and still exit 0.**
Found by C2 on 2026-07-27 while gating six owned files. Passing the flag repeatedly (and equally, using a brace
glob) results in **one** file landing in the coverage table; the run still exits 0, so the output reads as a clean
gate over N files when it in fact covered one. **Use one `--coverage.include` per run, and check the table lists
every file you claim to have gated.** Two consequences, stated because they are unequal: for every future task this
is a procedure rule, but for the tasks already clean it means any per-file coverage evidence gathered with stacked
includes proved less than it appeared to. This is the vacuity class again — a gate that cannot fail — and it is the
sixth instance this run. It is recorded here rather than silently fixed because agents read this section to
attribute failures, and this one produces a false GREEN, not a red.

Verified pre-existing at the time of writing. If a scoped run shows one of these, it is not
yours.

- **A concurrent workstream is live in this repo** — notifications/push, the document sandbox,
  service worker, and TTS work all have uncommitted files and their own failures. Never edit
  or "fix" a file outside your task's ownership list.
- ~~**`packages/shared/src/env.config.ts` + notifications typechecks may be red**~~ — **CLEARED**
  (verified 2026-07-26 during A1's fix: `turbo typecheck --force --continue` is 16/16 with zero cached
  tasks). **Repo-wide typecheck is now a usable gate and is the required one** — the earlier licence to
  fall back on scoped package typechecks is withdrawn, and it is what let A1 ship a red repo. Global
  Constraint 10 means what it says.
- **`scripts` suite collection failure** in `refresh-catalog-run.test.ts` and `seed-run.test.ts`
  — the test runner mangles an SSR-optimized dependency URL under `vi.mock` + `importOriginal`.
  The tests pass when collected. Needs an owner outside this run. **Refined 2026-07-26: this is NOT the
  stale-optimizer class** — it reproduces after `rm -rf scripts/node_modules/.vite`, so clearing the cache
  does not fix it and the two causes must not be conflated. **Consequence worth stating: those four tests
  never execute, so that file is gated by typecheck and lint alone** — which is exactly how A1's break
  reached a red repo.
- **`packages/db` `schema.integration.test.ts` "creates exactly the inventory tables"** fails
  intermittently when a parallel worker leaves a scratch table in the shared database. Passes
  in isolation.
- **`packages/config` `pnpm test` can fail its pole gate** — one rule test clocks over half the
  package's test-work under load. The file is unmodified by this run.
- **An orphan `email=''` user row** intermittently appears in the shared dev database and breaks
  email-verification tests. Clear it and re-run; do not chase a product bug. **Corrected by A1's audit:
  this is not the only cause, and may not be the one you are seeing.**
  `identity/routes-email-verification.integration.test.ts` was observed failing at **collection** on the
  vitest `deps_ssr/@hushbox_db.js` URL — the stale-optimizer class below, not an orphan row. Check which
  failure you actually have before attributing it here; an entry carrying the wrong cause is how a real
  failure gets excused.
- **A file on this list can still acquire a NEW, independent cause — check for a second one.** A1's audit
  found exactly this: `scripts/refresh-catalog-run.test.ts` is listed here for a _collection_ failure, so
  its tests never run, and A1's own change added an unrelated **typecheck** break in the same file that
  the listed entry masked. Being on this list makes a file's failures unattributable to you by default;
  it does not make the file invisible. If your change touches a listed file's domain, verify no second
  cause appeared — and remember typecheck reads files whose tests never execute.
- **Environment gotcha:** the bundler pre-bundles `@hushbox/shared`. After editing shared code,
  clear `node_modules/.vite` at the root and in `apps/api` / `apps/web` before trusting a test
  result.
- **`apps/api` `notifications/domain/templates/template-html.test.ts`** fails at HEAD — 7 snapshot
  failures over a removed Google-Fonts `<link>`, with both the template source and the `.snap`
  unmodified relative to HEAD. It belongs to the concurrent push/notifications workstream and
  needs an owner outside this run. Found while gating B1; it is the single `apps/api` failure a
  scoped run will show.
- **`pnpm lint:unused` (knip) reports two findings unrelated to this run.** Knip is whole-repo and
  noisy mid-run by design; it is a Phase 4 gate, not a per-task one.
- **`pnpm test:web` INTERMITTENTLY fails its per-file coverage gate on
  `apps/web/src/components/chat/message/markdown-renderer.tsx`** (branches 75% < 95%) even though all
  393 files pass. **Load-dependent, not deterministic** — one B1b auditor hit it and another did not,
  seeing web exit 0 at 98.8% branch. So a green web run does not disprove it and a red one does not
  prove it: **re-run in isolation before attributing anything to this entry**, and never excuse a
  coverage failure on a file your task touched by pointing here. **Not this run's** — orchestrator-verified: the component and its test are
  unmodified in the working tree, and `apps/web/vite.config.ts` is modified by the concurrent workstream.
  The component reports 100% branch coverage when run with only its own tests, so only the full-suite
  denominator differs — consistent with that config's streamdown transform. **This blocks any task
  that gates on `pnpm test:web`**, which is F1, E1–E3 and G2; judge those on the file list and the
  per-file numbers, not on the gate's exit code.
- **Five `apps/api` integration files time out on `model-catalog test lock: timed out acquiring`** under
  full-suite load — `models/domain/refresh.integration.test.ts`,
  `admin/routes-reads.integration.test.ts`, `admin/domain/operations/model.integration.test.ts`,
  `platform/dev/routes.integration.test.ts`, `chat/domain/media-turn.integration.test.ts`. **All five pass
  in isolation** (175 tests, exit 0), so it is shared-Redis test-lock contention, not a defect. Two traps:
  it is **load-dependent**, so its absence proves nothing; and it includes `refresh.integration.test.ts`,
  which is a **catalog-admission file**, so a task working near the model catalog will be tempted to
  attribute a real failure here. Re-run the file alone before attributing.
- **`npx turbo test --filter=@hushbox/api` SKIPS `ensure-stack`.** With the Docker stack down it
  yields roughly 176 of 466 red on `ECONNREFUSED` — phantom failures that look catastrophic and are
  entirely environmental. **Use `pnpm test:api`**, which runs through `scripts/with-env.ts` and starts
  the stack. Any agent reporting mass api failures should check this first, before attributing
  anything. (Found the hard way during B1's first cycle.)
- **`scripts/generate-env.test.ts` fails** on exactly three VAPID/notification secrets present in the
  generated output and absent from the test's expected string. It belongs to the concurrent
  push/notifications workstream and needs an owner outside this run.
- **A DURABLE CLAIM MUST BE BOUNDED, NOT MERELY TRUE.** This run produced the same defect four times: a true
  conclusion propped on a false stated mechanism. The test is **not** "is this true today?" but **"can this be
  falsified by a change in a file I am not editing?"** If yes, **a gate must hold it, or it must not be
  written** — verifying an unbounded claim harder does not bound it.

  **The discriminator is whether a gate would go red first, not whether the claim crosses files.** A cross-file
  claim is admissible in a comment when a test pins it, and inadmissible when the comment is the only
  enforcement. All four failures were **unpinned** claims: nothing anywhere would have gone red as they decayed.
  The counterexample that fixes the rule is in the same schema file — its `adminDisabledAt` comment asserts that
  no refresh write names that column in any set clause, which is unbounded by the test above, yet it earns its
  place because both directions are pinned in `refresh.integration.test.ts`, so an edit falsifying the comment
  reddens a gate before a reader is misled. So the instruction is not only "delete it": **pin it, and then the
  comment may point at it.**

  **A pin protects the behaviour, not the explanation, and the tell is the sentence's GRAMMAR.** The test above
  asks where a claim's truth-maker lives; that is not enough, because this run's sharpest instance was same file,
  same cycle, same author. A ceiling helper was inverted from tightest-sibling to widest, and the comment
  explaining the neighbouring assertion survived because **the assertion kept passing for a different reason** —
  nothing went red, and a name-grep would not have found it, because the comment never named the helper. It
  paraphrased its output. So the mechanical trigger is the grammar:

  - A comment that states **what another quantity IS** ("the shared cap is the tightest sibling's") is the
    **mirrored-constant ban in prose form** — two places holding one fact, free to drift, and CODE-RULES already
    bans that shape for code.
  - Rewrite it to state **what this code GUARANTEES, and where the mechanism lives** ("no node may carry a cap
    above its own bound; the clamp that guarantees it is applied where the cap is stamped"). An inversion
    elsewhere cannot falsify that, because it never quoted a current value.

  That form is checkable by reading one comment in isolation, which is what makes it enforceable. And because a
  green suite is no evidence the explanations hold, the re-read cannot be delegated to a test: **after your last
  edit, re-read every comment your diff touched against the final state of the code**, not the state you wrote it
  against — the same shape as the re-lint rule. All instances of this class so far were an inversion or relocation
  of a quantity with the comment left behind, never sloppiness about a fact the author never knew.

  Known blind spot: a claim that is a **policy** rather than a fact (a revisit trigger, a "should") is not
  falsifiable at all, so the bounding test does not flag it — only consequence 2 below catches that case.

  Two consequences, both learned the expensive way:
  1. Check a claim against **your own cycle's diff**, not the code you started from. One comment's revisit
     trigger was tripped by a sibling edit in the same cycle, so it told the next reader the condition was
     unmet at the moment its author made it met. Ruling 6 covers the cross-task case; this is the intra-cycle
     one.
  2. **Tightening the wording is not fixing the shape.** That same comment then failed twice more while being
     made more careful each time, because each pass verified the sentences instead of asking whether a comment
     could carry the claim at all. The fix was deleting the claim, not sharpening it.

- **`pnpm test:api` HIDES THE COVERAGE GATE WHENEVER ANY TEST FAILS — this applies to every task in this
  run.** Vitest never reaches the coverage report on a red run, so no threshold table prints at all. A red
  `test:api` therefore says **nothing** about coverage; it must never be read as "tests failed but coverage
  was fine". **Gate on a scoped `--coverage.include` run over the files you own** rather than on
  `test:api`'s exit code. This is not theoretical: it concealed a real 66%/75% shortfall in a new adapter
  from its own author, who found it only by running the scoped form.
- **BEFORE ATTRIBUTING A LOAD-DEPENDENT FAILURE AWAY, CHECK WHETHER YOUR OWN FIXTURE CAUSED IT.** Every other
  entry in this section trains you to attribute failures _outward_ — to this list, to load, to a concurrent
  workstream. This is the inverse case, and nothing else here covers it: **a fixture you just added can be the
  thing making the suite noisy.** One extra seeded catalog row shifted a shared percentile and produced 403s in
  tests its author never touched, across three of four full runs; the author's own green run was one draw of a
  variable its own fixture had made worse. So a green suite is not evidence your fixture is inert, and
  "load-dependent, therefore not mine" is only sound after you have checked that what you seeded is not the load.
  **The trigger, because "check" without one is an aspiration rather than a method:** if your diff adds or changes
  a fixture that writes to state another suite reads — a catalog row, a shared counter, anything behind a
  cross-suite lock — enumerate what else ranks or aggregates over that state before you attribute anything. The
  agent that found this instance said plainly that it only looked because an unrelated command happened to surface
  the evidence: "the check that found the crowding was luck, not method." This entry exists to remove the luck.
- **CLEARED 2026-07-27 — a foreign untracked rule file under `packages/config/arch/rules/` briefly broke
  `@hushbox/config` typecheck (repo read 15/16).** The concurrent workstream fixed it; the file is still present and
  repo typecheck is **16/16**, orchestrator-verified uncached. Kept as a cleared entry rather than deleted because
  three agents observed it differently within one hour and older reports cite 15/16 — that spread was a timing
  artifact, not a disagreement about the code.
- **One UNREPRODUCED sighting of the coverage-directory crash on `packages/shared`** — same shape as the api crash
  below (zero `FAIL` lines), seen once. An auditor then ran the shared suite four times across two cycles, two of
  them forced and uncached, plus two full web runs, and reproduced it **zero** times. So this is a single
  observation, **not** evidence the api entry generalises. Recorded at that strength deliberately: the orchestrator
  first wrote it up as a general hazard on the strength of one sighting, which is the same generalising-from-one
  error this section penalises elsewhere.
- **`pnpm test:api` CRASHES IN ITS COVERAGE MERGE on most attempts, with ZERO `FAIL` lines** — a known upstream
  Vitest bug with no fix. Three of five consecutive attempts crashed during one task. **A crash is not a test
  failure**: read the run for `FAIL` lines before concluding anything, and gate on a scoped run instead. One
  hypothesis is DISPROVED and recorded so nobody re-tests it: deleting `apps/api/coverage` between runs is **not**
  the trigger — a run that left the directory alone crashed anyway.
- **A CLEAN TASK'S AGENT CAN STILL RE-GATE, AND ON A SHARED GLOB IT WILL READ THE NEXT TASK'S WORK AS ITS OWN
  ENVIRONMENT.** The readiness rule releases a task's files when the task goes **clean** — but clean ends the
  _task_, not the _agent_, and a resumable implementer that re-runs a package suite in a directory the next task
  now owns will report that task's mid-flight state as a landed defect. This happened once here, on
  `packages/shared/src/affordability/**`, and produced a specific, four-way-attributed report of a 32% money
  under-reserve that was **not present in the tree** minutes later. Cost: one verification. Two consequences:
  **tell an implementer explicitly to stand down when its task goes clean**, and treat any red a stood-down agent
  reports in a glob the next task owns as transient until reproduced against the current tree.
- **Four more `apps/api` chat route tests now wipe `model_catalog`, and the cost is LOCK OCCUPANCY, not
  unlocked reads.** B4 generalised the file's pinned-catalog helper so the trial premium percentile is
  draw-independent rather than ranking against whatever the shared pool happens to hold. Verified: all six
  catalog-touching suites already hold the cross-suite lock across their reads, so there is **no
  unlocked-foreign-read hazard** — the wipes sit inside the same lock, by the same reentrancy path, as the
  pre-existing helper. What widening 4 → 8 wipe sites actually costs is four more critical sections that each span
  a full HTTP request, on a lock whose waiters abort at 12 s — i.e. the `model-catalog test lock: timed out
acquiring` entry above. Roughly a second of added occupancy per run of that file against a 12 s budget, measured
  clean; a contributor to look at if that timeout class worsens, not a correctness hazard.
- **Adding a file to `packages/shared` invalidates the api vitest pre-bundle.** Unrelated `apps/api` files
  then fail at **collection** on `deps_ssr/@hushbox_shared.js`. Run `rm -rf apps/api/node_modules/.vite`
  and re-run before attributing a collection failure to your own change. Distinct from the stale-optimizer
  URL-mangling entry above: this one a cache clear genuinely cures.

---

## Disposition of prior work

**Clean and unaffected — do not revisit:** catalog max-output ingestion · fee baking at
ingestion + descriptor v2 · estimator billable-only refactor · port billable conversion +
consumer deletion sweep · the fee-seam arch rule · output-cap bound · `GET /billing/spendable`
· hold-aware budget scopes · client served-numbers + nano cleanup · preview/send input parity ·
sender on billed rows · group budget lifecycle + guest denial · the fixture repair.
(Original T01–T10, T18, T19, T22.)

**Superseded by this plan — their landed code is a starting point, not a contract:**

| Original | What it shipped                                      | Superseded by                                                             |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| T11      | shared `turnEffortOptions` / `resolveEffortForModel` | **B2/B6** — becomes one dimension's registry entry                        |
| T12      | client union menu + picker greying                   | **E1** — surfaces render the produced sets; its held fix re-audit is moot |
| T13      | server effort resolution, static auto path deleted   | **B6/C3** — one resolver; multi-model auto now works                      |

**Never started, replaced entirely:** original T14–T17, T20, T21.

---

## Lane A — Catalog admission (independent, no dependencies)

### A1 — Restore the catalog price floor, age cutoff, and context exemption

**Objective:** a model that cannot be sold profitably never enters the catalog, and the
operator summary says how many were excluded and why.

**Design context.** §Catalog Admission is normative and states the rationale — **profit** —
which is the load-bearing part: this rule was previously deleted precisely because it shipped
without a recorded reason. The rules restore verified legacy behaviour: zero combined price is
excluded unconditionally and first; below `$0.0002` per 1K combined tokens on the **raw pre-fee**
rate is excluded; older than two years is excluded; a model in the top 5% of context length
(measured over the ZDR-filtered pool) is exempt from the floor **and** the age cutoff but never
from the zero-price check. Text models only — a per-token floor is meaningless for per-unit
media pricing and none is applied.

This is also load-bearing on the classifier: the engine is the cheapest priceable model, so
without the floor it resolves to a free model and the classifier reserve collapses to zero.

**Acceptance criteria:**

- Three new members of the closed exclusion-reason set: zero-priced, below-price-floor, too-old.
  They sit in the quiet-expected group (not the fail-closed group that warns), so the hourly
  refresh line counts and prints them with no extra instrumentation.
- The floor tests the **pre-fee** combined rate, evaluated before fee baking at the ingestion
  choke point.
- The top-context exemption is computed over the ZDR-filtered pool and applies to the floor and
  the age cutoff only. A test pins that a free model with the largest context in the fixture is
  still excluded.
- When a model fails both the floor and the age cutoff the reported reason is deterministic
  (price first), pinned by test so counts are stable across runs.
- New constants are named and exported from the constants module: the floor, the age limit, the
  context percentile.
- Fixture-level tests for each rule and each exemption path; a summary-formatting test showing
  the three reasons appear in the operator line.

- **The seeded catalog survives:** every model id referenced by seed data or E2E fixtures is still
  admitted, or those fixtures are updated in this task. Excluding models at ingestion changes what a
  seeded local catalog contains, and the scoped API/shared suites cannot see `scripts/` seeds or
  `e2e/` fixtures.

**Amendment (post-implementation) — an unowned gap this task exposed, and the numbers.**

**Live effect, measured 2026-07-26:** 184 excluded / 207 admitted → **209 excluded / 182 admitted**.
The 25 newly excluded are 1 zero-priced, 12 below the price floor, 12 too old; the arithmetic closes
both ways and no pre-existing reason's count moved. That is **~12% of the sellable catalog removed**,
which is the ruled intent (the floor's rationale is profit) but is worth stating as a product change
rather than a test result.

**THE GAP — needs a founder ruling, out of A1's ownership: nothing removes a catalog row that a newly
added admission rule now excludes.** Ingestion only writes; there is no prune path in the catalog
store. So the 25 models keep their persisted rows and **stay exposed to users**, because the exclusion
happens at ingestion and previously-ingested rows carry no exclusion marker. Consequence: A1 satisfies
its objective literally — those models never _enter_ — while the rule's purpose is defeated for every
model already there. This is pre-existing in mechanism (a model that vanishes from OpenRouter also keeps
its row) and was invisible until a rule started excluding models that previously passed.

**Two corrections from A1's audit, both of which shrink this problem.** The claim that the local dev
database is currently in that state is **not true** — it holds only 12 catalog rows, wiped by concurrent
test runs, so there is no local artefact and the gap is a production concern only. And more usefully,
**the "mark unsellable" option already exists in schema and code**: `modelCatalog.adminDisabledAt` with
`models/adapters/catalog-admin.ts`. So this is not the open-ended design question first described here —
the likely shape is an audited admin operation over an existing column, which satisfies the
Reversibility Iron Law for free. Deleting rows stays the option to avoid, since model ids are referenced
historically.

**A1 also broke `@hushbox/scripts` typecheck** — `scripts/refresh-catalog-run.test.ts` carries an
exhaustive reason map that now lacks `below-price-floor`, `too-old` and `zero-priced`. A1 edited
`scripts/refresh-catalog.test.ts` but not this near-identically-named sibling, and its self-gate ran a
**scoped** typecheck over `@hushbox/api` and `@hushbox/shared` only. Adding members to a closed set is a
contract change, so Global Constraint 10's repo-wide typecheck applied and would have caught it. Note
the trap: this file is on §Known Breakage for a _collection_ failure, so its tests never run — but
typecheck still reads it, and "the tests don't run" is not "the file can be ignored".

**A third disclosure, ruled: one residual seed reference stays.** `scripts/lib/seed-fixtures.ts:168,298`
carry `openai/gpt-4o` in `USAGE_MODELS` / `PUBLIC_TEXT_MODELS`, and gpt-4o is now `too-old`. A1's audit
verified independently that this is a **reference, not a dependency** — the public-stats store holds no
`modelCatalog` reference, the usage charts do no catalog lookup, and no spec asserts a model name — so
`db:seed` and the E2E run are unaffected. The criterion is met in purpose (nothing breaks) and unmet in
letter (a seed-referenced id is no longer admitted). **Ruling: accept it.** Correcting the id means
editing seed fixtures, which forces a regeneration of the seed-crypto cache — and that cache is already
dirty in the tree from an unrelated workstream, so the fix risks more than the cosmetic oddity of a dev
usage chart naming a model we no longer sell. Close-phase candidate if that cache is ever regenerated
deliberately.

**Two disclosures accepted as-is, recorded so they are not rediscovered.** The top-context exemption is
**inert on today's catalog** (threshold ~1,050,000 tokens over a 218-model pool; zero models rescued) —
correct per spec, but its green tests are not evidence it fires in production, so its value is
future-proofing and should be described that way. And the CI cassettes pin two now-unsellable models
(`openai/gpt-4o`, `openai/gpt-oss-20b`); not a break, since those tests hand-build descriptors and read
no catalog, but **the proven provider path is now a path for models we would never sell**, and changing
an id forces a re-record.

**Files:** `apps/api/src/slices/models/domain/normalize.ts` (language path + the exclusion-reason
set), the **money half** of the split constants (B1 owns the split — A1 runs after it), `scripts/`
seeds and `e2e/` fixtures if the criterion above requires, plus colocated tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; `turbo typecheck lint --filter=@hushbox/api --filter=@hushbox/shared`.
**Sensitive:** money — 2 independent auditors.

---

### A2 — Catalog exclusion is a soft delete (new, from ruling 1)

**Criterion 7 amendment — the durable record is the DECISION and the SCALE, and nothing else.** State that the
lifecycle columns carry no index and that the table's row count is in the low hundreds, which is the entire
justification. Then stop.

Do **not** enumerate which queries read or write the table, do not count call sites or venues, and do not phrase
a revisit trigger over query shapes. Those claims refer to code elsewhere, they multiply, and they go stale —
three consecutive audits each found a fresh falsehood inside exactly that elaboration while every one of them
confirmed the **decision** was sound. The last attempt was disproven by a comment in a file the same cycle had
open, and its own worked example (a cron staleness auditor) fell outside the request-path class the sentence
had just defined.

This is a correction of my own arbitration, not of the implementer's work. Criterion 7 asked for the row count
to be stated so a later reader sees a decision rather than an omission; I read that as "justify the decision in
the schema", and a justification of that shape is a standing proof about the whole codebase's query surface,
which a comment cannot carry. CODE-RULES already rules this: _a wrong comment is worse than no comment; if you
cannot state the durable fact precisely, leave it out._ If the row-count ceiling ever stops holding, the
decision gets revisited on that basis alone — which needs no enumeration to notice.

**Objective:** a model that becomes inadmissible stops being sellable without losing its row, and a model that
becomes admissible again returns with no human action.

**Design context.** Ruling 1 carries the full reasoning and the rejected alternatives — read it rather than
re-deriving. The short form: ingestion only writes, so A1's rules leave already-admitted rows sellable; and
`adminDisabledAt` must not be reused, because a **derived** state and an **asserted** one cannot share a column
without the refresh either overwriting a human's decision or trapping a model out permanently.

**Acceptance criteria:**

- New pgEnum `model_exclude_reason` over A1's existing `EXCLUDE_REASONS` — **sourced from that constant, never
  retyped**, so there is one authority and no second list to keep aligned.
- `excluded_reason` (nullable), `excluded_at`, `last_seen_at NOT NULL DEFAULT now()` on `model_catalog`; migration
  generated and committed with the schema change; the `packages/db` shape-test registry updated.
- **The refresh marks AND unmarks.** A row that becomes inadmissible gains its reason; a row that becomes
  admissible again has it cleared **without touching `adminDisabledAt`**. Pin both directions — the unmark is what
  makes this reversible by construction rather than a one-way trap.
- **Every exposure path filters `excluded_reason IS NULL AND admin_disabled_at IS NULL`.** Enumerate the paths
  repo-wide and pin one; a path that forgets the filter is the whole defect returning.
- Rows are **marked, never created** — nothing is written for a model that was never admissible, because several
  reasons exist precisely because the descriptor is unbuildable. Pinned.
- `last_seen_at` advances for every model in the live fetch, so a vanished model becomes detectable by staleness.
  **Acting** on staleness is out of scope; the column is not.
- **No index, deliberately** — state the row count and say so, so a later reader sees a decision rather than an
  omission.

**Files:** `packages/db/src/schema/{model-catalog,enums}.ts` + migration, `apps/api/src/slices/models/domain/{refresh,normalize}.ts`, `apps/api/src/slices/models/adapters/catalog-store.ts`, every exposure path, tests.
**Scoped checks:** `pnpm test:db`, `pnpm test:api`; migration drift gate; repo-wide `pnpm typecheck`.
**Sensitive:** money-adjacent, schema — 2 independent auditors.

---

## Lane B — The affordability module (the spine)

Strictly sequential: each task owns files the next one edits.

### B1 — Move the money math behind one barrel

**Objective:** relocate the closed money set into `packages/shared/src/affordability/`. **Behaviour
identity is the whole point of this task** — the wall is closed by B1b, not here.

**Design context.** §Where the Code Lives. Bounded directory rather than a workspace package is
settled and evidence-backed; the extraction trigger is recorded in that section — do not pre-empt it.

The closed set that must move together (leaving any behind creates a cycle): the estimate directory,
the smart-model directory, the billing directory, `money.ts`, `nano-usd.ts`, `tiers.ts`, `budget.ts`,
`fees.ts`, `pricing.ts`, `reasoning-effort.ts`, `model-descriptor.ts`, `modality.ts`, `param-spec.ts`,
the string-distance utility, and a split of `constants.ts` into money and non-money halves.
**Decide and report** whether `models/premium-check.ts` moves inside — it is premium classification,
a structural seam in §Where the Code Lives, and it imports the money set today.

**Do not** write the criterion "deep paths do not resolve from outside" — the package exports map has
no wildcard subpath, so that is **already true** and the criterion would be vacuous.

**Acceptance criteria:**

- The closed set relocated; a new narrow subpath entry in the exports map alongside the existing ones.
- No cycle: nothing inside the module imports a non-money shared module except through an enumerated
  allowlist, and that allowlist is written down in this task for B1b and G1 to enforce.
- `constants.ts` split with no re-export bridge (a bridge is laundering). Its colocated test splits
  with it — this is a permitted semantic test change and must be listed explicitly, because the rest
  of this task permits import-path edits only.
- The module imports no database or cache package.
- **Behaviour identity demonstrated, not asserted:** every package suite passes with no test file
  semantically modified beyond the `constants` split. List every touched test and why.

  **Restated after the content-free ruling — the original "543 exports before, 543 after" form is no
  longer the criterion, and must not be carried forward as one.** Moving the classifier's
  content-shaped functions out is a deliberate, ruled change to the export set: it now stands at
  540 on the root barrel and 140 on the module barrel. The criterion is therefore **identity except
  for an enumerated, justified delta**: every symbol added or removed is listed individually, each
  traced to the content-free ruling or to the sizing seam it created, and **every symbol that
  remains is unchanged in value and declaration**. That last clause is the part that still carries
  the task's weight — a changed rate or threshold hiding inside a legitimate count change is exactly
  what this criterion exists to catch, and a count comparison alone can no longer catch it.

  **Two permitted semantic test changes** beyond the `constants` split, both consequences of the
  ruling rather than of the move: the `constants` split itself, and two assertions in the
  classifier-prompt test that **became tautologies** once the overhead helper was reduced to
  `render(...).length`. The anti-drift property those two assertions carried must be shown to still
  exist somewhere — structurally plus a real identity test — and not merely to have been deleted
  because it stopped compiling. An auditor should verify the property, not the relocation.

- **Produce the `BILLING.md` path-diff** as a proposal (do not edit the doc): every path citation
  this move invalidates, with its replacement. There are roughly fourteen, across the Configuration
  Reference and the inline citations in Fee Structure, Storage Fees, the Funding Matrix, Model
  Classification, Tier derivation and New User Bonus.

**Files:** `packages/shared/src/**` (the closed set), every importer repo-wide, `packages/shared/package.json`.
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`; `pnpm lint:unused`.
**Sensitive:** money — 2 independent auditors.

**Amendment (post-implementation, before audit) — one accepted out-of-ownership edit.** B1 also
renamed paths inside `packages/config/eslint-extensions/{fee-seams.config.mjs, rules/fee-seams.mjs,
rules/fee-seams.test.mjs}`, which are G1's files. The rename was **forced**: the fee-seam allowlist
identifies files **by path**, so leaving it stale makes `pnpm lint` red. Path renames only; no rule
logic may change, and an auditor should verify exactly that rather than take it on trust.

**Correction to this amendment's original reasoning, from B1's audit.** It first claimed a stale
allowlist would "silently unhook fee protection from `money.ts`". That is **false**, and the
orchestrator relayed it from the implementer's raise without grounding it. `money.ts` _defines_
`applyMarkup*` and imports no fee helper, so its allowlist entry is never exercised; the real
consequence of a stale entry is a **loud** lint error at
`affordability/estimate/search-reservation.ts:15`, and a stale entry over-restricts rather than
under-protects. The deviation is still accepted — it was forced and it is verifiably path-only —
but on the correct grounds. Recorded because a wrong stated reason is what gets a guard deleted
later by someone who checks the reason and finds it hollow.

**Interfaces produced (consumed by B1b, B8 and G1):**

- **The import allowlist**, reported as: production imports into the module reduce to `zod` alone,
  enumerated over all 68 files. G1 rule 5 pins this membership.
- **G1 rule 1's inbox — 15 intra-package files repointed at exact moved paths** rather than the
  barrel, to keep the import graph byte-identical. **Corrected by B1's audit:** the first figures
  here (16 files, 12 of them "type-only") were wrong on both counts and the error was
  load-bearing. Exactly **one** reach is `import type` (`flow-executor.ts`); the rest are
  **runtime value imports** — `Modality` and `NanoUSD` are Zod schemas used as values
  (`z.array(Modality)`, `NanoUSD.refine(...)`), `CALL_SHAPE_FAMILIES` / `MODALITIES` are consts —
  and `packages/config/tsconfig.base.json:29` sets `verbatimModuleSyntax: true`, so each is
  emitted as a real runtime edge. **G1 must still decide whether a type-only reach counts as a
  barrel violation** — the plan does not pre-decide it — but it must decide knowing that a
  permit-type-only rule still leaves the value edges to repoint, which changes the very import
  graph B1 preserved and can move `apps/web`'s bundle shape.

  **Both auditors converged on 15 files and both found the symbol characterisation wrong, in
  different places.** Two further corrections from the second audit: `formatting.ts:6` reaches for
  `nanoUsdToFullDollarString` (a **money formatter**, not a general primitive) and
  `mock-directives.ts:3` for `CLASSIFIER_EFFORT_LEVELS` (the **effort dimension**) — so a carve-out
  written from the "general primitives only" framing would silently permit two value reaches into
  money proper. And **no intra-package file reaches for `ParamSpec` at all**, so it should not appear
  in the reached-symbol list. Because the two audits' counts do not agree in detail, **the figures
  above are not authoritative**: B1's fixer must derive the table fresh — one row per file, naming
  the exact symbol(s) and whether each import is value or type — and G1 consumes that table, not
  this paragraph.

  **AUTHORITATIVE RESULT — third derivation, independently reproduced row-for-row.** The fixer's
  table and a third auditor's independent derivation agree on all 15 rows, symbol-for-symbol and
  kind-for-kind. **G1 reads these numbers from here, not from the report**, because the report's
  _summary line_ tallies the root-barrel row inconsistently (counting `index.ts` as a value reach
  while excluding it from the type count) even though its table is right:
  - **15 files** reach into the module. Excluding the root barrel — which publishes rather than
    consumes — that is **13 with a value import and 3 carrying a type import**; including it,
    14 and 4.
  - **Exactly one reach is type-ONLY: `flow-executor.ts`.** So a rule that permits type-only reaches
    discharges precisely one file and leaves every other edge in place. That is the operative fact
    for G1's rule-1 decision, and it is unchanged across all three derivations.
  - Three reaches are into **money proper**, not general primitives: `formatting.ts`
    (`nanoUsdToFullDollarString`), `legal/terms-sections.ts` + `legal/legal.test.ts` (fee rates and
    the fee formatter), and `models/premium-check.ts` (pricing and the ceiling solver — the file B2
    moves inside, after which this reach disappears).
  - **`ParamSpec` is reached by nobody**; it appears only as a root-barrel re-export.
  - `constants.test.ts` is **not** a reach — it carries no `affordability/` specifier; its edit was
    the split.

- **A known G1 rule 2 collision, found in audit.** G1's "no `apps/web` code outside the named
  adapter hook imports an affordability symbol" rule **will trip on**
  `apps/web/src/components/chat/layout/capacity-bar.tsx`, whose only affordability symbols are
  `CAPACITY_RED_THRESHOLD` and its pair. Those two are in the money half only because
  `affordability/budget.ts:10,144` genuinely consumes one of them — they are otherwise pure UI
  thresholds. G1 must handle this deliberately (carve-out with a written reason, or a different home
  for the pair), not discover it as a lint failure.
- **The `constants.ts` split: 27 money / 28 non-money.** A1 adds its new constants to
  `affordability/constants.ts`.
- **The cross-workspace sweep found 158 money-symbol importer files across 9 workspaces needing
  zero edits**, because the root barrel is unchanged. That is precisely what leaves B1b's removal
  work real rather than cosmetic.

**Dispositions carried forward:**

- **`premium-check.ts` stays in `models/`.** Moving it is what creates a cycle:
  `premium-check → models/types.ts → schemas/api/models.ts → model-descriptor.ts`, and
  `model-descriptor.ts` is now inside the module. Audit-verified as real, with one nuance worth
  keeping: the first two hops are **type-only**, so this is a **directory-level** cycle
  (module → non-money → module), not a file-level runtime cycle. It still blocks the move, because
  admitting the file would require putting `models/types.ts` on the **inbound** allowlist. **B2 owns
  the revisit** — the cycle dissolves once `PriceableModel` exists and premium classification can be
  re-signed off it instead of `RawModel`.
- **G1 rule 4 has a known gap**, reported by B1 and unresolved: `isPremiumModel` performs
  `parseFloat(prompt) + parseFloat(completion)` against a threshold, which is rate arithmetic
  living outside the module — and float arithmetic on rates at that. G1 must either carve it out
  **with the reason written in the rule's docblock** or the file moves once B2 dissolves the cycle.
  Escalated to the founder as a design call; G1 must not invent a silent carve-out.
- **RULED: the two fee applications are NOT barrel seams, and `BILLING.md` is wrong, not the rule.**
  The fee-seam rule checks import specifier **paths**. A barrel that re-exported `applyMarkup` /
  `applyMarkupCeil` would give every consumer an allowed-looking path to fee application and turn the
  entire allowlist decorative — which is exactly what the star-launder guard exists to stop, and
  auditor A watched it fire on `export * from './money.js'`. So two mechanisms were being conflated:
  _what the module publishes_ (an export question) versus _which files may apply fees_ (a call-site
  question). The doc's barrel-seam list will lose the two fee applications and gain the reason fee
  application is enforced by path allowlist instead — without that reason written down, the next
  reader sees a documented seam that isn't exported, calls it an oversight, and "fixes" it, silently
  disabling the fee wall. **B8 therefore has no decision here**; the named structural seams it must
  export are the storage-fee function, tier and premium classification, the dimension registry as
  data, and money formatting.

- **RULED: the content-free guarantee is real, and the plan's closed set was wrong.** Global
  Constraint 6 and §Where the Code Lives say no export of this module accepts a prompt, a message or
  a history array — and `truncateForClassifier({ latestUserMessage, latestAssistantMessage })` plus
  `buildClassifierMessages(…)` make that false today. B1 followed the plan; the plan named "the
  smart-model directory" wholesale, which was the error. **The cut is the count/content seam:**
  `MAX_CLASSIFIER_CONTEXT_CHARS` and `computeClassifierPromptOverhead` **stay** — they are the
  quantity the classifier reserve prices, and pricing the cap rather than the realized text is what
  makes that reserve valid — while the two content-shaped functions **leave**. Neither has any
  in-module consumer, so nothing internal breaks. **B1's fixer performs the move**, rather than B6,
  because leaving it for B6 keeps Global Constraint 6 false across the whole B2–B5 spine, during
  which G1 cannot write the rule below and any new export could compound the breach. The fixer must
  **enumerate every consumer and place the functions at the narrowest location covering all of
  them** (CODE-RULES' One Implementation, Shared: hoist no further than the callers require) — and
  if the consumer set says the home should be `apps/api` rather than a shared package, report that
  rather than defaulting to shared.

- **The content-free ruling's premise was half-wrong, and the corrected seam is better than the one
  ruled.** Both the founder's ruling and this plan said neither moving function had an in-module
  consumer. That was true of `truncateForClassifier` and **false** of `buildClassifierMessages`:
  `computeClassifierPromptOverhead` — which the ruling keeps inside, correctly — rendered the prompt
  through it in order to count its characters. So the sizing function genuinely depends on the
  template, and the seam is not two-way but three:
  - the **template renderer** is content-free (options in, prompt string out) and is money's business,
    because the overhead _is_ its length;
  - the **excerpt injector** takes the user and assistant messages and leaves;
  - the **overhead counter** calls the renderer and returns a length, and stays.

  The fixer split it exactly there, exporting a new content-free `buildClassifierSystemPrompt` and
  moving only the wrapper. The two rejected alternatives were a second template implementation
  (banned outright) and moving a pricing input out of the module (which would have broken the
  reserve). **Orchestrator ruling on where the new symbol sits on the wall:** it is a **named
  structural seam**, alongside the storage-fee function and money formatting — not one of §The public
  surface's six feature exports. It must be exported because two consumers need one template, one
  inside the module (to size it) and one outside (to send it), which is One Implementation, Shared
  working as designed rather than a leak. B8 should additionally consider whether this is the symbol
  §The public surface already calls `renderOptions(options)` under another name; if so, the rename is
  cosmetic and B8's naming rule applies.

- **A standing-rule incident, verified and closed.** B1's fixer typed `git mv` once. It errored (the
  source was untracked), a `cp` fallback ran, and the fixer **self-reported it**. Independently
  verified by the orchestrator: `git diff --cached` is empty, and the reflog shows the only recent
  entry is the founder's own commit — no subagent operation mutated git state. Recorded because the
  rule is that no agent _runs_ such a command, not that none succeeds; the self-report is the correct
  behaviour and is why this could be checked at all.

- **Superseded B8 input (kept so the reasoning is not re-derived):** `affordability/index.ts`
  re-exports `money.ts` **by name** because the fee-seam rule
  forbids a star re-export, and `applyMarkup` / `applyMarkupCeil` are therefore **not** on the
  module barrel — while `BILLING.md` §Where the Code Lives lists "the two fee applications" as
  barrel seams. B8 must either add the barrel to the seam allowlist or leave those two root-only,
  and report which. B1 deliberately did not decide it.

### B1b — Close the export wall (removal half)

**Objective:** make §Where the Code Lives' "deliberately not exported" list true, using the
producers that exist **today**.

**Design context.** The leak is not deep imports — it is the root barrel. `packages/shared/src/index.ts`
`export *`s the whole money set, so `apps/web` imports `MINIMUM_OUTPUT_TOKENS`, `evaluateManifest`,
`planReasoning`, `priceRequest` and `turnEffortOptions` from the package root today, and an api module
re-exports a tier-ratio constant. Closing this **necessarily breaks consumers**, and repairing them is
this task's work — not a behaviour-identity violation to avoid.

**This task is deliberately the removal half only.** The six-export feature surface
(`getTurnOptions`, `chooseFrom`, `wireFor`, `renderOptions`, `resolveFunding`, `notices`) does not
exist yet — B3, B6, B7 and C1 build it. A criterion demanding the barrel expose "only the feature
surface" is therefore unsatisfiable at this position in the spine, and was corrected to this split
before dispatch. **B8 lands the surface** once its producers exist; consumers repaired here are
repointed at internal module paths in the interim, and B8 flips them onto the barrel.

**There are now TWO entry points, and closing only one leaves the wall fake.** B1 added
`"./affordability"` to the exports map, and the module barrel behind it `export *`s all eleven
units — so every symbol on the "deliberately not exported" list is currently reachable from every
workspace via `@hushbox/shared/affordability`, through an entry point that did not exist before this
run. B1's audit surfaced this: as originally written, B1b asserted absence from the **root** barrel
only, so it would have reported the wall closed while the subpath published the entire list. This
is not a B1 defect (behaviour identity required the root barrel keep working, and B1b was always
the closer) — it is a defect in B1b's criteria, corrected here before dispatch.

**Acceptance criteria:**

- Every symbol on §Where the Code Lives' not-exported list is **absent from BOTH barrels** — the
  root barrel and the `@hushbox/shared/affordability` subpath. One test per entry point, asserting
  absence symbol by symbol. A symbol absent from one and present in the other is a failure, not a
  partial pass.
- Each removed export is dispositioned one of three ways, enumerated per consumer: repointed at an
  internal module path (the interim state B8 closes), replaced by a producer that **already** exists,
  or its consumer deleted. A consumer repointed internally is listed explicitly as B8's inbox.
- No consumer outside the module references a rate, a manifest, a reducer, a ceiling solver, a tier
  ratio, the ladder, or the minimum-answer constant **through the root barrel**. Grep-clean, listed.

**Files:** `packages/shared/src/index.ts`, `packages/shared/src/affordability/index.ts`, every consumer the closure breaks, `packages/shared/package.json` (the interim subpaths — see the amendment), tests.
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`.
**Sensitive:** money — 2 independent auditors.

**Amendment (post-implementation) — what B1b actually delivers, stated plainly.** B1b **closed both
barrels and did not close the wall.** Those are different things and the difference must not be
glossed:

- The not-exported list is absent from the root barrel and from `@hushbox/shared/affordability`, twice
  asserted per entry point, watched red with positive controls. That criterion is met.
- But **38 walled symbols are consumed outside the module and producers exist for none of them** — the
  six-export feature surface is B3/B6/B7/C1 work. So "repoint the consumer at an internal module path",
  which this plan instructed, required those paths to _resolve_ from outside the package. They did not.
  B1b therefore added **14 interim per-unit subpath entries** to `packages/shared/package.json`.
- Consequence, recorded because it would otherwise read as a closed wall: **external consumers can
  still reach rates, manifests, reducers and ceiling solvers** — now through 14 named, enumerated,
  dated holes instead of an unbounded barrel. `BILLING.md` §What is enforced' "deep imports do not
  resolve" is **temporarily false for exactly those 14 paths**, and becomes true again when B8 deletes
  them.
- **Accepted**, on three grounds: the deviation is forced by this plan's own instruction; the entries
  are **per-unit, never per-directory** — a `./affordability/estimate` entry would have rebuilt the
  leak one entry point along, and the implementer chose correctly unprompted; and the alternative was
  to leave the barrel wide open until B8, making B1b worthless.
- **So B1b's real product is the enumeration**, and that is genuine value: B8 inherits a known
  28-file / 102-reference / 14-unit inbox instead of discovering it. Dispositions: 38 repointed
  internally, **0** replaced by an existing producer, 0 consumers deleted, and 29 walled symbols had no
  external consumer at all.
- Two structural choices worth keeping: `affordability/estimate/index.ts` and
  `affordability/smart-model/index.ts` are no longer directory barrels — the wall is expressed once at
  the sub-barrel level so both outer barrels inherit it. And `premium-check.ts` now reaches four walled
  units by relative path rather than one; **B2's move dissolves this**, which is why G1 no longer needs
  to rule on it.

**A second standing-rule incident, verified and closed.** A failed shell filter let B1b's mechanical
repoint edit five `/legacy/` files. Each diff was import-only; each was restored by writing back
`git show HEAD:<path>`; the implementer self-reported. Orchestrator-verified: `git status --porcelain
legacy/` is empty. No state-writing git command was run. This is the second incident in two cycles,
both self-reported and both harmless — the pattern to watch is mechanical repo-wide edits reaching
quarantined trees, not intent.

### B2 — The dimension registry

**Objective:** one registry entry describes a cost-affecting dimension completely; everything a
dimension author could get wrong about money is derived rather than declared.

**Design context.** §The Dimension Framework. `ParamSpec` is the **option domain** and must be
_consumed_, not extended: it is a `z.strictObject` persisted inside the jsonb descriptor, so it cannot
carry function fields, and a strict object rejects new keys. `DimensionSpec` is therefore a
non-persisted code registry that **references** a per-model `ParamSpec` for its option values — which
is what keeps option domains single-sourced without inventing a second one.

`PriceableModel` is the narrow projection the module consumes instead of the descriptor, so a new
catalog field cannot reshape money inputs.

**Acceptance criteria:**

- `DimensionSpec` and `PriceableModel` exist per §Data Structures. `DimensionSpec` reads its option
  values from the model's `ParamSpec`; a test pins that adding a value to the catalog spec changes the
  offered options with no registry edit. (Corrected after audit: **there is no per-model `ParamSpec` for
  effort** — ingestion seeds only `temperature`/`topP`/`maxOutputTokens`, and `reasoning` is a behaviour, so
  the effort vocabulary lives in `reasoning.supportedEfforts`. The criterion is met in substance: the option
  domain is a declared literal sourced from the single vocabulary constant with no second copy, and the
  per-model **offered** set is read from the catalog row. The literal reading applies to media dimensions,
  which do have ParamSpecs — see E4.)
- `DIMENSIONS` contains the model and effort entries. A non-enumerable dimension is **rejected when
  opened**; pinned. (Corrected after audit: "rejected at registration" was unsatisfiable as written —
  openness is not a declared field, correctly, since §Pinned or open makes it a property of what the user
  fixed rather than of the declaration. The structural property the criterion wants is that a
  non-enumerable dimension cannot reach a classifier, and that holds by construction when `openDimension()`
  is the only producer of the open form and it throws. **E4's "a continuous dimension is rejected if
  declared open" inherits the same reading** and is already satisfied by `enumerable: false`.)
- `deliversAtHoldCeiling: false` has a measurable effect: a multiplicative dimension's worst option
  determines the delivered ceiling even when the cheapest is chosen. Pinned — a declared field with no
  behaviour is a comment.
- Derived, with a test each: reserve contribution from resource + cost class; prompt section from the
  description plus option labels; answer parsing from option ids; the failure fallback as the cheapest
  presented option; whether a classifier is bought (≥2 **distinct resolved** requirements, not ≥2 labels).
- `resolution` is a two-value enum, not a callback. Property test: no resolution moves upward except
  the mandatory-reasoning carve-out.
- **One vocabulary per rung.** The id set contains no `none`; `Min` is the label for reasoning-off and
  `off` is its persisted value. Today three tokens exist for that rung (`none` as an id labelled `Min`,
  and `off` in the persistence design) — collapse them here, before D1 writes a column.
- The `medium` ↔ `Mid` mapping is single-sourced; no user-facing surface or classifier prompt emits an id.
- **The `moneyPerToken` contract, which B3 is the first consumer of — and it is not a multiplication.**
  B2's fix gives a rate-shaped requirement its own resource, and its audit established the part the
  orchestrator's ruling got wrong: **`nanoUsdPerToken × ceiling ≠ cost(m, ceiling)`**, because the input leg
  is **prompt-sized, not ceiling-sized**. So there is no arithmetic that converts the rate into a hold term.
  A consumer needing money must price `cost(m, ceiling(m))` per candidate **through the estimator** and take
  `MAX` over candidates for an open dimension, `Σ` for pinned siblings. The rate's only legitimate role is
  the **requirement's unit**. Treat any expression multiplying a `moneyPerToken` by a token count as a
  defect.

  **Correction — the earlier version of this contract was wrong, and the orchestrator wrote it.** It said
  the rate "is the balance- and prompt-independent candidate total order §Smart Model 1 mandates". It is
  not. §Smart Model 1 mandates a total order on **turn cost** with an **identifier tiebreak**, reproducible
  from the catalog and **the prompt size**; §Predicates fixes that quantity as
  `maxCallCost(m) = cost(m, min(providerCap(m), contextHeadroom(m)))`. Ordering by `inputRate + outputRate`
  is a **different order**: the input leg is prompt-weighted, the output leg carries storage, per-model caps
  differ (§Smart Model 3 says the outlier test deliberately catches an enormous-capacity model too), and a
  rate carries no tiebreak. The old sentence was also self-contradictory — a "prompt-independent" order
  cannot be the reason an order needs the prompt size. **Do not rank anything by rate on the strength of
  this contract.**

  **A second limit, stated honestly because the orchestrator overstated it to the founder:** the distinct
  kind makes a wrong consumption **unreachable by accident**, not unrepresentable. A deliberate
  `hold += c.nanoUsdPerToken` under the `moneyPerToken` arm still typechecks, because both arms carry raw
  `bigint`. That is the limit of what the ruling asked for.

- **Close the last link of the re-partition invariant, which B2 could not reach.** B2's suite pins that the
  partition pool is `maxB(m)` and that the ceiling is option-invariant, but the ceiling itself is a test
  constant there — so "the **priced** ceiling is derived from `maxB(m)`" is unpinned end to end until this
  task's producer exists. Pin it here, against the produced value rather than a fixture.
- **The re-partition invariant is pinned executably:** for every model and every presented option, the
  priced ceiling derived from `maxB(m)` is unchanged.
- **`premium-check.ts` moves into the module, re-signed off `PriceableModel`, and its float
  arithmetic dies with the move.** Ruled after B1's audit. Today the function does
  `parseFloat(prompt) + parseFloat(completion)` against a threshold — rate arithmetic outside the
  module _and_ float arithmetic on money, which CODE-RULES bans outright. The two defects have one
  root cause: **outside the module the function receives raw catalog rate strings, so it has to parse
  them.** Taking a `PriceableModel` — which carries bigint rates — makes the comparison a bigint
  comparison and removes the reason the `parseFloat` existed. B1 could not do this because
  `premium-check → models/types.ts → schemas/api/models.ts → model-descriptor.ts` is a
  directory-level cycle; defining `PriceableModel` here is what dissolves it. Pin the threshold
  boundary exactly: a model whose combined rate equals the threshold, and one a single nano either
  side, classify deterministically. **No G1 carve-out is to be written for this** — a permanent
  exception in a money rule bought to accommodate a temporary cycle is worse than the cycle, because
  a rule with one exception has arguments instead of a wall.

**Amendment (post-implementation) — a plan-scoping defect of mine, and one discovery that changes what
this task was for.**

**§B2's Files list could not satisfy its own criteria 6, 7 and 9, and its scoped checks (`test:shared`
only) understated the blast radius.** A vocabulary collapse over a union type necessarily reaches every
consumer of that union, and moving a file necessarily reaches its importers — so criteria that say
"collapse the three tokens" and "move `premium-check.ts`" cannot be honoured inside
`affordability/dimensions/**`. B2 was right to proceed and enumerate rather than stop. **The files it
reached that other tasks own, so those tasks are not surprised:**

- `apps/web/src/hooks/billing/use-prompt-budget.{ts,test.ts}` — **F1's**, one production line plus two
  test lines, forced by the union member's removal (a comparison against `'none'` becomes `TS2367`).
- `apps/api/src/slices/chat/{routes.ts,domain/turn-definition.ts,domain/turn-reasoning.ts}` + four chat
  tests — **B4's, then C3's, then E4's** per the ownership table.
- `apps/web/src/hooks/chat/use-reasoning-effort.{ts,test.ts}` and
  `reasoning-effort-menu.{tsx,test.tsx}` — **E1's**, including renaming the exported `offersEffortNone`
  to `offersEffortOff`.
- `packages/shared/src/models/premium-check.{ts,test.ts}` **deleted**, plus `models/index.ts` and
  `packages/shared/src/index.ts`.

**THE DISCOVERY: `premium-check.ts` had no production consumer, and the live premium classifier is a
different file with its own duplicated rules.** `apps/api/src/slices/models/domain/trial-eligibility.ts`
carries its **own** price quartile (`:33`), its **own** recency window (`:42`) and a trial-affordability
leg — and it is the one that actually runs. So the `parseFloat` fix this run prioritised was applied to
dead code, and the real One Implementation, Shared violation is still live and unowned. **Routed to B5**,
which owns eligibility predicates: decide whether `trial-eligibility.ts` collapses onto the moved
implementation or the moved implementation is deleted as redundant, and report which — do not leave two
premium classifiers.

**Confirmed and refined by B2's audit, which derived it independently rather than taking B2's word.** At
the time of the move the file's exports reached exactly two places: its own test and one re-export line —
and `exceedsTrialBudget` / `TRIAL_AFFORDABILITY_MULTIPLIER` were not even on that line. The live chain is
one hop longer than B2 reported: **`models/domain/tier-gate.ts`** holds the local `isPremiumModel`, and it
derives from `trial-eligibility.ts`, which carries `TRIAL_PRICE_PERCENTILE = 0.75` (`:33`),
`TRIAL_RECENCY_MS` = 182 days (`:42`) and its own affordability leg. Both halves of the discovery stand.

**A second, pre-existing contradiction for B5 to rule at the same time, since it is the same clause:** the
live trial gate **prices storage into the 1¢ cap** (`trial-eligibility.ts:23-25,194-201`), contradicting
§Cost and §Trial Usage — "Trial never persists", so no storage term. That is precisely the clause the moved
function was corrected against, so ruling one without the other would leave the two implementations
disagreeing for a new reason after being collapsed for the old one.

**Two pre-existing money defects the move exposed and fixed, neither with a live consumer:**
`exceedsTrialBudget` fed the estimator **raw pre-fee rates** while its docblock claimed the core applies
markup (it does not), under-pricing by 15%; and `isPremiumModel` called `Date.now()` inside a module
documented clock-free. Recorded because both would have been real defects the moment a consumer appeared.

**Open items handed forward:** `exceedsTrialBudget` / `TRIAL_AFFORDABILITY_MULTIPLIER` are newly on both
barrels and need **B8's** disposition ruling, like `estimateOk`/`estimateErr`; `dimensions/index.ts`
publishes the registry and types only, with the derivations behind the wall, which **B8 must confirm
rather than assume**; and **E4 must know `PriceableModel` has no `parameters` field**, so media dimensions
cannot reach a per-model `ParamSpec` through it — effort reads `reasoning` instead, so B2 needed none.

**Criterion 2 was met by interpretation, not literally, and the auditor must judge it:** openness is not
a declared field, so "a non-enumerable dimension declared open is rejected at registration" is discharged
by `openDimension()` throwing and `OpenDimension` being obtainable nowhere else.

**Criterion 7 is deliberately incomplete and that is correct:** the live classifier prompt still prints
`low, medium, high` from the hardcoded triple in `smart-model/effort-dimension.ts:18`
(`smart-model/prompts.ts:72,74,84,88`). Deleting that triple is **B6's own named criterion**; B2 built
`renderDimensionSection` as the producer B6 consumes and did not pre-empt it.

**Files:** `packages/shared/src/affordability/dimensions/**`, `reasoning-effort.ts` (vocabulary), tests.
**Scoped checks:** `pnpm test:shared`; typecheck/lint shared.
**Sensitive:** money — 2 independent auditors.

### B3 — `getTurnOptions`: one producer, two sets

**Objective:** the single mint, and the arithmetic vocabulary the specification defines.

**Design context.** §Affordability (the four notions, principles 1–11), §Math & Terms, §Data
Structures. One entry point evaluating one pure core twice — against `effectiveBalance` for
`affordable`, against `spendable` for `admissible`. The pair **derives the reason**: outside
`affordable` is money, inside `affordable` but outside `admissible` is a hold.

**The ruled call pattern — build exactly this.** `getTurnOptions(funding, basis, selection)` is called
**once**, with the composed basis, and internally evaluates one pure core over two `(funding, basis)`
pairs: `(effectiveBalance, EMPTY_BASIS)` → `affordable`, `(spendable, basis)` → `admissible`. **The
producer substitutes the empty basis itself; no caller ever supplies one.** This was ruled after the
review found three `BILLING.md` statements disagreeing on the pattern — the alternative (callers make
two calls with different bases) leaves the real-basis call returning a prompt-dependent `affordable`
that the type's own doc comment invites surfaces to grey from, which §Scope forbids. Under the ruled
shape that state is unobtainable rather than merely discouraged.

`holdNanoUsd` lives on `TurnOptions`, **not** on `OptionSet` — a hold is only ever taken against
`spendable`, so an affordable-side hold is a value with no meaning and must not be representable.

**Acceptance criteria:**

- `TurnOptions` returns the pair plus `holdNanoUsd`; `OptionSet` carries `runnable: NonEmpty` beside
  `all` and **no hold field**, so sendable-with-nothing-runnable and an affordable-side hold are both
  compile errors to write.
- **One call, two evaluations:** a test spies the core and asserts it ran exactly twice per call, with
  the empty basis on the `affordable` pass. No exported signature accepts a basis for `affordable`.
- `PromptBasis` carries components with the total derived. `Selection` requires ≥1 answer source.
- Options are **marked, never filtered**; a test asserts no code path removes an entry.
- `admissible ⊆ affordable` as a property test over generated funding/prompt/selection triples. The
  property must hold across **both** differing inputs, since the sets differ in funding _and_ basis.
- **ONE derivation must feed all four presented-set readings — this is a criteria change, not another fix.**
  Three consecutive audits found three defects in one family, and the family is the point: B3's producer
  computes **four** views of "what is presented or possible" — per-row availability, the turn-level dimension
  union, sendability, and the hold's `MAX` domain — and **nothing structurally forces them to agree**. The three
  instances were (1) per-row grading read off a funding-dependent arrangement so `admissible ⊄ affordable` at
  option level; (2) the presented candidate set and the hold domain being different sets neither containing the
  other, a ≈34% under-reserve; (3) `mergeTurnOption` **OR**-ing the turn-level effort union over **pinned**
  siblings where §Turn Stories 2.1 requires an **AND** — so the menu marks a rung available at every balance
  while pinning that rung is unsendable, §Reasoning Effort 3's forbidden shape.
  **Requirement: derive all four from one place, so agreement is structural rather than asserted** — the
  correct rule for the union being **AND over pinned siblings, OR over runnable candidates** — and pin
  **pairwise agreement** as a property, not a spot check. Fixing instance 3 alone would leave the fourth
  instance to be found by whoever reads this code next.
- **The hold must cover every arrangement a PRESENTED candidate can create.** Added after B3's audit found the
  two sets are different and neither contains the other: a candidate's entry is graded on the candidate alone,
  while `viableCandidates` requires **every sibling of its arrangement** to fit — so a candidate whose
  arrangement starves a pinned sibling is **presented as runnable** yet **excluded from the hold's MAX**.
  Measured overrun: a placed hold of 89,263,685n against a presented arrangement pricing at ≥ 119,934,700n —
  **≈34% more than admission reserved** — reproduced 599 times under an explicit pin and 75 times on Auto.
  §Affordability names this exact failure: "the hold … must cover the worst option the classifier can pick …
  This is the one place where using the wrong set is a money defect." **Make the two sets one** — preferably by
  excluding a candidate from `runnable` when its own arrangement is not viable, which also restores §Story
  1.3's "pinned siblings are a hard gate" — and pin the property directly: **the hold is ≥ the priced total of
  every arrangement a presented candidate can create.**
- **Completeness:** `presented == feasible` over every model × option assignment, over the
  `admissible` set. The fixture must be non-degenerate — **≥3 models, ≥2 dimensions, one
  mandatory-reasoning model, one plateau-collapsed pair** — because one model with one option
  satisfies the words otherwise.
- **The floor is prompt-independent and hold-blind:** a keystroke sweep leaves `affordable`
  byte-identical, while a pin, a sibling change or a modality change alters it. Both pinned.
- **The arithmetic vocabulary exists as named exports and every call site uses it:** `variableRate(m)`
  (output rate plus per-token storage when the turn persists, bare output rate when it does not),
  `fixedCosts` (input tokens at rate, `inputStorage`, `classifierReserve` when a classifier runs, plus
  any additive dimension). Pinned **by amount**, not by structure.
- **Storage drops on non-persisting turns:** a trial result contains zero storage line items in both
  legs, and the classifier leg carries none on any tier.
- **Inverted output-storage ratios** (paid 2, others 4) with every division rounding against the user;
  pinned on a paid/free pair with identical character counts.
- **Cache reads price at the full input rate**; pinned.
- **The "10 × $0.005" web-search figure in these criteria is the PROVIDER amount, not the billable one.**
  B3's audit settled the reading against §Units and rates ("billable rate — the only rate that exists in any
  calculation"): the pinned 172,500,000n on three models is the billable equivalent, 57,500,000n per model,
  with markup baked at definition in `estimate/search-reservation.ts` — a file **byte-identical to
  content-unchanged by this run** (the relocation is a pure rename), so the markup baking is pre-existing
  rather than introduced. Recorded so nobody "corrects" the billable figure back
  to the provider one.
- **`estimateTokenCount` — RESOLVED by B3, and both halves of the orchestrator's premise were wrong.**
  It was a duplicated **constant**, not a duplicated question: the money-path reservation and a marketing
  illustration, now collapsed onto `CHARS_PER_TOKEN_STANDARD`, and the function changed to take a **char
  count** (it accepted content inside a content-free module). No number moved. The two premise errors, kept
  so they are not re-derived: the `apps/web` hazard is **not live** — nothing imports `lib/tokens` at all —
  and **for a paid user both ratios are already 4**. The "/4 versus /2" concern conflated **input
  estimation** (paid = 4 chars/token) with **output-storage** estimation (the inverted paid = 2), which are
  different terms. Superseded original:
  **~~hardcoded `/4` may be a second implementation of the tier conversion — collapse it if so~~** Named by B1's audit.
  `affordability/pricing.ts:8` divides by a fixed 4, while the vocabulary above converts through
  `outputCharsPerTokenForTier` (**2 for paid, 4 for others**). If both answer "how many tokens is this
  many characters", they are one function with two implementations and the paid tier disagrees with
  itself — a One Implementation, Shared violation, not a rounding difference. **The client consequence
  is the reason this is B3's and not a cleanup item:** its callers are
  `apps/marketing/src/lib/calculate-cost.ts:49-50` and **`apps/web/src/lib/tokens.ts:13`**, so a
  paid user's client could size a turn at `/4` while the server sizes at `/2` — the "one verdict, two
  renderers" failure this run exists to end. Report the finding either way; if they are genuinely
  different questions, say what each one is for.
- **Web search reserves 10 × $0.005 × model count**; pinned by amount on a three-model turn.
- Pure: no clock, no I/O, no randomness — asserted structurally, not by comment.
- **`RefusalCode` and per-model `Availability.reason` must cover the tier/premium/trial-quota axis, not only
  feasibility.** B3's audit found the enum complete and reachable on the ceiling axis and short elsewhere:
  **E1** needs a per-model reason for a premium lock (its criterion is that premium rows are _marked_, not
  removed) and **B7** must collapse three live premium-locked phrasings (`PREMIUM_REQUIRES_ACCOUNT`,
  `MODEL_TIER_LOCKED`, `TRIAL_MESSAGE_TOO_EXPENSIVE`). A bounded enum extension per §Extending → Add a refusal
  reason — cheap here, a day-one rework for two later tasks if left.

**Amendment (post-clean) — NEW SCOPE, ruled: a pinned row carries no `dimensions` list.** B3's last cycle
established that no type-level change was _needed_ to state the two-kinds-of-row rule, and then answered the
better question: whether one is _wanted_. A `kind` discriminator would **not** make the rule structural — a
consumer can still read a pinned row's `dimensions`. **The change that would: a pinned row carries its blocking
reason and no `dimensions` list at all, so consuming an own-fit diagnosis as a decision becomes a compile
error.**

**Ruled: do it, and do it now.** Three of the five defects in the presented-set family came from exactly this
class — an agreement guarded by prose rather than by structure — and this is the last such guard left in the
producer. It is also the founder's stated standard: structural impossibility over convention. **Timing is the
whole reason it is ruled here rather than deferred:** `ModelEntry` is consumed by B6, B7, E1 and E4, **none of
which is built yet**, and B3's implementer flagged it precisely as "decide before E1 builds against the current
shape, not after". Every cycle of delay adds a consumer to retrofit.

Shape: a candidate row is arrangement-graded and decision-bearing and carries `dimensions`; a pinned row carries
`availability` with its reason and **no** `dimensions`. §Data Structures joins the founder's doc batch. This is
new scope from a ruling, **not** a fix cycle — B3's criteria are met and it is clean.

**Amendment (post-implementation) — a ruling on the `OptionSet` union's unsendable arm.** B3's audit found a
consequence of the shape this plan approved: on the `sendable: false` arm an `OptionSet` carries **no
entries**, so a zero-balance payer's picker has **no rows to grey and no per-row reasons to show** — even
though notion 1 exists precisely to grey them. B3 implemented the documented union faithfully; the union is
wrong. It contradicts the standing product rule, which is _grey_ what the user cannot afford, not _hide_ it.

**Ruling: `all` and `turnDimensions` move to BOTH arms; only `runnable` stays exclusive to the sendable one.**
That keeps "sendable with nothing runnable" unrepresentable — the property the `NonEmpty` was added for —
while making an unsendable set still renderable as a fully-greyed picker with reasons. §Data Structures needs
the same correction, so it joins the founder's doc batch.

**Amendment (post-implementation) — an orchestrator ruling on the vocabulary's relationship to the
estimator.** B3's arithmetic audit found `turn-arithmetic.ts`'s `costNanoUsd`, `feasible` and `eligible` have
**no production call site**: `turn-core.ts` re-derives `cost(m, ceiling(m))` through the estimator fold and
**inlines the `feasible` formula three times**, while a test exists to prove the two `cost` implementations
agree — **the golden cross-check CODE-RULES names as the banned artifact.** There is no live divergence (a
4,500-case differential sweep confirms the amounts are identical), so this is a design question, and the
ruling is:

**The vocabulary is the single home for the PREDICATES; the estimator is the single home for PRICING.**
`turn-core` must **call** `feasible()`/`eligible()` rather than inline them — deleting three copies of one
formula — and `costNanoUsd` must **delegate** to the estimator rather than reimplement it. Then the agreement
test has nothing to compare and is deleted with it. This satisfies both constraints that were pulling apart:
§Math's terms keep named homes (this task's criterion), and pricing keeps exactly one implementation
(CODE-RULES). A named function that merely _agrees_ with the real one is the duplication the rule forbids,
and its agreement test is the smell the rule names.

**Files:** `packages/shared/src/affordability/turn-options.ts` and the pricing internals it composes, tests.
**Scoped checks:** `pnpm test:shared`; typecheck/lint shared.
**Sensitive:** money — 2 independent auditors.

### B4 — The shared-budget solve

**Scope reduced by B3 (post-implementation).** B3 implemented the shared-token solve itself, because the
§Math vocabulary is incoherent without it — with the charge basis correctly `Σᵢ cost(mᵢ, ceiling(mᵢ))`, never
`T × Σrates`. **What remains here is untouched and still required:** the heterogeneous-sibling-pair pin, the
cross-verification against `createEstimateRun` on a compiled definition, and deletion of the summed-rate
guess (`turnMaxOutputTokens` / `answerMaxOutputTokens`) — **not** `fitAnswerCapToCeiling`, which is the
reconciliation, per the correction block below.

**Objective:** N siblings sharing one funding number get one shared token count and per-model physical
ceilings.

**Design context.** §Math & Terms → Sharing one budget across siblings. `T` is a **solve variable**;
the **priced basis is `Σᵢ cost(mᵢ, ceiling(mᵢ))`** with each ceiling clamped by its own bounds. Those
are different things and the distinction is load-bearing: §Multi-Model 2 forbids a summed-rate
approximation over a single shared token count as a _basis_, so computing the hold as `T × Σrates`
would violate the specification while looking like it satisfies this task.

**Correction to earlier planning — read this before touching code.** `fitAnswerCapToCeiling`
(`turn-definition.ts:440`) is **not** a second estimator and must **not** be deleted. Its docblock
records the opposite: it calls the canonical `createEstimateRun` precisely to eliminate a second cost
formula, because the per-rate guess applies markup per rate while admission applies it to the subtotal,
and that drift caused live 402 refusals. **The thing to delete is the guess** — the summed-rate answer
cap sizing (`turnMaxOutputTokens` / `answerMaxOutputTokens`) that the fit exists to reconcile.

**Acceptance criteria:**

- `T` solved once per turn; each sibling's ceiling applies its own `providerCap` and `contextHeadroom`.
  Pinned on a heterogeneous pair: the large-context sibling is **not** capped by the small one.
- The reserved amount is `Σᵢ cost(mᵢ, ceiling(mᵢ))`, never `T × Σrates`. Pinned by amount.
- **Verified against the admission estimator, not the module's own cost function:** for every generated
  turn, `createEstimateRun(compiled definition) ≤ funding`. A property test over the module's
  arithmetic alone would miss the integer-nano markup drift that caused the historical 402s.
- `inputStorage` appears **exactly once** in a three-sibling hold; pinned by amount.
- A smart slot's `MAX` over candidates enters the `T` solve; pinned.
- The summed-rate guess is deleted; grep-clean. The fit survives.
- The duplicated value-store byte-budget constant is hoisted to one home and its "MUST stay in sync"
  comment removed with it. The _other_ such comment in that file documents a genuine dual guard and is
  **out of scope** — do not delete it.
- **B3's existing money pins stay green exactly as written.** B3 already pins holds BY AMOUNT — the
  three-sibling `inputStorage`-once figure, the heterogeneous money-bound pair, the smart-slot `MAX`. B4 is
  a verification-and-deletion task on top of a solve that already exists, so **no hold should move**. If one
  of those pins goes red, that is a finding to report — never a pin to update so it matches new behaviour.
  A hold that moves during B4 is either a regression or a discovery about the estimator, and both need the
  orchestrator, not a rewritten expectation.

**Files:** `packages/shared/src/affordability/**`, `apps/api/src/slices/chat/domain/turn-definition.ts`, `apps/api/src/slices/models/domain/estimate-run.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; typecheck/lint both.
**Sensitive:** money — 2 independent auditors.

### B5 — Outlier exclusion and resolved-corner eligibility

**FIX-CYCLE RULINGS 2026-07-27, after B5 reported two items rather than shipping them. Both calls go B5's way.**

**(a) The trial-gate storage strip ships, and the one-line hole is closed with it.** B5 measured the hazard
precisely rather than accepting my framing: the gate must dominate the compiled turn floor, and it fails past
input ≈32.5× output **today** (a pre-existing gap) and past ≈1.25× after the strip. That is the inverted-rate
shape B4's audit predicted, now quantified. Closing it needs `chat/routes.ts` to pass `promptCharacterCount`
into the gate — a value already computed fourteen lines above the call site. **Ownership extended to that one
line only**; the file otherwise belongs to lane C. Ship the strip and the line together: neither alone is
correct, since the strip without the line widens a hole and the line without the strip leaves storage inflating
trial cost.

**(b) The classifier-storage strip is ONE EDIT — delete the emitter — and B5's answer beat my ruling.** I ruled
it atomic across three sites. B5 found a **fourth** fold (`models/domain/trial-smart-model-candidates.ts`, which
sums reserve items generically and therefore cannot be fixed by a `kind === 'provider'` filter at all), and the
correct conclusion: **stopping the emitter in `estimate/classifier-line-item.ts` makes all four folds no-ops
simultaneously.** That is the safe direction an earlier investigation identified — every folder degrades through
`find(kind === 'storage') → undefined → 0n` — and it needs no cross-task ownership. Delete the emitter, its
now-dead storage computation and parameter, and the assertions that pin the item's presence. Leave the folds as
dead reads for whoever cleans them; do **not** subtract a storage number anywhere.

**Routed to B8, not B5: premium marking needs a signature change.** The exact field set is `releasedAtMs` on
`PriceableModel` plus `nowMs` on the producer's input, because the money core reads no clock. The second changes
`getTurnOptions`' documented signature, which is B8's surface to land and document. Until it lands, E1's
"premium rows are MARKED, not removed" has no data to mark with — B8 must therefore treat this as blocking E1,
not as a nicety. `trial_message_cap_exceeded` is already wired.

**RULED 2026-07-26 — the mandatory-single-rung model gets ONE PRICEABLE RUNG.** `offeredLevels` currently returns
an empty list for a model whose reasoning is mandatory with one native level, so `e_min(m)` is `undefined`,
`maxB(m)` is 0, and eligibility grades that model at a 1,000-token floor — while the provider spends its whole cap
thinking. That sells a paid, contentless answer. It is live: `openai/gpt-5-pro`, `openai/o4-mini-high` and
`openai/o3-mini-high` all carry the shape and all three pass catalog admission (verified against the live API:
ages within the cutoff, combined rates far above the floor).

Delete the early return that empties the list. The single rung becomes an ordinary one-option set, so `e_min(m)`
is total as §Math already defines it ("otherwise its lowest offered level — a mandatory-reasoning model's cheapest
option is not free"), and §Affordability's "never on an unreachable zero" stops being violated. `docs/BILLING.md`'s
"offers no choice" clause is already corrected to match; **the shipped comments citing it are yours to correct in
this task** — they are at `turn-core.ts` and `estimate/effort-options.ts`, and under this ruling they are wrong as
written.

Expected and correct consequences, not regressions: a solo `High` rung appears where the menu was empty; the wire
carries an explicit effort instead of silence; `maxTokens` becomes `B + H`; and these three models' floors rise
roughly thirty-fold, which is the honest floor. A hold may rise on a multi-model turn by about one classifier
reserve, because the union gains a rung — that direction is safe. Rejected: a pricing-only second view of the
ladder, because it institutionalises the priced-vs-presented fork B3 spent three cycles deleting.

**OWNERSHIP EXTENSION (ruled with it).** Two test files outside the Files list carry expectations this ruling
inverts and must be updated here rather than left red for a later task:
`apps/api/src/slices/chat/domain/turn-reasoning.test.ts` and
`apps/api/src/slices/chat/domain/smart-model-turn.test.ts`. Production code in those files needs no edit. Nothing
else outside the list.

**RULED — THE CLASSIFIER-STORAGE STRIP IS YOURS, ATOMICALLY, AND THE PLAN'S SPLIT WAS UNSAFE.** An earlier note
assigned the emitting site to B6 and the folding site to B5. In the spine's actual order that is the one unsafe
sequence: removing a fold while the emitter still emits, and while
`apps/api/src/slices/models/domain/estimate-run.ts` still folds the term into the **real admission hold**, makes
candidate caps grow against a hold that still carries the term — `hold > effectiveBalance` at the balance edge,
which is precisely the storage-edge affordable-then-402 the term exists to prevent.

So: either strip it **atomically** — the emitter in `estimate/classifier-line-item.ts`, the shared fold in
`estimate/smart-model-affordability.ts`, and `estimate-run.ts`'s fold, in one change — or **touch none of it** and
say so, leaving the whole item to B6. `estimate-run.ts` is added to your Files list for this purpose only
(its previous owner is complete). Remove the term by **positively selecting `kind === 'provider'`**, the pattern
B3 already documents as load-bearing in `turn-core.ts`; never by subtracting a separately computed storage number,
which double-subtracts and under-reserves. Note this is a DIFFERENT item from ruling 5's trial-gate storage strip
— do not conflate them in one change.

**Added criterion, from B4's audit — ruling 5's storage strip NARROWS A MARGIN B4 CURRENTLY RELIES ON.** This is
the one item in B5 that can open a money hole rather than close one, so it is stated before the rest.

`reconcileAnswerCeiling` fits rather than refuses — it drops `withinFunds`. So on the **reasoning-free trial
path** the only thing that refuses an over-cap turn is the separate trial eligibility gate. Today that gate is
strictly stricter than the fit's floor (it prices 2,000 output tokens **plus storage**, against the fit floor's
1,000 tokens storage-free), which is why a 3,000-configuration sweep found **zero** escapes.

When B5 strips storage from that gate, the margin narrows to `2000 × outputRate` against the fit floor's
`≈805 × inputRate + 1000 × outputRate` — the 805 being the system prompt the gate does not price but the turn
does. Measured: safe at **0 of 3,000** wherever `outputRate ≥ 2 × inputRate`, but **5 of 3,000 for inverted rate
shapes** (input dearer than output).

So B5 must show that after the strip, the trial gate still refuses **everything the fit would admit above the 1¢
per-message ceiling**, and the demonstration must include an **inverted rate shape** — not only the realistic
`outputRate ≥ 2 × inputRate` catalog. A sweep over realistic shapes alone would report zero escapes and prove
nothing about the case that fails. If no gate placement can close it, say so rather than shipping the strip: the
alternative is restoring a funds check to the fit for the unstamped path, which is a B4-area change and needs a
ruling, not a choice.

**Objective:** a high-cost outlier cannot tax every other candidate's ceiling, and eligibility is
graded on the corner a model can actually reach.

**Design context.** §Smart Model 1–3, §Predicates. The hold is a `MAX` over the pool, so one extreme
candidate sets the hold for every turn the pool appears in. The median is taken over the **priceable
catalog pool** — not the eligible pool, which would make the test balance-dependent.

**Acceptance criteria:**

- `outlier(m)` as specified. Balance-independence pinned: same catalog and prompt yield the same
  exclusion set at two different balances.
- Excluded models remain explicitly selectable; pinned.
- **`eligible(m)` grades on `B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS`, never on an unreachable zero.**
  Pinned on a mandatory-reasoning model whose ceiling fits the minimum answer but not the minimum
  answer plus its lowest rung — it must be excluded.
- Deterministic total order on the catalog read with an identifier tiebreak; a test pins that row order
  cannot change which model classifies.
- **The order's BASIS is turn cost, not summed rates — and the live code gets this wrong today.**
  `estimate/smart-model-affordability.ts:107-120` sorts the pool by `inputRate + outputRate`, **tiebreak-free**,
  while §Smart Model 1 mandates an order on turn cost and §Predicates fixes the quantity as `maxCallCost(m)`.
  These are genuinely different orders (the input leg is prompt-weighted, the output leg carries storage, and
  per-model caps differ — which is why §Smart Model 3 says the outlier test must also catch an
  enormous-capacity model). Found by B2's audit; pre-existing, not B2's. **The spec decides this, so no
  founder ruling is pending:** order on `maxCallCost` with the identifier tiebreak, and pin that a
  rate-ranked pool and a cost-ranked pool disagree on a real catalog pair — otherwise the two orders are
  indistinguishable in test and the wrong one survives.
- **But the ENGINE choice must stay basis-independent, and that is a different question from pool order.**
  B3 raised this and it refines the criterion above rather than contradicting it: `maxCallCost` depends on
  `contextHeadroom`, hence on the prompt. `affordable` is evaluated at an **empty** basis and `admissible` at
  the real one — so choosing the **classifier engine** by a prompt-weighted quantity lets the two sets pick
  **different engines**, hence different classifier reserves, and **`admissible ⊆ affordable` can break.**
  B3 uses combined rate plus an id tiebreak for the engine precisely to stay basis-independent. So:
  **pool order on `maxCallCost`; engine choice on a prompt-independent quantity with the id tiebreak.** Two
  agents gave partially conflicting ordering advice here and this is the resolution — they were describing
  different decisions.
- **Your resolved-corner criterion is UNSATISFIABLE for one model shape without a B2 contract change.** B3's
  audit measured it: for a **mandatory-single-rung** model, `dimensionSupportFor` exposes **no** rung
  (`options: []`, `maxReasoningBudgetTokens` = 0), so the producer can only grade it on
  `MINIMUM_OUTPUT_TOKENS` — grading on the unreachable zero this criterion exists to forbid. The evidence is a
  pair with identical rates: a one-native-level model is **sendable at a 3,343-token ceiling** while a
  three-level model is correctly **refused** at the same funding, because only the latter's `B(low)+MIN` is
  graded. **The single mandatory level must become priceable before `eligible(m)` can grade on
  `B(m, e_min(m))`** — that is a B2 shape question, so report it rather than working around it. Pre-existing on
  the Auto path, not introduced by B3.
- **Nothing produces the premium/tier refusal reasons yet, and E1 cannot satisfy its own criterion until you
  do.** B3 landed the enum but reports that premium _marking_ needs a `premium` / `releasedAt` field on
  `PriceableModel` — a shared-type change under Global Constraint 10 — because classification needs a **pool
  percentile and a clock**, both of which are yours (you already take a percentile over the priceable pool for
  the outlier test, and A1 established the release-date basis). The trial code is free: `exceedsTrialBudget`
  already computes it from a `PriceableModel` plus `basis.systemChars`. **Wire at least one**, or E1's
  "premium rows are marked, not removed" has no data to mark with.
- **RULED (ruling 5): collapse onto `affordability/premium.ts`, deleting `trial-eligibility.ts`'s duplicated
  price percentile and recency window; and stop the trial gate pricing storage.** Report the **eligibility change
  before and after** — storage was inflating trial cost, so the 1¢ cap now buys more and more models become
  trial-eligible. That is a product effect to surface, not to ship quietly.
- **The classifier reserve folds in storage on the live path, and B3's producer drops it.**
  `estimate/smart-model-affordability.ts` folds `classifier-storage` into the live reserve (emitted by
  `estimate/classifier-line-item.ts`), contradicting §Cost and §Reasoning Effort 7 and the founder's ruling
  that a classifier call carries no storage. Until it is removed the live path and the produced set disagree.
  This file is yours; the emitting file is B6's, so coordinate rather than each half-fixing it.
- **The biconditional threshold pinned by a balance sweep:** the client's empty-pool verdict equals the
  server's at every point across the sweep.
- Fixture with a synthetic outlier: hold falls, presented set grows, the outlier absent from candidates
  and present in the picker.

**Files:** `packages/shared/src/affordability/**`, `apps/api/src/slices/models/domain/{smart-model-candidates,catalog-store,trial-eligibility,estimate-run}.ts`, `apps/api/src/slices/chat/domain/{turn-reasoning,smart-model-turn}.test.ts`, `apps/api/src/slices/chat/routes.ts` (the single `promptCharacterCount` argument at the trial gate — nothing else in that file), `apps/api/src/slices/chat/domain/smart-model-turn.ts` (forwarding the prompt character count to the trial candidate builder only), `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` (two falsified comments only), tests.
**Files-list correction:** `trial-eligibility.ts` was missing from this list while ruling 5 requires deleting its duplicated `TRIAL_PRICE_PERCENTILE` / `TRIAL_RECENCY_MS` and stopping it pricing storage — the criteria could not have been satisfied inside the stated bounds. Same defect class as B2's list, caught pre-dispatch rather than by the implementer.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

### B6 — One effort resolver, and the spend bound it carries

**FIX-CYCLE OWNERSHIP EXTENSION 2026-07-27 — close the sign inversion rather than defer it.** B6's change to what
the shared producer prices for a **pinned-model + auto-effort** turn (an empty model list) left the api still
pricing one model. Both remain upper bounds so `reserve ⊇ bill` is intact, but **the sign of the client↔server gap
inverted**: the client used to price MORE than the server and now prices ~118–126 characters LESS, which opens an
affordable-then-402 window of roughly 2–6 μUSD. The correct figure is the empty list on **both** sides. Ownership
is extended to exactly that change in `apps/api/src/slices/models/domain/estimate-run.ts` and
`apps/api/src/slices/models/domain/smart-model-candidates.ts` — nothing else in either file. Ruling 6's standing
rule applies: the task that superseded the path closes it.

**Pre-answered 2026-07-26 by a read-only investigation, so B6 does not rediscover any of it.** Every claim below
was cited to file:line; where it contradicts an earlier note in this section, this wins.

**The authoritative resolver is the REGISTRY one** (`dimensions/derive.ts`'s `resolveDimensionOption`). It is the
only one that resolves over the **presented** support, which §Reasoning Effort 3 requires ("enabled iff feasible
**and** affordable"), and it orders from the declared domain rather than an enumeration order — so `off` sits at
position 0 and one nearest-below walk covers Min. Everything the other two return is losslessly derivable from it:
the wire from the dimension's `wire`, `B` from its `requirement` (arithmetically identical to `planReasoning`'s
branch), the cap from `partitionCeiling`.

**Collapse it as a core plus thin adapters, keeping the published names.** `resolveEffortForModel` and
`pickClassifiedEffortPlan` keep their signatures and delegate. This is not cosmetic: repointing the call sites
instead would edit `smart-model-execution.ts` (C2's), `turn-reasoning.ts` (C3's) and three `apps/web` files (E1's),
which B6 may not do — and C2 can delete the adapters for free when it repoints. **Two behaviours a naive collapse
would silently drop, and both must survive:** the wire-**silence** arm (`{kind:'default'}`), which the registry
collapses into `undefined`; and the **cap-feasibility step-down**, which skips a level whose budget leaves no
answer room and walks on.

**The re-partition bound rests on TWO lines, not one, and its arithmetic already exists.** `partitionCeiling`
returns the held ceiling unchanged with `reserved = min(B, ceiling)`, and a property test already pins
`reserved + answer == held ceiling` for every presented option of every shape. What is missing is the live wiring
and a **boundary** pin: for every model shape × every presented option × a cap sweep, the returned plan's
`maxTokens` equals the cap argument it was handed — never a recomputed number. That pin is what makes deleting the
distance sort unable to delete the spend bound. **Keep the step-down and make it downward-only** (resolve down,
then continue walking down while the answer room is under one token); dropping it instead would let the plan fall
through to reasoning-free where today it runs a lower rung — a behaviour drop dressed as a bug fix. State plainly
which property the bound rests on: **`maxOutputTokens == the held cap, always`**. A fourth `B + H` site exists
(`nodeAnswerCap`, solving the same equation for the cap given H); the property test covers both or the criterion is
half-pinned.

**CORRECTION TO MY OWN FRAMING — the ≤54-character reserve gap is NOT a live `reserve ⊇ bill` breach, and the
earlier "the invariant is binary" wording here overstated it.** The arithmetic is right: four labels plus three
separators add exactly 54 characters beyond the 4,000 the reserve prices. But the same expression converts those
characters at the **trial** ratio of 2 chars/token while the paid input ratio is 4 — a deliberate ~2× over-reserve
on that same leg, so 54 characters (≈27 reserve-tokens) cannot flip an inequality carrying thousands of tokens of
slack. It is a real **derivation** defect — a priced quantity computed from a constant instead of from the thing
being priced, the same shape B1 fixed — and it should be closed. The one shape where it could bite is CJK or
emoji-dense text, and there the **ratio** is the binding term, not the 54 characters. Fix by making the emitter
respect the priced cap (budget the labels and separators inside the global character budget) or by deriving the
envelope once in shared from a single label list. **Refuse a mirrored `+ 54` constant** — that is the banned sync
contract.

**No `PriceableModel` field is needed** — this closes a possible contract change rather than opening one. Every
description is already capped at a declared maximum, so pricing the description leg at that declared bound with a
filler per model is a strict upper bound for any catalog, keeps the money layer content-free, and avoids putting a
free-text field on the narrow projection whose whole purpose is that a new catalog field cannot reshape money
inputs. **A worse adjacent defect, previously unnamed and now a criterion:** the producer prices the classifier
overhead against the **full catalog** while the executor's prompt lists only the presentable pool — and lists no
models at all on an effort-only turn. Two different lists means the error's **sign is not fixed**, so the reserve is
not an upper bound by construction, which is the property that matters rather than the magnitude. The presentable
pool is already in scope at that call site.

**The classifier-storage strip is now B5's, atomically** — the earlier emitter-to-B6 / folder-to-B5 split was
unsafe in the spine's real order and has been re-ruled in §B5. B6's item is therefore **conditional**: if B5's
report says it touched none of it, B6 strips it atomically — emitter, shared fold, and the api fold that reaches
the real admission hold — by positively selecting the provider kind, never by subtracting a storage number.

**Already true today — do not rebuild, and do not "fix" what is already right:** the 4,000-character excerpt
budget matches §Reasoning Effort 6 exactly (the emitted message being 54 characters larger is the item above, not a
doc defect); `partitionCeiling`'s arithmetic; and the registry's `classifierIsBought`, which correctly measures
**distinct resolved requirements**. The LIVE gate still counts option labels, but that file belongs to lane C.

**FILES-LIST GAP RESOLVED 2026-07-27, before dispatch rather than by the implementer.** Ownership is extended to
exactly these and no further: `packages/shared/src/mock-directives.ts` and `apps/api/src/slices/models/adapters/mock-provider.ts`
(the hardcoded level triple has consumers there as well as in lane C's executor), and
`apps/api/src/slices/workflows/nodes/classifier-context.ts` (the emitter side of the ≤54-character fix, which
appeared in no Files list anywhere in this plan).

**`smart-model-execution.ts` is deliberately NOT granted.** It is lane C's, and the adapter approach above is
precisely what removes the need to touch it — the published names keep their signatures and delegate, so the
distance sorter's only production caller needs no edit. If B6 concludes it cannot collapse the resolvers without
editing that file, that is a NEEDS_CONTEXT stop, not a licence.

**Objective:** delete the resolver that can resolve upward **without deleting the guarantee it
currently provides**.

**Design context.** §Reasoning Effort 4. Two resolvers exist; one orders by nearest distance with ties
preferring lower, so a nearer rung _above_ beats a farther rung below — which the ruled rule forbids.

**The trap:** that same function is what currently guarantees a classified pick can never spend past
its reserve — its returned plan's `maxTokens` always equals the already-held completion cap. Deleting
it removes both the bug and the bound. The bound must be re-established here, not assumed.

**Acceptance criteria:**

- One resolver remains, downward-only with the mandatory-reasoning carve-out. The distance-sorting
  implementation is deleted; grep-clean.
- **`e_min(m)` exists as a named function**: `Min` when reasoning is disableable, the lowest offered
  rung otherwise. Pinned on both shapes.
- **The spend bound survives the deletion:** for every model and every classified level, the wire cap
  equals the held ceiling — `B + H == ceiling` — property-pinned. A classified pick can never exceed
  the priced ceiling.
- The classifier's effort options come from the registry entry with user-facing labels including Min,
  Lite and Max. The hardcoded level triple is deleted.
- Distinctness measured on the **resolved requirement**: a plateau-collapsed pair is one option and buys
  no classifier call. Pinned on a real collapsing shape.
- Property test: every model's feasible set is a downward-closed prefix — no gaps.
- **The classifier's shared context is truncated at 4,000 characters** (§Reasoning Effort 6), pinned by
  amount on an over-long history. This clause had no owner until the pre-execution review; the figure
  is documented but was never verified against code, so **report whether the shipped truncation
  already matches it** — if the code disagrees with the doc, that is a finding for the founder, not a
  number to quietly change on either side. **Verified during B1: the cap is 4,000 and the truncator's
  output is byte-identical to baseline**, so the figure is right; what follows is the gap it exposed.
- **B3's per-row rungs and turn menu CHANGED semantics in its final cycle — write expectations against the
  new behaviour, not against its earlier reports.** Per-row rungs changed on 34,854 turns and the turn-level
  menu on 28,412 of a 55,440-turn differential, intentionally: three competing derivations were deleted so that
  every decision-driving reading is now a query over one leaf predicate. The hold, the send gate, row verdicts
  and `runnable` are byte-identical across that differential, so nothing about money moved — but a test written
  from an earlier report's rung expectations will now be wrong.
- **A residual you must NOT "fix": on turns whose only open dimension is effort, pinning drops the classifier
  reserve, so the menu is conservative by ≈0.1¢.** Pre-existing and in the safe direction. Closing it requires
  a second pricing pass per rung — **which is precisely the multiple-derivation hazard B3 spent three cycles
  removing.** Leave it, and leave this note with it.
- **`e_min(m)` exists but is NOT TOTAL, and this criterion is therefore open, not satisfied.** B2 shipped it
  as `cheapestEffortOption` (`dimensions/effort.ts`) and an earlier note here recorded the criterion as already
  met. That was wrong: for a **mandatory-single-rung** reasoning model `cheapestEffortOption` returns
  `undefined`, because `offeredLevels` returns an empty list for that shape — so `e_min(m)` is partial where
  `docs/BILLING.md`'s definition is total ("otherwise its lowest offered level (a mandatory-reasoning model's
  cheapest option is not free)"). The criterion is: **`e_min(m)` is total over every reasoning shape the live
  catalog contains, pinned on the mandatory-single-rung shape.** Whether the empty list itself is corrected is
  a ruled question owned by B5 — read its resolution before implementing, and do not re-derive the ladder here.
- **The classifier reserve also understates the PROMPT overhead, not only the truncated context.**
  `classifierReserveChars` cannot see model descriptions through `PriceableModel`, so the priced overhead is
  smaller than the prompt the classifier actually sends — the same defect shape as the ≤54-character item
  above, at a different term. Closing it may need a new `PriceableModel` field, a contract change under
  Global Constraint 10; report rather than widen silently.
- **Stop `classifier-line-item.ts` emitting `classifier-storage`** — the founder ruled a classifier call
  carries no storage, and the live reserve still charges it. B5 owns the file that folds it in; coordinate.
- **THREE effort resolvers now coexist, and this task's criterion as written kills only one of them.**
  B2's two audits disagreed here and the second is right, so the earlier version of this bullet is
  withdrawn: the `mandatory`-gate difference between `dimensions/derive.ts`'s `resolveOption` and
  `estimate/effort-options.ts`'s `resolveEffortForModel` is **unreachable**, because
  `canDisable ⟺ reasoning defined ∧ ¬mandatory` — so there is no live bug today. The real hazard is
  arithmetic: the three are
  1. `dimensions/derive.ts` `resolveOption` + `dimensions/effort.ts` (B2's, no production caller yet),
  2. `estimate/effort-options.ts:88` `resolveEffortForModel` (**live** — consumed by
     `apps/api/.../turn-reasoning.ts`),
  3. `smart-model/effort-dimension.ts:83` `pickClassifiedEffortPlan` (the distance-sorting one).

  This task's criterion names only "the distance-sorting implementation is deleted". **Delete only #3 and
  #2 survives as a second nearest-below resolver with the same carve-out** — precisely the drift One
  Implementation, Shared bans, arrived at by satisfying the criterion. **Exactly one must survive; name it
  and say what happened to the other two.**

- **B2's classifier protocol is labelled lines; the live one is positional. Replace both halves together.**
  `renderDimensionSection` emits a description plus `Choose exactly one of: <labels>` plus an
  `effort: <choice>` answer line, and `parseDimensionAnswer` reads exactly that. The live parser
  (`smart-model/effort-dimension.ts:46-59`) is **positional** — line 1 model, line 2 effort — and
  `resolveClassifiedEffort` matches against the hardcoded triple. Adopting the producer without replacing
  the parser in the same task leaves the two ends speaking different protocols.
- **The classifier reserve under-covers what the truncator actually emits, by up to 54 characters —
  close it.** Found by B1's audit and **pre-existing**, with identical arithmetic at baseline:
  `classifierReserveChars = MAX_CLASSIFIER_CONTEXT_CHARS + template overhead`, but
  `truncateForClassifier` emits the excerpt **plus four labels and three separators**, so the user
  message reaches 4,054 characters (observed on a 5,000/5,000 input) against a reserve priced for
  4,000. The amount is trivial — tens of tokens — but `reserve ⊇ bill` is the invariant the whole
  settlement design rests on, and it is binary: it holds or it does not. **Pin the reserve against
  what the truncator emits, not against the cap constant**, so the two cannot drift again. This is
  the same defect shape as the sizing/template split B1 resolved — a priced quantity computed from a
  constant rather than from the thing being priced.

**Files:** `packages/shared/src/affordability/**` (effort dimension, resolver, classifier prompt assembly), tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`.
**Sensitive:** money — 2 independent auditors.

### B7 — Notices: typed reasons, derived copy

**Objective:** one vocabulary, one wording per condition, every notice naming an action.

**Design context.** §Notices & Refusals 1–9. A rich notification system already exists with severity,
dismissibility and link segments, and most copy already names cause and action — this is
**consolidation, not invention**. The defect is two parallel copy systems describing one condition
differently: three phrasings for balance-too-low, three for premium-locked, two for guest-has-no-budget.

**Acceptance criteria:**

- Copy derives from the typed reason in one place. An enumeration test over **every** reason asserts
  exactly one wording exists for it.
- **Every** reason's copy contains an action clause — not the three named in this criterion. The
  enumeration test covers all of them.
- **No copy names an amount, a token count, or a threshold** (§Notices 6). Asserted by the same
  enumeration over every string.
- **Severity is structural and biconditional:** blocking ⇒ error and non-dismissible; informational ⇒
  dismissible; and a blocked send always carries a notice while a notice never blocks a send the verdict
  permits. Both directions pinned.
- Precedence: money if the funding cannot cover a minimum answer, else length. Pinned where both would
  otherwise be true.
- The hold-versus-balance distinction produces different copy; the hold notice's action is "wait", it
  offers no payment path, and **it names no conversation**.
- The guest reason implies no top-up path.
- The payer-switch disclosure fires for a member with no allocation as well as one whose allocation ran out.
- **The concurrent-run-cap refusal has a typed reason with one wording and an action.**
- **The payer-switch disclosure fires on `payerSwitch: 'group_headroom_insufficient'`** — F2's emitted
  constant, `PayerSwitchReason`, carried on `FundingDecision.self.payerSwitch` and
  `ResolveBillingResult.payerSwitch`. Wire to that value; do not invent one. It is set **only** on an
  approved fall-through, never on solo, owner, or any refusal, and **one value deliberately covers all
  three shapes** — allocation exhausted, never allocated, and positive-but-too-small — which is why B7's
  criterion requiring the disclosure for a member with no allocation as well as one whose allocation ran
  out is satisfiable from a single reason.
- **Two notes on B3's refusal enum, both overrulable by you in a line.** B3 **split** premium into
  `premium_requires_account` and `premium_requires_credit`, on the grounds that different **actions** mean
  different **conditions** under §Notices 2 — so the one-wording-per-condition rule is satisfied by two
  reasons rather than violated by one. Judge that; collapsing them is a one-line deletion if you disagree.
  And `option_not_offered` survives but is now reachable **only** via a pinned id outside the declared domain,
  since effort resolution is total over the domain — **do not write copy expecting it from a legal rung.**
- **Do not assume `payerSwitch` implies a charge lands.** F2's audit found an unreachable-today shape worth
  knowing: a group fall-through for a `trial`-tier caller would attach the reason to `trial_fixed`, where
  nothing is charged. It cannot occur now (trial means unauthenticated, so it can never hold group context),
  and it is not worth a fix — but if trial ever becomes group-capable, copy written on that assumption
  becomes wrong.
- **A group turn refused because the OWNER's wallet moved gets its own typed reason.** No ruling is
  pending: §Group Funding 6(b) already makes this case a hard refusal at admission (see §F1). The served owner dimension is deliberately hold-blind for privacy, so a
  member can be shown an affordable option that admission refuses. The copy must name the cause without
  naming a number or disclosing that the owner is running turns, which is the whole point of keeping the
  figure raw; §Notices 6's no-magnitude rule already forbids the amount. Skip this item if the founder
  instead rules the owner dimension hold-aware.
- **A top-up against a negative balance discloses the deficit and the net credit before submit**
  (§Fee Structure). Currently absent entirely.
- The three notices that name a cause with no action gain one.

**Files:** `packages/shared/src/affordability/notices.ts`, `packages/shared/src/error-codes.ts`, the budget-notification module (post-B1 path), the payment surface, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`.
**Sensitive:** no.

### B8 — Land the public surface (depends on B7 and C1)

**RE-SCOPED 2026-07-27 after B8 returned NEEDS_CONTEXT having changed zero files, and the founder ruled the
split. The task as originally written was not buildable, and that was my error, not the implementer's.**

The defect: the criterion "every consumer on B1b's inbox is flipped from an internal path to the barrel"
silently assumed those consumers import symbols the barrel _carries_. They do not. B8 measured the inbox as
reaching three walled subpaths — `affordability/estimate` (68 references), `constants` (10), `smart-model` (4)
— i.e. almost every reference is to a module **internal** that `WALLED_EXPORTS` deliberately keeps off the
barrel. "Flipping" such a consumer is therefore not an import edit; it is **rewriting that consumer onto
`getTurnOptions`** — roughly 4,270 lines across 11 modules. And that rewrite belongs to **E1** (`hooks/billing/*`)
and **G2** (`use-media-cost-estimate.ts`) by the ownership table, both of which **depend on B8**. B8 could not
finish without performing the work of the tasks waiting on it.

**The split, per the founder's ruling:** B8 lands the _real surface_ and everything separable; **B8b** deletes
the 14 interim subpaths once nobody is importing them. The ordering is the honest one — a door cannot be removed
before its users have another way in. The cost is accepted and named: the wall closes at B8b, later in the run
than originally drawn, and `BILLING.md` §What is enforced stays aspirational until then.

**Added criterion, from B4's audit — WIRING IS WHERE TWO `T` VALUES MEET, AND THEY DIVERGE.** B8 is the task that
gives `getTurnOptions` its first production consumer, so it is the task where this becomes reachable.

The server's fit solves the shared token count with the **per-sibling clamp inside the sum** — `fits(cap)` prices
`withAnswerCap`, which clamps each node. §Sharing one budget across siblings defines `T` from the **unclamped**
`Σᵢ cost(mᵢ, T)` and clamps only afterwards. Where one sibling saturates its own room the two disagree: the
server's `T` is larger than the module's, so the wide sibling receives a **longer answer than the shared producer
would have presented**.

This is safe today and must not be "fixed" blind: the server's figure was verified ≤ funds at three funding
levels, so `reserve ⊇ bill` and `admissible ⊆ affordable` are both untouched, and it is unreachable while
`getTurnOptions` has no production consumer. B8 must therefore either **collapse the two onto one clamp order**
or **state which one is authoritative and why the other is allowed to differ** — and pin whichever it chooses by
amount on a saturating-sibling case.

**CLOSED 2026-07-27 BY C3, which held the solver B8 could not reach.** Both amounts on B8's own fixture: the wide
sibling gets **12,281** tokens under the module's order and **22,562** under the server's; the hold is
**11,774,800n** vs **19,999,600n**; the unspent remainder **8,225,200n** vs **400n** — the server releases 8,224,800
of the saturated sibling's unused room to the sibling that can use it. **The saturated sibling agrees at 2,000
either way, which is what isolates the divergence to the clamp ORDER rather than to the fixture.**

**Authority: the MODULE.** §Sharing one budget's unclamped-then-clamp is the spec, so the module governs what is
presented and what the client holds. The two are safe to differ because the server's fit is **bounded by the same
spendable figure** (asserted, not assumed), so it can only ever _lengthen_ an answer — never admit a send the client
refused — and the presented ceiling is the smaller of the two, so the served number is never a promise the run
breaks. **The orders were deliberately NOT collapsed:** collapsing onto the module's would cost a paid user
8.2M nano of deliverable answer, and collapsing onto the server's would change what the client presents. B8's
resolution was state-the-authority-and-pin, and this is that, with the amounts.

**RESOLVED 2026-07-27 — B8 took the "state the authority and pin by amount" branch, and my pushback was
half right.** It pinned the module side by amount on a saturating-sibling turn, including the **8,225,200 nano** the
other clamp order would have reallocated, so the choice is now a tested decision rather than a latent disagreement.
It also did what I demanded instead of the category claim: it **named the artifact** it could not produce. A genuine
cross-implementation amount comparison needs `turn-definition.ts`'s solver, which is owned by B4 → C3 → E4 and not
in B8's Files list, and re-deriving that solver inside `packages/shared` to compare against is exactly the
golden-cross-check shape Global Constraint 5 bans. **So the residual is real and owned: whoever holds
`turn-definition.ts` next (C3) pins the cross-implementation amount.** My original claim that the fix needed no
consumer was right about the module half and wrong about the comparison half.

**This criterion STAYS in B8 under the re-scope, and the orchestrator does not accept that it is unreachable.**
B8's NEEDS*CONTEXT argued it must wait for a production consumer. The \_hazard* needed one; the _fix_ does not —
both implementations exist on disk today, so collapsing them onto one clamp order and pinning the saturating-
sibling case by amount is a unit-level change available now. If you find a specific artifact you genuinely cannot
produce without a wired consumer, name that artifact concretely and report it rather than deferring the whole
criterion; "unreachable" as a category claim is not accepted. What it may not do is wire the producer up and leave two numbers answering
one question, which is the defect family B3 spent four cycles removing.

**Objective:** the six exports of §The public surface exist under those names and are real — built where no
producer exists, renamed where one exists under another name — so that E1, G2 and C3 have an API to consume.

**Design context.** B1b removed the leaked exports but could not land the replacements, because
`getTurnOptions` (B3), `renderOptions` and the classifier prompt assembly (B6), `notices` (B7),
`wireFor` (B2's `wire`) and `chooseFrom` (C1's reducer logic) are built across the spine and into
lane C. This task is the second half of B1b: it closes the interim state rather than introducing
new behaviour. `resolveFunding` already exists as an export today — F2 changes its behaviour, not
its name, so B8 does not wait on F2.

**The naming question this task decides and reports.** The six documented names are the contract;
several producers currently exist under different names. Where a rename is cosmetic, rename to the
documented name — a wrong name is treated like a wrong comment. Where the documented name would
imply a different signature than the producer actually has, report the mismatch rather than
inventing an adapter: that is a `BILLING.md` defect for the founder, not a wrapper to write.

**Acceptance criteria:**

- **Define `ModelId` as a branded string** (ruling 4). Model ids are bare strings today, so G1 rule 7's
  no-bare-`string` rule cannot pass without it — and §Data Structures already names `ModelId` as though it
  existed, so one change closes both items.
- All six exports exist on the barrel under their documented names, plus the named structural seams
  (the storage-fee function, tier and premium classification, the dimension registry as data, money
  formatting — **not** the two fee applications; see §B1's ruling, which removed that decision from
  this task).
- **The six exports and the named seams are present and exported.** The _totality_ pin — set equality against
  the documented list — **moved to B8b on 2026-07-27**, because it cannot be satisfied here: B8 measured 123
  runtime exports on the affordability barrel against a ~20-name documented list, so asserting set equality today
  would mean deleting ~103 published names while consumers still reach the module through subpaths. Totality is
  meaningful only once the surface is final and the subpaths are gone, which is B8b by construction.
- **Build the surface that does not exist yet — this is now the heart of the task.** B8 measured the six
  documented names against the repo and the orchestrator independently confirmed the load-bearing half:
  **`chooseFrom` and `renderOptions` have zero producers anywhere**, while `BILLING.md` §The public surface
  documents both as things "feature code touches". Two more exist under other names: `notices(decision, options)`
  is `noticeFor`/`noticeText` in `affordability/notices.ts`, and `wireFor(chosen, modelId)` is `spec.wire`.
  **Correcting B8's own report:** it listed `notices` among the absent, which is wrong — that file exists; the
  real split is **two absent, two present-under-another-name**. Build the two, rename the two. Existing pieces are
  dimension-granular (`parseDimensionAnswer`, `cheapestPresentedOption`, `renderDimensionSection`, `spec.wire`),
  so building means composing them into the documented turn-level signature — not writing new money logic, and
  not an adapter that merely satisfies a name.
- **Unwind the walled types off the models slice's public barrel (founder-ruled 2026-07-27, "unwind it now").**
  `DeclaredCeiling` and `NodeStorage` are walled money types that travel out through `affordability/estimate` →
  `models/domain/estimate.ts` → `models/domain/index.ts` → `models/index.ts`, landing on an `apps/api` slice's
  **public** barrel. Neither barrel's absence test nor G1 rule 6 can see it: those read the shared package's
  export map, and this escape route crosses a slice boundary instead. It is load-bearing — the two types appear in
  `models/domain/estimate.ts`'s public signature (~`:227-228`) — so this is a real contract change, and the
  founder chose it over recording it as debt. **Criterion: neither type appears on the models slice's public
  barrel, and a test pins their absence there.** The orchestrator verified the blast radius is confined to
  `models/domain/{estimate,estimate-run,index}.ts`, `models/index.ts` and `affordability/estimate/run-ceiling.ts`
  — no overlap with C2's files. **If the only way to remove the re-export is to make a walled type public, stop
  and report it**: that would resolve a wall breach by widening the wall, and it is the founder's call, not yours.
- **Produce the authoritative walled-consumer inventory that gates B8b.** For every remaining reference to a
  walled subpath, record file, symbol, and **which task owns the rewrite** (E1, G2, or an `apps/api` owner you
  name). B8b's only job is deletion, and it cannot start until this inventory is empty. Your re-derivation
  (29 files / 98 refs / 13 units in use, versus the plan's 28/102/14) supersedes B1b's table — including the two
  findings the orchestrator accepts outright: `./affordability/budget` has **zero** consumers and is deletable
  immediately, and errata 2 and 3 are both confirmed.
- **The separable items are yours and are unblocked:** `ModelId` branding, and premium marking's data — B8
  established `ModelDescriptor.releasedAt` already exists and `premium.ts` already takes `nowMs` as an argument,
  so the money core still reads no clock and the criterion below is smaller than it looked. Note that
  `priceable-model.ts`'s "a release timestamp is deliberately NOT here" comment becomes wrong and must be
  corrected in the same change — a wrong comment is worse than none.
  **TWO B8 DEVIATIONS ACCEPTED 2026-07-27, both because refusing them would push work somewhere worse.**
  (1) The criterion asked only for premium _data_, but B8 made the core also produce `premium_requires_account` /
  `premium_requires_credit` as the row's availability **reason**. Accepted: with data alone, `nowMs` is an argument
  nothing reads, and a boolean field would push the _verdict_ into E1 — which §What is enforced forbids and which E1's
  own criteria describe deleting, not adding. The verdict belongs in the money core; E1 renders it.
  (2) `getTurnOptions`' fourth argument became `CatalogSnapshot = { models, nowMs }` rather than gaining a fifth
  positional parameter, which would trip the repo's `max-params` rule. Accepted, and B8 was right not to disable the
  rule: both premium legs are properties of the pool **as of an instant**, so the pairing is meaningful rather than a
  bag. This is a documented-signature change **beyond** the `nowMs` the criterion named, and it is now on the
  `BILLING.md` correction list for the founder.

**THE `nowMs` GUARD IS DELIBERATELY ONE-SIDED, AND THE RESIDUAL IS ROUTED (accepted 2026-07-27).** B8 added
`requireUsableInstant` (safe integer, ≥ `PREMIUM_RECENCY_MS`, `RangeError`) and deliberately added **no upper
bound**. Accepted, because the argument is correct and worth preserving: a far-future instant is representable, **the
module holds no clock to check a caller's against**, and any calendar ceiling would be a policy that rejects a
correct clock the day it passes. You cannot detect a wrong-but-representable future clock without a clock.

It pinned the money-visible half instead — **a price-premium row stays refused a thousand years later**, because the
price leg reads no clock at all. Its stated residual: a **recency-only** premium row does flip available under a
false future instant. That is a **served-value contract** belonging to whoever supplies `nowMs` (B9, E1, C3), each of
which must treat the instant as data it is responsible for rather than a free parameter.

**THE RESIDUAL HAS A GREP-ABLE FORM, so it cannot decay into a wish (B8's money auditor, 2026-07-27).** Whoever
wires the first production caller owes exactly this, and it is checkable rather than aspirational:

1. **`nowMs` is derived at the same boundary that resolves the catalog, from the server's own clock.** The pattern
   already exists in-repo — `apps/api/src/slices/models/routes.ts` and `slices/chat/routes.ts` take `Date.now()` at
   the route edge — so the first caller copies it rather than inventing it.
2. **`nowMs` is never sourced from a Zod-parsed request shape.** That is the grep: if the instant can be traced back
   to a request field, the contract is broken regardless of what any comment says.
3. **E1 specifically: pass a session-stable instant, not a per-render `Date.now()`.** Marked **Inferred** — no path
   exists to trace yet. It is not a verdict hazard (crossing the 182-day boundary mid-composition is not a real
   case), but it churns the memo key of a set `turn-types.ts` documents as **keystroke-stable**.

The guard's floor cannot refuse a legitimate call, and this was **verified rather than argued**: the floor is
~1970-07-01, every `setSystemTime` value in the repo is ≥ 2024, and every production `nowMs` already comes from
`Date.now()` at a route edge. The only way to trip it is an instant that cannot be one.

Severity bounded honestly: there is **no production caller of `getTurnOptions` yet** — all 55 call sites are tests —
so the residual is entirely prospective. When callers arrive, the client pass is advisory and the server re-validates
at admission with its own instant, so a tampered client clock would mis-_display_ availability rather than move
money. That last step is **Inferred, not Verified**: no production path exists to trace, and whoever wires the first
one owes the check.

- **Land premium marking's data, because E1 cannot be built without it.** B5's audit established that a model
  cannot be marked premium without a signature change the money core may not make on its own: the field set is
  `releasedAtMs` on `PriceableModel` plus `nowMs` on the producer's input, because **the money core reads no
  clock** and must not acquire one — time arrives as an argument or not at all. The `nowMs` half changes
  `getTurnOptions`' documented signature, which is precisely this task's surface to land and document, so it was
  routed here rather than to B5. Until it lands, E1's "premium rows are MARKED, not removed" has no data to mark
  with: **this is blocking E1, not a nicety.** Pin that a model released inside the premium window classifies
  premium and one released outside it does not, driving both from the same `nowMs` rather than from a real clock.
  (`trial_message_cap_exceeded` is already wired and needs nothing here.)
- **No wrapper exists whose only purpose is to satisfy a name.** If one seemed necessary, the
  mismatch is reported instead.
- No behaviour change: every package suite passes with no test semantically modified beyond import
  paths and renames. List every touched test and why.

**Files:** `packages/shared/src/index.ts`, `packages/shared/src/affordability/**` (the producers being built and
renamed), `packages/shared/src/models/model-descriptor.ts` and `priceable-model.ts` (premium data + the comment it
falsifies), `apps/api/src/slices/models/domain/{estimate,estimate-run,index}.ts` and
`apps/api/src/slices/models/index.ts` (**the walled-type unwind only**), tests.
**Not yours:** `packages/shared/package.json`'s subpath entries (B8b), the consumer rewrites (E1, G2), and
`models/domain/smart-model-candidates.ts`'s `_pinned` parameter (C3).
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`; `pnpm lint:unused`.
**Sensitive:** money — 2 independent auditors.

### BILLING.md correction batch — surfaced by B8, verified by its auditor, awaiting founder approval

Held here rather than applied, per the 2026-07-27 ruling that subagents never edit `.md`. **B8's auditor checked all
four before relay and found one enumeration wrong — the reason this batch is presented verified rather than
relayed.**

1. **The producer's signature.** The doc writes a fourth `catalog` argument; the code takes
   `CatalogSnapshot = { models, nowMs }`. Verified accurate.
2. **`PriceableModel.releasedAtMs`** — §Data Structures lists no release field. Verified accurate.
3. **`notices(decision, options)` and `wireFor(chosen, modelId)` do not exist at those signatures.** The producers
   are `notices(reason: NoticeReason)` and `wireFor(chosen, model: PriceableModel)`. The auditor confirmed
   `wireFor(chosen, modelId)` is genuinely **unbuildable**: `DimensionSpec.wire` is
   `(model: PriceableModel, option: OptionId)` and the effort wire reads the model's reasoning metadata, context
   length and provider cap — so a bare id cannot make a wire fragment. **Wording nit from the auditor: it needs the
   model's caps and reasoning metadata, not its "rates".**
4. **"The storage-fee function" names nothing** — conclusion accurate, **enumeration NOT accurate.**
   `storageRatePerTokenNanoUsd` is not the only storage-money function: `turn-arithmetic.ts`'s `inputStorageNanoUsd`
   and `estimate/pre-adapters.ts`'s `outputStorageRatePerTokenNanoUsd` also compute storage money, and all three are
   walled. Correct that sentence before acting on it.
5. **`§What is enforced` describes a wall in the wrong place (founder-ruled 2026-07-28).** The money module's
   internals are hidden from **consumers of prices**, not from every package. The api estimator **produces** prices
   and legitimately reaches internals; `apps/web` consumes them and must not. The current text implies a package
   boundary, which B9 proved unsatisfiable — all 32 symbols the estimator needs are on the deliberately-not-exported
   list, so satisfying the sentence would mean publishing exactly what it protects. Restate the boundary as
   owner-versus-consumer, and note it is enforced by an `arch:check` rule rather than by the export map alone.

6. **Added by BOTH auditors independently — the doc contradicts its own structural rule.** `chooseFrom(options,
rawAnswer)` is documented with a bare `string` parameter carrying model-generated text, while §Where the Code
   Lives makes "no export takes a bare `string` parameter" structural and §Data Structures cites that very rule as
   the reason `ModelId` is branded — this task's own first criterion. One auditor extended it to `modelId(value:
string)` as a second violating site.

   **Orchestrator's reading, offered as reasoning and not as a decision: the two sites are not alike.** A brander
   _must_ accept the unbranded form — you cannot brand a string without a function that takes a string — so
   `modelId(value: string)` is a necessary exception the rule should name rather than a violation to fix; treating it
   as one makes branding impossible. `chooseFrom` is the genuine question: it carries untrusted model-generated text
   across the barrel, which is either the strongest case for a refined type or the clearest case for a stated
   carve-out. Founder's call either way; no code was reshaped under it.

### F3 — Serve what affordability actually needs (blocks E1)

**Created 2026-07-27 on the founder's ruling. The defect is real; the PREMISE I GAVE FOR IT WAS WRONG, and F3
corrected it by execution.**

**What I told the founder** (relaying E1): a free payer's snapshot is `{spendable:'0', held:'0', tier:'free'}`, so
driving the client's greying from `affordable` would grey every model and refuse every send for every free user.

**What is actually true** (F3, verified against the running endpoint): the endpoint served **500,000,000n — the PAID
$0.50 cushion — at `tier:'free'`**, against a gate of **50,000,000n**. So the defect is a **10× OVERSTATEMENT in the
UNSAFE direction**: the client is offered sends that admission then refuses. Not universal greying — the opposite.
E1's `'0'` came from somewhere other than this endpoint, and tracing that is E1's to do.

**The fix is unchanged and the task was still right to create**, because a served number that disagrees with the gate
by 10× is a defect either way — and offering what cannot be afforded is worse than the reverse. But the reasoning was
wrong, I relayed it as established fact, and a decision was taken on it. **`docs/BILLING.md` needed no correction
here: §Funding already specifies that a free payer's effective balance is the allowance. The doc was right and the
code was not** — which is precisely why the plan should have checked the doc before inventing a premise.

The root cause is a planning defect, stated plainly because it should not recur: **`plan.md` contained zero
occurrences of "allowance" or "free tier".** A whole user tier was absent from a plan about affordability.

**Objective:** one served number that is correct for every tier, so no client composes a funding figure.

**Acceptance criteria:**

- `GET /billing/spendable` returns the payer's genuine spendable figure **including the free-tier daily allowance**,
  so a free payer's served number matches what admission actually gates on. **Pinned two-sidedly against `admitRun`
  at PAID and FREE only** — corrected from "all four tiers", which was unsatisfiable: `/billing/spendable` is
  billing-token-classed and the route class refuses trial-session principals by design, so trial and guest have no
  served figure to pin. My criterion asked for something the auth model forbids.
- ~~The remaining trial message count is served in the same response.~~ **CRITERION WITHDRAWN 2026-07-27 — it is
  unservable here by design, and I should have seen that before writing it.** `/billing/spendable` is
  billing-token-classed (401 unauthenticated) and `route-class.ts` refuses trial-session principals on **every**
  class deliberately; the counters are chat-owned (`trial-quota.ts`, keyed by trial token + hashed IP,
  increment-only) and chat belongs to C3. Serving it needs either a public chat-side read or a route-class change —
  a decision and a different owner, not a line in this task.
  **Orchestrator scope call, reversible and flagged to the founder:** E1's dependency on this is **severed**. E1's
  objective is rendering the produced sets, and a remaining-trial-message count is not part of those sets. If a
  surface must show one, that is a separate task with a named owner. E1 is unblocked by F3 without it.
- **No client composes a funding figure from two endpoints.** That is the composed-basis duplication B3 removed; one
  number, one source.
- The day-keyed nature of the free allowance is preserved — it is an allowance remaining _today_, never a reset job.
- Pinned against `admitRun` itself, the way F1 pinned its figure, so the served number cannot drift from the gate.

**TWO DUPLICATIONS FOUND BY F3's AUDITOR, and they are DIFFERENT KINDS — the distinction is the ruling.**

**A THIRD DUPLICATION, AND IT IS THE DANGEROUS KIND — it already corrupted an agent's reasoning.** The cushion is
resolved two ways: the **shared, tier-keyed** `getCushionNano(tier)` (paid-only, so free ⇒ `0`) and the server's own
**wallet-type-keyed** `spendableFor`, which maps `purchased → 'paid'` unconditionally ⇒ `500,000,000n`. Unlike the
tier-boundary pair below, **these two genuinely disagree on the same input.**

Its cost is already paid and it was not a runtime cost. E1 reasoned about free-tier funding using the shared
implementation, concluded a free payer is served `0`, and reported it. I relayed that to the founder as fact, and a
task was created on it. **The duplication corrupted a DIAGNOSIS, not just a value** — an agent read one of two
implementations, was right about that one, and was wrong about the system. Record it that way, because it changes
how the taxonomy below should be read: a duplication's danger is not only that the two copies drift at runtime, it
is that a reader can consult either one and believe they have consulted the system.

1. **The tier boundary is written twice and CANNOT DISAGREE.** `affordability/tiers.ts` and
   `chat/domain/turn-context.ts` both test `purchased balance > 0n` — same operand (the purchased wallet row from
   `billing.readWallets`), same operator, same literal, both reading DB truth rather than the advisory Redis
   snapshot. No balance, wallet shape, hold state or clock makes them differ; the only divergence is **temporal**
   (the balance moved between preview and send), which is the accepted staleness contract, not drift. So this is
   **edit-drift duplication only** — harmless today, real the moment one side gains a term (a cushion, `>= 0n`, a
   wallet-type test). **A duplication that cannot drift on an input is a different finding from one that can, and
   only the second is urgent.** Two nearby sites are _recoveries_ rather than third decisions: both key off the
   frozen payer wallet's type.
   **Consequence for the artifact F3 left:** it recorded the coupling as a comment, which Global Constraint 5 calls
   a smell. That comment is defensible **only while both sites stand** — whoever collapses them deletes it.
2. **"Remaining allowance today" is derived twice, and THIS one has a live consequence.** `billing/domain/balance.ts`
   and `billing/domain/budget-resolution.ts` both compute `clamp(DAILY_ALLOWANCE − spent)` over the same day-keyed
   row. Byte-equal today — but F3 correctly took the **admission-side** one while `/billing/balance` keeps serving
   the other, and **that second server-side derivation is exactly what still permits a client to compose a funding
   figure from two endpoints.** It is the server-side root of the client duplication E1 must remove. Pre-existing,
   unowned, and named here so it is not rediscovered a fourth time.

**Files:** `apps/api/src/slices/billing/**` (the spendable path and its schema), `packages/shared` (the response
schema only), `apps/web/src/lib/api-client.ts` if the typed client needs regenerating, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

### B9 — The api estimator moves onto the barrel (depends on B8)

**Created 2026-07-27. B8 found that no task in the plan owned this, and it is the last thing standing between the
run and a closed wall.** Of the 96 walled references remaining after B8, **22 are in `apps/api/src/slices/models/**`
— the api's own estimator.\*\* E1 and G2 cover the web consumers, lane C covers the chat turn, and nothing covered
these. B8 did not invent an owner, which was right; this task is that owner. Without it B8b is permanently
unstartable, so the founder-approved split does not actually work until this exists.

**BLOCKED 2026-07-28 — B9 IS NOT BUILDABLE AS I SCOPED IT, and the reason is architectural rather than practical.**
B9 probed exhaustively and found **32 of 32 symbols `apps/api` reaches through walled subpaths are absent from BOTH
`@hushbox/shared` and `@hushbox/shared/affordability`.** Not one is an import edit. **Every one is on `BILLING.md`'s
explicit "deliberately not exported" list**, so "move the estimator onto the barrel" means _publishing the internals
the wall exists to hide_ — the task and the wall want opposite things.

**And the one route that would avoid publishing is already ruled against.** Expressing the estimator through
`getTurnOptions` **moves money**: server hold `19,999,600n → 11,774,800n`, wide sibling cap `22,562 → 12,281` — the
exact divergence C3's clamp-order test now pins, and which §B8's resolution deliberately preserved ("the orders were
NOT collapsed"). B9 hit its own stop-and-report trigger: a re-expression that changes an amount means the two paths
were never equivalent.

**Two further corrections to my criteria:**

- **The grep criterion is a RUN-level end state, not a task-level one.** It cannot be emptied by anyone this cycle:
  `workflows/nodes/smart-model-execution.ts` carries three walled refs and sits on **D1's** concurrent Files list.
- **`estimate.ts` and `estimate-run.ts` have no `getTurnOptions` expression by design** — `BILLING.md` §Where the DAG
  lives mandates that seam, and the barrel does not publish it. I wrote a criterion against the spec.

**Inventory re-derived, superseding B8's:** 24 files / 54 specifier lines / **69 bindings** / 13 units in `apps/api`
(models 27, chat 19, workflows 8 lines). B8's "22" reproduces exactly on production `import` statements in
`models/**`. The 27 refs **outside** `models/**` are unowned again — the plan assigned them to lane C, C3 has landed,
and they remain.

**RE-SCOPED 2026-07-28 BY FOUNDER RULING — THE WALL IS AGAINST CONSUMERS, AND THE API ESTIMATOR IS AN OWNER.** The
money module's internals are hidden from **consumers of prices** — `apps/web`, and any code that reads a price to
render or decide. The api estimator does not consume prices, it **produces** them: it is money-layer code that lives
in `apps/api` for deployment reasons. A wall drawn at the package boundary was drawing it in the wrong place, which is
why B9 found all 32 symbols on the deliberately-not-exported list — the task and the wall wanted opposite things
because the boundary was mis-sited, not because either was wrong.

**B9's new objective: make that distinction ENFORCED rather than stated.** The ruling is worthless as prose — the
whole run's ethos is that only a test survives — so this task ends with a rule that fails, not a paragraph that
explains.

**Acceptance criteria (replacing the originals, which are void):**

- **Every one of the 69 bindings is classified** as an **owner** reach (legitimate; pricing production) or a
  **consumer** reach (must move onto the barrel or be deleted). Per binding, per file. B9's re-derived inventory —
  24 files / 54 specifier lines / 69 bindings / 13 units — is the input; the output is that inventory with a verdict
  in each row.
- **An `arch:check` rule enforces it**, in `packages/config/arch/`: walled affordability subpaths may be imported
  **only** from the designated owner paths, and importing one anywhere else in `apps/api` fails the gate. Name the
  owner set explicitly in the rule — an allowlist that must be edited to grow is the point.
- **The rule is proven to fail**: add a walled import to a non-owner file, watch `pnpm arch:check` go red, revert
  byte-exact. A structural rule nobody has watched fail is the vacuity class at gate scale.
- **Every consumer reach found by the classification is closed** — moved onto the barrel where the barrel can express
  it, or reported with the exact symbol if it cannot. Consumer reaches outside `models/**` are in scope for the
  classification and the report; **fixing** them is only in scope where the file is yours.
- **B8b's gate becomes: no CONSUMER reach remains**, not "no reach remains". Deletion still requires that nothing
  imports the subpath, so state which subpaths survive because an owner needs them.

**Not in scope, and explicitly so:** re-expressing the estimator through `getTurnOptions`. B9 proved that **moves
money** — server hold `19,999,600n → 11,774,800n`, wide sibling cap `22,562 → 12,281` — and §B8's clamp-order
resolution deliberately preserved that divergence. Do not collapse it.

**THE RULE READS BROADER THAN IT IS — found by B9's second auditor, 2026-07-28.** Its docblock says scope is
`apps/api` and it gates on `filePath.includes('apps/api/')`, but the arch harness only loads
`apps/api/src/{slices,lib,middleware}/**` and `src/app.ts` into the ts-morph project. So **`src/platform/**`,
`src/jobs/**`, `src/adapters/**`, `src/smoke/**`, `src/workers-validation/**`, `entry.ts`and`scheduled.ts`are never
scanned** — a walled import in any of them passes`arch:check`**silently**. Not hypothetical:`platform/dev/seed-billing-history.ts`is money code (nano-USD ledger legs,`billableCostNanoUsd`, its own comment
says "mirroring `chargeWithinTx`") sitting entirely in the hole. No live violation exists today — all 23 reaching
files are under `slices/`— so this is a **latent gate hole, not a breach.** The auditor's framing is the durable one:
**the failure mode to avoid is a rule that reads broader than it is.** Fix by widening the globs (and re-running the
other twelve rules for fallout) or by narrowing both`API_ROOT` and the docblock to the scanned subtree — but the
stated reach and the actual reach must match.

**THE RULE EARNED ITSELF WITHIN MINUTES, AND THAT IS THE ARGUMENT FOR IT.** Its first real run flagged
`workflows/engine/live-run.test.ts` — modified by a concurrent agent **25 minutes after B9's own inventory grep**.
B9's conclusion is the durable one: **a grep-and-classify pass is a snapshot; the rule is continuous.** Every
classification in this run has been a photograph of a moving tree; this is the first thing that keeps looking.

**LAUNDERING BEATS THE RULE, AND IT BEAT B9's INVENTORY TOO — flagged to the founder, not taken.**
`models/domain/trial-smart-model-candidates.ts` is a price **owner** with **zero walled specifiers**: it reaches
`classifierReserveLineItems` through **an owner's re-export**. **No specifier grep can find it, and the arch rule
does not see it either**, because the import it makes is legal. Closing it needs an _"owners may consume internals
but must not republish them"_ clause, forcing four re-export sites and their consumers — a design change beyond B9's
criteria. **This is the same shape as the aliased re-export recorded in §Known Breakage: a name changes identity at a
hop, and every name-based method loses it.** The rule is real and continuous; it is not airtight, and the gap has a
name.

**RULED: publish `planReasoning` and `planReasoningOff`.** B9 owns a consumer reach it cannot close —
`integration-setup.ts` needs them, and routing through `reasoningEntryFor` would mean **re-deriving `B + H`**, which
Global Constraint 5 bans, inside a cassette-hash-stable file. **Four of their sibling exports are already published**,
so the wall does not in fact protect this family; the omission is an inconsistency rather than a policy. Publishing
two symbols that four siblings already sit beside is the smallest closure available and adds no new surface class.
(The alternative — putting `maxTokens` on `TurnReasoningEntry` — changes a shared type to avoid publishing two
functions, which is the larger change.)

**ADD THE RATCHET B9 PROPOSED.** `PENDING_CONSUMER_CLOSURES` holds nine files with **nothing forcing it to shrink**,
which is how an allowlist becomes furniture. A **non-increasing-length assertion** is the cheapest mechanism that
makes the list a debt rather than a shelf: it may shrink freely and cannot grow without someone editing the number.

**Objective:** the api's estimator reaches the money module only through the barrel, so that no `apps/api` file
imports a walled subpath.

**Design context.** These are not import edits. A walled reference is a reference to a module _internal_ — rates,
ladders, ceiling solvers, manifests — so moving it onto the barrel means expressing what it needed in terms of the
published surface, principally `getTurnOptions`. Where the barrel genuinely cannot express what the estimator needs,
that is a finding about the surface, not a licence to keep the subpath: report it rather than widening the wall.
Read what B8 landed first — the surface changed shape (`CatalogSnapshot`), and `chooseFrom`, `renderOptions`,
`notices` and `wireFor` did not exist when the estimator was written.

**Acceptance criteria:**

- No file under `apps/api/**` imports `@hushbox/shared/affordability/*` — only `@hushbox/shared` or
  `@hushbox/shared/affordability`. Proven by a repo grep in the report, not asserted.
- **The "22 references" figure counts PRODUCTION (non-`.test`) files** — B8's auditor reproduced it exactly under
  that reading and got a different number otherwise. Use it, and re-derive rather than trusting the count: the
  inventory moved by one reference during B8's own audit window because C2 was editing concurrently.
- Behaviour identity where the estimator's output is money: the amounts it produced before equal the amounts it
  produces after, pinned on at least one saturating-sibling turn and one trial turn. This is a re-expression, not a
  repricing — if an amount changes, that is a finding to report before proceeding, because it means the two paths
  were never equivalent.
- The `reserve ⊇ bill` direction is preserved or improved, never weakened; state which.
- Any capability the barrel cannot express is reported, with the exact symbol and what it is needed for.

**Files:** `apps/api/src/slices/models/**`, tests. **Not yours:** anything under `packages/shared` (B8/B8b), the web
consumers (E1, G2), and `estimate-run.ts`'s classifier double-pricing (C3 — coordinate by reading its criteria, do
not fix it here).
**Scoped checks:** `pnpm test:api`; repo-wide `pnpm typecheck`.
**Sensitive:** money — 2 independent auditors.

### B8b — Close the wall (depends on B8, B9, E1, G2)

**Created 2026-07-27 by the founder's split ruling.** B8b exists because deletion has a precondition that B8
cannot satisfy itself: **the 14 interim per-unit subpaths can only be removed once nothing imports them**, and the
importers are rewritten by E1 and G2, which depend on B8. This task is the deletion, and nothing else.

**Do not start B8b while B8's walled-consumer inventory still has open rows.** That inventory is the gate: every
row names a file, a symbol and the task that owns its rewrite. An empty inventory is the entry condition.

**Objective:** the money module's internals stop being reachable from outside it, making `BILLING.md` §What is
enforced true rather than aspirational.

**Acceptance criteria:**

- **Delete all 14 interim per-unit subpath entries from `packages/shared/package.json`, and prove deep specifiers
  no longer resolve.** A probe asserting `error TS2307` (or the ESM equivalent) for a representative deep
  specifier is the evidence; the export map must end at exactly `.` plus `./affordability` among the affordability
  entries. B1b closed both barrels but had to open these to repoint external consumers — this is the criterion
  that actually closes the wall.
- **`./affordability/budget` can go immediately regardless of the rest** — B8 measured **zero** consumers.
- **The barrel is exactly the documented surface:** a test enumerates the root barrel's affordability exports and
  asserts set equality against the documented list — not merely that the forbidden ones are absent. B1b pinned
  absence; this pins totality, so a leak added later fails. **B8 measured 123 runtime exports against a ~20-name
  documented list, so satisfying this means ruling on ~103 names**, each of which either joins the documented
  surface or comes off the barrel. Two groups already have this question pending against them: B1b's
  `estimateOk`/`estimateErr` (nothing outside the module consumes them) and A1's `affordability/catalog-admission.ts`
  (three constants, three predicates). Report the disposition per group, not per name.
- No behaviour change: every package suite passes, with no test semantically modified beyond import paths.

**Files:** `packages/shared/package.json`, `packages/shared/src/index.ts`,
`packages/shared/src/affordability/index.ts`, tests.
**Scoped checks:** every package suite; repo-wide `pnpm typecheck`; `pnpm lint:unused`.
**Sensitive:** money — 2 independent auditors.

**Superseded material, retained because B8b discharges from it.** The following was B8's original inbox-flip
criterion. It is **not** B8b's work — B8b deletes, it does not rewrite consumers — but its errata are the
authoritative corrections over B1b's report and B8's inventory supersedes its counts:

<details>

- Every consumer on B1b's reported inbox is flipped from an internal path to the barrel; the
  enumerated list is discharged item by item, none deferred. **The inbox is 28 files / 102 references
  across 14 units** (20 in `apps/api`, 8 in `apps/web`), plus `packages/shared/src/models/premium-check.ts`
  if B2 has not already moved it inside. **Four of the 28 are re-export sites** —
  `estimate.ts` (`ratesFromPricing`), `smart-model-candidates.ts`
  (`CHARS_PER_TOKEN_CONSERVATIVE`, `classifierReserveLineItems`) and `use-reasoning-effort.ts`
  (`offeredEffortLabels`) — which **republish onward under local names**, so flipping them is a
  contract change for their own consumers, not an import edit. Treat those as the hard cases.

  **Corrected by B1b's audit — the site count was six, not four, and the two extra ones are invisible
  to grep.** `estimate.ts` re-exports **three** walled symbols, not one: `ratesFromPricing` plus the
  types `DeclaredCeiling` and `NodeStorage` (`:36-39`). And that republication continues through two
  files that carry **no affordability specifier at all**, so no specifier-driven enumeration can find
  them: `apps/api/src/slices/models/domain/index.ts:55` and `apps/api/src/slices/models/index.ts:38`
  — the latter putting the walled type `DeclaredCeiling` on the **models slice's own public barrel**.
  Nothing is stranded (both types appear in the inbox's `estimate.ts` row), but **deleting the 14
  interim entries is impossible until all three re-exports at `estimate.ts` are resolved**, and B8 was
  about to be told they were ordinary imports.

  **Errata over B1b's report — read these with its inbox table.** Both audits independently reproduced
  28 files / 102 references / 14 units exactly, so the totals stand; three annotations do not, and the
  orchestrator is correcting them here rather than spending an implementer cycle on a run-record file,
  because these are the artifact B8 discharges from:
  1. The hard-case list is the six sites above, not four (this section's correction).
  2. The row for `apps/web/src/hooks/billing/use-budget-calculation.test.ts` lists a `constants` unit
     with **no symbol** — that file has no `affordability/constants` reach at all. **A phantom item
     cannot be discharged**, so it either wastes a search or masks a real miss. Drop it.
  3. `packages/shared/src/models/premium-check.ts` reaches **five** walled units, not four —
     `../affordability/constants.js` also carries the walled `MINIMUM_OUTPUT_TOKENS`. Moot for G1 now
     that B2 moves the file inside, but recorded so the count is not re-derived wrongly.
  4. **B1b newly publishes `estimateOk` / `estimateErr` on both barrels**, and nothing outside the
     module consumes them. B8's set-equality-against-the-documented-list criterion is where these get
     ruled — either they join the documented surface or they come off the barrels.
  5. **A1 adds `affordability/catalog-admission.ts`** — three constants and three predicates, all on the
     affordability barrel (the floor comparison is rate arithmetic, so Global Constraint 4 puts it
     inside). Same disposition question as item 4: documented surface, or off the barrel.

  **B8 must additionally report, not decide:** whether a walled money type reaching a slice's public
  barrel is itself a wall breach. It is not caught by either barrel's absence test nor by G1 rule 6,
  which reads only the shared package's export map — the type travels out through an `apps/api` slice
  boundary instead. That touches slice-boundary doctrine rather than this module's wall, so it is a
  founder question if B8 finds the republication is load-bearing.

- **Delete all 14 interim per-unit subpath entries from `packages/shared/package.json`, and prove deep
  specifiers no longer resolve.** This is the criterion that actually closes the wall: B1b closed both
  barrels but had to open these to repoint external consumers, so until they are gone the money
  layer's internals remain reachable and `BILLING.md` §What is enforced is false. A probe asserting
  `error TS2307` (or the ESM equivalent) for a representative deep specifier is the evidence; the
  export map must end at exactly `.` plus `./affordability` among the affordability entries.

</details>

## Lane C — The classifier mechanism (depends on B2, B6)

**PRE-ANSWERED 2026-07-27 by a read-only investigation, before any lane-C dispatch. Where this contradicts an
earlier note or ruling sentence in this lane, THIS WINS — and where it contradicts the CODE, the code wins and is
named as such.** Every claim below was cited to file:line.

**Streaming is DERIVED, so C1's "two additive schema fields" criterion is wrong on that half.** `§How the decision
reaches the answer` states verbatim that streaming is withheld from any node whose output is consumed rather than
displayed — a property of the graph. The interpreter **already computes that set** (`consumedProducers()`), and the
grant already lives on the resolved execution object rather than the node type. The minimal change is to conjoin
consumption into the streaming decision at the single site where the node context is built. **No schema field, no
execution-registry change, no `model-call-execution.ts` change.** Blast radius is zero across every shipped
definition: all of them wire nodes only from the workflow-input node, which the consumption walk skips, so no
sibling loses its stream.

**The input-tag half IS unavoidable, and C1's file list misses the authorities.** A `modelCall`'s input tag is not
persisted on the node; the compile-time declaration comes from the node registry's port derivation, which hardcodes
a text input for every model, and a single port cannot express text-or-envelope because TypeTag v1 has no union. So
exactly one additive persisted field is required, and it must be honoured in **`engine/node-registry.ts`** and
**`engine/model-ports.ts`** — plus the Smart Model slot's own hardcoded ports, which are declared in two places.
None of those are in C1's list. Conversely `live-execution-registry.ts` and `execution-registry.ts` are **not**
needed under the derived-streaming shape.

**THREE MONEY CONSEQUENCES OF A TURN-LEVEL NODE, none previously in any criterion. Whichever task lands the
classifier node owns all three, and `docs/BILLING.md` now states them normatively.**

1. **The prompt storage fee vanishes.** It is not anchored — it is folded onto the charge at index 0. Charges land
   in declaration order, and a turn-level classifier node runs in an earlier level than the siblings, so it becomes
   index 0, the whole prompt fee attaches to a charge with no anchor, and settlement drops it.
2. **The all-siblings-failed detector stops firing.** "No charges" is the all-failed signal. With a classifier
   charge present, an all-fail turn has one charge, so the error never raises, the persistable set is empty, every
   charge is skipped — and settlement **commits successfully having persisted nothing and billed nothing while the
   client is told the turn succeeded.** User-visible, and the most serious of the three.
3. **The anchor rule has TWO implementations that must agree** — the debit path in the engine's settlement and the
   display path in the chat slice's settlement, hand-maintained while asserting non-drift "by construction". If
   they diverge, displayed cost stops matching the wallet debit. The chat-slice file is **missing from C2's Files
   list**, so C2 as scoped cannot land correctly; add it.

**ALREADY SATISFIED BY THE CLEAN B-SPINE — do not rebuild, and do not "fix" what is already right.** Both trial
arms consume the route's own character count. The classifier reserve is provider-only with no storage term, at both
the producer and the reserve layer. `runnable` already excludes outlier candidates while `all` keeps their rows — so
any criterion reading "reserve is MAX over candidates" must mean the **classifier-selectable** pool, or it
over-holds. And the effort union with per-model resolution, the downgrade rule and the mandatory carve-out are all
landed in one shared authority already. **Lane C's real risk is re-implementing these in `chat/domain`, not
building them.**

**STALE RULING TEXT, corrected here:** this lane's reserve predicate was ruled as `candidatePool.length >= 2`. The
landed code uses the **outlier-excluded** pool, which is what §Smart Model 3 requires. Follow the code.

**MISSING GRAPH EDGE — B8 → C3.** C3's criterion that the classifier is presented the `admissible` set cannot be
satisfied while `getTurnOptions` has zero production consumers; B8 is what wires it. Without this edge C3 will
re-derive the option set locally, producing a fourth implementation of a predicate this run has already unified
twice. **Treat B8 as a C3 dependency.**

**NOT C3's, and its criterion says otherwise:** "an explicit level is never rewritten to `auto`" is a **client**
defect, in a web hook outside every lane-C file list — it belongs to lane E. The same hook sends no effort at all
for a Smart Model turn, which makes the smart-plus-auto criteria unreachable end-to-end until lane E moves, so
H1's proof depends on an unowned change. Confirmed live and server-side, however: web-search turns skip the
pinned-auto classifier path, and the trial single-model path returns reasoning-free whenever there are ≥2 real
choices.

**Ruling carried into this lane from B3's audit — the reserve predicate, and why it is pool size.**
`classifierIsBoughtForTurn` decides "will a classifier run" from **`candidatePool.length >= 2`** — the pool,
not the presented set. Measured: a pool of three with exactly **one** presentable candidate still charges the
reserve, while §Reasoning Effort 5 says one option means no call and no reserve. **This stands, and C1/C2 must
use the same predicate**, for three reasons the audit established: the money direction is safe (over-reserve,
licensed by §Affordability 10); the dangerous direction is unreachable, since `runnable ⊆ pool` means a call
can never occur without a reserve; and **a naive collapse onto the presented set has no fixed point** — with
the reserve one candidate is presentable, drop it and three are, which re-buys it.

**The real exposure is this seam:** §Reserve ⟺ classify requires **one predicate shared by estimator and
executor**, so if C2's executor decides "one option ⇒ no call" while B3's estimator reserved, they disagree on
exactly the predicate the spec says must be shared. **Ruling: the shared predicate is pool size. The executor
MAY skip the call when the presented set collapses to one, and the unspent reserve is simply never charged** —
a hold that is not spent is released, so `reserve ⊇ bill` is untouched and "no call, no reserve" is an
efficiency preference rather than a correctness rule. §Reserve ⟺ classify's "exactly" is corrected in the
founder's doc batch to say so.

### C1 — The decision envelope

**DEPENDENCY RESOLVED 2026-07-27 — C1 depends on B6, NOT on B7, so the two run concurrently.** The ASCII graph is
ambiguous at this branch and neither section stated its own dependency, so this was settled on substance rather
than by parsing the diagram: C1 consumes the classifier prompt and the effort dimension registry, both of which are
B6's and now clean, and consumes nothing from B7, whose subject is notice copy. Their file sets are disjoint. The
graph prose agrees — it says lane C's first task "lands mid-spine rather than after it", which is only true if C1
runs beside B7. Recorded rather than acted on silently, so a reader who thinks this is wrong can see exactly what
it rests on.

**FILES-LIST EXTENSION, resolved before dispatch (fourth instance of this class, third caught in advance).** The
port authorities were missing and C1's central change cannot land without them: `engine/node-registry.ts` and
`engine/model-ports.ts` (a `modelCall`'s input tag is not persisted on the node — the compile-time declaration
comes from the registry's port derivation, which hardcodes a text input for every model), plus the Smart Model
slot's own hardcoded ports. Also `engine/interpreter.ts`, for the one-site streaming derivation.

**Conversely, two files C1 was expected to need are NOT granted and should not be touched:**
`engine/live-execution-registry.ts` and `engine/execution-registry.ts`. Under the derived-streaming shape they are
unnecessary, and needing them means the derivation was abandoned for a declared flag — which is a NEEDS_CONTEXT
stop, not a licence.

**Objective:** a runtime decision reaches N consumers through the existing single input port, with no
new node type and no relaxed compile invariant.

**Design context.** §Reasoning Effort → How the decision reaches the answer, and §Mechanisms rejected.
Verified: a `fanIn` node's arity comes from its registered reducer's type tuple; the capability schema
registry is **empty and was built for this**; node input is validated per node and every produced value
is type-checked at commit.

**Correction to earlier planning.** Withholding the classifier's stream is _not_ a single registration
flag. The grant is per-registration, but the model-call execution hardcodes streaming for the **whole
node type** — so making one call non-streaming needs a **second** additive workflow-schema field
threaded through the live execution registry. Two fields, not one, and the registry file is in scope.

**Acceptance criteria:**

- One registered decision-envelope schema — the **first** entry in the capability schema registry.
- One registered reducer taking the prompt and an optional classifier answer, returning the envelope:
  parse, clamp to the printed ceiling, and the declared fallback in one pure function.
- Two additive schema fields: the node's registered input schema, and its streaming disposition. No
  existing definition changes shape; pinned.
- **Compile-layer invariants untouched:** a test asserts the one-input-port rule is unchanged and still
  fires for a genuine violation.
- The classifier emits no stream event; pinned by asserting zero events for that node.
- The envelope flows through schema derivation and fails closed on a malformed value.

**Files:** `packages/shared/src/workflow.ts` (two additive fields), `apps/api/src/slices/workflows/engine/{workflow-capabilities,live-execution-registry}.ts`, the reducer, `apps/api/src/slices/workflows/nodes/model-call-execution.ts`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`; repo-wide typecheck.
**Sensitive:** money-adjacent — 2 independent auditors.

### C2 — Smart Model consumes the decision, and the charge lands

**Two forward items from C1's money audit, both currently unreachable and both yours.** (1) `anchorChargeKey`
still returns `undefined` for a bare top-level key, so a turn-level classifier charge would be **absorbed** until
you land the run-level anchor — C1 has made that a one-function change rather than two. (2) `finalizeStopped`
skips settlement entirely when sink outputs are empty, so **a user stop after the classifier runs but before any
sibling produces output would absorb the classifier's spend**. Confirm that against the carve-out that a user stop
settles its partial — this is the one path where "no output" and "nothing owed" are not the same thing.

**OWNERSHIP CORRECTION 2026-07-27 — MY ERROR, and it changes C2's anchor criterion for the better.** C1's brief
assigned it the three turn-level-node money consequences as its own; the ownership table assigns the settlement
files to C2. C1 followed the brief. The conflict was mine — I wrote the brief from the lane-C pre-answers without
reconciling it against the table.

Accepted rather than reverted, because the result is strictly better: **the anchor rule is now ONE function
(`anchorChargeKey`), not two hand-maintained implementations asserting non-drift "by construction".** That sync
contract was a finding against C2's scope; it is now closed. C2's criterion accordingly changes **one** function
rather than reconciling two, and C2 must **verify** the collapse rather than repeat it. C2's Files list still needs `chat/domain/settlement.ts` for its display path, and C2 still owes the one `smartModel` **builder** change: its `in` port is still typed text-only, though both of the slot's port authorities and its runtime prompt read already honour the envelope field.

Still C2's, unchanged: the `smartModel` builder's `in` port is still typed text-only (its two port authorities and
its runtime prompt read already honour the envelope), and the internal classifier path still exists for C2 to
delete, exactly as C2's criteria say.

**The dead `_pinned` parameter is NOT yours — it moved to C3 on 2026-07-27, and the reason is a file collision.**
Removing it is a two-sided edit: the declaration is `pickEffortClassifier` in
`apps/api/src/slices/models/domain/smart-model-candidates.ts`, the call site is in
`apps/api/src/slices/chat/domain/smart-model-turn.ts`. Both sides must move together or typecheck breaks, so one
task must own both. That file is simultaneously one of **B8's four re-export sites**, and B8 runs concurrently
with you — two tasks editing it at once is the collision this plan's ownership rule exists to prevent. C3 owns
`smart-model-turn.ts` already and runs after both of you, so it takes the pair atomically. Do not touch either
symbol.

**Objective:** one classifier per turn for the whole product, and its charge is billed rather than
silently absorbed.

**Design context.** The model dimension stays on the node holding the candidate set, because a `MAX`
over alternatives is only expressible there.

**The money bug this task exists to avoid.** The existing anchor helper resolves a charge's content by
stripping the last `#` segment of its key — it can only name its **own node's** content. That works
today because the classifier charge lives inside the Smart Model node. Once the classifier is a
turn-level node, a parent-strip resolves nothing, and settlement `continue`s past a charge with no
anchor — the "reserve is a lie" failure §Reasoning Effort names. Naming the classifier after the first
sibling does **not** fix it: when sibling 1 fails and sibling 2 persists — an explicitly supported
outcome — the anchor is undefined again and the charge vanishes.

**RULED 2026-07-27 by the orchestrator, from C2's first audit — BILLABLE ⟺ THE NODE'S VALUE WAS COMMITTED.**
C2's generalized rule 3 bills a charge whose node **failed**, and the report's justification ("a charge only exists
for a generation that SUCCEEDED") is false as stated: `collectCharge` runs BEFORE `commitValue`, so a generation
whose provider call succeeded but whose value fails the runtime `zodFor(out)` gate leaves a charge with no output.
Multi-model and media siblings are declared `onError: 'skip'`, so the run still succeeds — and that orphan charge
now anchors to the run's first persisted item, debiting the wallet **and** inflating that item's displayed cost,
where it was previously absorbed. The user is over-billed.

**This is not a design choice, it is documented behaviour being violated:** `BILLING.md` §Multi-Model 4 bills the
**successful subset**, and a node whose output failed validation is not in it. A `zodFor(out)` failure is our schema
or the model returning malformed output — platform fault, absorbed like a cost-circuit trip, never billed.

Of the auditor's two offered resolutions, the criterion is the **second**: mark the charges whose node committed a
value, and let rule 3 apply only to those. Narrowing the comments to "the provider call succeeded" was the other
option and is rejected — it would make the comment true by describing a behaviour we do not want, which is the
documentation-as-cover pattern this run has removed twice. The classifier charge keeps billing because its value
**is** committed and consumed by the `decideTurn` reducer; a validation-failed sibling stops billing because its
value never commits. One rule, and it distinguishes the two cases without a flag.

**A durable consequence of that ruling, recorded because it is counter-intuitive and a future reader will be
tempted to "fix" it: ACCRUAL STAYS ABOVE THE COMMIT.** Only _billing_ is gated on the value committing. The spend
of an uncommitted generation must still accrue toward the cost circuit — otherwise a model returning malformed
output repeatedly becomes **unbounded platform cost**, since each attempt costs real provider money while
contributing nothing to the circuit that exists to stop exactly that. Absorbed-but-counted is the correct
asymmetry: the user is not billed, and the platform's exposure is still bounded by `hold × K`. This must be pinned,
not merely true by construction.

**Acceptance criteria:**

- Settlement resolves a **run-level** anchor: the first persisted content item of the run in
  deterministic order. The anchor rule change is this task's scope, not just its caller.
- **Pinned on the failure shape that matters:** a multi-model turn where the first sibling fails and a
  later one persists — the classifier charge lands, with the right amount, on the persisted item.
- With an envelope present the slot performs **no** classifier call; pinned by call count.
- Reserve remains `MAX` over candidates; the hold is unchanged by this refactor; pinned.
- **The equivalence invariant** (§Smart Model 8): a Smart-Model-resolved model is sized exactly as a
  direct pick minus the classifier cost, on the same catalog and prompt.
- The internal classifier path is deleted; grep-clean.

**Files:** `apps/api/src/slices/workflows/nodes/smart-model-execution.ts`,
`apps/api/src/slices/chat/domain/smart-model-turn.ts`,
`apps/api/src/slices/workflows/engine/settlement.ts` (where `anchorChargeKey` is **defined**, line ~153),
`apps/api/src/slices/chat/domain/settlement.ts` (where it is **consumed**, line ~471 — the display path the
ownership correction above names), `apps/api/src/slices/workflows/engine/interpreter.ts` (**the stop path only** —
`finalizeStopped` lives here, and forward item (2) cannot be closed without it; C1 owned this file and is clean,
so it is free), tests.
**Grant widened 2026-07-27 for the fix cycle:** `workflows/engine/interpreter.ts` is no longer stop-path-only —
the billable-⟺-committed rule lives at the `collectCharge`/`commitValue` seam — and
`workflows/engine/{execution-registry,failures}.ts` are granted **for comment corrections only**, being sites whose
stated mechanism this task falsified.

**Verified on disk 2026-07-27**, because an earlier revision of this list named only one of the two settlement
files and omitted `interpreter.ts` entirely, which would have forced a BLOCKED mid-task on a file that was
already free. **Not granted:** `models/domain/smart-model-candidates.ts` — see the `_pinned` note above.
**Scoped checks:** `pnpm test:api`.
**Sensitive:** money — 2 independent auditors.

### C3 — Multi-model auto, the original blocker

**BLOCKED AND UNOWNED as of 2026-07-27 — `send_cannot_start` CANNOT be deleted yet, and the reason is a real
product gap, not a scheduling one.** C3's first mapping sent `budget-exceeded` to `group_owner_funds_unavailable`
and **the suite refuted it** — three tests failed, including "refuses a free-tier turn once the daily allowance is
spent". `budget-exceeded` is **two conditions whose actions point at different people**: a group owner's budget, or
the sender's own daily allowance. `AdmissionRefusalReason` does not carry which, and the scope lives in
`billing/domain/admission.ts`. C3 narrowed to `run-cap` — closing the named lie rather than **replacing one wrong
sentence with another**, which is the right instinct and worth keeping as the standard for copy fixes.

Deleting the catch-all therefore needs **two** things and has **no owner**: (1) carry the refusal scope through
`AdmissionRefusalReason` so the two conditions are distinguishable, in billing; and (2) a decision on the
**cost-circuit trip's** own copy — `INSUFFICIENT_ADMISSION` has three producers, and a trip is a run that **started
and was killed**, not a refusal to start at all, so it needs its own sentence rather than a share of one. That second
half is a product-copy question, not a refactor. **Flagged to the founder; not assigned.**

**Added item — DELETE the catch-all when you un-collapse, do not keep it.** B7 minted `send_cannot_start` as an
honest condition-neutral sentence for the collapsed admission code. Once you give each admission reason its own
wire reason, that entry must be **removed**, not left as a fallback: a permanent catch-all silently re-absorbs
every new condition added later, which is the defect it was created to stop. B7 recorded this in the entry's own
docblock; this is the owning task's copy of it.

**Added item — THREE REFUSAL CONDITIONS STILL SHARE ONE WIRE REASON, and one of them tells the user something
false.** B7 delivered typed reasons and copy for the per-wallet concurrent-run cap and for a group refusal caused by
the owner's wallet moving, but both still collapse into a single admission refusal in `chat/domain/runtime.ts`,
whose reason set is only `insufficient-balance | run-cap | budget-exceeded`. Consequence today: **a run-cap refusal
renders as "Your balance can't cover this message"** — a user with ample balance is told they are out of funds, and
the action offered is to pay. That is §Notices' one-wording-per-condition rule broken in the direction that
misleads. You own the chat refusal mapping: widen the wire reason so each condition carries its own, and wire the
two vocabulary entries B7 shipped without producers (`funds_held_by_run`, `group_owner_funds_unavailable`).

**Added item — the FOURTH `B + H` site is unpinned and this file is yours.** B6 collapsed the effort resolvers and
pinned the boundary property everywhere it owned, but `nodeAnswerCap` in `chat/domain/turn-definition.ts` is a
fourth site solving the same equation and sits in no Files list B6 had. B6 verified by reading that it shares the
canonical wire-budget derivation, and established the true statement there is **`cap ≤ B + H`, not equality**,
because it is the stamping direction rather than the partition direction. Pin that inequality here; an unpinned
fourth site is how the property this run spent a task establishing quietly stops holding.

**Added item — narrow the classifier's option list to the PRESENTED subset.** B6 ships the classifier the effort
dimension's **full declared domain** rather than the turn's presented subset, because narrowing it needs the
executor and the classifier message builder, neither of which B6 owns. B6's argument that this cannot produce an
infeasible plan is accepted for now, but the standing rule is that the classifier is presented `admissible` and
never a wider set — so close it when you repoint the executor, and pin the narrowing rather than the argument.

**CLOSED 2026-07-27, do not re-open — recorded because a stale routed item costs a later task a cycle.** This
section previously carried an item saying the trial Smart Model path prices the system prompt but not custom
instructions, while the single-model gate prices both. B5 closed it **at the root** in its second fix cycle: the
local recount was deleted, `TrialSmartModelCandidatesInput` now takes the prompt character count, and
`smart-model-turn.ts` forwards the route's own figure — so **both trial arms consume the one count the route
builds**, custom instructions included. The reachability bound originally attached to it was withdrawn in writing
by its author; the real escape band was `outputRate < 2.5 × inputRate` (20 of 81 live models, worst overshoot 21.6%
of the 1¢ cap, reproduced at 1.192¢), not the inverted-rate shape first claimed. C3 owes nothing here.

**Objective:** `auto` on a multi-model turn resolves through the classifier for every sibling.

**Design context.** §Turn Stories 2 is the step-by-step specification. This is the promise the run
stopped on; the interim reasoning-free behaviour is deleted here.

**Acceptance criteria:**

- The ladder is pruned against pinned siblings first; a level infeasible for any pinned sibling is gone
  turn-wide.
- Each candidate carries its own effort ceiling, capped by the tightest pinned sibling; candidates with
  no feasible effort are excluded.
- **The classifier is presented the `admissible` set, never `affordable`.** §Affordability calls this
  the one place where the wrong set is a money defect. Pinned: with a live hold, an option present in
  `affordable` and absent from `admissible` does not appear in the prompt.
- **The classifier engine is chosen from the post-admission priceable pool.** A fixture containing an
  excluded free model asserts it is never the engine — this is what makes §Catalog Admission
  load-bearing rather than decorative.
- One classifier call carries both dimensions on **labelled** lines; a test pins that a third dimension
  does not break the parser.
- The chosen effort applies to all siblings, resolved per model; each sibling's wire cap is its own
  budget plus its own headroom.
- An explicit level on a multi-model turn is never rewritten to `auto`; pinned (a live defect today).
- Web-search and trial `auto` turns run the classifier. **The trial smart path** substitutes the fixed
  per-message ceiling for a wallet and runs the same math, classifier included; pinned.
- **Partial-success billing** (§Multi-Model 4): a three-sibling integration test over the three
  outcomes — partial, all-fail, explicit stop — asserting charge counts. All-fail persists and bills
  nothing.
- **The last successful sibling becomes the fork tip**; pinned on three siblings.
  **ROUTED TO H1 ON 2026-07-27, and the argument is accepted rather than tolerated.** C3 left this open on judgement,
  not budget: every version buildable in a unit fixture **asserts arithmetic over numbers the fixture itself chose**,
  and deriving the maximum billable independently is the golden cross-check Global Constraint 5 bans. A property test
  that can only restate its own inputs is the vacuity class wearing a property's clothes. It needs **real provider
  costs against a real hold**, which is H1's territory. Moved there rather than forced here.

**A DOCTRINE CALL C3 MADE AND I AM UPHOLDING: a classifier that THROWS still kills the run, deliberately.** C3 wrote
that test, watched it fail, and **deleted the test rather than change engine semantics** — a throw is a defect by
doctrine, and adapters convert _expected_ inference failures into typed `Result` errors, so the production path
degrades through `onError: 'skip'` as designed. The deleted internal path's catch-any-throw is **not** restored:
restoring it would convert defects into silent degradation, which is the opposite of fail-fast. Graceful degrade
covers expected failures; it does not cover bugs.

- **`reserve ⊇ bill` over reachable outcomes**, not just the shared-ceiling inequality: a property or
  fuzz test asserting `hold ≥ Σ charges` across partial success, deadline partial, user stop and
  cost-circuit trip.

**Added item, inherited from C2 on 2026-07-27 — remove the dead `_pinned` parameter, both sides in one edit.**
`pickEffortClassifier`'s `pinned` argument became dead when B6 made the pinned-model auto-effort path price an
empty model list; lint forced it to `_pinned` and B6 left a comment saying it selects nothing, because the fix
reached outside B6's grant. It reached outside C2's too: the declaration lives in
`models/domain/smart-model-candidates.ts` while the call site is in `chat/domain/smart-model-turn.ts`, and that
first file was one of B8's re-export sites while B8 and C2 ran concurrently. By your turn both are clean and the
file is free, so **you own both sides and must remove them together** — a parameter that exists only to satisfy a
linter teaches the next reader the wrong thing about what the function selects on, and half the removal does not
typecheck.

**TWO ITEMS FROM B8 (2026-07-27), and the first is the defect family this run keeps removing.**

- **TWO FALLBACKS ANSWER ONE QUESTION.** C1's `turn-decision.ts` declares `CLASSIFIER_EFFORT_FALLBACK = 'medium'`,
  while §Reasoning Effort 8 and the dimension registry make the fallback **the cheapest presented option** — which
  is `off` for a model whose reasoning can be disabled, not `medium`. B8's `chooseFrom` follows the spec. So a
  classifier answer that cannot be resolved lands on `medium` in one path and `off`/cheapest in the other. B8
  correctly refused to rule on a file it does not own. **Collapse them onto the spec's rule — the cheapest presented
  option — and delete the constant, or state which is authoritative and why.** Two numbers answering one question is
  the family B3 spent four cycles removing and B8 was told not to recreate.
- **§Reasoning Effort 6 is not true end-to-end yet.** `buildClassifierSystemPrompt` still prompts the **declared**
  effort domain (`Min | Lite | Low | Mid | High | Max`) while the produced set is `Min | Low | Mid | High`. B8
  verified both sides and pinned them so the divergence cannot be lost, but closing it edits a C2 file. This is the
  same item already recorded above as narrowing the classifier's option list to the presented subset.

  **CORRECTED 2026-07-28 — I wrote that the narrowing "is a call, not a rewrite" onto B8's `renderOptions`. It is
  not.** C3 narrowed through `buildClassifierSystemPrompt({ effortOptions })` instead, and **`renderOptions` still
  has zero production consumers.** Both compose the classifier prompt's option and model sections, but **only
  `buildClassifierSystemPrompt` is what `computeClassifierPromptOverhead` prices** — so whoever later wires the
  Smart-Model-slot arm through `renderOptions` would render a prompt **the reserve does not price**. The second
  composer survives, and that is a live trap for the next arm rather than a tidiness note.

### The classifier-marker question — analyst findings and the rulings so far

**C3 stopped here with zero files changed, and it was right to.** A classifier `modelCall` cannot be recognised at
execution: no field on the variant marks it, `params` is closed by `z.strictObject` at the language adapter, **and**
— the analyst added this — `Node` variants are `z.object` while the DO re-parses the definition at ingest, so an
unregistered property is **silently stripped**. Attaching a property is not unclean, it is a no-op.

**TWO OF C3's CLAIMS WERE REFUTED by the analyst, and both widen the option set:**

1. _"The producer must be a reducer, which sees only graph values."_ **False.** Workflow inputs are a first-class
   run-start channel, and `chat/routes.ts` already supplies `{ prompt: … }` while holding the normalized history
   **and** the funding decision. A classifier prompt can therefore be rendered outside the node, by the one place
   that has both the history and the admissible set. Bound: `ContentValue` is `text | bytes | media`, so a rendered
   **text** prompt rides today's channel unchanged while a `json` envelope would not.
2. _"The estimator may not see enough graph structure."_ **False — and this was my hypothesis, not C3's.**
   `createEstimateRun` receives the whole `WorkflowDefinition` and iterates `definition.nodes`, which includes
   `fanIn` nodes with their `reducer` and `ins: PortRef[]`. The derivation is computable **at admission, before
   execution**. I raised this as the thing most likely to sink the derived option; it does not.

**RULED BY THE ORCHESTRATOR — §C1's execution-registry clause does NOT bar the derived option.** That clause says
needing `engine/execution-registry.ts` means "the derivation was abandoned for a declared flag — a NEEDS_CONTEXT
stop". It was written to stop a **declared flag** being smuggled through that file. A **derived** fact travelling the
same route is the opposite case, and reading the clause literally would forbid precisely the shape this run prefers.
The clause is scoped to declared flags; carrying a derived fact through `execution-registry.ts` is permitted.

**THE C1 PRECEDENT IS EXACT, INCLUDING ITS MECHANISM.** Streaming suppression is not a flag — the interpreter
**withholds an existing ctx member** (`emit`) when building `nodeContext`. The same function builds `history` and
`customInstructions` from the request, so withholding _those_ for a derived-classifier node is byte-for-byte the same
move with zero new surface.

**TWO OF THE FOUR SITES ARE SMALLER THAN STATED.** The output cap needs no recognition at all —
`params: { maxOutputTokens: … }` is legal today. And the estimator's storage exclusion is **not a classifier rule**:
settlement persists **sink** outputs, so the correct fix is _a node whose output is consumed is never persisted and
therefore reserves no output storage_. That is the same walk C1 landed and it fixes a **class**, not one node.

**A FIFTH UNDER-RESERVE TERM, FOUND BY THE ANALYST AND OWNED BY NOBODY.** `inferLanguage` sets the turn system prompt
**unconditionally**, while the classifier reserve prices only the 4,000-char context plus template overhead. The base
preamble is ~2.6 KB, so a classifier call's input leg carries roughly **+2.3 KB against a 4,000-char priced budget** —
an unpriced ~55% input-leg overshoot. It **pre-dates this run** (the deleted internal path had it too) but it binds
the moment the classifier reserve is claimed exact. No option below closes it without a suppression signal on
`InferenceRequest`. **Awaiting founder ruling.**

**FOUNDER RULING 2026-07-27 — OPTION A: RECOGNITION IS DERIVED. This is the design C3 implements.**

1. **The predicate is one shared function**, placed beside `smartModelClassifierDimensions` in
   `packages/shared/src/workflow.ts` — the file that already holds a one-derivation/two-readers precedent consumed by
   both the estimator and the executor. A `modelCall` `M` **is** the classifier iff there exists a `fanIn` `F` with
   `F.reducer === 'decideTurn'` and `F.ins[1].node === M.id` (the optional-answer port). One authority; a node cannot
   disagree with the graph about what it is.
2. **The negatives are WITHHELD, not flagged.** The interpreter builds `history` and `customInstructions` into
   `nodeContext` in the same function where it withholds `emit` for consumed producers. Withhold those two for a
   derived-classifier node — byte-for-byte the same move C1 already landed, and no new node surface.
3. **Storage is excluded by the CLASS rule, not a classifier exception.** Settlement persists **sink** outputs, so
   the correct statement is: _a node whose output is consumed is never persisted and therefore reserves no output
   storage._ `tokenNodeStorage` currently applies to every `modelCall` unconditionally. Fix the class. **This also
   falsifies `estimate-run.ts`'s existing positive-filter comment** ("the filter is what guarantees it") — it must
   state the new authority, or it becomes exactly the kind of falsified comment §Known Breakage's vocabulary-sweep
   rule targets.
4. **The prompt is rendered at the route onto the existing text input channel.** `chat/routes.ts` already supplies
   `{ prompt: … }` as a workflow input and already holds the normalized history **and** the funding decision — so it
   is the one place that can render the marker, the option lines and the truncated context with the **admissible**
   narrowing applied. The classifier node's `in` points at that input. Bound to respect: `ContentValue` is
   `text | bytes | media`, so this must be **rendered text**, never a `json` envelope.
   **RULED 2026-07-27: PUBLISH them through the workflows barrel**, do not move them into `chat`. C3 recommended this
   and it is right — the helpers are engine-side prompt machinery consumed by a slice, which is what a barrel is for,
   and moving them would put workflow prompt assembly inside the chat domain. Publishing is the smaller, reversible
   change.
5. **The output cap needs no recognition at all** — `params: { maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP }` is
   legal today. That constant currently has no production consumer outside the reserve formula; wire it.
6. **PRICING STAYS AT THE DECLARED MAXIMUM, DELIBERATELY.** The estimator reads definitions, never input values, so
   it cannot see the route-rendered narrowed list. The reserve therefore keeps pricing the declared effort domain.
   That **over-reserves**, which is the safe side of `reserve ⊇ bill`, and the founder accepted it rather than
   putting the option list on the node. The consequence to state plainly in code and report: the hold is larger than
   the narrowed prompt strictly needs. Do not "fix" this by declaring the list — that was the rejected option.
7. **FOUNDER RULING — SUPPRESS THE BASE SYSTEM PROMPT for classifier calls.** `inferLanguage` sets the turn system
   prompt unconditionally. **Magnitude corrected 2026-07-27 by measurement:** the base preamble is **1,739 chars**,
   not the "~2.6 KB / +2.3 KB" the analyst estimated and I recorded, and the real priced basis is
   `classifierReserveChars` = **4,929 chars**, not 4,000 — so the unpriced overshoot was **35.3%**, not ~55%. The
   direction and the ruling are unaffected; my figure was high by about a third, and it was an estimate carried into
   the plan as though measured.
   Add a suppression signal to `InferenceRequest` so a classifier call sends no base preamble. This lowers real spend
   **and** makes the existing reserve honest — the founder chose it over merely widening the reserve's budget. It
   touches the ModelProvider seam, which is accepted. **Grant extended: `packages/shared/src/inference.ts` and
   `apps/api/src/slices/models/adapters/language-adapter.ts`.**

**Four pins this design must carry** (the analyst verified each is RED today):

- A run wired `classify → decideTurn → siblings` issues a provider request with **no `history`** and **no
  `customInstructions`** — red today, both forwarded unconditionally.
- For a persisting multi-model auto definition, the hold contains **no output-storage term for the consumed node** —
  red today.
- The classifier request's `parameters.maxOutputTokens === CLASSIFIER_OUTPUT_TOKEN_CAP` — red today, the constant has
  no production consumer.
- `reserve ⊇ bill` on the **real assembled request**, counting the base system prompt — red today under any option
  until item 7 lands.

**SECOND-ORDER FINDING THAT COSTS NOTHING:** the classifier double-pricing is derivable from **already-declared**
data — `smartModel.inputSchema !== undefined` means the decision arrives from outside, so `estimateSmartModelNode`'s
internal classifier reserve should be zero for such a node. That is the same field the runtime already uses for the
same fact, it needs no new surface, and it is in C3's granted `estimate-run.ts`.

**FOUR MORE ITEMS FROM C2's FIRST AUDIT (2026-07-27) — three deleted properties with no home, and a second
under-reserve term.** C2 deleted ~18 classifier-internals unit tests as "covered elsewhere". The auditor checked
that claim per property and found it true for five groups and **false for three**, all of which are properties of
the classifier node **you** wire, so the deletions are defensible but the properties are now unguarded:

- **(a) The classifier call's output cap is applied nowhere.** `CLASSIFIER_OUTPUT_TOKEN_CAP` is referenced only by
  the estimator — nothing applies it to an actual request. The reserve prices a cap the request does not enforce.
- **(b) The classifier receives no conversation history** was an explicit property of the deleted path; nothing
  pins it now.
- **(c) Graceful degrade on classifier failure is gone.** The old path fell back to the cheapest candidate with no
  charge. A classifier `modelCall` **without `onError: 'skip'` fails the whole run**, and nothing pins the skip.
  This is the one of the three that turns a routing hiccup into a dead turn.
- **(d) A SECOND under-reserve term, compounding the history one above.** `model-call-execution.ts` (~`:206,213`)
  forwards `ctx.customInstructions` onto **every** `modelCall`. The deleted code excluded them from the classifier
  deliberately — "custom instructions shape the ANSWER only — the classifier is routing internals". Wired as an
  ordinary node, the classifier carries the full history **and** the custom instructions against a reserve priced
  on a truncated 4,000-char context. Same direction as (2) below, doubled: pin the reserved-vs-billed input
  amounts with custom instructions present.

**THREE ITEMS ROUTED FROM C2 ON 2026-07-27, and the first two are money defects that would violate
`reserve ⊇ bill` or over-hold if you wire the classifier node without closing them.**

1. **The classifier node gets priced TWICE.** Once the classifier is an ordinary `modelCall`, the generic
   `modelCeiling` path in `models/domain/estimate-run.ts` prices it **on top of** `estimateSmartModelNode`'s
   existing reserve. Direction is safe for the invariant (over-reserve, not under) but the amount is wrong and an
   inflated hold refuses sends the user can afford. `estimate-run.ts` was in **neither C2's nor C3's Files list** —
   my omission, and C2 was right that C3 cannot satisfy its criteria without it. **It is granted to you below.**
2. **The classifier's input leg is UNDER-reserved, which is the invariant-breaking direction.**
   `apps/api/src/slices/workflows/nodes/model-call-execution.ts` (~`:205,212`) forwards the **full run history** on
   every `modelCall`, while the classifier reserve prices a **truncated 4,000-char context**. While the classifier
   lives inside the Smart Model node this never binds; the moment it becomes an ordinary node, billed input can
   exceed reserved input. C2 found this while reshaping a live-run test and deliberately left it unpinned because
   wiring is yours. **Pin it with the amounts: reserved input vs billed input on a run whose history exceeds
   4,000 chars.** Either truncate what the classifier node is sent to match what was priced, or price what is
   actually sent — one of the two, never a comment asserting they agree.
   **THE INTERSECTION CLAMP WAS WRONG IN BOTH DIRECTIONS, AND ONE FIXTURE SHOWS BOTH (E1, 2026-07-28, measured against
   the real producer rather than reasoned).** With siblings `A={low,high}` and `B={low,medium,high}`, the producer returns
   `off`/`low` available and `medium`/`high` marked `model_output_cap_too_low`. The intersection therefore **HID
   `medium`** — only `B` offers it, but **per-model resolution falls downward, so the turn can honour it** — and
   **ENABLED `high`**, which both siblings name and **neither can fund**. A clamp built to be conservative was
   simultaneously too strict and too permissive, on the same selection.
   The replacement clamps against the **union** and lets the producer mark each rung, which is the same correction as
   premium: **the menu presents, the producer decides.** Retiring it reddens six pins under the hide-shape inversion.

**CORRECTION 2026-07-28 — THE TWO-VERDICT STATE IS CLOSED FOR THE GATE, NOT FOR THE EXPLANATION, and I reported it
as fully closed.** E1's auditor found that `sendRefusal` (`'funds_held_by_run'`) has **no render consumer anywhere in
`apps/web`** — it is folded into `hasBlockingError` and nothing displays it. The composer's only rendered explanation
still comes from `generateNotifications` over `useResolveBilling`, **a second client-side affordability comparison**,
which in exactly the hold case returns `denied/insufficient_balance` and renders _"Your balance can't cover this
message. **Add credit**…"_.

**That is the B7 defect class alive at the rendered surface, and §Notices 9 forbids it by name** — "no payment
action — paying would not help, so offering it would be a false path". Worse, the send is disabled, so the user
cannot discover the block is transient. `grep "Wait for"` across `apps/web/src` returns **zero product hits**: the
correct copy exists, is derived, is pinned, and is never shown.

So the gate reads one verdict while its explanation reads another. **A derived value that nothing renders is not a
closed loop** — and the criterion "exactly one hold notice renders" is unmet at every rendered surface while
impl-report-11 marks it met.

**CLOSED 2026-07-28 — the two-verdict state is gone.** Picker, adapter, selection store, both choice-hooks and now
the composer all read one produced value. The demonstration is the case the whole two-set design exists for, both
sets from **one call** at funding `{spendable: 0, held: 100e9}`: **`affordable`** prices against `spendable + held`
= 100e9, so `sendable: true` and **every row available** — the picker greys **nothing**; **`admissible`** prices
against `spendable` = 0, so `sendable: false` and the composer refuses with **`funds_held_by_run`** ("Wait for it to
finish, then send again"). The contrast case — nothing held, no funds — falls out of **both** sets, so the picker
greys _and_ the reason is money.
**THE CLOSURE ARGUMENT IS FALSE, AND I RECORDED IT AS PROVEN. Corrected 2026-07-28.** I wrote that because
`admissible ⊆ affordable` holds, "exactly three states exist and the middle one can only be a hold". **The two sets
differ in TWO inputs, not one — funding AND basis** — which `turn-options.ts`'s own header states explicitly. So a
payer with **zero holds** lands in the middle state whenever the composed basis refuses: verified by execution at
`heldNanoUsd: 0n`, a long history gives `affordable.sendable=true` with `admissible.refusal='prompt_too_long'`, and a
low balance with a long history gives `insufficient_funds`. **Both render "Wait for the message to finish" to a user
with nothing running**, whose real action is to shorten the message or add credit. That breaks §Notices 2, 3 and 4's
precedence ladder and the criterion's own "distinct copy" requirement.
I accepted a subset relation as a closure proof without checking what else varies between the two calls. The
derivation must key on the actual refusal, not on the difference between the sets. Both inversions bite: gating on
`affordable` stops the hold blocking; collapsing the pair makes the hold borrow the money wording, which would offer
payment for a condition payment cannot fix.

**A SECOND TRANSIENT STATE THAT MUST NOT SHIP, alongside C3's:** E1's midpoint leaves **two verdict paths
coexisting** — the new adapter hook and the old `useModelFloor`. That is the intended ordering (the adapter had to
exist before any surface could move onto it) and E1 named it itself as "the exact state E1 exists to end". The close
phase must verify one verdict engine remains, exactly as it must verify C3's classifier wiring landed. Two
half-states, both disclosed by their own implementers, both invisible to a passing test suite.

3. **You are closing an interim product regression, so it must not outlive you.** C2 delivered the mechanism
   without wiring it, which the lane-C ruling licenses; the consequence is that until you wire the node,
   `buildSmartModelTurn` binds the cheapest candidate at `CLASSIFIER_EFFORT_FALLBACK` and **classifies nothing** —
   routing quality only, with the reserve held and never spent. **This is the one interim state in the run that is
   a user-visible product regression rather than a neutral half-build, so C3 must not be deferred past the run's
   close, and the close phase must verify the wiring landed.**

**FILES-LIST ERROR, found by C3 and corrected 2026-07-27 — my second grant error on this task.** The refusal-mapping
grant named `chat/routes.ts`, but all three admission reasons collapse onto one wire code in
**`chat/domain/runtime.ts` (~`:599-613`)**. Deleting the `send_cannot_start` catch-all therefore also edits
`packages/shared/src/error-codes.ts` (~`:162`) and `packages/shared/src/affordability/notices.ts` (~`:81,223`).
Billing's typed reason set already carries all three and needs nothing.

**SCOPE CORRECTION from C3, and it changes a criterion above:** the classifier double-pricing **only binds where a
`smartModel` node coexists with a turn-level classifier** — the Smart-slot-as-sibling shape and
`compileAutoEffortTurn`'s pinned+auto. A pure multi-model auto turn has **no `smartModel` node at all**, so nothing
double-prices there. The required pin is therefore **two figures, not one**: the coexisting shape and the pure shape.
The criterion above said one; C3 was right and it is corrected here rather than in a brief.

**REACHABILITY OF THE ARMS C3 DID NOT BUILD, from C3's own assessment — and one of them carries a money risk.**
Single-model `auto` and the Smart-Model slot are **cheaply reachable**: same `classify → decideTurn → slot` shape,
and C3's `inputSchema` guard already zeroes the slot's internal reserve. The **web-search arm falls out of
single-model `auto` with no new mechanism**, which is why it is H1's. **Trial `auto` is the same shape plus one
extra check, and that check is a money check: its 1¢ ceiling must still cover the classifier now that the classifier
is priced as an ordinary node.** B5 fought that cap once already — a trial arm reserving a classifier it did not
previously price is exactly how a 1¢ cap gets breached, so whoever wires trial `auto` prices it before wiring it.

**Files:** `apps/api/src/slices/chat/domain/{turn-definition,turn-reasoning,smart-model-turn,runtime}.ts`, `apps/api/src/slices/models/domain/smart-model-candidates.ts` (the `_pinned` declaration only), `apps/api/src/slices/models/domain/estimate-run.ts` (the double-pricing fix), `apps/api/src/slices/workflows/nodes/model-call-execution.ts` (the classifier context/reserve reconciliation), `packages/shared/src/error-codes.ts` and `packages/shared/src/affordability/notices.ts` (deleting `send_cannot_start` only), tests. **Pending the marker ruling, the grant may extend to `packages/shared/src/workflow.ts`, `workflows/builder/model-call.ts`, `workflows/nodes/turn-decision.ts` and `smart-model-execution.ts` — see §The classifier-marker question.**
**Ordering note:** B8 also holds `models/domain/estimate-run.ts` for its walled-type unwind. B8 runs before you, so the file is serialized, not shared — but read what B8 landed there before editing it.
**Scoped checks:** `pnpm test:api`, `pnpm test:shared`.
**Sensitive:** money — 2 independent auditors.

## Lane D — Persistence and display (depends on C2)

### D1 — Persist the resolved effort

**Objective:** each generation records the effort it actually ran at.

**Design context.** §Reasoning Effort 10. It goes on `llm_completions`, beside `reasoningTokens`,
because that table holds language-specific facts while the content row holds modality-agnostic
display data — and because the history read already joins it. A nullable pgEnum: null when the
concept does not apply, `off` when the user chose Min. **No capture point exists today** — the
resolved value is computed and consumed immediately, so it must be threaded from the node's billing
metadata through the settlement charge into the row.

**Acceptance criteria:**

- New pgEnum and nullable column; migration generated and committed with the schema change; the db
  shape-test registry updated.
- Threaded end to end: resolved effort → node billing metadata → settlement charge input → row.
  An integration test on a real turn asserts the persisted value.
- Null versus `off` distinguished, pinned: a non-reasoning model persists null, an explicit Min
  persists `off`.
- **Totality, scoped to text**: every persisted assistant **text** content item has an
  `llm_completions` row, so the badge can never be missing its data. Media items have no such row —
  scope the assertion or it passes vacuously.

**ACCEPTED 2026-07-28 — a registered `modelCall.reasoningEffort` field, and the argument for it is falsifiable rather
than stylistic.** The founder's derived-over-declared ruling governs **recognition** of the classifier; this is a
different question. **The wire is provably lossy: two rungs whose budgets clamp to one ceiling mint an identical
`{max_tokens}`**, so reading the level back off the wire would render a **false downgrade badge** — D1 pinned that
with a test rather than asserting it. A decision outcome that cannot be recovered from what was sent must be
recorded, and `promptInputTokens` is the standing precedent for an admission-derived declaration stamped onto a node.
`params` was not available: `z.strictObject` at the language adapter rejects unknown keys.

**MY FILES LIST WAS STALE AND D1 WAS RIGHT TO EXCEED IT.** It predates C3 moving the classified path into
`model-call-execution.ts`, and it omitted the middle links of its own chain — a list naming both ends of a thread and
neither of its knots. D1 additionally edited `shared/{flow-executor,workflow,reasoning-effort,reasoning-plan}.ts`,
`workflows/{interpreter,model-call-execution,builder/model-call}.ts`, `billing/{ports,adapters,index}` and
`chat/domain/turn-definition.ts`, none owned by B9 (`models/**`) or E1 (`apps/web/**`). Disclosed, non-colliding,
accepted.

**A BEHAVIOUR CHANGE IN THE MONEY PATH, disclosed rather than buried:** `writeGenerationDimension` no longer skips
the completion row for a text generation that reported no usage (counts fall to 0). Required by the totality
criterion — **without it an aborted partial persists an answer the badge can never describe.** Auditors must judge
whether anything downstream assumed that row's absence.

**HANDOFF TO D2, and it is the kind that prevents a silent wrong number:** the classifier's charge anchors to the
run's first persisted content item, so **that item carries TWO `llm_completions` rows** — the answer's, with a level,
and the classifier's, null. **D2's per-item read must TAKE the non-null row, not fold like the reasoning-token read
sums.** A fold over two rows would produce a number no rung corresponds to.

**Known limitation, failing in the safe direction:** a `smartModel` slot carrying a pinned **non-off** wire records no
level. Unreachable from today's builder, which stamps only the hard-off wire, and it fails toward a **missing badge,
never a wrong rung.**

**Files:** `packages/db/src/schema/{llm-completions,enums}.ts` + migration, `apps/api/src/slices/workflows/engine/{execution-registry,settlement}.ts`, `apps/api/src/slices/billing/domain/charge.ts`, `apps/api/src/slices/workflows/nodes/smart-model-execution.ts`, plus the chain links above, tests.
**Scoped checks:** `pnpm test:db`, `pnpm test:api`; migration drift gate.
**Sensitive:** money-adjacent, schema — 2 independent auditors.

### D2 — The effort badge

**Objective:** the answer shows what effort it ran at, using the Smart Model badge component.

**Design context.** The Smart chip lives in the assistant nametag component and is driven by a
boolean on the message. The effort badge sits beside the model name using **the same component**.

**Implementation trap, stated because it is easy to get wrong:** the existing per-content-item
helper **sums** `reasoningTokens` across the several completion rows of one item — one per agentic
step. Summing is right for tokens and **wrong for an enum**. The level is constant across a turn's
steps and must be taken, not aggregated.

**Acceptance criteria:**

- The level reaches the client through the history read and the finish frame, mirroring how the
  token count already does.
- The badge renders beside the model name, reusing the existing chip component; absent level ⇒ no
  badge; `off` ⇒ a Min badge.
- A test pins take-not-sum across a multi-step generation.
- The multi-model case: each sibling's badge shows its own resolved level, so a downgraded sibling
  says so.

**Files:** `apps/api/src/slices/conversations/{adapters/stores.ts,domain/history.ts,ports/stores.ts}`, `packages/shared/src/schemas/api/{conversations,sse-events}.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/chat/message/message-item.tsx`, tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`, `pnpm test:shared`; repo-wide typecheck.
**Sensitive:** no.

---

## Lane E — Client surfaces (depends on B5, B6, B7, B8)

### E1 — Every surface renders the produced sets (depends on B5, B6, B8, F3)

**RULED 2026-07-27 — E1 IS THE TEXT ARM ONLY, and the media pricing builder SURVIVES.** E1 probed
`turn-core.ts`'s `evaluateTurn` and found it returns `refused('modality_not_priceable')` for every non-text
modality — image yields `all: []` and no sendable arm — so criterion 1 read literally makes every media turn
unsendable, while criterion 2 deletes the pricing builder the media arm still needs. **Founder ruling: narrow E1 to
text.** The existing media pricing path stays untouched until G2 (the media cost hook) and E4 (the modality panel)
land. **Two pricing paths therefore coexist after E1, and this plan says so rather than implying the builder is
gone** — criterion 2 is satisfied when no TEXT-modality surface prices anything, not when the builder is deleted. No
task currently makes `evaluateTurn` price media; that stays out of scope, and `turn-core.ts` remains outside E4's
list.

**E1 now depends on F3**, which serves the free-tier allowance and the trial count; without it, driving greying from
`affordable` refuses every send for every free user.

**Out-of-grant files E1 reports it must touch — resolve before re-dispatch:** `chat-layout.tsx`, `chat-header.tsx`,
`chat-layout-helpers.ts` and `chat-welcome.tsx`. The last is not a threading detail but a **fourth verdict site**: it
derives `canAccessPremium = isAuthenticated && balance > 0` from the balance endpoint, which is criterion 3's own
violation sitting in a file E1 was not granted. All four are added to E1's Files list.

**Brief correction, recorded against the orchestrator:** money copy's single home is `NOTICE_COPY` / `noticeText` in
`affordability/notices.ts` — `ERROR_MESSAGES` derives from it. My brief named `ERROR_MESSAGES` as the source. E1
checked rather than following the wrong pointer, and established `NOTICE_COPY` is a total
`Record<NoticeReason, …>` with `REFUSAL_CODES ⊂ NOTICE_REASONS`, so no reason can lack copy.

### E1 — Every surface renders the produced sets

**Added item — a THIRD phrasing of two conditions B7 single-homed still ships in the picker.**
`model-selector/model-list-item.tsx` renders "Top up … to unlock" and "Sign up … to access" as its premium-locked
copy, which are live third wordings of the two premium refusal reasons B7 collapsed into one each. E1 already owns
this file and already has the criterion that every disabled option carries its typed reason; this is that criterion
with a named instance. Use the typed reasons rather than writing a third sentence.

**Objective:** the picker, the effort menu, the search toggle, the media panel and the send gate render
one produced value, and **the client's own verdict engine is deleted**.

**Design context.** §Affordability (the four notions, principle 1), §Notices 9. Greying comes from
`affordable`, the send gate from `admissible`.

**The hole to close deliberately.** The second verdict engine is a **hook, not a component** — the
prompt-budget hook contains a floor computation, a candidate-pool builder and a token-pricing builder,
and imports manifest and reasoning primitives directly. A criterion phrased "no component may import a
pricing function" is satisfiable while all of that keeps computing. Deletion is the criterion.

**Also in scope, because no other task owns them:** the model-validation and default-model hooks derive
premium access from the **balance endpoint**, which §Affordability 4 says is not an affordability input
— and one of them _removes_ premium selections from the store, violating "marked, never filtered".

**Acceptance criteria:**

- All greying derives from `affordable`; the send gate from `admissible`.
- **The local verdict engine is deleted:** the floor computation, the pool builder and the pricing
  builder are gone; grep-clean; `apps/web` imports no affordability symbol outside the feature surface.
- No surface derives funding or premium access from the balance endpoint; premium rows are **marked, not
  removed** from the selection store.
- Every disabled option carries its typed reason as a tooltip and an accessible description.
- The menu's enable rule is existential; pinning culls the candidate set. Both pinned.
- A hold-caused shortfall blocks the send and leaves the picker normal; a balance shortfall greys. Both
  pinned with distinct copy, and **exactly one** hold notice renders for a multi-model selection.
- The remaining intersection clamp is retired; union-only levels de-grey.
- A below-floor selected row is de-selectable — a greying model must not trap the user.
- **No text-modality surface renders a pre-send cost figure** (§Affordability 11); media still may.
- ~~The remaining trial message count reaches the client and renders before it binds.~~ **STRUCK 2026-07-27, and
  striking it is the necessary other half of a scope call I made incompletely.** I severed E1's _dependency_ on the
  trial count when F3 proved it unservable there — but left this criterion standing, which would have handed E1 an
  **unsatisfiable** requirement: F3's auditor grepped repo-wide and **nothing serves that count today, zero hits**.
  Severing a dependency without striking the criterion behind it is not a scope reduction, it is a trap. If a surface
  must show a remaining-trial count, it is a separate task with a named owner and a server-side source; it is not
  E1's, and it is not in this plan today.
- Component tests: heterogeneous multi-model selection, trial greying, picker greying, a single-choice
  model with auto enabled, and the hold-versus-balance pair.

- **Re-pin the defect class F1 found here, because deleting `useModelFloor` deletes its pins.** F1's audit
  caught a payer-scoped `spendableNanoUsd` being passed into a parameter documented as _the caller's own_,
  which greyed models a member could self-fund; F1 also found the same defect inside the load window
  (scoped read warm, unscoped in flight ⇒ the figure fell back to `0n` and greyed every affordable row for
  a render). Both are pinned by tests **that live in the hook this task deletes**. The defect class —
  a payer-scoped figure reaching a caller-scoped parameter, and a partially-loaded funding read greying
  affordable rows — survives the rewrite. Re-pin both against whatever replaces the hook; a deletion that
  silently drops a regression test is how the regression returns.
- **`turnDimensions` is empty on an unsendable smart-slot-only turn** (no contributing model), while per-row
  `dimensions` still render. So the turn-level dimension strip has nothing to show in that state even though
  the rows do — decide what the strip renders rather than discovering it blank.
- **One plumbing note from F2's audit, so it is not mistaken for a second implementation.** The estimate is
  already computed once per surface and reused — the composer's `estimatedCostNanoUsd` feeds
  `useResolveBilling`, whose whole result including the switch reason reaches `generateNotifications`. But
  `usePromptBudget` currently **returns only `fundingSource` and drops the rest**, so a send-gate surface
  that needs the typed reason outside `generateNotifications` must widen that return. That is a one-line
  change, **not** a re-derivation — do not recompute the estimate to get the reason.
- **The `use-spendable` mock in `use-prompt-budget.test.ts` is now argument-aware** (`mockUnscopedSpendable`,
  default `undefined` meaning both arms share one fixture). Any web task touching that file inherits this
  shape rather than the old single-return mock.
  **RULED 2026-07-28 — THE ADAPTER RESOLVES THE PAYER THROUGH `resolveFunding`, THE SHARED AUTHORITY.** E1's
  deletion attempt surfaced a live regression **in its own adapter**, already shipping in the picker: §Group Funding 2
  says a signed-in member whose group budget is spent falls through to personal funds, and a one-read adapter greys
  models they can self-fund. **That is the F1 defect class verbatim — a payer-scoped figure answering a caller-scoped
  question.** E1 probed it with a discriminating pair rather than reading source: headroom _held out_
  (`spendable:0, held:1e12, payer:'owner'`) → row available; headroom _durably exhausted_
  (`spendable:0, held:0, payer:'owner'`) → row greyed `insufficient_funds`.

**THE PREMISE UNDER THIS RULING WAS AN UNREACHABLE STATE. Corrected 2026-07-28 by E1's second auditor.** The
discriminating case the ruling rested on — `{spendable: 0, held: 0, payer: 'owner'}` — **cannot be served at all**:
the owner arm is returned only when hold-blind headroom is positive, which forces `held > 0`. The pin certifying the
other half pairs `effectiveRemainingNanoUsd: 1e12` with a served `{spendableNanoUsd: 0}`, and **those are the same
server-side quantity**, so that fixture is jointly unreachable too — with the endpoints' real pairing the assertion
inverts.
Worse, the ruled design is **inert exactly where it was needed and wrong where it fires**: `turnEstimateNanoUsd:
undefined` keeps the owner for any positive headroom, so the positive-but-small case never reaches the branch; and
where hold-blind headroom is positive while hold-aware headroom is zero — an ordinary settle-then-release window —
the client resolves `self` while the server's payer freeze resolves `owner`, greying options the group funds.
**The server already serves `payer` and its figures, hold-blind, having applied §Group Funding 2.** The correct shape
is to consume that, not to re-resolve it client-side from hold-aware inputs the server deliberately excludes. I ruled
a client-side re-derivation into existence on evidence that could not occur.

**Verified by the orchestrator before ruling:** `useModelFloor` makes **two** `useSpendable` reads plus
`useConversationBudgets`, and its own docblock already states the hazard — "feeding it the payer-scoped figure would
grey models the [member] can self-fund". The hook being deleted documented the defect its replacement reintroduced.

**The ruling:** take two funding reads plus `useConversationBudgets`, resolve **who pays** through the published
`resolveFunding`, then call `getTurnOptions` **once** with the winning payer. The adapter grows; it acquires **no
verdict of its own**, which is the only property that matters here.

**The rejected alternative and why** — a second `useSpendable(null)` with "available if either payer says so" is a
**client-side rule about which payer applies**, and it drifts from the server on precisely the boundary F2 exists to
pin: priority 1 compares the **estimate** against durable headroom, while a union compares the **floor**. It would
also be a second verdict rule in `apps/web` — the exact thing this task deletes. E1 identified both objections
itself and declined to choose unilaterally "after being wrong about a funding number once already"; that restraint is
why the ruling is available to make rather than a defect to find later.

**Not chosen:** giving `getTurnOptions` two-candidate-payer expression. That is a producer contract change, outside
E1's grant, and it would put a resolution the money module already publishes into the module twice.

**E1's own correction, recorded:** report 4 called the deletion "unblocked and provably contained". It is
**contained**; it was **not unblocked**. The 42 references split 6 floor-boundary + 2 already re-homed and
inversion-proven + 3 trial/media + 5 Smart Model + 1 mandatory-reasoning + 21 mechanical fixtures — all re-home
cleanly; the **4 group payer-scope pins** are what the ruling releases.

**Files:** `apps/web/src/hooks/billing/*` (except the media-cost hook — G2 owns it), `apps/web/src/hooks/chat/use-reasoning-effort.ts`, `apps/web/src/hooks/models/*`, `apps/web/src/components/chat/{model-selector/*,input/*,budget/*}`, `apps/web/src/components/chat/{chat-layout,chat-header,chat-welcome}.tsx` and `chat-layout-helpers.ts` (E1 reported it must thread these, and `chat-welcome.tsx` is a **fourth verdict site** deriving `canAccessPremium` from the balance endpoint), **`packages/shared/src/affordability/billing/client-billing.ts`** (the `freeAllowanceNanoUsd` input field and the free arm), tests.
**The `client-billing.ts` grant is not optional:** F3's auditor established that dropping `freeAllowanceNanoUsd` reaches that shared file and `use-budget-calculation.ts`, and that it sat in **neither** E1's nor F3's Files list — so without it E1 cannot satisfy its own "no funding figure from the balance endpoint" criterion. This is the third time this run a task could not meet a criterion because the file that criterion lives in was unowned.
**Scoped checks:** `pnpm test:web`; typecheck/lint web.
**Sensitive:** no.

### E2 — Every paid action carries the verdict

**Objective:** queueing, draining and regenerating cannot spend what the send gate would refuse.

**Design context.** §Notices 8. Verified current state: the queue store gates only on a count and
never reads the blocking-error state; the drain sends with a hardcoded funding source because "the
composer's per-keystroke budget resolution isn't available at drain time"; regenerate is gated on
role, mode, privilege and streaming state with no money check.

**Acceptance criteria:**

- The queue button reads the same verdict as send.
- The drain **re-resolves** funding and affordability per message at drain time rather than assuming
  a source. On refusal it stops, restores the text, and leaves the remaining queue intact — the
  existing recovery behaviour, now reached deliberately.
- Regenerate reads the verdict and disables with a reason.
- Tests: a queued message that becomes unaffordable before draining; a regenerate blocked by
  balance; a regenerate blocked by a hold showing the transient reason.

**Files:** `apps/web/src/stores/message-queue.ts`, `apps/web/src/hooks/chat/use-authenticated-chat.ts`, `apps/web/src/lib/message-actions.ts`, `apps/web/src/components/chat/input/prompt-input.tsx`, `apps/web/src/components/chat/message/message-item.tsx`, tests.
**Scoped checks:** `pnpm test:web`.
**Sensitive:** no.

### E3 — Freshness

**Objective:** a released hold is visible immediately, on every surface.

**Design context — the premise earlier planning got wrong.** Spendable invalidation is **not**
conversation-scoped: the realtime hook invalidates the global spendable key with no argument, on
socket-ready catch-up and on both run frames. The real gap is that the hook is **only mounted from the
group-chat path**, so a surface with no socket receives no frame at all — and with focus refetching off
and a five-minute stale time, its blackout can outlive the run indefinitely. A criterion phrased
"invalidate regardless of conversation" therefore passes with **zero production change**.

**Acceptance criteria:**

- Identify and report every surface that renders affordability without mounting the realtime hook. Each
  either mounts it or obtains freshness another way; enumerate the disposition.
- Focus refetching enabled for the spendable and conversation-budget keys specifically, not globally.
- Invalidation fires on socket-ready catch-up, `run-started` and `run-finished` — all three
  (§Affordability 1), pinned.
- A test reproduces the stale blackout on a socket-less surface and shows it cleared.

**Files:** `apps/web/src/providers/query-provider.tsx`, `apps/web/src/hooks/realtime/use-realtime-sync.ts`, the mount sites, tests.
**Scoped checks:** `pnpm test:web`.
**Sensitive:** no.

### E4 — Media parameters as dimensions

**Objective:** resolution, duration and aspect ratio become registry entries, so the media picker
greys like the text picker — **plus web search, which B3 found is a dimension with no registry entry.**

**Scope addition from B3.** §The Dimension Framework treats web search as a cost-affecting dimension, but B2
registered only model and effort, so web search is a dimension the framework does not describe. B3's interim
home is `Selection.webSearch` with the amount pinned (172,500,000n on three models). **Migrate it to a
registry entry here** and delete the interim field, so "one registry entry describes a dimension completely"
becomes true of every dimension rather than most of them.

**Design context.** §The Dimension Framework, §Extending → Add a modality. Verified: three unlinked
validation layers describe the same values today — the request schema, the untyped node params
record, and raw range checks inside pricing and the byte-floor estimator — with no compile-time link.
Aspect ratio is a **zero-cost** dimension; duration is **continuous** when the catalog declares no
discrete set, so it may be pinned but never opened to the classifier; resolution keys a price matrix.

**Acceptance criteria:**

- Entries registered with resource, cost class, ordered/enumerable, and per-unit reference cost.
- Media rows grey on affordability — the current state greys nothing at any balance.
- The three validation layers collapse to one derived from the registry.
- A continuous dimension is rejected if declared open; pinned.
- A zero-cost dimension skips affordability entirely; pinned.

- **`maxCallCost` gains a per-unit reference quantity** — one image, or N seconds at a resolution — so
  media models produce a finite value and participate in the outlier median. A token-shaped bound is
  never applied to per-unit pricing; pinned.

**Files:** `packages/shared/src/affordability/dimensions/**`, `packages/shared/src/schemas/api/conversations.ts`, `apps/api/src/slices/chat/domain/turn-definition.ts` (media params only — **after B4 and C3**), `apps/web/src/components/chat/media/modality-config-panel.tsx` (sole owner), `apps/web/src/hooks/billing/use-media-cost-estimate.ts` is **G2's**, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`, `pnpm test:web`.
**Sensitive:** money — 2 independent auditors.

---

## Lane F — Group funding fixes (independent)

### F1 — Payer-scoped served numbers

**Objective:** the client computes affordability from the wallet that will actually pay.

**Design context.** §Group Funding 1, §Data Structures (`FundingSnapshot`). The endpoint derives its
user from the calling principal while admission gates on the payer's wallet at the payer's tier — wrong
balance _and_ wrong tier in every group conversation.

**This is a contract change, not a handler edit.** The endpoint takes no conversation id and returns
only the two money fields, while `FundingSnapshot` also requires `tier` and `payer`. Serving the payer's
numbers requires a request-shape change, the shared API schema, and the typed client — so Global
Constraint 10's sweep applies, and the new key shape must be reconciled with E3's invalidation.

**Acceptance criteria:**

- The endpoint accepts the conversation context and serves the payer's numbers plus `tier` and `payer`.
  Contract test: the served figure equals the group's hold-aware remaining at the payer's tier.
- The shared schema and typed client are updated together; repo-wide typecheck green.
- **The key shape is reconciled with E3:** whatever scoping the key gains, invalidation still fires for
  every surface. Coordinate explicitly — a conversation-scoped key silently breaks E3's guarantee.
- Client sizing inputs take the payer's tier.
- Guests and self-funded turns unchanged; pinned.

**Amendment (post-implementation) — the E3 contract, two accepted deviations, and two routed items.**

**THE KEY SHAPE, for E3 to act on without re-deriving it.** `billingKeys.spendable()` stays the
argument-free family **prefix** `['billing','spendable']`; each payer caches at
`billingKeys.spendableFor(conversationId | null)` = `[...spendable(), { conversationId }]`. Invalidating
or refetching the **prefix** still reaches every scoped entry — pinned by a test that invalidates the
prefix and observes a conversation-scoped refetch. **E3 must keep using the no-argument form** and add
focus refetching on that same prefix; it must never invalidate a per-conversation key. This is the
reconciliation §F1 required, discharged.

**Accepted deviation — a composition-root adapter, and it is the architecturally correct answer.** F1
added `apps/api/src/adapters/conversation-funding.{ts,integration.test.ts}` plus `app.ts` wiring and
**four** manifest construction sites (this amendment first said two; an auditor enumerated four, and
making the dependency required is what made typecheck name every one of them), because **the rows naming a group's payer are conversations-owned and the
billing slice may not read them** (single-writer-per-table). Modelled on the existing `presign-readers.ts`
precedent, and the dependency is required rather than optional, so typecheck names every construction
site instead of letting one be forgotten. This is the boundary rule working, not scope creep.

**Accepted deviation — `readSpendable`/`SpendableView` renamed to `readFundingSnapshot`/`FundingSnapshot`**,
matching §Data Structures now that the type carries payer identity. Route path and query keys unchanged.
Correct under durable naming: a name that no longer describes its value is a wrong comment at type scale.

**THE OWNER ARM IS NOT HOLD-AWARE, and that is a standing-ruling conflict, not a bug.** F1's audit
found three comments (`billing/routes.ts:217-218`, `domain/spendable.ts:152`,
`schemas/api/billing.ts:121`) claiming the served figure matches the admission gate **exactly**. True of
the self arm; **inexact for the owner arm** — `ownerSnapshot` prices the owner dimension from the **raw**
purchased balance, applying neither the payer's paid-tier cushion nor the owner wallet's own holds.

Consequence when the owner dimension binds: the figure understates by ≤50¢ (safe), **and overstates
whenever the owner's wallet holds exceed the cushion** — so a group composer presents a send that
admission then refuses with `insufficient-balance`. **That is precisely the failure class F1 exists to
remove.**

But the arithmetic is **correct by ruling**: "the owner-balance dimension stays RAW (never hold-aware) by
ruling: members must not infer owner activity" — pre-existing at baseline and already the shape of
`conversations/domain/budgets.ts`. A member watching a hold-aware owner figure move learns the owner is
running turns. So two founder rulings are in tension: **owner-activity privacy** versus **never present
an option the user cannot afford**.

**Disposition: the three comments are F1's to fix** (state the raw-owner exception instead of "exactly" —
a comment claiming an exactness the code does not have is worse than none).

**The residual needs no founder ruling after all — the spec already decides it.** A second auditor found
that **§Group Funding 6(b) already rules this exact divergence a hard refusal at admission**. So the
tension the first audit surfaced is resolved in the spec's favour: the owner dimension stays raw, the
served figure may exceed what admission admits, and admission refuses. Nothing to decide; what remains is
only that the refusal deserve decent copy, which B7 already owns generically. The B7 item below is
therefore a notice-quality item, not a pending ruling.

**Routed to G2** (both are One Implementation, Shared items F1 correctly refused to fix outside its
ownership): `payerSizingTier` in `client-billing.ts` now has **no production consumer**, because the
payer's tier is served and re-deriving it client-side would be a second implementation — knip will
report it, and deletion is G2's. And the hold-aware group minimum is now **composed** in two places
(`spendable.ts` and `conversations/domain/budgets.ts`); both call the same shared
`groupEffectiveRemainingNanoUsd`, but the `cap − spent − held` composition repeats, and collapsing it
means editing the conversations slice.

**Files:** `apps/api/src/slices/billing/{routes.ts,domain/spendable.ts}`, `packages/shared/src/schemas/api/billing.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/hooks/billing/*` (inputs only), tests.
**Scoped checks:** `pnpm test:api`, `pnpm test:web`, `pnpm test:shared`; repo-wide `pnpm typecheck`.
**Sensitive:** money — 2 independent auditors.

### F2 — The group verdict compares the estimate

**Objective:** a positive remaining balance that cannot cover this turn is not fundable.

**Design context.** §Funding Decision Matrix priority 1. Today the group branch tests headroom
greater than zero and never compares the turn's estimate, so one nano of headroom presents as
fundable and the send fails at admission with no prior signal.

**Acceptance criteria:**

- Priority 1 compares the estimate against headroom. A test pins the boundary: headroom one nano
  below the estimate is not fundable, exactly equal is.
- The fall-through and guest-refusal outcomes are unchanged; pinned.
- **F2 produces the fall-through outcome and its typed reason; it does NOT verify a notice.** The
  original criterion here said "the payer-switch notice from B7 fires on fall-through", which is
  unsatisfiable at F2's position — B7 is not built, and F2's only dependency is F1. Corrected before
  dispatch: F2 owns the decision and the typed reason it carries, **B7 owns the copy and the rendering**,
  and B7's own criteria already require the payer-switch disclosure to fire for a member with no
  allocation as well as one whose allocation ran out. F2 must report the exact reason value it emits so
  B7 wires to a real constant rather than inventing one.

**Amendment (post-implementation) — one accepted deviation, and a spec gap F2 cannot reach.**

**Accepted deviation:** `chat/domain/turn-context.ts` and `billing/domain/spendable.ts` each gained one line
(`turnEstimateNanoUsd: undefined`) plus a comment — a required-member contract change under Global
Constraint 10, without which repo-wide typecheck ships red. No behaviour change in either.

**THE SPEC GAP — needs a founder ruling; the orchestrator verified `BILLING.md` does not resolve it.**
§Funding Decision Matrix priority 1 is now correct **on the client** and **cannot be implemented on the
server as the path is ordered**: `resolveTurnContext` freezes the payer _before_ the turn is priced,
because the ceiling is bounded by the payer's own funding. So a member with positive-but-insufficient group
headroom is frozen as owner-funded and then refused at admission — where the matrix says fall through to
personal funds. The premium tier gate (`tierGateRejection`) is estimate-blind for the same reason.

**Verified not to be a money leak, which bounds the urgency but does not excuse it.** F2's first audit
checked the materially worse shape rather than trusting the narrative: admission's per-scope gate **does**
compare the estimate against `min(scope remaining)` and returns `budget-exceeded`, so **the group budget
cannot be silently overspent.** This is a bad presentation outcome, not a lost-money one.

**But it is NOT spec-sanctioned, and the orchestrator said twice that it was.** F2's second audit corrected
the citation: **§Group Funding 6(b) rules the RACE case** — exhaustion discovered only at admission, where
the client's retry re-resolves — whereas this case is **deterministic**, so the retry re-resolves to the same
refusal forever. Priority 1 and §Group Funding 6(a) say a signed-in member **falls through**. So the server's
behaviour here is a spec violation rather than a documented hard stop, and citing 6(b) for it made an
escalated gap look settled. That mis-citation is the substance of one of F2's two remaining findings.

**Why this is worth a ruling rather than a backlog line:** after F2, the client tells that member _"your
personal funds will pay"_ and permits the send; the server then refuses it. That is the standing product
rule broken — an option presented that the user cannot use — and the divergence is now sharper than before
F2, because the client's promise is more specific while still unkept. The gap is **pre-existing** (the
payer froze before pricing at baseline too); F2 made it visible by making the client right.

**The orchestrator's recommendation, for the founder:** hoist a **minimum-turn estimate at the owner's
tier** ahead of the payer freeze, and decide the payer on that. It breaks the apparent circularity —
the ceiling needs the payer, the payer needs a price — because the _minimum_ cost is payer-independent
enough to decide the question: if the group cannot cover even the cheapest admissible turn, it can never be
the payer, so fall through; once the payer is fixed, price the turn fully. This is the same shape as
`eligible(m)`, which already grades on the corner a model can actually reach rather than on an unreachable
zero, so it introduces no new principle. **C3 owns it and the bar is LIFTED** (ruling 2). Decide the payer on
`minTurnCost` at the candidate payer's tier — the least the turn could cost if that payer paid — and fall through
when group headroom cannot cover even that. One pass, because the result never feeds the input. The same
reordering fixes the estimate-blind premium tier gate. `BILLING.md` now carries the general rule: **a decision
that gates pricing may consume only bounds, never prices.**

**F1 interaction, informational and not a defect:** the served `payer`/`tier` remain estimate-blind, so on a
fall-through the client sizes at the **owner's** paid ratios while the **member** pays. The verdict itself
is correct (`useModelFloor` compares the caller's own spendable); only the sizing ratio is the wrong tier.

**Files:** `packages/shared/src/affordability/billing/funding-decision.ts`, `client-billing.ts`, `apps/api/src/slices/chat/domain/turn-context.ts` + `apps/api/src/slices/billing/domain/spendable.ts` (one line each, forced), tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:api`, `pnpm test:web`.
**Sensitive:** money — 2 independent auditors.

---

## Lane G — Enforcement and hygiene

### G1 — The arch rules that keep the wall

**Objective:** the boundary and the registry seam are build failures, not conventions.

**Design context.** §Where the Code Lives → What is enforced. Precedents to follow: the fee-seam
rule already allowlists money math by path inside the shared package, the structural-rule harness
already parses that tree, and two directory-isolation rules exist. **Depends on B8, not B1b** —
resequenced after B1b, because rule 6 asserts the export-map surface and B1b had to open 14 interim
per-unit subpaths that only B8 deletes. Written before B8 lands, rule 6 would either fail on a state
the plan created or be softened to allowlist the holes — and a softened rule is the one that never
gets tightened again. B2's move of `premium-check.ts` also dissolves the reach question B1b raised, so
waiting resolves two items rather than one. Depends on B1 for the paths and
B2 for the registry.

**Acceptance criteria:** seven rules, each with a **positive control** in its own test proving it
fires — a silent rule proves nothing:

1. Barrel-only access from outside the module. (Note: deep specifiers already fail to resolve via the
   exports map — this rule covers the intra-package relative path, which is where the reach exists.)
2. **No code under `apps/web` outside one named adapter hook** imports a pricing or affordability
   symbol. "No _component_" is too narrow — the second verdict engine E1 deletes is a hook.
3. No branching on a dimension id, and no dimension option literal, outside the registry.
4. Rate arithmetic confined to the module; fee application confined to the two seams.
5. No database or cache import inside the module. Imports _into_ the module are permitted **only from
   an enumerated allowlist** — B1 produces that list — and the allowlist's membership is itself pinned,
   so growth is a visible edit. Phrasing it as "nothing imports into it" is unimplementable: the barrel
   is imported by design.
6. **The export allowlist, structurally, over BOTH entry points.** A rule in the arch harness reads
   the export list of the root barrel **and** of the `@hushbox/shared/affordability` subpath, failing
   on any symbol from §Where the Code Lives' not-exported list appearing in either. Both matter: B1
   added the subpath, and a rule covering only the root barrel would pass while the subpath published
   the whole list. This is deliberately **not** a duplicate of the package-local tests: B1b pins
   absence and B8 pins set equality, both by importing at runtime from inside `packages/shared`; this
   rule is static, lives with the other structural rules, and is what catches a re-export added from
   a package that has no such test. Do not reimplement either runtime test here.
7. **Content-freedom, as a build failure.** No export of the module may have a parameter whose type
   references a message, prompt or content type. This converts Global Constraint 6 and §Where the
   Code Lives' "content-free" clause from a sentence a reader must honour into a property the build
   checks. It is here because the clause was **already false when B1 landed** — two content-accepting
   functions sat in the module and no test noticed — so fixing the instance without the rule fixes
   today and nothing else. The rule's value is specifically that it blocks the reintroduction path:
   pricing the real prompt server-side per keystroke, which this architecture rejected on E2EE
   grounds, becomes impossible to write without first widening a type inside the module, which is a
   visible and reviewable act. Positive control mandatory — a content-shaped parameter added to a
   module export must fail the rule.

   **A known hole in this rule as drafted, for G1 to close deliberately rather than discover.** Named
   by an auditor: `affordability/pricing.ts:8` exports `estimateTokenCount(text: string)`. A rule
   phrased against _content type names_ does not catch a bare `string`, so the module would keep an
   export that accepts arbitrary text while passing rule 7. It is pre-existing and outside the ruled
   cut, and its only caller **pads a synthetic string to express a length**
   (`apps/marketing/src/lib/calculate-cost.ts:49-50`) — which is evidence the signature is wrong, not
   that the rule is too strict. **RULED (ruling 4), and the reason goes in the rule's docblock:**
   **reject a bare `string` parameter on any module export.** `estimateTokenCount` already takes a character
   count, so that half is done —
   because a type-name list is a sync contract that must be maintained forever while "no bare
   `string`" is a bright line. The line worth drawing is **branded/refined string types are scalars
   and stay legal** (`NanoUSD` is a numeral at a JSON boundary — see §Data Structures) **while bare
   `string` is unbounded content**. If G1 finds legitimate bare-`string` exports it cannot change,
   that is a finding for the founder, not an allowlist to start.

Each rule lists its known limitations in a docblock, and any documented limitation carries an
executable pin so the list cannot rot.

**Files:** `packages/config/arch/rules/*`, `packages/config/eslint-extensions/*`, `boundaries.config.mjs`, tests.
**Scoped checks:** `pnpm test:config`, `pnpm arch:check`, `pnpm lint`.
**Sensitive:** no.

### G2 — Collapse the remaining duplication

**Objective:** delete the sync contracts and the local money math this run has now identified.

**Acceptance criteria:**

- The storage float derives from the nano constant; the cost model remains as a comment recording
  how the rate was chosen, not a live parallel computation.
- The group budget modal's plain-number aggregation routes through shared money helpers.
- The media dollar-conversion duplicated across three per-modality hooks becomes one shared display
  formatter.
- The two sync contracts are dispositioned **individually, by citation**, not by grep: the value-store
  byte-budget duplicate (B4 hoists it) and the enclosure dual-guard comment (**out of scope — it
  documents two deliberate guards; do not collapse them**). A grep for "keep in sync" matches neither,
  since both say "MUST stay in sync" — which is why enumeration replaces the grep.

**Three items routed here from other tasks — an auditor caught that they were recorded in the routing
task's amendment and not in these criteria, so a G2 implementer reading only this section would have
missed all three.** That was an orchestrator bookkeeping error, not a scope change; the items are:

- **`payerSizingTier` (`affordability/billing/client-billing.ts`) has no production consumer** and must
  be deleted. **Delete its docblock's claims with it, not just the symbol.** F2's audit found two clauses
  that only survive because the symbol is dead: a "cannot drift" biconditional whose precondition is now
  "same caller, same estimate" (after F2 the estimate is an input to the payer decision, so a caller handing
  `undefined` to one side and an amount to the other could genuinely diverge), and the phrase
  "exhausted-headroom fall-through", which is now too narrow — the set is exhausted **or** insufficient. Both
  are correct today only because nothing calls it. If the deletion leaves the docblock behind, it becomes
  wrong the moment anything calls it again. F1 made it dead by serving the payer's tier: re-deriving it client-side would be a second
  implementation. Verified — the only remaining reference is its own test file, and knip will report it.
- **The `cap − spent − held` composition repeats** in `billing/domain/spendable.ts` and
  `conversations/domain/budgets.ts`. Both already call the shared `groupEffectiveRemainingNanoUsd`, so
  the _helper_ is single-sourced and only the composition around it repeats — collapsing it means
  editing the conversations slice, which is why F1 refused to do it.
- **Two tier vocabularies now exist on the wire in one package.** `schemas/api/billing.ts`'s
  `userTierSchema` is the correct one (`satisfies Record<UserTier, UserTier>`, exhaustive at compile
  time); `workflow.ts`'s `StorageStamp.tier` is a bare `z.enum` literal list whose **own docblock says
  it "mirrors" the canonical `UserTier` union** — the sync contract CODE-RULES bans, self-documented.
  Collapse it onto the exhaustive schema.

**Files:** `packages/shared/src/constants.ts`, `packages/shared/src/affordability/**`, `packages/shared/src/workflow.ts` (the tier enum only), `apps/api/src/slices/billing/domain/spendable.ts`, `apps/api/src/slices/conversations/domain/budgets.ts`, `apps/web/src/components/chat/budget/budget-settings-modal.tsx`, `apps/web/src/hooks/billing/use-media-cost-estimate.ts`, tests.
**Scoped checks:** `pnpm test:shared`, `pnpm test:web`; `pnpm lint:duplication` on the changed paths.
**Sensitive:** no.

### G3 — E2E specs, authored not run

**Objective:** the flows this run changes are covered at the level that would catch them, delivered
unexecuted per the standing ruling.

**Acceptance criteria:** specs authored per `e2e/CLAUDE.md` conventions for — a multi-model turn
including Smart Model as one sibling; an `auto` multi-model turn asserting each answer's effort
badge; **a multi-model turn whose first sibling fails, asserting the classifier charge still lands**;
a hold-blocked send in a second conversation showing the transient reason with the picker still
normal; a group member falling through to personal funds with the disclosure. Lint and
typecheck clean; **not run**. The auditor judges convention conformance and assertion completeness,
not a passing run.

**Files:** `e2e/**`.
**Scoped checks:** `turbo typecheck lint --filter=e2e`.
**Sensitive:** no.

---

## Lane H — End-to-end proof (depends on C3, D1, D2)

### H1 — One real turn, three invariants at once

**Objective:** prove the specification on a real turn, since no per-task audit can see across layers and
E2E does not run this run.

**Design context.** Every task above verifies its own layer. Nothing verifies that a turn priced by
admission is the turn that executed, that the classifier charge lands when the first sibling fails, and
that the persisted effort matches the badge — all three of which are cross-layer by nature. The close
phase runs gates and a critic; neither executes a turn.

**Acceptance criteria:** one integration test, at the api layer against real local infrastructure, of a
multi-model `auto` turn with a Smart Model sibling where the **first sibling fails**, asserting in one
run:

- each surviving generation persists the effort it resolved to, and the value reaching the wire equals
  the persisted one (the take-not-sum rule, across a multi-step generation);
- the classifier charge is anchored to the first **persisted** content item and billed;
- `hold ≥ Σ charges` for the run as settled;
- **`estimate ⟺ executed`**: the definition admission priced is the definition that executed, now that
  the envelope carries a runtime choice. Asserted, not assumed — §Reasoning Effort states it in prose
  and nothing else in this plan pins it.

**Files:** one api integration test file.
**Scoped checks:** `pnpm test:api`.
**Sensitive:** money — 2 independent auditors.

---

## Dependency graph

```
B1 → B1b → B2 → B3 → B4 → B5 → B6 → B7 → B8
      │                        │     │      ↑
      │                        │     └→ C1 ─┘ → C2 → C3 → D1 → D2 → H1
      │                        │
      ├→ A1                       (A1 needs B1's constants split)
      ├→ F1 → F2                  (F1 needs B1's paths + a schema change)
      └→ (G1 moved: now needs B8b's deleted subpaths + B2's registry — see the table)

B8 → C3                         (added: C3 needs getTurnOptions wired, see Lane C pre-answers)
B8 → B9, E1, G2 → B8b → G1      (2026-07-27 split: B8 lands the surface; B9, E1 and G2 rewrite the
                                 consumers onto it; B8b then deletes the subpaths. G1 moved from
                                 B8 to B8b because rule 6 asserts the export MAP, which stays
                                 false until the 14 entries are gone.)
B5, B6, B8 → E1 → E2            (E2 also needs D2 — shared message component)
E1 → E3
B2, B4, C3 → E4                 (E4 edits turn-definition after B4 and C3)
B4, E1 → G2
C3, D2, E1, E2 → G3
D2 → E2
```

**Lane B is a strict spine.** Nothing in it is parallel, and **B8 closes it** — it needs both B7 and
C1, so lane C's first task lands mid-spine rather than after it.

**What opens when.** A1, F1 and G1 are the only tasks that open on a B1-family clean, and none of
them opens _alongside_ B1 — all three touch paths, constants or barrel state B1 and B1b move:

| Dispatch                          | The moment it becomes ready                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **B1**                            | immediately — the run's single entry point                                                                                          |
| **A1**, **F1**                    | B1 clean (constants split, moved paths)                                                                                             |
| **G1**                            | **B8b clean and B2 clean** — rule 6 asserts the export map, which is false until B8b deletes B1b's 14 interim subpaths              |
| **B9**                            | B8 clean — it re-expresses the api estimator against the surface B8 lands                                                           |
| **B8b**                           | **B8, B9, E1 and G2 clean, and the walled-consumer inventory empty** — deletion's precondition is that nothing imports the subpaths |
| **F2**                            | F1 clean                                                                                                                            |
| **E1**                            | B5, B6 and B8 clean — it renders the produced sets through the landed barrel                                                        |
| **E3**                            | E1 clean. **E3 is not parallel with B1** — the graph edge `E1 → E3` governs                                                         |
| everything in C, D, E4, G2, G3, H | as the graph shows                                                                                                                  |

An earlier revision of this section listed E3 as "genuinely parallel, dispatched alongside B1" while
the graph carried `E1 → E3`, and listed G1 in one sentence and not the other. The table above is
authoritative; that sentence is deleted. Nothing is dispatched in parallel with B1.

**Ownership resolutions** (each file has exactly one owner at any time):

| File                                            | Owner                                                | Note                         |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------- |
| `constants.ts`                                  | B1 splits; A1 adds to the money half after           | never concurrent             |
| `turn-definition.ts`                            | B4, then C3, then E4                                 | serialized by graph edges    |
| `smart-model-turn.ts`                           | C2, then C3                                          |                              |
| `settlement.ts`                                 | C2 (anchor rule), then D1 (charge input)             |                              |
| `smart-model-execution.ts`                      | C2, then D1                                          |                              |
| `message-item.tsx`                              | D2, then E2                                          | D2 → E2 edge exists for this |
| `prompt-input.tsx`                              | E1, then E2                                          |                              |
| `modality-config-panel.tsx`                     | **E4 only**                                          | removed from E1's glob       |
| `use-media-cost-estimate.ts`                    | **G2 only**                                          | removed from E1's glob       |
| `hooks/billing/*`                               | E1, then E2, then F1                                 | F1 touches inputs only       |
| `shared/src/index.ts`                           | B1b removes; B8 lands the surface; B8b pins totality | never concurrent             |
| `shared/package.json` subpaths                  | **B8b only**                                         | B8 is explicitly denied it   |
| `models/domain/estimate*.ts`, `models/index.ts` | **B8 only** (walled-type unwind)                     | founder-ruled 2026-07-27     |

---

## Close phase

1. **Full unscoped pass:** `pnpm typecheck`, `pnpm lint`, every `pnpm test:*` suite,
   `pnpm lint:duplication`, `pnpm lint:unused`, `pnpm arch:check`. Attribute every failure; fix only
   what this run caused.
2. **Batch the validated findings to one fixer**, then re-audit the batch. Two mechanical items are
   already queued for this batch, both pre-existing and both surfaced by B1's audits:
   - **Plan-identifier leaks now living inside the new module.**
     `affordability/estimate/reasoning-plan.ts:70` and `reasoning-plan.test.ts:799,810` carry `(G1)`
     labels, and `affordability/smart-model/prompts.ts:42` carries `(D3, dimension-composed)`. All are
     byte-identical to baseline — B1 only moved them — but Global Constraint 8 now reads as violated at
     a path this run created. Deferred to the close batch rather than fixed in B1 precisely because
     criterion 5 permits no semantic edits to moved files beyond the enumerated exceptions; the same
     disposition this run gave an earlier pre-existing doc defect adjacent to corrected text.
   - **`packages/shared/src/affordability/dimensions/registry.test.ts:120`'s test name** still says
     "at registration" while the criterion it pins was reworded to "when opened". The assertion is correct;
     only the name is stale. B2's fixer flagged it and deliberately left it rather than widening a surgical
     cycle, which was the right call — test names are read as documentation, so it gets fixed, just not at
     the cost of a dispatch.
   - **A dangling `§2.K` spec pointer in the money core** — `affordability/billing/funding-decision.ts`'s
     docblock plus the contract test's docblock and `describe` title. It resolves to nothing in `docs/` and
     appears to point at a superseded backend-redesign section. Found by F2's fixer and deliberately left
     (different owner), but it matters more than its size: **it is the only spec pointer a reader of the
     funding core gets.** Repoint it at the live `BILLING.md` section or delete it.
   - **`packages/shared/dist/src/billing/funding-decision.d.ts` carries retracted text.** Stale build output
     still holding the "can never drift" claim F2 corrected, so a grep for the old wording still hits it.
     `dist/` is gitignored and imported by nothing, so this is a grep trap rather than a defect — regenerate
     or note it.
   - **`workflows/engine/settlement.ts:79`'s "who pays (`walletId`/`userId`)"** comment, which bundles
     `userId` into "who pays" — contradicted by ground truth (the payer's user is the sender; owner
     funding changes the wallet, never the payer) and sitting 19 lines from text an earlier task
     corrected.
3. **No E2E execution.** Specs are delivered static-clean.
4. **Completeness critic** with a close-out brief: which criterion is unverified, which integration
   untested, which doc unupdated.
   4b. **One-word comment precision, carried here rather than spent as a cycle.** `dimensions/derive.ts`'s noise-class
   safety comment states its property over "option label"; the true statement is over a **literal-domain** option
   label, since catalog labels are model ids that routinely carry the stripped characters. An auditor proved the
   strip is structurally unreachable for them and declined to raise it because a violation **fails closed** — a
   future label would stop matching and take the declared fallback rather than bind a wrong rung. Correct as
   worded anyway: a claim that is false as written is the wrong-comment class regardless of failure direction.

5. **Doc proposals.** `BILLING.md` is already current — the batch and all six rulings are applied and its
   path citations resolve, so it needs no close-phase proposal unless a later task invalidates a clause
   (ruling 6: whoever invalidates it corrects it in that task). Two docs are still owed:

   - **`ARCHITECTURE.md`** — its node-type list omits the shipped Smart Model node, and its exclusion
     sentence should distinguish **commercial** exclusions (price floor, age) from **representability**
     ones (unknown pricing unit, unclassifiable modality); the first are quiet and expected, the second
     warn.
   - **`DEVELOPMENT.md`** — its doc index.

   Present both as a per-file diff of proposed removals vs additions and let the founder decide each.

6. **Do not commit.** The tree is the human's.

---

## B4's trial-cap blocker — RULED 2026-07-26, validated facts below

**RULED: resolution 3, and both further findings are fixed inside B4.** Everything below is confirmed by a
read-only validator against the code, not taken from the implementer's report; the arithmetic was
re-derived independently. The criteria this adds to B4 are at the end of this section.

**The ruling, in one line each.** (1) Fit unstamped turns against the payer's spendable AND move the trial
gate to compile-then-price, deleting the `apps/api` rate arithmetic — one change, not two. (2) Give each
sibling its own wire cap, per §Multi-Model 3. (3) Return the capped definition from the fit.

**The exposure is in the working tree only, not in `HEAD`.** `HEAD` still carries the money bound
(`computeSafeMaxTokens`); B4's deletion is uncommitted. This is a must-not-land state, not a live incident.

**The mechanism.** `POST /chat/trial` is quota-gated — trial admission compares only a daily counter, so
there is no hold and no wallet to refuse. Its definition is deliberately left unstamped, and
`reconcileAnswerCeiling` returns early when `stamped.storage === undefined`, so the money-derived fit never
runs on a trial turn. The summed-rate guess B4 deleted was therefore **the only bound on a trial turn's
output**. Removing it moved the wire cap from **7,909 to 999,194 tokens**.

**There are TWO ungated doors, not one.** The implementer named only the single-model trial path. The trial
**Smart Model** arm is ungated by the identical mechanism, trial candidates carry no per-candidate caps, and
**no test pins its wire cap at all** — so a fix touching only the single-model path leaves it open and green.
Both arms call the same `reconcileAnswerCeiling`, so removing the `stamped.storage === undefined` condition
closes both in one edit.

**Neither 7,909 nor 999,194 is the spec's number, and this is the fact that decides the shape of the fix.**
The spec mandates `ceiling(m) = min(providerCap(m), contextHeadroom(m), budgetBuys(m))` (§Model bounds,
§Affordability 7, §Smart Model 7 for the trial tier specifically), and §Funding makes the trial payer's
funding input the fixed per-message ceiling. So a money term is **required**, and the current state violates
the spec. But the deleted 7,909 was **~99.8% storage-driven** — a storage term §Trial Usage says a trial
turn never pays — so it was non-conformant in the conservative direction, under-serving trial users. Both
the old and new numbers are wrong, in opposite directions.

**Consequence for whoever fixes this:** the failing route pin must be rewritten under _any_ resolution, and
at its current fixture a spec-conformant cap equals **999,194** — the money term does not bind there,
because the rates are 2–3 nano/token. So that fixture **cannot prove the fix**. A realistic-rate case is
required, where the money term actually binds.

**Blast radius the validator established beyond the cap itself:**

- **The trial cost circuit inherits the inflation.** It is `estimate × 5`, and the estimate is now the
  inflated physical-ceiling figure, so the circuit loosened by the same factor as the cap.
- **A documented invariant is broken, not just a number.** `BILLING.md` §Trial Usage states the $50/day
  cap's overshoot bound _is_ the per-message cap. That reasoning no longer holds.
- **Magnitude:** ~2×–15× the 1¢ cap realistically (the 5-minute text deadline is the practical bound),
  up to ~500× arithmetically, ×5 per identity. Graded HIGH on mechanism, MEDIUM on magnitude — the local
  catalog is empty, so no live rate distribution was available.
- **The paid path is genuinely fine.** Where money binds, the fit reproduces the deleted guess: the paid
  figure is unchanged and holds moved only _downward_ (the rich-payer pin moved `{}` →
  `{maxOutputTokens: 127997}`, three tokens below the 128,000 the hold already covered). `reserve ⊇ bill`
  is untouched on the paid path. The asymmetry is the whole finding: on the paid path the deleted bound was
  never load-bearing, on trial it was the only enforcement.

**`answerHeadroomTokens` / `turnCostBasis` are a second implementation of §Model bounds living in
`apps/api`.** They multiply rates by tokens and divide funds by a rate, against Global Constraint 4, and the
money module already has the spec-shaped version (`budgetBuysTokens`, `ceilingTokens`). No lint rule catches
it — `money/fee-seams` covers `applyMarkup` imports only. The implementer's claim that it _cannot_ follow the
deletion is **overstated**: the ordering is exactly as described (the trial gate runs before any definition
exists to price), but the restructuring that fixes the blocker is the same one that makes the deletion
possible. Note `getTurnOptions` has **zero production consumers** today — B8 owns wiring it — so collapsing
onto the shared producer instead would mean widening B8 or breaching the module wall.

**Two further validated findings needing their own disposition:**

- **§Multi-Model 3 is now universally violated.** The api wire cap is one shared value sized by the
  tightest sibling, stamped on every answer node. Previously a payer who could afford the whole window got
  no cap, so a wide-context sibling ran to its own bound; now every budgeted multi-model turn carries the
  tightest sibling's cap. Holds only move down; the cost is a truncated answer on the wide sibling. One
  route test actively pins the deviation and will move when it is fixed.
- **`fitAnswerCapToCeiling` prices a capped definition and returns the uncapped one.** Sound today only
  because every caller passes the same number to both, which nothing enforces. It arms in the **unsafe**
  direction the moment a definition carries an uncapped `modelCall` — which is exactly the shape Lane C's
  decision-envelope classifier node introduces, inside this run.

### Added B4 criteria, from the ruling

These are acceptance criteria, identical for B4's implementer and its auditors.

1. **No turn of any tier carries a wire cap with no money term.** `reconcileAnswerCeiling` fits unstamped
   definitions against the payer's spendable, so the fit runs on trial turns. Both trial arms are closed by
   this one change — pinned separately, because the Smart Model arm has **no wire-cap pin at all** today and
   a single-arm fix would leave it open and green.
2. **The trial cap is `trialTurnCost`-derived — storage-free — by construction, not by a second formula.**
   An unstamped definition priced through `createEstimateRun` already carries no storage term, which is why
   this satisfies ruling 5 without new arithmetic.
3. **`turnCostBasis`, `summedTurnPricing` and `answerHeadroomTokens` are deleted**, retiring the last rate
   arithmetic in `apps/api` (Global Constraint 4). The trial eligibility gate becomes compile-then-price:
   compile at the requested level, price it unstamped, refuse if `B + MINIMUM_OUTPUT_TOKENS` exceeds the 1¢
   ceiling. This needs `fitAnswerCapToCeiling` to distinguish **fitted** from **floored** — it currently
   swallows that signal. Do not reintroduce the bound anywhere else: after this, `createEstimateRun` is the
   only numeric authority on every money path.
4. **Each sibling's wire cap is its own** (§Multi-Model 3): per-node clamping, not one shared
   tightest-sibling value. Holds may only move **down**. One route test actively pins the shared-cap
   behaviour and will move — that is expected here, and it is the one place in this task where changing an
   existing expectation is correct rather than forbidden.
5. **The fit returns the definition it priced.** Fixing the early return closes a hazard that is armed in
   the **under-reserving** direction the moment a definition carries an uncapped `modelCall` — the shape
   Lane C introduces inside this run, which is why it is fixed now rather than routed there.
6. **The property sweep covers the unstamped arm.** Its grid uses only stamped hooks today, which is exactly
   why the regression was invisible to it and reached a single route pin instead. A sweep that cannot see the
   arm where the defect lived is the guard that failed, so extending it is not optional.
7. **The route pin is rewritten with a realistic-rate companion.** At the existing fixture the
   spec-conformant cap **equals** today's ungated 999,194, because the rates there are 2–3 nano/token and the
   money term does not bind — so that fixture cannot prove the fix. The companion case must be one where the
   money term binds. Neither 7,909 nor 999,194 is the spec's number; do not restore either as a target.
8. **The trial cost circuit is verified to have deflated with the cap.** It is `estimate × 5`, so it should
   follow automatically once the estimate is money-bounded — but "should follow" is the class of claim this
   run keeps finding false, so show it.

## Rulings — all six decided 2026-07-26, with the reasoning that decided them

Recorded in full, because the reasoning is what stops each being re-litigated. Every one is now normative in
`BILLING.md` and assigned to a task.

1. **RULED — exclusion is a soft delete with a reason. NEW TASK A2 owns it.** Ingestion only writes, so a rule
   added later leaves already-admitted rows sellable, and the same gap hides a model that has vanished upstream.
   **Rejected:** hard delete (loses the provenance behind past charges — usage and completion rows reference the
   model that ran — and is irreversible, so it cannot be an admin op under the Reversibility Iron Law); reusing
   `adminDisabledAt` (conflates a **derived** state with an **asserted** one, forcing the hourly refresh either
   to overwrite a human's decision or to trap a model out permanently); read-time filtering (the floor tests the
   **pre-fee** rate while rows store billable rates with fees baked, so recovering it means inverting markup —
   lossy at integer boundaries and fee math outside its two seams).
   **Schema:** one pgEnum `model_exclude_reason` over A1's existing `EXCLUDE_REASONS` (one authority, no second
   list) plus `excluded_reason` (nullable), `excluded_at`, `last_seen_at NOT NULL DEFAULT now()`. Exposure filters
   `excluded_reason IS NULL AND admin_disabled_at IS NULL`. **No index** — a few hundred rows make one reflex
   rather than measurement. `last_seen_at` buys the vanished-upstream case for one column.
   Rows are **marked, never created**: several reasons exist _because_ the descriptor is unbuildable, so there are
   no values to write — yet every reason stays reachable, since any can newly apply to a model that already has a
   row. Ships its generated migration for the drift gate plus the `packages/db` shape-test registry.

2. **RULED — the payer is decided on `minTurnCost`. C3 owns it, and the bar on starting is LIFTED.** The payer
   decision and the price are mutually dependent (a ceiling is bounded by the payer's funding; priority 1 compares
   the estimate), so iteration has no guaranteed fixed point. **Rejected:** two-pass re-resolve (flipping the payer
   changes the ceiling, which changes the price, which can flip it back); making the client match the server
   (reverses F2 and picks the worse behaviour — refusing a turn the user can fund personally); better copy on the
   refusal (leaves the client promising a send the server refuses).
   **The fix is asymmetry, not iteration:** compute the least the turn could cost _if the candidate payer paid_, at
   that payer's tier; if group headroom cannot cover even that, the group can never pay, so a signed-in member
   falls through. One pass, because the result never feeds the input. **Cheaper than it looks** — the minimum needs
   rates for the selected models, which the send path reads anyway to compile the definition, so it is a
   **reordered** read, not a new one. The estimate-blind premium tier gate is fixed by the same reordering.
   Generalised into `BILLING.md`: **a decision that gates pricing may consume only bounds, never prices.**

3. **RULED — accepted, and now defined in the spec.** `ceilingTokens` on a row of a turn with unresolved slots is
   a **best case**: the ceiling this model receives if every unresolved slot resolves to its cheapest admissible
   option. **Rejected:** a range (its lower endpoint is the worst arrangement, carrying exactly the
   non-monotonicity being escaped); omitting the number (notion 3's question is literally "up to what ceiling
   each"); conservative grading (breaks `admissible ⊆ affordable` at option level and §Affordability 6 — an
   unclamped arrangement totals `funding − ((funding − fixedCosts) mod Σrate)`, so "costliest" flips on a
   remainder and a richer payer sees a _smaller_ ceiling).
   **Safe because the asymmetry is deliberate: presented ceilings are best-case, the hold is worst-case, and that
   is what makes both monotone.** Measured at a presented 64,000 against a hold priced on 13,291 tokens; an
   over-presented ceiling degrades to a shorter answer, never a refusal, since the send gate is a separate
   monotone predicate. **The guard keeping it display-only is B6's `B + H == ceiling` bound, which is NOT yet
   built** — verify when B6 lands rather than assuming it holds today.

4. **RULED — G1 rule 7 rejects a bare `string` parameter on any module export; branded and refined string types
   stay legal.** **Rejected:** a content-type-name list (a sync contract in rule form — maintained forever, and a
   new content type ships uncovered, which is the shape CODE-RULES bans); forbidding all strings (breaks
   `NanoUSD`, a string at JSON boundaries by design); a whitelisted primitive set (heaviest, and it taxes every
   unrelated new type).
   The principle, now in `BILLING.md`: **phrase the rule over what a type PERMITS, not what it is NAMED.** A
   branded string is a scalar with a checked shape; a bare `string` is unbounded content.
   **Dependency: B8 must define `ModelId` as a branded string**, since model ids are bare strings today — which
   also closes the doc defect where §Data Structures named a type that did not exist. One change, two items.

5. **RULED — collapse onto the module implementation, and drop storage from the trial gate. B5 owns both.**
   `premium-check.ts` had **no production consumer**; the live path is `tier-gate.ts` → `trial-eligibility.ts`,
   which carries its own price percentile and recency window. The moved `premium.ts` is the correct one — bigint
   comparison, clock injected rather than read, fees at the right seam — so collapse onto it and delete the
   duplicated constants. The module can host it because both the clock and the pool percentile are **inputs**,
   which is what preserves purity.
   **And the trial gate stops pricing storage** — §Trial Usage's "trial never persists" is unconditional.
   **A product consequence B5 must measure, not ship quietly:** storage was _inflating_ trial cost, so the 1¢ cap
   now buys more and **more models become trial-eligible.** Report eligibility before and after.

6. **DONE — the `BILLING.md` batch is applied** (29 edits, prettier-clean). The process lesson is the
   orchestrator's: **batching doc corrections to avoid churn produced a fourteen-item backlog whose first item
   became a correctness problem.** The durable rule is that a task invalidating a normative statement corrects it
   **in that task** — a batch's cost grows with every reader who arrives before it lands.

### The pattern underneath rulings 4, 5 and 6

All three are one failure in different clothes: **this run repeatedly built a correct thing beside an incorrect
one and relied on a later step to remove the incorrect one.** The correct premium classifier beside the live
duplicate; correct vocabulary functions beside three inlined copies; a producer that drops classifier storage
beside a live path that folds it in; corrected doc text queued behind a spec that still said the wrong thing.
**Every instance became a defect or an open item.**

**Standing rule for the rest of this run: a task that supersedes a live path deletes it in the same task, or the
plan names the deleting task in that task's criteria before the replacement lands.** Not "records that it should
be deleted" — names the owner, in criteria. Three of these six questions would not have existed under it.

## Deferred, with reasons

- **Extracting the affordability module to its own workspace package.** Trigger recorded in
  §Where the Code Lives: when the arch rule records a legitimate exception, or a build target needs
  affordability without the shared package.
- **The estimator prices mutually-exclusive branch targets additively**, so the first real branching
  workflow over-holds by the branch count. No shipped definition uses `branch`; fixing it now would
  be speculative, and the fix is new money-critical static analysis whose failure direction is
  under-reserve.
- **Magnitude in refusals** ("about 2¢ short") — ruled not now.
- **A usage or receipt surface** — out of scope.
- **The lock-order inversion** between member removal and settlement (sub-millisecond window,
  documented, accepted).
- **Media price floor** — deliberately not extended; a per-unit equivalent would be a new commercial
  rule, not a translation.
