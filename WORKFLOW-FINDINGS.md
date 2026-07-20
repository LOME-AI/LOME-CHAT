# Workflow Findings — Subagent-Driven Development, Refined Against the Field

Research 2026-07-19 (primary sources) + founder rulings 2026-07-19. Three parts:

- **Part 1 — RULED.** Settled decisions with reasons, including rejections. A record, not a ballot.
- **Part 2 — DECIDE.** The remaining open points, D1–D40, ordered for one linear pass. Each: proposal → why → sources → target doc.
- **Part 3 — CONFIRM.** Existing doctrine the research validated. Bulk-confirm or name exceptions.
- **Appendix** — informational context, no decisions.

When done, adopted content is written into its target docs and this file is archived to `docs/history/`.

**Source dots:** ⚫ our skill (S# = current skill/agent-def point) · 🔴 Bun Zig→Rust migration (Sumner/Anthropic; bun.com/blog/bun-in-rust + PORTING.md, oven-sh/bun `46d3bc29`) · 🔵 Anthropic official (best-practices/context-engineering/multi-agent/harness posts, docs, published plugins) · 🟣 obra/superpowers (incl. measured results) · 🟢+initials practitioners (BC Cherny · GH Huntley · DH Horthy · KK Klaassen · SW Willison · MH Hashimoto · AR Ronacher · TB Ball) · 🟡 counterpoints/failure catalogs (Cognition, community, arXiv 2606.07828) · ⚪ ours/new.

**Target docs:** `SKILL` subagent-driven-dev SKILL.md · `IMP` sdd-implementer.md · `AUD` sdd-auditor.md · `A-R` docs/AGENT-RULES.md · `C-R` docs/CODE-RULES.md · `none` no doc change.

---

# Part 1 — RULED

## R1. Doc placement: split; no new always-loaded doc *(was T6)*

Universal doctrine → AGENT-RULES.md (already loaded by every agent). Orchestration mechanics → the skill + agent defs (loaded only when orchestrating). No merging of existing docs. **Reason:** subagents load the CLAUDE.md chain; orchestration rules in it would pollute every implementer/auditor context, and 🔵 "bloated CLAUDE.md files cause Claude to ignore your actual instructions."
**Rejected — consolidate everything into AGENT-RULES:** pays attention-tax in every non-orchestrated session. **Rejected — 🟢GH's everything-always-loaded:** assumes a single-purpose repo where every session is the loop; ours is mixed-use.

## R2. Auditor stance: hybrid *(was T2)*

Keep calibrated verdicts (no manufactured findings, confidence floor, do-not-flag list) + adopt the adversarial **evidence posture**: the implementer's report is unverified claims; rationales never downgrade severity; reward-hacking smells hunted explicitly (stubs presented as done, "suspiciously long explanatory comments" — 🔴 "If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong"). Skepticism about claims, calibration about verdicts — where 🔵 AO also lands.
**Rejected — full adversarial (🔴🟣 "assume the code is wrong"):** 🔵 measured that a reviewer prompted to find gaps always finds some; inflates false positives. **Rejected — pure neutral (keep as-was):** 🟣 measured auditors trusting implementer reports instead of the diff.

## R3. Auditor count: tiered 1/2/3 *(was T3)*

1 auditor default · 2 independent auditors for money/settlement/crypto-adjacent tasks even when not formally sensitive · 3-lens panel (correctness/security/conventions) for sensitive-flagged tasks.
**Rejected — always 2+ (🔴):** doubles audit cost everywhere; our stakes tiering targets the spend. **Rejected — keep 1+panel only:** leaves high-stakes-but-unflagged tasks under-audited.

## R4. Parallelism: waves + Interfaces blocks *(was T4)*

Keep parallel waves across disjoint file ownership; add per-task **Interfaces blocks** (Consumes/Produces, exact signatures) to `plan.md` so parallel tasks can't disagree on shared contracts — the engineered fix for the documented shared-contract failure (🟡).
**Rejected — serialize all implementation (🟣, Cognition):** guards a failure our file-ownership + contracts-first ordering already prevents; wastes wall-clock on independent slices. **Rejected/deferred — worktree-per-implementer:** overkill while file-ownership holds; revisit only if cross-task collisions actually appear.

## R5. Artifact transport *(was T5; settled through discussion)*

| Artifact | Form | Written by | Read by |
|---|---|---|---|
| `plan.md` | file, immutable after approval | orchestrator | every subagent, every cycle (criteria, Global Constraints, Interfaces, ownership, scoped checks) |
| `ledger.md` | file, append-terse | orchestrator only | future orchestrator (compaction/resume); human |
| Brief | **prompt string** | orchestrator | one subagent, once |
| `task-xx/impl-report-N.md` | file | implementer/fixer | that task's auditor (phase B); same-lineage fixer |
| Audit report | **message only**, full findings | auditor | orchestrator |
| `research/*.md` | file, only when it feeds multiple briefs | research agents | orchestrator + referenced by briefs |

- **Run directory:** `docs/plans/{date}-{slug}/` — `plan.md`, `ledger.md`, `research/`, `task-xx/`. Date-first to match existing docs/plans convention. Survives session death → cross-session resume for free (session scratchpad would not).
- **Single writer per file** (mirrors single-writer-per-table): orchestrator owns plan+ledger; each subagent writes only its assigned file. **Cycle-numbered filenames, never overwritten** (`impl-report-2.md`); the orchestrator names exact filenames in every brief.
- **Ledger carries** status transitions, one line each, plus per-failed-audit: validated findings as one-liners and invalid findings with the rejection reason (the durable curation record; survives compaction).
- **Fix briefs carry only orchestrator-validated findings** — the fixer never reads a raw audit, so judged-invalid findings never reach it. Curation is the flow, not extra work.
- **Rejected — brief files:** after `plan.md` absorbs the shared payload, a brief is small, role-specific, and read exactly once — a file read once by one reader saves nothing over a prompt string. (The write-once-read-many saving lives in `plan.md`, not briefs.)
- **Rejected — auditor report file:** findings ARE the orchestrator's decision payload (S19 validity judgment) — they must be fully in the message anyway; a file would only duplicate, and would tempt fixers to read unvalidated findings.
- **Rejected — RED/GREEN transcripts in reports (🟣's rule):** our auditor judges end state, explicitly not process (⚫S47); transcripts are dead weight to every reader. Evidence rule trimmed to: command + one-line result + counts; full output excerpted only for failures or surprises.
- **Rejected — 🟣's don't-re-run-checks rule:** our auditor runs scoped checks itself in the blind phase (R6); the implementer's claimed results serve as a cross-check target, not a substitute.

## R6. Auditor protocol: blind first, reconcile second

**Phase A (blind):** brief + `plan.md` §task + Global Constraints + code on disk; navigation from `git diff` (unbiased); run scoped checks; form findings and provisional scores — before opening the report. **Phase B (reconcile):** read `impl-report-N.md` as a checklist: implementer-flagged concerns the auditor missed → investigate; claimed check results contradicting its own runs → red flag; deviations-with-reasons → verify against criteria, severity unmoved by rationale. Reconciliation may **add** findings or raise severity; it may resolve a finding only via code/criteria evidence, never the rationale alone.
**Reason:** 🔴🔵 split contexts because narrative pre-frames any reader ("the Claude that wrote the code wants the code to get accepted"); but the report file is the only channel for implementer concerns to reach the auditor — ordering gets independence AND coverage. **Rejected — withhold the report entirely (🔴):** loses the concerns channel. **Rejected — report-first (🟣):** instruction-level armor is weaker than not being anchored.

## R7. Report readership boundaries

**No cross-task report reads, ever.** Dependents couple to the contract (`plan.md` Interfaces), never the implementation story — reports are task-internal; the plan is the published API (the slice-barrel doctrine applied to the run). Contract deviations reach siblings only via raise → orchestrator → plan/brief update. **Same-lineage exception:** a fixer reads its own task's prior `impl-report-*.md` by default. Task dirs stay (room for unanticipated artifacts, e.g. scout notes).

## R8. Raise vs write (the subagent contract)

Purpose, stated to every subagent: *your file is the complete record, read by the next agent in the chain, not by the orchestrator; your message is read by the orchestrator, who will not read your file unless arbitrating. Anything that should influence orchestration and appears only in your file is lost. The file is a superset — nothing exists only in the message.*

**RAISE (message)** — anything that changes what the orchestrator does next: (1) status + verdict facts, self-gate one-liners, confidence high/medium/low + reason; (2) blockers and missing context; (3) out-of-scope needs; (4) contract/criteria deviations, even justified ones; (5) invalidated plan assumptions; (6) cross-task side effects (shared fixtures, deps, env/ports); (7) check failures attributed outside ownership (auditor: attribution-unsure too); (8) auditor: full findings + dimension scores + every INSUFFICIENT CONTEXT item + suspected plan/criteria defects. Categories 3–6 are one family: **facts whose blast radius exceeds your task.**

**WRITE (file only)** — evidence and detail: per-criterion evidence, per-file change notes, test-to-criterion mapping, concerns/limitations, Minor elaboration, failure excerpts.

**Tiebreaker:** coordination facts get raised; evidence gets written; when unsure, raise — a one-line mention costs nothing, a missed re-sequencing corrupts a wave.

## R9. Brief addressing header (mandatory, orchestrator-templated)

```
READ:  plan.md §Task-03 + §Global-Constraints [; task-03/impl-report-2.md  ← exact cycle]
WRITE: task-03/impl-report-3.md                ← exact filename, never "the next one"
BOUNDS: nothing else in the run directory — other task dirs are out of bounds.
```

Out-of-bounds guards audit independence and prevents building against unaudited work.

## R10. Auto-invocation (principle ruled; details in D1–D4)

The main agent auto-invokes the skill for any implementation task that isn't extremely small — no manual invocation. `disable-model-invocation` is removed; the skill scales its ceremony to task size instead of refusing medium tasks. Only truly trivial work (a few straightforward lines) proceeds without it.

## R11. Run-dir lifecycle

At close: delete the run dir, or archive to `docs/history/` if worth keeping. (The one-line legitimization in CODE-RULES' doc-lifecycle section is D35.)

---

# Part 2 — DECIDE (linear, D1–D40)

## Invocation & scaling

- **D1. Trivial threshold.** Skip the skill only when ALL hold: describable as a one-sentence diff 〔🔵🟢BC〕, few lines, single concern, no design decisions. Everything else auto-invokes. → SKILL (description + body)
- **D2. AGENT-RULES trigger line.** One line in A-R making auto-invocation doctrine, not just description-matching: "any implementation task beyond the trivial threshold → invoke subagent-driven-dev" — with the guard "unless already operating as an SDD subagent." 〔⚪〕 → A-R
- **D3. Two ceremony tiers, orchestrator declares which in the plan digest.** Tier 1 (roughly 1–3 tasks): compact plan, run dir + ledger still created, 1 implementer + 1 auditor per task. Tier 2: full ceremony — pilot wave, parallel waves, tiered audits, close pass. 〔⚪ · 🔵 effort-scaling〕 → SKILL
- **D4. Approval gate at Tier 1.** Recommend: the human-approval invariant holds at every tier (digest is ~10 lines at Tier 1); the human may waive per-request ("go ahead without a plan"). Alternative: Tier 1 auto-proceeds — faster, but breaks invariant #1. → SKILL

## Planning additions

- **D5. Pilot wave (Wave 0).** At Tier 2, dispatch ONE representative task through the full implement→audit cycle first; its audit doubles as a test of the brief template ("de-risk it first" — 🔴 ran 3 files before 1,448; 🔵 "test on a few files, then run at scale"). → SKILL
- **D6. Batch questions.** All plan-phase questions collected into ONE AskUserQuestion round, not serial interrupts. 〔🟣🔵〕 → SKILL
- **D7. Interview-driven spec (optional tool).** For fuzzy features: interview the human via AskUserQuestion until the spec is complete — "time spent making the spec precise pays off more than watching implementation." 〔🔵🟢BC〕 → SKILL
- **D8. Error-amplification framing.** State in the skill why the human reviews plans not diffs: a bad plan line is hundreds of bad code lines; a bad research line, thousands. 〔🟢DH·SW·MH〕 → SKILL
- **D9. Global Constraints section** in plan.md: spec-wide requirements, exact values verbatim, implicitly part of every task's criteria and every auditor's lens. 〔🟣〕 → SKILL
- **D10. No placeholders in plans.** Ban "TBD", "add appropriate error handling", "similar to Task N" (repeat it — tasks are read out of order). 〔🟣〕 → SKILL
- **D11. Plan self-review** before presenting: spec coverage, placeholder scan, cross-task naming/type consistency. 〔🟣〕 → SKILL
- **D12. Competing designs (optional, big features).** 2–3 architect agents with different mandates (minimal/clean/pragmatic); orchestrator recommends; human picks. 〔🔵 feature-dev plugin〕 → SKILL
- **D13. Task right-sizing wording.** Sharpen "one coherent unit" to: the smallest unit that carries its own test cycle AND is worth a fresh auditor's gate — split only where an auditor could reject one task while approving its neighbor. 〔🟣⚫S9〕 → SKILL
- **D14. Scout pattern.** For a genuinely murky plan area: one agent attempts it purely to find the sticky bits; burn the code, keep the knowledge (notes land in `research/`). 〔🟢SW〕 → SKILL
- **D15. Pre-computed shared analyses.** When many tasks face the same hard cross-file question, compute the answer once as a `research/` artifact briefs are told to trust over local guessing (🔴's LIFETIMES.tsv, built with adversarial review). → SKILL
- **D16. Clean-baseline check.** Scoped checks must pass before Wave 0 dispatches — else new failures are indistinguishable from pre-existing and auditors misattribute. 〔🟣〕 → SKILL

## Implementer changes

- **D17. Escalation legitimacy line.** "It is always OK to say 'this is too hard.' Bad work is worse than no work. You will not be penalized for escalating." 〔🟣〕 → IMP
- **D18. Status vocabulary.** DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT, each with a prescribed orchestrator response (context → improve brief + re-dispatch; reasoning → stronger model; size → split; plan wrong → human; never same-model blind retry). 〔🟣〕 → IMP+SKILL
- **D19. Test-run economics.** Focused test while iterating; full scoped suite once at the end — not after every edit. 〔🟣〕 → IMP

## Auditor changes

- **D20. Severity wording.** Important = "this task cannot be trusted until it is fixed"; "coverage could be broader" and polish are Minor by definition. 〔🟣〕 → AUD
- **D21. Named-risk exceptions to diff-scoping.** Inspect outside the diff only for a concrete named risk (lock ordering, contract change, shared mutable state → call sites), one focused check per risk; never crawl the repo. 〔🟣〕 → AUD
- **D22. Validator before expensive fixes.** A Critical finding from a single-auditor task gets one cheap validator agent to confirm it's real before a fixer dispatches (🔵's validation wave / security-action filter stage). Guards the false-positive fix spiral. → SKILL
- **D23. Never pre-judge findings.** Audit briefs must not contain "do not flag X" / "at most Minor" — that's the orchestrator sparing itself a loop. Plan-mandated defects escalate to the human: "the plan's authorship does not grade its own work." 〔🟣〕 → SKILL

## Close phase

- **D24. E2E close-out for user-facing work.** Runs touching user-facing behavior end with an e2e-suite task or `run`-skill verification pass — unit-only "done" is a named failure mode (🔵; 🟢BC's verify-app). → SKILL
- **D25. Completeness critic.** One closing agent asks "what am I missing?" — criterion unverified, modality untested, doc not updated (🟢MH runs this on all work, AI or manual). → SKILL
- **D26. Fix-wave batching.** Close-pass findings go to ONE fixer with the complete validated list — 🟣 measured per-finding fixers costing more than all tasks combined. (Per-task audit fixes stay per-task.) → SKILL
- **D27. Minors triage at close.** Accumulated Minor counts in the ledger get an explicit keep/fix/drop pass — "a roll-up nobody reads is a silent discard." 〔🟣〕 → SKILL
- **D28. Post-run codification step.** From recurring audit failures and brief ambiguities, propose updates to docs/skill/agent-defs/memory — human approves each. The field's strongest shared habit ("a bug fix feels half-done if it doesn't prevent its entire category" 🟢KK; 🟢BC·GH·MH·🟣). Currently absent from our skill. → SKILL+A-R

## Cross-cutting & other docs

- **D29. Model/effort routing table.** Orchestrator strongest + thinking; implementers inherit; validators/mechanical fixes cheaper tier; sensitive-panel auditors strongest. 🟣's correction: "turn count beats token price" — cheapest models take 2–3× the turns; cheapest only for transcription-grade work. → SKILL
- **D30. Two-strikes-then-reset.** Corrected the same issue twice → clear and re-prompt with what you learned; clean session + better prompt beats accumulated corrections. 〔🔵🟢BC·MH〕 → A-R
- **D31. No-verifiable-criterion rule.** No pass/fail signal reachable → don't run an agent loop; find the signal first. 〔🟢SW·🔵〕 → A-R
- **D32. Fresh-verification rule.** No completion claims without evidence from THIS run; "agent said success" → verify the diff independently. 〔🟣🟡〕 → A-R
- **D33. Red-green-red for bug fixes.** Write test → pass → revert fix → MUST FAIL → restore → pass; proves the test guards the bug. 〔🟣〕 → C-R
- **D34. Prune test for docs.** Per line: "would removing it cause mistakes? If not, cut" — standing test for every doc this exercise touches. 〔🔵🟢KK〕 → C-R §Documentation
- **D35. Doc-lifecycle line for run dirs.** One line legitimizing ephemeral `docs/plans/{run}/` dirs with mandatory disposition at close (delete or archive) — otherwise the workflow violates the three-category doc rule. 〔⚪〕 → C-R
- **D36. Utilization guidance.** Treat ~40–60% orchestrator-context utilization as the working band; compact deliberately, not at the auto-compact cliff. 〔🟢DH·🔵〕 → SKILL
- **D37. Cheap-reset doctrine.** A wedged task/run: throw away, improve the brief, re-dispatch — keep the knowledge, burn the code; rescuing a polluted attempt usually costs more. 〔🟢GH·SW·MH·🔵〕 → SKILL
- **D38. Evidence for skill edits.** Future changes to the skill/agent defs cite evidence (a failed run, a measured improvement), not taste; carefully-tuned content (calibration language, report formats) is protected (🟣 runs evals on skills; rejects 94% of PRs). Lightweight for us: an "evidence:" line in any skill-edit proposal. → A-R
- **D39. Elevate process-repair to stated principle.** Our diagnose-the-brief-first note (⚫S20) becomes the section's headline, with 🔴's formulation: "fix the process that generates the code, not the code." → SKILL

## Subagent architecture

- **D40. Keep exactly two SDD agent types.** Recommendation: `sdd-implementer` + `sdd-auditor` remain the only SDD agent definitions. Every variant is a **brief + model-override**, not a new definition: fixer = implementer with a fix brief; validator (D22) = auditor with a validation brief + cheap model; completeness critic (D25) = auditor with a close-out brief; researchers = existing Explore / package-researcher / deep-research. **Reasons:** (a) each new agent definition is another prompt to keep tuned and another route the main agent can mis-pick — 🟡 documents name-based behavior override (a "code-reviewer"-named agent silently inherits generic expectations); (b) our briefs are now engineered as the delivery vehicle (R8/R9) — role variation is exactly what they're for; (c) cost tiers are handled per-dispatch (D29), no per-role definitions needed. 🔵's plugin fleet (six reviewer agents) is the alternative — viable, but it solves a marketplace problem we don't have. **Alternative if rejected:** add exactly one `sdd-validator` def (cheap, read-only, verdict-only) and stop there. → none / SKILL

### What changes for each subagent (summary of rulings + pending D-items)

**sdd-implementer:** file-transport contract — write `impl-report-N.md` (claims + navigation + one-line check results + concerns; no transcripts), string return per R8 raise categories (R5–R8, ruled) · READ/WRITE header compliance + no cross-task reads (R7/R9, ruled) · confidence self-assessment in every report (ruled with R8) · escalation legitimacy (D17) · status vocabulary (D18) · test-run economics (D19).

**sdd-auditor:** blind-first/reconcile-second protocol (R6, ruled) · claims-not-facts posture + reward-hacking smells (R2, ruled) · confidence floor + do-not-flag list (R2, ruled) · findings fully in message, none in file (R5, ruled) · severity wording (D20) · named-risk exceptions (D21). Unchanged: read-only construction, calibration prime directive, rubric scoring, INSUFFICIENT CONTEXT, forced verdict, affirmations, file:line evidence.

**Orchestrator (skill):** run dir + plan/ledger + curation flow (R5, ruled) · never pre-judge audit briefs (D23) · tier declaration (D3) · routing table (D29) · pilot wave (D5) · close-phase additions (D24–D28).

---

# Part 3 — CONFIRM (existing doctrine the research validated)

Bulk-confirm, or name exceptions. All ⚫ ours; dots show who independently agrees.

1. Cost honesty — orchestration ~10×; refuse for small tasks *(now: scale down per R10 instead of refusing medium)* 〔🔵🟢SW〕
2. Writes single-threaded, reads parallel 〔🟡🟣🔵〕
3. Orchestrator holds plan + distilled summaries only; detail dies in subagents 〔🟢DH·GH·🔵🟣〕
4. Orchestrator reads code only when decision-load-bearing 〔🟢BC·DH〕
5. Zero-unknowns plan; unknowns log driven empty 〔🔵🟣〕
6. Humans decide design; agents fetch facts 〔🔵🟢MH〕
7. Stranger-test acceptance criteria 〔🟣🟢DH〕
8. Hard approval gate before implementation 〔🟣🟢MH·BC〕
9. Sensitive-task flagging 〔—〕
10. Dependency graph, contracts first, waves 〔—〕
11. Effort scaling; no breadth the work doesn't have 〔🔵〕
12. Four-part brief (objective/output/tools/boundaries) — 🔵's published anatomy is ours word-for-word 〔🔵🟣〕
13. Think-like-your-agent pre-flight 〔🔵〕
14. Auditor gets identical criteria — 🟣 measured the failure otherwise (reviewers "silently redefine spec", 0/5 flagged a missing brief) 〔🟣〕
15. Blocker over guess in briefs 〔🟣🔴〕
16. Subagents can't spawn subagents; auditor read-only by construction 〔🟣🔵〕
17. File-ownership discipline; event-driven ready-set dispatch 〔🟡〕
18. TDD iron law + watch-it-fail (repo-wide) 〔🟣🟢KK·🔵〕
19. Minimal code; match idioms; no check-silencing; out-of-scope reported never made; self-gating 〔🟣🔴🔵〕
20. Implementer never reviews; reviewer never implements 〔🔴🟣〕
21. Fresh-context audit, diff not reasoning 〔🔴🔵🟣🟢KK·BC〕
22. Diverse lenses on panels 〔🔵〕
23. Calibration doctrine (findings tie to criterion/rule/bug/risk or drop; no false positives) 〔🔵🟣〕
24. file:line evidence; deterministic-checks-first; failure attribution; scored rubric; INSUFFICIENT CONTEXT verdict; forced verdict; affirmations 〔🟣🔵〕
25. Judge end state, not process story 〔—〕
26. Closed feedback loop as core doctrine (scoped-check matrix) — the strongest convergence in the corpus 〔🟢BC #1 tip·🔵🟢SW·GH·KK·MH·TB〕
27. Final full unscoped pass; its problems become new tasks, orchestrator never patches 〔🟣〕
28. Diagnose-brief-first on failed audits; every fix re-audited; three-cycle cap then escalate with specifics 〔🔴🟣〕
29. Continuous execution between gates; mid-run ambiguity → human 〔🟣🔵〕
30. Close-out summary (shipped/escalated/out-of-scope); no commit 〔—〕

---

# Appendix — informational (no decisions)

- Multi-agent won +90.2% on 🔵's research eval; token spend explained ~80% of variance — value must carry cost.
- 🔵's named context failures: kitchen-sink session, correcting-over-and-over, infinite exploration; context rot is universal and gradual.
- 🔴 migration-scale mechanics if ever needed: restart-safe batch feeder (skip existing outputs), compile-errors-as-work-queue, resource containment (cgroups, git-command bans), prompt-cache-shaped loops (12:1 cached ratio).
- The conformance-oracle precondition: 🔴's +1M-line rewrite was reviewable only because 1.39M language-independent assertions acted as the equivalence oracle ("0 tests skipped or deleted"); our 95% coverage gate is this precondition. Field consensus: test-suite robustness bounds grantable autonomy.
- Model quality beats token budget (🔵); don't cap orchestrator thinking (🟣 measured backfire).
- The human sits ON the loop, not in it: 🔴's 11 days were reading outputs and prompting loop edits; human review of a run = auditing the auditors. Review bandwidth is the true parallelism cap (🟢SW·TB·🟡).
- Instructions vs enforcement: docs advise, hooks/permissions enforce — we already practice the split.
