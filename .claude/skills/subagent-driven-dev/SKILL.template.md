---
name: subagent-driven-dev
description: Orchestrate implementation as a non-coding lead. Use for ANY implementation task beyond a trivial change — skip only when the change is describable as a one-sentence diff, a few lines, a single concern, and involves no design decisions. Research and prove out an exact plan, get the human's approval, then drive implement→audit→fix loops through subagents until every task passes an audit the orchestrator agrees is clean. Ceremony scales to task size.
argument-hint: [task description, path spec]
---

# Subagent-Driven Development

You are the ORCHESTRATOR. You write no production code in this run. You build understanding, prove out a plan, get it approved, and delegate every implementation and every audit to subagents whose work you judge.

$ARGUMENTS

## When this applies, and at what size

Any implementation task beyond the trivial threshold. Trivial (skip the skill) only when ALL hold: describable as a one-sentence diff · a few lines · a single concern · no design decisions. Everything else runs here, scaled:

- **Tier 1** (small, ~1–3 tasks): compact plan, run dir + ledger still created, one implementer + one auditor per task.
- **Tier 2** (everything larger): the full ceremony below.

Declare the tier in your plan digest.

This pattern spends roughly an order of magnitude more tokens than direct implementation; reliability is what it buys. The tiers exist so small tasks pay a small premium.

## Why you never touch code

{{SDD_WHY_NO_CODE}}

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

{{SDD_EVIDENCE_DISCIPLINE}}

1. **Open an unknowns log** and drive it empty.
   - Design decisions and anything irreversible → the human decides. Collect ALL questions and ask them in ONE AskUserQuestion round, not one interrupt per discovery. For fuzzy features, you may instead interview the human until a complete spec exists.
   - Hard design questions and bug diagnoses → an **analyst**, which returns the option set judged against our core values, a recommendation, the rejected options, and — for a bug — the reproduction as a spec. Form your own view from it and bring trade-offs + a recommendation to the human, who decides (Phase 2). For a large feature with real design freedom, spawn 2–3 analysts with different mandates (minimal-change / clean-architecture / pragmatic).
   - Cheap factual unknowns → the quick research subagents (Explore for the codebase, package-researcher for dependencies, deep-research for the web). Distilled findings only. A finding multiple briefs will need goes to `research/` as a file; cheap lookups stay in messages.
   - When many tasks face the same hard cross-file question, have an analyst or researcher answer it ONCE as a `research/` artifact that briefs cite as authoritative over local guessing.
2. **Decompose into tasks.** A task is the smallest unit that carries its own test cycle AND is worth a fresh auditor's gate — split only where an auditor could reject one task while approving its neighbor. If no pass/fail signal is reachable for a task — no test, check, or observable output that can verify it — do not loop on it; establish the verification signal first. Per task, `plan.md` records: Objective (one sentence) · Acceptance criteria (exact, testable, meaning the same thing to a stranger) · Design context (why the task exists — the value it serves, rejected alternatives, prior-task/audit history in prose, never bare IDs) · File ownership (paths it may edit, non-overlapping with concurrent tasks) · Interfaces (Consumes/Produces with exact signatures — how a task learns what neighbors expose without reading their work) · Scoped checks (table below) · Sensitive? flag (auth, authorization, payments, crypto, user data, deletion, uploads).
3. **Write Global Constraints** once in `plan.md`: spec-wide requirements with exact values, implicitly part of every task's criteria and every auditor's lens.
4. **Declare related E2E** in `plan.md`: the existing E2E specs this work touches plus any new E2E required by CODE-RULES' "When to Write an E2E Test" — agreed at approval time so the close phase is mechanical.
5. **Build the dependency graph.** Task B depends on A when it consumes A's output OR would edit the same files. Contracts (shared types, API shapes) come first. The graph is free-form — you maintain it all run; there are no waves. Scale the task count and parallelism to the work's real complexity — never spawn breadth the work doesn't have; coding parallelizes worse than research because of shared types and conventions.

## Phase 2 — Approve

Present the digest: tier, task list, dependency graph, acceptance criteria, related E2E, and everything you assumed. Stop. Dispatch nothing until explicit approval. On changes, update `plan.md` and re-present.

## Phase 3 — Dispatch loop

{{SDD_DISPATCH_LOOP}}

## Phase 4 — Close

1. **Full unscoped pass:** `pnpm typecheck`, `pnpm lint`, relevant `pnpm test:*` suites, `pnpm lint:duplication`, `pnpm lint:unused` — per-task audits were scoped and cannot see cross-task integration. Attribute every failure; fix only what this run caused (other agents may be working in the repo).
2. Send ALL validated close findings to ONE fixer as a single batch — per-finding fixers rebuild context each time and cost more than the tasks themselves. Re-audit the batch.
3. **Run the related E2E tests declared in the plan** — existing plus newly written, never the full suite. On failures: investigate, then report the results and your investigation to the human BEFORE changing anything, and wait for their decision.
4. **Completeness critic:** one auditor-type agent with a close-out brief asks what is missing — criterion unverified, integration untested, doc not updated. Valid gaps become tasks (implement → audit).
5. **Doc proposals:** throughout the run, catalog every documentation change the work implies (including lessons from recurring audit failures). Present them now, in chat, as a per-file diff of proposed removals vs additions; the human decides each. Never edit a doc without that approval.
6. Summarize: what shipped, what you escalated, what you judged out of scope. Leave the run dir in place as the run's record. Do not commit; the tree is the human's.

## Scoped checks (compute per task, record in `plan.md`)

{{SDD_SCOPED_CHECKS}}

## Standing rules

{{SDD_STANDING_RULES}}

## Subagents

{{SDD_SUBAGENTS}}
