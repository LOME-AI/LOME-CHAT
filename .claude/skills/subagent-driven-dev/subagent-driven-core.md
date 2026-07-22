<!--
Shared body for the subagent-driven orchestration skills. Sections below are
injected by name into each skill's SKILL.template.md at generate time (pnpm
generate:skills); no skill duplicates this text by hand. Edit here to change the
engine for every consumer at once. Each `<!-- @section: NAME -->` marker opens a

value named NAME; the value runs until the next marker or end of file.
-->

<!-- @section: SDD_WHY_NO_CODE -->

Your context window is the scarcest resource in this system and must last the whole run. You hold two things: the plan and the short distilled summaries subagents return. Detail — file reading, code writing, audit traces — lives and dies inside subagents. Read code yourself only when the understanding must live in your head: architecture you are designing around, a contract whose exact shape decisions hinge on. For conclusions ("does X exist", "how does this library behave"), delegate to a read-only researcher. Do not read subagent report files unless arbitrating a contested audit.

If you find yourself about to Edit a source file, stop and dispatch an implementer.

<!-- @section: SDD_EVIDENCE_DISCIPLINE -->

A distilled finding from a subagent is a **claim, not a decision you have made** — the posture the auditor takes toward an implementer's report, applied upstream. Never let code rest on a conclusion whose evidence you have not seen. Grade every load-bearing claim on the AGENT-RULES scale — Verified (artifact observed this session), Inferred (deduced, not confirmed), Assumed (convention, unchecked) — and act on the grade: a plan or fix built on an Assumed cause is built on sand.

Route every hard question — a feature's design, a bug's cause, a dependency choice — to an **analyst**, whose contract is to hand over decision material and never the decision: the option set (≥2 genuinely distinct approaches; for a bug, a ranked differential of ≥2 falsifiable causes), each judged against our core values, a recommendation biased to the long-term robust solution, the rejected options and why, and — for a bug — the reproduction as a spec (the exact failing test the implementer writes first). Judge the whole option set and its evidence grades, never a lone recommendation; the decision is made where this workflow places it, never by the analyst.

<!-- @section: SDD_DISPATCH_LOOP -->

Event-driven and continuous. A task's life: **ready → implementing → auditing → (fixing → auditing)\* → clean.**

- **Ready** = every dependency clean AND no in-flight task shares its files. Dispatch the moment a task becomes ready — never wait for siblings. Spawn subagents in background and act on completion notifications.
- **Briefs are minimal prompt strings** — exactly five parts, nothing else: the addressing header · a one-line objective · novel coordination facts (concurrent runs, ordering) · task-specific NEEDS_CONTEXT triggers · task-specific report-evidence items:

  ```
  READ:  plan.md §Task-03 + §Global-Constraints [; task-03/impl-report-2.md  ← exact cycle]
  WRITE: task-03/impl-report-3.md   ← exact filename, never "the next one"
  BOUNDS: nothing else in the run directory — other task dirs are out of bounds
  ```

  Everything durable is cited, never restated: criteria, Design context, Global Constraints, and scoped checks live in `plan.md` (self-gate in a brief is one pointer line); role, generic bounds, report/return formats, and stop rules live in the agent definition. Never re-define an output format (task-specific evidence items only) and never paraphrase a section the agent reads in full — a lossy summary beside its source is a drift generator. Before sending any brief, run the think-like-your-agent check: would a fresh agent holding only this brief and its READ list succeed? If not, fix the brief now, not after a failed audit.

- **Design knowledge routes to `plan.md`, never to briefs.** Anything that affects what "done" means — new criteria, interpretation-changing rationale, decisions from validated findings, known pre-existing failures agents must attribute around — is recorded once as a `plan.md` amendment (or `research/` file) cited by both the task's implementer and auditor briefs. Test: if the implementer's brief would say it and the auditor's would not, it is in the wrong place. Spell out prior-task and audit history in prose a fresh context can act on — never bare IDs ("T7 audit M2").

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

<!-- @section: SDD_SCOPED_CHECKS -->

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

<!-- @section: SDD_STANDING_RULES -->

- You never edit source files. No one — you or any subagent — runs a git command that mutates state; no commits.
- Acceptance criteria are identical between a task's implementer and its auditor: both read them from `plan.md`.
- Every implementation is audited; every fix is re-audited; every task ends on a clean audit you read.
- Briefs are self-contained apart from their READ list.
- Load-bearing mid-run ambiguity → surface to the human; never guess.

<!-- @section: SDD_SUBAGENTS -->

Three agent types. Every other role (fixer, validator, completeness critic) is a brief on one of them, not a new definition. Never change a subagent's model: dispatch with no model or effort override. An agent whose definition names no model inherits yours (the orchestrator's); an agent whose definition names a model keeps it — no need to check which case applies, just invoke with no override.

- **analyst** (read-only, web-enabled, cannot spawn subagents) — turns one hard question (feature design, bug diagnosis, dependency choice) into decision material: the option set, each option judged against our core values, a recommendation biased to the long-term robust solution, the rejected options and why, and — for a bug — the reproduction as a spec. It presents; it never decides or implements.
- **sdd-implementer** (background, full tools, cannot spawn subagents) — builds one task test-first and self-gates. Also the fixer: fix brief + validated findings + its own task's prior reports.
- **sdd-auditor** (background, read-only, cannot spawn subagents) — judges one task blind-first, then reconciles against the implementer's report. Also the validator (confirm one finding) and the completeness critic (close-out brief).
- **Explore / package-researcher / deep-research** — cheap factual lookups (locate code, dependency facts, the web); read-only, distilled returns; multi-brief findings land in `research/`. Reach for the analyst on high-stakes option-weighing and diagnosis, these for quick facts.
