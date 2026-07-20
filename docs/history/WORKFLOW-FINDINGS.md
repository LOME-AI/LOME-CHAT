# Workflow Findings — Subagent-Driven Development, Refined Against the Field

Research 2026-07-19 (primary sources) + founder rulings 2026-07-19. **All points are now
ruled**; this file is the lossless decision record. Adopted content has been written into
its target docs (SKILL.md, sdd-implementer.md, sdd-auditor.md, AGENT-RULES.md,
CODE-RULES.md); archived here 2026-07-19.

**Source dots:** ⚫ our skill (S# = pre-overhaul skill/agent-def point) · 🔴 Bun Zig→Rust
migration (Sumner/Anthropic; bun.com/blog/bun-in-rust + PORTING.md, oven-sh/bun `46d3bc29`)
· 🔵 Anthropic official (best-practices/context-engineering/multi-agent/harness posts,
docs, published plugins) · 🟣 obra/superpowers (incl. measured results) · 🟢+initials
practitioners (BC Cherny · GH Huntley · DH Horthy · KK Klaassen · SW Willison · MH
Hashimoto · AR Ronacher · TB Ball) · 🟡 counterpoints/failure catalogs (Cognition,
community, arXiv 2606.07828) · ⚪ ours/new.

---

# Part 1 — Foundational rulings

## R1. Doc placement: split; no new always-loaded doc

Universal doctrine → AGENT-RULES.md (already loaded by every agent). Orchestration
mechanics → the skill + agent defs (loaded only when orchestrating). No merging of
existing docs. **Reason:** subagents load the CLAUDE.md chain; orchestration rules in it
would pollute every implementer/auditor context, and 🔵 "bloated CLAUDE.md files cause
Claude to ignore your actual instructions."
**Rejected — consolidate everything into AGENT-RULES:** attention-tax in every
non-orchestrated session. **Rejected — 🟢GH's everything-always-loaded:** assumes a
single-purpose repo; ours is mixed-use.

## R2. Auditor stance: hybrid

Keep calibrated verdicts (no manufactured findings, confidence floor, do-not-flag list)
plus the adversarial **evidence posture**: the implementer's report is unverified
claims; rationales never downgrade severity; reward-hacking smells hunted explicitly
(stubs presented as done, "suspiciously long explanatory comments" — 🔴 "If you need a
paragraph-long comment to justify why the workaround is OK, the code is wrong").
Skepticism about claims, calibration about verdicts — where 🔵 also lands.
**Rejected — full adversarial (🔴🟣 "assume the code is wrong"):** 🔵 measured that a
reviewer prompted to find gaps always finds some. **Rejected — pure neutral:** 🟣
measured auditors trusting reports instead of the diff.

## R3. Auditor count: tiered 1/2/3

1 default · 2 independent auditors for money/settlement/crypto-adjacent tasks even when
not formally sensitive · 3-lens panel (correctness/security/conventions) for
sensitive-flagged tasks.
**Rejected — always 2+ (🔴):** doubles cost everywhere. **Rejected — keep 1+panel only:**
under-audits high-stakes-but-unflagged tasks.

## R4. Dispatch: free-form dependency graph — no waves _(founder modification)_

The plan records a dependency graph (depends-on = consumes output OR shares files);
contracts first. The orchestrator maintains the graph continuously and dispatches any
task the moment ALL its dependencies are clean and no in-flight task shares its files —
never batched, never waiting for siblings. Parallel implementers remain allowed across
disjoint file ownership, with per-task **Interfaces blocks** (Consumes/Produces, exact
signatures) as the shared-contract mechanism.
**Rejected — wave batching (⚫ original):** waves were a planning artifact; a finished
task should unlock successors immediately. **Rejected — serialize all implementation
(🟣, Cognition):** guards a failure file-ownership + contracts-first already prevents.
**Rejected/deferred — worktree-per-implementer:** revisit only if collisions appear.

## R5. Artifact transport

| Artifact                   | Form                                     | Written by        | Read by                                           |
| -------------------------- | ---------------------------------------- | ----------------- | ------------------------------------------------- |
| `plan.md`                  | file, immutable after approval           | orchestrator      | every subagent, every cycle                       |
| `ledger.md`                | file, append-terse                       | orchestrator only | future orchestrator; human                        |
| Brief                      | **prompt string**                        | orchestrator      | one subagent, once                                |
| `task-xx/impl-report-N.md` | file                                     | implementer/fixer | that task's auditor (phase B); same-lineage fixer |
| Audit report               | **message only**, full findings          | auditor           | orchestrator                                      |
| `research/*.md`            | file, only when it feeds multiple briefs | research agents   | orchestrator + briefs                             |

- **Run directory: `docs/plans/runs/{date}-{slug}/`** — `plan.md`, `ledger.md`,
  `research/`, `task-xx/`. The `runs/` subdir separates ephemeral run state from the
  standing design docs already in `docs/plans/` (ADMIN-PLANE.md etc. stay put — they are
  referenced by path from ARCHITECTURE.md and memory; moving them breaks references for
  zero benefit). Survives session death → cross-session resume.
- **Single writer per file** (mirrors single-writer-per-table); **cycle-numbered
  filenames, never overwritten**; the orchestrator names exact filenames in every brief.
- **Ledger carries** status transitions plus, per failed audit, validated findings as
  one-liners and invalid findings with the rejection reason — the durable curation
  record; after compaction, trust ledger + `git status` over recollection.
- **Fix briefs carry only orchestrator-validated findings** — a fixer never reads a raw
  audit; judged-invalid findings never reach it.
- **Rejected — brief files:** once `plan.md` holds the shared payload, a brief is small
  and read exactly once; a file saves nothing over a prompt string.
- **Rejected — auditor report file:** findings ARE the orchestrator's decision payload;
  a file would only duplicate and tempt fixers to read unvalidated findings.
- **Rejected — RED/GREEN transcripts in reports (🟣):** our auditor judges end state,
  not process; evidence trimmed to command + one-line result + counts, full output only
  for failures/surprises.
- **Rejected — 🟣's don't-re-run-checks rule:** the auditor runs scoped checks itself in
  the blind phase; claimed results are a cross-check target, not a substitute.

## R6. Auditor protocol: blind first, reconcile second

**Phase A (blind):** brief + `plan.md` criteria + code on disk; navigation from
`git diff`; run scoped checks; form findings and provisional scores — before opening the
report. **Phase B (reconcile):** read `impl-report-N.md` as a checklist: flagged concerns
you missed → investigate; claimed results contradicting your runs → red flag; deviations
→ verify against criteria, severity unmoved by rationale. Reconciliation may add findings
or raise severity; it may resolve one only via code/criteria evidence, never the
rationale alone.
**Reason:** 🔴🔵 split contexts because narrative pre-frames any reader; but the report
file is the only channel for implementer concerns to reach the auditor — ordering gets
independence AND coverage. **Rejected — withhold the report (🔴):** loses the concerns
channel. **Rejected — report-first (🟣):** instruction armor is weaker than not being
anchored.

## R7. Report readership boundaries

**No cross-task report reads, ever** — dependents couple to `plan.md` Interfaces, never
to a sibling's implementation story (the slice-barrel doctrine applied to the run).
Contract deviations reach siblings only via raise → orchestrator → plan amendment.
**Same-lineage exception:** a fixer reads its own task's prior reports by default. Task
dirs kept.

## R8. Raise vs write (the subagent contract)

Stated to every subagent: _your file is the complete record, read by the next agent in
the chain, not by the orchestrator; your message is read by the orchestrator, who will
not read your file unless arbitrating. Anything that should influence orchestration and
appears only in your file is lost. The file is a superset — nothing exists only in the
message._

**RAISE:** status + self-gate one-liners + confidence; blockers/missing context;
out-of-scope needs; contract/criteria deviations even when justified; invalidated plan
assumptions; cross-task side effects; failures attributed outside ownership; (auditor)
full findings, scores, INSUFFICIENT CONTEXT items, suspected plan defects. Common
thread: **facts whose blast radius exceeds your task.**
**WRITE only:** per-criterion evidence, per-file change notes, test-to-criterion mapping,
concerns detail, failure excerpts.
**Tiebreaker:** coordination facts raise; evidence writes; unsure → raise.

## R9. Brief addressing header (mandatory, orchestrator-templated)

```
READ:  plan.md §Task-03 + §Global-Constraints [; task-03/impl-report-2.md  ← exact cycle]
WRITE: task-03/impl-report-3.md                ← exact filename, never "the next one"
BOUNDS: nothing else in the run directory — other task dirs are out of bounds.
```

## R10. Auto-invocation

The main agent auto-invokes the skill for any implementation task that isn't trivial —
no manual invocation; `disable-model-invocation` removed; ceremony scales instead of
refusing medium tasks.

## R11. Run-dir lifecycle _(founder revision 2026-07-19)_

Run dirs stay in `docs/plans/runs/` permanently as the run's record — never deleted,
never updated, never cited as current. `docs/history/` is for document-level records
(superseded or completed manually-authored docs, e.g. this file). Legitimized in
CODE-RULES' doc-lifecycle section (D35).
**Rejected — delete-at-close and archive-to-history (earlier drafts):** the run dir is
the review aid for the uncommitted work and the run's audit trail; it self-archives in
place.

## R12. No model or effort routing _(founder)_

Every dispatch — implementer, auditor, validator, critic, researcher — inherits the
session model. The skill never chooses models or effort.
**Rejected — 🟣/🔵/wshobson per-dispatch routing and tiering** (D29): simplicity and
consistency outweigh the cost tuning.

## R13. Fix everything — no minors backlog _(founder, replacing minors-triage)_

Every finding that survives the orchestrator's validity judgment gets fixed in the fix
cycle regardless of severity; severity orders work, it never defers it. The do-not-flag
list still filters noise (pre-existing issues, linter-territory, nitpicks) — but whatever
is flagged and validated is fixed. High quality bar; nothing accumulates.

## R14. E2E policy _(founder-shaped, replacing generic E2E close-out)_

CODE-RULES gains a "When to Write an E2E Test" section (criteria: new/materially altered
user-facing flow; critical-path flows; integration-seam-only behavior; major feature bug
that escaped unit/integration coverage → new or extended E2E guard). The skill follows
it: `plan.md` declares the related E2E specs (existing + new) at approval time; at close
the orchestrator runs **only those** — never the full suite; failures are investigated
and reported to the human BEFORE any changes, then the run waits for the human's
decision.

## R15. Doc proposals as end-of-run diffs _(founder modification of codification)_

Throughout the run the orchestrator catalogs every documentation change the work implies
(including lessons from recurring audit failures). At the end it presents them in chat as
a per-file diff of proposed removals vs additions; the human decides each. No doc is
edited without that approval.

## R16. Concurrent agents _(founder, replacing clean-baseline check)_

AGENT-RULES gains a line: other agents may be working in the repository at the same time
— ignore their work; never investigate, fix, or revert changes you did not make. Pairs
with attribution everywhere: the close pass fixes only problems this run caused. Lives
ONLY in AGENT-RULES (founder: no duplication into agent defs — subagents load the
CLAUDE.md chain automatically). Post-audit rulings: the skill keeps its cost-honesty
sentence (~10×, tiers scale the premium) and the auditor's RECONCILIATION report section.

---

# Part 2 — Point rulings (D1–D40, founder 2026-07-19)

## Invocation & scaling

- **D1 ✅ adopted.** Trivial threshold — skip the skill only when ALL hold: one-sentence
  diff, few lines, single concern, no design decisions. 〔🔵🟢BC〕
- **D2 ✅ adopted.** AGENT-RULES trigger line with the not-already-a-subagent guard. 〔⚪〕
- **D3 ✅ adopted** (reworded per R4/R12 — no waves, no pilot, no model tiers). Tier 1
  (~1–3 tasks): compact plan, run dir + ledger still created, 1 implementer + 1 auditor
  per task. Tier 2: full ceremony. Orchestrator declares tier in the digest. 〔⚪🔵〕
- **D4 ✅ adopted.** Approval gate holds at every tier; human may waive per-request. 〔⚪〕
- **D5 ❌ rejected.** No pilot wave. 〔🔴🔵 not adopted〕

## Planning

- **D6 ✅ adopted.** Batch all plan-phase questions into one AskUserQuestion round. 〔🟣🔵〕
- **D7 ✅ adopted.** Interview-driven spec as an optional technique. 〔🔵🟢BC〕
- **D8 ✅ adopted.** Error-amplification framing (bad plan line = hundreds of bad code
  lines) as the skill's stated reason humans review plans, not diffs. 〔🟢DH·SW·MH〕
- **D9 ✅ adopted.** Global Constraints section in `plan.md`. 〔🟣〕
- **D10 ❌ rejected.** No placeholder-ban rule for plans. 〔🟣 not adopted〕
- **D11 ❌ rejected.** No formal plan self-review step. 〔🟣 not adopted〕
- **D12 ✅ adopted.** Competing-designs option (2–3 architect agents, different mandates)
  for big features. 〔🔵〕
- **D13 ✅ adopted.** Right-sizing: smallest unit carrying its own test cycle and worth a
  fresh auditor's gate. 〔🟣⚫〕
- **D14 ❌ rejected.** No scout pattern. 〔🟢SW not adopted〕
- **D15 ✅ adopted.** Pre-computed shared analyses as `research/` artifacts briefs trust
  over local guessing. 〔🔴〕
- **D16 ❌ rejected, replaced.** No clean-baseline check; instead the AGENT-RULES
  concurrent-agents line (R16). 〔🟣 not adopted; ⚪ replacement〕

## Implementer

- **D17 ❌ rejected.** No escalation-legitimacy line. 〔🟣 not adopted〕
- **D18 ✅ adopted** (minus model-escalation per R12). Statuses DONE /
  DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT with prescribed orchestrator responses:
  context → improve brief + re-dispatch; too large → split; plan wrong → human; never a
  blind same-brief retry. 〔🟣〕
- **D19 ✅ adopted.** Focused test while iterating; full scoped suite once at the end. 〔🟣〕

## Auditor

- **D20 ❌ rejected.** Keep current severity wording. 〔🟣 not adopted〕
- **D21 ✅ adopted, modified.** Named-risk out-of-diff checks PLUS deeper investigation
  whenever there is a concern or it is reasonable — looser than 🟣's one-check-per-risk;
  still never aimless repo crawling. 〔🟣+founder〕
- **D22 ✅ adopted** (same-model per R12). Critical finding from a single-auditor task →
  one validator confirms before a fixer dispatches. 〔🔵〕
- **D23 ✅ adopted.** Audit briefs never pre-judge ("do not flag X" banned); plan-indicting
  findings escalate to the human. 〔🟣〕

## Close phase

- **D24 ❌ rejected as written, replaced by R14** (E2E criteria in CODE-RULES + related-E2E
  declared in plan + close-run of only those + investigate-report-wait on failures).
- **D25 ✅ adopted.** Completeness critic at close (auditor-type, close-out brief). 〔🟢MH〕
- **D26 ✅ adopted.** Close-pass findings batched to ONE fixer. 〔🟣〕
- **D27 ❌ rejected, replaced by R13** (fix everything; no minors backlog).
- **D28 ✅ adopted, modified per R15** (catalog throughout; per-file removed/added diffs at
  end; human decides each). 〔🟢KK·BC·GH·🟣·MH + founder〕

## Cross-cutting & other docs

- **D29 ❌ rejected → R12.** No model/effort routing.
- **D30 ❌ rejected.** Two-strikes-then-reset is human interactive-session technique;
  the agent-side mechanism is already covered by D37. 〔🔵🟢BC·MH not adopted〕
- **D31 ✅ adopted.** No-verifiable-criterion rule — founder relocated it from AGENT-RULES
  to the skill (Phase 1 decomposition). 〔🟢SW·🔵〕
- **D32 ❌ rejected.** Fresh-verification rule — already covered by AGENT-RULES'
  Verified/Inferred/Assumed discipline. 〔🟣🟡 not adopted〕
- **D33 ❌ rejected.** Red-green-red revert leg not adopted; TDD bugfix rules already in
  AGENT-RULES ("the failing test reproduces the bug first"). The major-feature-bug case
  is covered by the E2E criteria (R14). 〔🟣 partially folded〕
- **D34 ✅ adopted.** Prune test for doc lines → CODE-RULES Documentation. 〔🔵🟢KK〕
- **D35 ✅ adopted.** Doc-lifecycle line legitimizing `docs/plans/runs/` with mandatory
  disposition at close → CODE-RULES. 〔⚪〕
- **D36 ❌ rejected.** No utilization-band guidance. 〔🟢DH·🔵 not adopted〕
- **D37 ✅ adopted.** Cheap-reset doctrine (throw away a wedged attempt, improve the
  brief, re-dispatch; keep the knowledge, burn the code). 〔🟢GH·SW·MH·🔵〕
- **D38 ❌ rejected.** No evidence-for-skill-edits rule. 〔🟣 not adopted〕
- **D39 ✅ adopted.** "Fix the process, not the code" elevated to the fix-loop's stated
  principle. 〔⚫🔴🟢GH·KK〕

## Subagent architecture

- **D40 ✅ adopted.** Exactly two SDD agent types; fixer/validator/critic are briefs, not
  new definitions; researchers are the existing Explore/package-researcher/deep-research;
  all same-model (R12). Reasons: per-definition tuning burden; 🟡 name-based behavior
  override; briefs are the engineered role-delivery vehicle.

---

# Part 3 — Confirmed existing doctrine (founder: approve all; #27 modified)

1. Cost honesty (scale down per R10 instead of refusing medium) 〔🔵🟢SW〕 · 2. Writes
   single-threaded, reads parallel 〔🟡🟣🔵〕 · 3. Orchestrator holds plan + distilled
   summaries only 〔🟢DH·GH·🔵🟣〕 · 4. Orchestrator reads code only when decision-load-bearing
   〔🟢BC·DH〕 · 5. Zero-unknowns plan 〔🔵🟣〕 · 6. Humans decide design; agents fetch facts
   〔🔵🟢MH〕 · 7. Stranger-test criteria 〔🟣🟢DH〕 · 8. Hard approval gate 〔🟣🟢MH·BC〕 ·
2. Sensitive-task flagging · 10. Dependency graph, contracts first (now free-form, R4) ·
3. Effort scaling; no breadth the work doesn't have 〔🔵〕 · 12. Four-part brief — 🔵's
   published anatomy is ours word-for-word 〔🔵🟣〕 · 13. Think-like-your-agent pre-flight
   〔🔵〕 · 14. Auditor gets identical criteria — 🟣 measured the failure otherwise 〔🟣〕 ·
4. Blocker over guess 〔🟣🔴〕 · 16. No sub-spawning; auditor read-only by construction
   〔🟣🔵〕 · 17. File-ownership discipline; event-driven dispatch 〔🟡〕 · 18. TDD iron law +
   watch-it-fail 〔🟣🟢KK·🔵〕 · 19. Minimal code; match idioms; no check-silencing;
   out-of-scope reported never made; self-gating 〔🟣🔴🔵〕 · 20. Implementer never reviews;
   reviewer never implements 〔🔴🟣〕 · 21. Fresh-context audit 〔🔴🔵🟣🟢KK·BC〕 · 22. Diverse
   lenses on panels 〔🔵〕 · 23. Calibration doctrine 〔🔵🟣〕 · 24. file:line evidence;
   deterministic-first; failure attribution; scored rubric; INSUFFICIENT CONTEXT; forced
   verdict; affirmations 〔🟣🔵〕 · 25. Judge end state, not process story · 26. Closed
   feedback loop as core doctrine — strongest convergence in the corpus 〔🟢BC·🔵🟢SW·GH·KK·MH·TB〕
   · **27. Final full unscoped pass — MODIFIED: fix only problems caused by this run**
   (attribution; concurrent agents, R16); its valid problems become tasks, orchestrator never
   patches 〔🟣+founder〕 · 28. Diagnose-brief-first; every fix re-audited; three-cycle cap
   then escalate 〔🔴🟣〕 · 29. Continuous execution between gates; ambiguity → human 〔🟣🔵〕 ·
5. Close-out summary; no commit.

---

# Appendix — informational (no decisions)

- Multi-agent won +90.2% on 🔵's research eval; token spend explained ~80% of variance.
- 🔵's named context failures: kitchen-sink session, correcting-over-and-over, infinite
  exploration; context rot is universal and gradual.
- 🔴 migration-scale mechanics if ever needed: restart-safe batch feeder,
  compile-errors-as-work-queue, resource containment, prompt-cache-shaped loops (12:1).
- Conformance-oracle precondition: 🔴's +1M-line rewrite was reviewable only because
  1.39M language-independent assertions acted as the oracle ("0 tests skipped or
  deleted"); our 95% coverage gate is this precondition.
- Model quality beats token budget (🔵); don't cap orchestrator thinking (🟣).
- The human sits ON the loop, not in it (🔴 11 days of reading outputs and prompting
  loop edits); review bandwidth is the true parallelism cap (🟢SW·TB·🟡).
- Instructions vs enforcement: docs advise, hooks/permissions enforce — already our split.
