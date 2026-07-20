---
name: subagent-driven-e2e-green
description: Drive the E2E suite to fully green with zero flakes — orchestrated as a non-coding lead who diagnoses via debug-e2e and runs implement→audit→fix loops through subagents — verified by three consecutive clean full runs, then pass every pre-push gate. Loops run → diagnose → fix → verify until done. Use when the E2E suite has failures or flakes that must be eliminated for good.
disable-model-invocation: true
argument-hint: [additional instructions or focus area]
---

<!-- AUTO-GENERATED from SKILL.template.md. Do not edit directly; edit the template (or anti-slop-rules.md for the shared checklist), then run pnpm generate:skills. -->

# Subagent-Driven E2E Green

You are the ORCHESTRATOR. You write no production code in this run. You drive the E2E suite to green by diagnosing every failure, delegating every fix and every audit to subagents, and judging their work — until three consecutive fully green runs pass, followed by all pre-push gates.

$ARGUMENTS

## The goal

**Three consecutive fully green E2E runs, followed by all pre-push checks passing.** Nothing else ends this task. Not "mostly green", not "only known flakes left", not "green except infrastructure". Three clean runs in a row, then clean gates.

## Definitions

- **A run** = `pnpm e2e` — the full suite, every project, unfiltered. The only command that counts for the streak. While iterating, `pnpm e2e:fast` (the whole suite on a single project, retries off) gives faster feedback but does **not** count for the streak.
- **Green** = zero failed, zero flaky, zero errors, zero unexpected skips. Playwright marks a pass-on-retry as **flaky** in the report, so retries never hide a flake — a flaky result makes the run not green.
- **Flaky = failed.** A flake is a determinism bug in app code, test code, or infrastructure. It gets the same root-cause treatment as a hard failure — flakes are removable by construction.
- **The streak** = consecutive green `pnpm e2e` runs with no code changes between them. Any code change resets the streak to zero. Any non-green run resets the streak to zero.

## Command toolkit

Only pnpm scripts, never raw playwright invocations. Spec paths append to any of these (`pnpm e2e path/to/spec.ts` runs just that spec):

| Command                                                                                           | Use                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm e2e:fast`                                                                                   | The iteration run — the whole suite on a single project (`iphone-15`), retries off. Fast full-suite feedback while looping; **does not count for the streak.** |
| `pnpm e2e`                                                                                        | The full run — every project, unfiltered. The only command that counts for the streak.                                                                         |
| `pnpm e2e:failed`                                                                                 | Re-run exactly the last run's failures — the default way to verify a fix batch cheaply.                                                                        |
| `pnpm e2e:<area>` (`chat`, `billing`, `sharing`, `group`, `ui`, `mobile`, `api`, `auth`, `admin`) | Targeted area suite when a fix is contained to one domain.                                                                                                     |
| `pnpm e2e <path/to/spec.ts>`                                                                      | One or a few specific specs.                                                                                                                                   |
| `pnpm e2e:stress <path/to/spec.ts>`                                                               | Flake verification: repeats each test 3×, retries disabled, parallel workers on.                                                                               |

## Why you never touch code

Your context window is the scarcest resource in this system and must last the whole run. You hold two things: the plan and the short distilled summaries subagents return. Detail — file reading, code writing, audit traces — lives and dies inside subagents. Read code yourself only when the understanding must live in your head: architecture you are designing around, a contract whose exact shape decisions hinge on. For conclusions ("does X exist", "how does this library behave"), delegate to a read-only researcher. Do not read subagent report files unless arbitrating a contested audit.

If you find yourself about to Edit a source file, stop and dispatch an implementer.

## Permissions and standards

This workflow has complete permission to change **any** code — application, test, fixture, infrastructure, config — to reach green. This supersedes all other rules gating the ability to edit code. The permission is exercised through implementers: you, the orchestrator, still never edit source yourself (see Standing rules). Git writes and external writes are still not allowed — skip those. Two conditions bind every change:

1. **Every change meets the repo's full quality bar**: TDD, the repo's code rules, and the E2E determinism pillars.
2. **Long-term fixes only.** You are removing the root cause, not the symptom. A change whose honest one-line description is "make test stop failing" instead of "fix <root cause>" is a shortcut and is forbidden.

### Do not invoke subagent-driven-dev

This skill already contains that workflow, merged and adapted for E2E green — the approval gate removed, diagnosis routed through `debug-e2e`. Do **not** invoke the `subagent-driven-dev` skill from here; run the phases below directly.

### Forbidden shortcuts — these never count as fixes

- `test.skip`, `test.fixme`, `.only`, deleting a test, or excluding it from a run to make the suite green
- Deleting or weakening an assertion so it can't fail
- Raising a timeout, adding retries, adding wall-clock waits (`waitForTimeout`, `setTimeout`), or reordering/serializing tests to hide a race
- Loosening a lint rule, coverage threshold, or enforcement fixture to let a violation through
- Catch-and-ignore around flaky app behavior
- Running the streak with a filter (`--grep`, project subset, shard) so a failing test isn't executed
- Any change whose honest one-line description would be "make test stop failing" instead of "fix <root cause>"

If a test itself is genuinely wrong or stale, that is an intent conflict (see below); removing or rewriting a test is legitimate only after that resolution.

## The run directory

Create `docs/plans/runs/{date}-e2e-green/` when the run begins:

- `plan.md` — the live fix backlog: per task, Objective (one sentence) · Acceptance criteria (exact, testable, meaning the same thing to a stranger) · File ownership (non-overlapping with concurrent tasks) · Interfaces (Consumes/Produces with exact signatures) · Scoped checks (table below) · Sensitive? flag (auth, authorization, payments, crypto, user data, deletion, uploads). Global Constraints and the related E2E live here too. Unlike a feature run this plan is **not** frozen — each cycle appends the new root causes a fresh run surfaces.
- `ledger.md` — yours alone, append-terse. This is the ONLY ledger; there is no separate scratchpad. It carries both the task transitions AND the run history: one line per run (`Run #7 — 2 failed, 1 flaky — streak: 0`), one line per task transition, and per failed audit the validated findings as one-liners plus invalid findings with your rejection reason. Record each root cause fixed, each enforcement added, and each open intent conflict. After any compaction or session resume, trust `ledger.md` and `git status` over your recollection, and reconcile before dispatching anything.
- `research/` — diagnosis findings from Explore agents that fix briefs reference.
- `task-xx/` — per-task dirs holding `impl-report-N.md` files (cycle-numbered, never overwritten).

Single writer per file: you own `plan.md` and `ledger.md`; each subagent writes only the one file its brief names. The run dir stays in place after the run — it is the run's permanent record; never delete it.

## The cycle

Work is a loop: **run → Phase 1 diagnose → Phase 3 fix → re-run**, repeated until a run comes back green, then Phase 4 verifies the streak and runs the gates. Never edit code while a run is in flight — a run's result must correspond to one exact tree state.

## Phase 1 — Diagnose and plan

When a run returns with any failure or flake, before touching any code:

1. **Invoke `debug-e2e` once.** As the orchestrator you run the `debug-e2e` skill (Skill tool) a single time to establish the report location and the failure inventory — `e2e/report/` is the single source of truth. You do not read every trace yourself; that reading lives in subagents.
2. **Dispatch Explore agents to diagnose — one per root-cause cluster.** Group the run's failures into candidate clusters, then spawn read-only Explore agents in parallel. Each brief names the exact `e2e/report/` paths, the failing spec(s), and the browser/project, and asks for a full diagnosis: the root cause with evidence; **where the defect lives** (domain code / test code / harness-infrastructure); **which determinism pillar or repo rule** it violates; and the concrete fix plus the enforcement rung that would kill the whole class (lint rule, contract test, auto-fail fixture, type). Distilled diagnosis returns only — multi-task findings land in `research/`. No fix is written from an error message alone.
3. **Decompose into fix tasks** in `plan.md`, in SDD task shape. Triage first: bucket every diagnosis as **regression** (was green, now red), **deterministic failure**, **flake**, or **environment**. Regressions you introduced come first, then the largest deterministic bucket — don't shotgun edits across unrelated failures in one batch. Group by root cause; one cause often explains many failures. Fixing the instance _and_ adding its class-level enforcement are both acceptance criteria of the task.
4. **Build the dependency graph.** Shared contracts first; tasks touching the same files serialize. Proceed straight to Phase 3 — there is no approval gate.

## Phase 2 — Approval: bypassed

This workflow has **no** human approval gate. The plan is derived from the run's own failures, it evolves every cycle, and waiting on per-batch sign-off would defeat the loop. Dispatch fixes the moment Phase 1 produces ready tasks. You still stop and ask on the narrow set in **Escalation** (intent conflicts, schema/dependency/architecture changes, stalls) — those are conflicts to resolve, not plans to approve.

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

Two E2E-specific obligations ride on top of the loop, enforced as task acceptance criteria:

- **TDD at the closest layer.** For an app bug, the implementer first writes the failing test at the unit/integration layer that reproduces the root cause — the e2e failure is the symptom, not the regression test. Watch it fail, fix, watch it pass.
- **Prove the specific fix cheaply before the next full run.** Hard failure → `pnpm e2e:failed`, the matching `pnpm e2e:<area>`, or `pnpm e2e <path/to/spec.ts>`. Flake → a single pass proves nothing; stress it with `pnpm e2e:stress <path/to/spec.ts>` (parallel workers on, retries off). A flake fix is proven only by repeated deterministic passes.

## Phase 4 — Close: the streak, then the gates

A cycle ends by re-running the suite. While iterating use `pnpm e2e:fast`; compare against the previous run:

- **Ratchet rule: the failure set must shrink monotonically.** A test that was green and is now red is a regression you introduced — fixing it is the immediate top priority, before any new fix work.
- New, previously unseen flakes are new Phase 1 diagnoses, not noise.

When a `pnpm e2e:fast` run comes back completely green, stop changing code and switch to the full suite for verification: run `pnpm e2e` three times in a row. Only the full, every-project, unfiltered `pnpm e2e` counts toward the streak — a green fast run is the signal to _start_ verifying, never a substitute for a full run.

Before the streak, run the **full unscoped pass** the per-task scoped audits could not see: `pnpm typecheck`, `pnpm lint`, relevant `pnpm test:*` suites, `pnpm lint:duplication`, `pnpm lint:unused`. Attribute every failure; fix only what this run caused (other agents may be working in the repo) through the same dispatch loop. A **completeness critic** (one auditor-type agent, close-out brief) asks what a root cause fixed at the instance but not the class — a missing lint rule, contract test, or auto-fail fixture. Valid gaps become tasks.

Then:

- Three consecutive greens on the identical tree → run the gates: `pnpm pre-push`. Any gate failure is a new Phase 1 diagnosis, and after fixing, the streak must be re-earned because the tree changed.
- Any failure or flake → streak resets to 0, return to Phase 1 with that run's report. Do not rationalize a "one-off" — on this suite there is no such thing; it is a determinism bug with a fresh report to mine.

**Done = a streak of 3 on the final tree + all gates green.**

## Intent conflicts

When a diagnosis concludes the test and the application disagree about intended behavior, do **not** silently pick a side. Continue fixing everything unambiguous, collect the conflicts, and present them to the human in one batch per cycle: "the test expects X because…, the app does Y because…, which is intended?" Tasks touched by a pending conflict are excluded from fix work (never from runs) until answered. This is the one human gate the workflow keeps — it is a conflict to resolve, not a plan to approve.

## Escalation

- **Same root cause survives 3 distinct fix attempts** → stop work on it and escalate with the full diagnosis history. Persistent failure usually means the diagnosis is wrong or the intended behavior is ambiguous.
- **Stall detection:** if the failure set has not shrunk across 3 consecutive full runs, stop and escalate with the ledger. A loop that isn't converging needs a human, not more iterations.
- **Environment failures** (Docker down, disk full, port conflicts, `e2e:prepare` failing) are not test results: fix the environment (`pnpm dev:restart`, `pnpm db:up`), don't count the run for or against the streak, and note it in the ledger. If the same environment failure recurs 3 times, diagnose it like any other failure.
- **A fix requires a schema change, new dependency, or architecture decision** → outside your decision authority; stop and ask.

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

Plus the narrowest e2e reproduction for the task: `pnpm e2e:failed`, the matching `pnpm e2e:<area>`, `pnpm e2e <path/to/spec.ts>`, or `pnpm e2e:stress <path/to/spec.ts>` for a flake.

## Standing rules

- You never edit source files. No one — you or any subagent — runs a git command that mutates state; no commits.
- Acceptance criteria are identical between a task's implementer and its auditor: both read them from `plan.md`.
- Every implementation is audited; every fix is re-audited; every task ends on a clean audit you read.
- Briefs are self-contained apart from their READ list.
- Load-bearing mid-run ambiguity → surface to the human; never guess.

E2E-green adds:

- **Never fix without a diagnosis.** Every code change traces to a root cause established in Phase 1.
- **One tree state per run.** No edits while a run is in flight; a result must be attributable to exact code.
- **Flaky = failed**, everywhere, always.
- **The streak is sacred.** Only identical-tree, full-suite `pnpm e2e` runs count, and flaky counts against green. Resets on any change or any non-green.
- **Fix the class, not just the instance** — every root cause gets an enforcement-ladder check.
- **Report staleness.** If any command or path referenced in this skill doesn't exist, stop and tell the user the skill needs updating.

## Subagents

Exactly two SDD agent types. Every role variant is a brief, not a new definition, and every dispatch inherits the session model:

- **sdd-implementer** (background, full tools, cannot spawn subagents) — builds one task test-first and self-gates. Also the fixer: fix brief + validated findings + its own task's prior reports.
- **sdd-auditor** (background, read-only, cannot spawn subagents) — judges one task blind-first, then reconciles against the implementer's report. Also the validator (confirm one finding) and the completeness critic (close-out brief).
- **Explore / package-researcher / deep-research** — planning research; read-only, distilled returns; multi-brief findings land in `research/`.

In this workflow the Explore agents are also your diagnosticians: after you invoke `debug-e2e` once, they read `e2e/report/` and the failing specs and return the root-cause diagnoses that become fix tasks.

## Final report

```
## Subagent-Driven E2E Green — Complete

### Verification
- Runs #N, #N+1, #N+2: fully green (zero failed, zero flaky), identical tree
- Gates: `pnpm pre-push` ✓

### Root causes fixed
| RC | Cause | Class fix (enforcement added) | Tests affected |

### Intent conflicts resolved
[question → human's answer → change made]

### Escalated / open
[anything the human still owns]

### Run history
[run #, result, streak counter — the ledger's summary]
```
