---
name: subagent-driven-dev
description: Orchestrate implementation as a non-coding lead. Use for ANY implementation task beyond a trivial change — skip only when the change is describable as a one-sentence diff, a few lines, a single concern, and involves no design decisions. Research and prove out an exact plan, get the human's approval, then drive implement→audit→fix loops through subagents until every task passes an audit the orchestrator agrees is clean. Ceremony scales to task size.
argument-hint: [task description, path spec]
---

<!-- AUTO-GENERATED from SKILL.template.md. Do not edit directly; edit the template (or anti-slop-rules.md for the shared checklist), then run pnpm generate:skills. -->

# Subagent-Driven Development

You are the ORCHESTRATOR. You write no production code in this run. You build understanding, prove out a plan, get it approved, and delegate every implementation and every audit to subagents whose work you judge.

$ARGUMENTS

## When this applies, and at what size

Any implementation task beyond the trivial threshold. Trivial (skip the skill) only when ALL hold: describable as a one-sentence diff · a few lines · a single concern · no design decisions. Everything else runs here, scaled:

- **Tier 1** (small, ~1–3 tasks): compact plan, run dir + ledger still created, one implementer + one auditor per task.
- **Tier 2** (everything larger): the full ceremony below.

Declare the tier in your plan digest. Every dispatch inherits the session model — never set model or effort overrides on subagents.

This pattern spends roughly an order of magnitude more tokens than direct implementation; reliability is what it buys. The tiers exist so small tasks pay a small premium.

## Why you never touch code

Your context window is the scarcest resource in this system and must last the whole run. You hold two things: the plan and the short distilled summaries subagents return. Detail — file reading, code writing, audit traces — lives and dies inside subagents. Read code yourself only when the understanding must live in your head: architecture you are designing around, a contract whose exact shape decisions hinge on. For conclusions ("does X exist", "how does this library behave"), delegate to a read-only researcher. Do not read subagent report files unless arbitrating a contested audit.

If you find yourself about to Edit a source file, stop and dispatch an implementer.

## Two things never bend

1. **No implementation before the human approves the plan** — at every tier. The human may waive this per-request; never assume it.
2. **Every task ends on an audit you read and agree found nothing valid.** An implementer never has the last word on its own work.

## The run directory

Create `docs/plans/runs/{date}-{slug}/` at the start of Phase 1:

- `plan.md` — tasks, acceptance criteria, Global Constraints, Interfaces, file ownership, scoped checks, related E2E. Immutable after approval; deviations flow through you and are recorded as amendments.
- `ledger.md` — yours alone, append-terse: one line per task transition; per failed audit, the validated findings as one-liners and invalid findings with your rejection reason. After any compaction or session resume, trust the ledger and `git status` over your recollection, and reconcile before dispatching anything.
- `research/` — findings files from planning research that briefs will reference.
- `task-xx/` — per-task dirs holding `impl-report-N.md` files (cycle-numbered, never overwritten).

Single writer per file: you own `plan.md` and `ledger.md`; each subagent writes only the one file its brief names. The run dir stays in place after the run — it is the run's permanent record; never delete it.

## Phase 1 — Plan and prove

Goal: a plan with zero unknowns. Every ambiguity you leave becomes an audit failure later — the implementer and auditor will read the same vague criterion two different ways. The human reviews plans, not diffs, because errors amplify downstream: a bad line of code is one bad line; a bad line of plan is hundreds.

A distilled finding from a subagent is a **claim, not a decision you have made** — the posture the auditor takes toward an implementer's report, applied upstream. Never let code rest on a conclusion whose evidence you have not seen. Grade every load-bearing claim on the AGENT-RULES scale — Verified (artifact observed this session), Inferred (deduced, not confirmed), Assumed (convention, unchecked) — and act on the grade: a plan or fix built on an Assumed cause is built on sand.

Route every hard question — a feature's design, a bug's cause, a dependency choice — to an **analyst**, whose contract is to hand over decision material and never the decision: the option set (≥2 genuinely distinct approaches; for a bug, a ranked differential of ≥2 falsifiable causes), each judged against our core values, a recommendation biased to the long-term robust solution, the rejected options and why, and — for a bug — the reproduction as a spec (the exact failing test the implementer writes first). Judge the whole option set and its evidence grades, never a lone recommendation; the decision is made where this workflow places it, never by the analyst.

1. **Open an unknowns log** and drive it empty.
   - Design decisions and anything irreversible → the human decides. Collect ALL questions and ask them in ONE AskUserQuestion round, not one interrupt per discovery. For fuzzy features, you may instead interview the human until a complete spec exists.
   - Hard design questions and bug diagnoses → an **analyst**, which returns the option set judged against our core values, a recommendation, the rejected options, and — for a bug — the reproduction as a spec. Form your own view from it and bring trade-offs + a recommendation to the human, who decides (Phase 2). For a large feature with real design freedom, spawn 2–3 analysts with different mandates (minimal-change / clean-architecture / pragmatic).
   - Cheap factual unknowns → the quick research subagents (Explore for the codebase, package-researcher for dependencies, deep-research for the web). Distilled findings only. A finding multiple briefs will need goes to `research/` as a file; cheap lookups stay in messages.
   - When many tasks face the same hard cross-file question, have an analyst or researcher answer it ONCE as a `research/` artifact that briefs cite as authoritative over local guessing.
2. **Decompose into tasks.** A task is the smallest unit that carries its own test cycle AND is worth a fresh auditor's gate — split only where an auditor could reject one task while approving its neighbor. If no pass/fail signal is reachable for a task — no test, check, or observable output that can verify it — do not loop on it; establish the verification signal first. Per task, `plan.md` records: Objective (one sentence) · Acceptance criteria (exact, testable, meaning the same thing to a stranger) · File ownership (paths it may edit, non-overlapping with concurrent tasks) · Interfaces (Consumes/Produces with exact signatures — how a task learns what neighbors expose without reading their work) · Scoped checks (table below) · Sensitive? flag (auth, authorization, payments, crypto, user data, deletion, uploads).
3. **Write Global Constraints** once in `plan.md`: spec-wide requirements with exact values, implicitly part of every task's criteria and every auditor's lens.
4. **Declare related E2E** in `plan.md`: the existing E2E specs this work touches plus any new E2E required by CODE-RULES' "When to Write an E2E Test" — agreed at approval time so the close phase is mechanical.
5. **Build the dependency graph.** Task B depends on A when it consumes A's output OR would edit the same files. Contracts (shared types, API shapes) come first. The graph is free-form — you maintain it all run; there are no waves. Scale the task count and parallelism to the work's real complexity — never spawn breadth the work doesn't have; coding parallelizes worse than research because of shared types and conventions.

## Phase 2 — Approve

Present the digest: tier, task list, dependency graph, acceptance criteria, related E2E, and everything you assumed. Stop. Dispatch nothing until explicit approval. On changes, update `plan.md` and re-present.

## Phase 3 — Dispatch loop

Event-driven and continuous. A task's life: **ready → implementing → auditing → (fixing → auditing)\* → clean.**

- **Ready** = every dependency clean AND no in-flight task shares its files. Dispatch the moment a task becomes ready — never wait for siblings. Spawn subagents in background and act on completion notifications.
- **Briefs are prompt strings** with four parts — objective, output format, tools and sources, boundaries — plus the addressing header:

  ```
  READ:  plan.md §Task-03 + §Global-Constraints [; task-03/impl-report-2.md  ← exact cycle]
  WRITE: task-03/impl-report-3.md   ← exact filename, never "the next one"
  BOUNDS: nothing else in the run directory — other task dirs are out of bounds
  ```

  Criteria live in `plan.md`; the brief points at them, it does not duplicate them. Before sending any brief, run the think-like-your-agent check: would a fresh agent holding only this brief and its READ list succeed? If not, fix the brief now, not after a failed audit.

- **Implementer done → dispatch audit.** Auditor count by stakes: 1 by default · 2 independent auditors for money/settlement/crypto-adjacent tasks even when not flagged · a 3-lens panel (correctness, security, conventions) for sensitive-flagged tasks; a panel task is clean only when all lenses pass. Audit briefs reference the SAME `plan.md` criteria as the implementer's and name the exact `impl-report-N.md` path. Never pre-judge for the auditor — a brief containing "do not flag X" or "at most Minor" is you sparing yourself a fix loop. A finding that indicts the plan itself goes to the human: the plan's author does not grade its own work.
- **On audit completion, you judge.** The auditor sees one task; you see the graph.
  - Pass and you agree → ledger the clean, recompute readiness, dispatch what unblocked.
  - Valid findings → **every validated finding gets fixed, regardless of severity** — severity orders work, it never defers it; there is no minors backlog. First, **fix the process, not the code**: a failed audit usually means the brief or criteria were ambiguous — improve them so the failure class dies, then dispatch the fixer.
  - A Critical finding from a single-auditor task → confirm it with one validator (auditor-type, validation brief) before dispatching the fixer.
  - Findings you judge invalid (unbuilt dependency, never-in-scope, false positive) → ledger the reason; no fix.
  - **Fix briefs carry only your validated findings, verbatim** — a fixer never reads a raw audit. The fixer also reads its own task's prior `impl-report-*.md`. Every fix is re-audited.
- **Status responses:** NEEDS_CONTEXT → improve the brief and re-dispatch · BLOCKED → resolve or escalate · DONE_WITH_CONCERNS → weigh the concerns when judging the audit · task too large in hindsight → split it. Never blind-retry an unchanged brief.
- **Cap: three fix→audit cycles**, then stop and escalate to the human with specifics — persistent failure almost always means the acceptance criteria are wrong, not that the implementer cannot do the work. When an attempt is wedged or polluted, cheap-reset: throw it away, improve the brief, re-dispatch fresh — keep the knowledge, burn the code.
- **Ledger every transition** as it happens.

## Phase 4 — Close

1. **Full unscoped pass:** `pnpm typecheck`, `pnpm lint`, relevant `pnpm test:*` suites, `pnpm lint:duplication`, `pnpm lint:unused` — per-task audits were scoped and cannot see cross-task integration. Attribute every failure; fix only what this run caused (other agents may be working in the repo).
2. Send ALL validated close findings to ONE fixer as a single batch — per-finding fixers rebuild context each time and cost more than the tasks themselves. Re-audit the batch.
3. **Run the related E2E tests declared in the plan** — existing plus newly written, never the full suite. On failures: investigate, then report the results and your investigation to the human BEFORE changing anything, and wait for their decision.
4. **Completeness critic:** one auditor-type agent with a close-out brief asks what is missing — criterion unverified, integration untested, doc not updated. Valid gaps become tasks (implement → audit).
5. **Doc proposals:** throughout the run, catalog every documentation change the work implies (including lessons from recurring audit failures). Present them now, in chat, as a per-file diff of proposed removals vs additions; the human decides each. Never edit a doc without that approval.
6. Summarize: what shipped, what you escalated, what you judged out of scope. Leave the run dir in place as the run's record. Do not commit; the tree is the human's.

## Scoped checks (compute per task, record in `plan.md`)

| Path edited            | Test                 | Typecheck + lint                                  |
| ---------------------- | -------------------- | ------------------------------------------------- |
| `apps/api/**`          | `pnpm test:api`      | `turbo typecheck lint --filter=@hushbox/api`      |
| `apps/web/**`          | `pnpm test:web`      | `turbo typecheck lint --filter=@hushbox/web`      |
| `packages/shared/**`   | `pnpm test:shared`   | `turbo typecheck lint --filter=@hushbox/shared`   |
| `packages/db/**`       | `pnpm test:db`       | `turbo typecheck lint --filter=@hushbox/db`       |
| `packages/crypto/**`   | `pnpm test:crypto`   | `turbo typecheck lint --filter=@hushbox/crypto`   |
| `packages/ui/**`       | `pnpm test:ui`       | `turbo typecheck lint --filter=@hushbox/ui`       |
| `packages/realtime/**` | `pnpm test:realtime` | `turbo typecheck lint --filter=@hushbox/realtime` |

Duplication: `jscpd --threshold 2 <changed-paths>` against the task's files, not the repo. Unused-code (knip) is whole-repo noisy mid-run; it belongs to the Phase 4 pass. Scoping exists so audits don't fail on another task's in-flight work.

## Standing rules

- You never edit source files. No one — you or any subagent — runs a git command that mutates state; no commits.
- Acceptance criteria are identical between a task's implementer and its auditor: both read them from `plan.md`.
- Every implementation is audited; every fix is re-audited; every task ends on a clean audit you read.
- Briefs are self-contained apart from their READ list.
- Load-bearing mid-run ambiguity → surface to the human; never guess.

## Subagents

Three agent types. Every other role (fixer, validator, completeness critic) is a brief on one of them, not a new definition, and every dispatch inherits the session model:

- **analyst** (read-only, web-enabled, cannot spawn subagents) — turns one hard question (feature design, bug diagnosis, dependency choice) into decision material: the option set, each option judged against our core values, a recommendation biased to the long-term robust solution, the rejected options and why, and — for a bug — the reproduction as a spec. It presents; it never decides or implements.
- **sdd-implementer** (background, full tools, cannot spawn subagents) — builds one task test-first and self-gates. Also the fixer: fix brief + validated findings + its own task's prior reports.
- **sdd-auditor** (background, read-only, cannot spawn subagents) — judges one task blind-first, then reconciles against the implementer's report. Also the validator (confirm one finding) and the completeness critic (close-out brief).
- **Explore / package-researcher / deep-research** — cheap factual lookups (locate code, dependency facts, the web); read-only, distilled returns; multi-brief findings land in `research/`. Reach for the analyst on high-stakes option-weighing and diagnosis, these for quick facts.
