---
name: e2e-green
description: Drive the E2E suite to fully green with zero flakes, verified by three consecutive clean full runs, then pass every pre-push gate. Loops run → diagnose → fix → verify until done. Use when the E2E suite has failures or flakes that must be eliminated for good.
disable-model-invocation: true
argument-hint: [additional instructions or focus area]
---

# E2E Green

You have exactly one goal: **three consecutive fully green E2E runs, followed by all pre-push checks passing.** Nothing else ends this task. Not "mostly green", not "only known flakes left", not "green except infrastructure". Three clean runs in a row, then clean gates.

## Additional Instructions

$ARGUMENTS

## Definitions

- **A run** = `pnpm e2e` — the full suite, every project, unfiltered.
- **Green** = zero failed, zero flaky, zero errors, zero unexpected skips. Playwright marks a pass-on-retry as **flaky** in the report, so retries never hide a flake — a flaky result makes the run not green.
- **Flaky = failed.** A flake is a determinism bug in app code, test code, or infrastructure. It gets the same root-cause treatment as a hard failure — flakes are removable by construction.
- **The streak** = consecutive green runs with no code changes between them. Any code change resets the streak to zero. Any non-green run resets the streak to zero.

## Command toolkit

Only pnpm scripts, never raw playwright invocations. Spec paths append to any of these (`pnpm e2e path/to/spec.ts` runs just that spec):

| Command | Use |
| --- | --- |
| `pnpm e2e` | The full run. The only command that counts for the streak. |
| `pnpm e2e:failed` | Re-run exactly the last run's failures — the default way to verify a fix batch cheaply. |
| `pnpm e2e:<area>` (`chat`, `billing`, `sharing`, `group`, `ui`, `mobile`, `api`, `auth`, `admin`) | Targeted area suite when a fix is contained to one domain. |
| `pnpm e2e <path/to/spec.ts>` | One or a few specific specs. |
| `pnpm e2e:stress <path/to/spec.ts>` | Flake verification: repeats each test 3×, retries disabled, parallel workers on. |

## Permissions and standards

You have complete permission to change **any** code — application, test, fixture, infrastructure, config — to reach green. Two conditions bind every change:

1. **Every change meets the repo's full quality bar**: TDD, the repo's code rules, and the E2E determinism pillars.
2. **Long-term fixes only.** You are removing the root cause, not the symptom. If a fix would make the test pass without making the underlying behavior correct and deterministic, it is a shortcut and it is forbidden.

### Forbidden shortcuts — these never count as fixes

- `test.skip`, `test.fixme`, `.only`, deleting a test, or excluding it from a run to make the suite green
- Deleting or weakening an assertion so it can't fail
- Raising a timeout, adding retries, adding wall-clock waits (`waitForTimeout`, `setTimeout`), or reordering/serializing tests to hide a race
- Loosening a lint rule, coverage threshold, or enforcement fixture to let a violation through
- Catch-and-ignore around flaky app behavior
- Running the ratchet with a filter (`--grep`, project subset, shard) so a failing test isn't executed
- Any change whose honest one-line description would be "make test stop failing" instead of "fix <root cause>"

If you believe a test itself is genuinely wrong or stale, that is an intent conflict — see **Intent conflicts** below. Removing or rewriting a test is legitimate only after that resolution, never as a convenience.

## The cycle

Work is a loop. Each iteration:

### 1. Run

Kick off a full run in the background. First iteration and after every fix batch:

```
pnpm e2e
```

While it runs, you may prepare (read code, plan), but never edit code mid-run — a run's result must correspond to one exact tree state.

### 2. Diagnose — always via the investigation protocol

When the run returns with any failure or flake, invoke the `debug-e2e` skill (Skill tool) before touching any code. Every failure and every flake gets a full diagnosis: root cause, evidence, code involved, concrete fix. No fix is written from the error message alone.

Then extend each diagnosis one level further than the instance:

- **Where does the defect live?** Explicitly classify each root cause as **domain code** (the application behaves wrong), **test code** (the test asserts or drives the app wrong), or **harness/infrastructure** (fixtures, config, environment, tooling). The classification decides where the fix goes and where the regression test lives — a misclassified root cause produces a symptom fix.
- **Which determinism pillar or repo rule did the root cause violate?**
- **Can this class of bug be prevented at a higher enforcement rung?** (lint rule, contract test, auto-fail fixture, type) If yes, adding that enforcement is part of the fix, not optional polish. Fix the instance *and* close the class.

### 3. Plan the fix batch

Triage first: bucket every diagnosis as **regression** (was green, now red), **deterministic failure**, **flake**, or **environment**. Regressions you introduced come first, then the largest deterministic bucket — don't shotgun edits across unrelated failures in one batch.

Group diagnoses by root cause (one cause often explains many failures). Write each fix as a task:

- **Objective** — one sentence.
- **Acceptance criteria** — exact, testable: which tests must pass, which scoped checks must be clean, what enforcement was added.
- **File ownership** — the paths this task may edit; no two concurrent tasks overlap.
- **Scoped checks** — the package-scoped `pnpm test:*` / `turbo typecheck lint --filter=...` commands for the touched paths, plus the narrowest e2e reproduction (see step 4).

Tasks written this way are self-contained: they can be executed directly or handed to an implementing agent verbatim, and audited against their own criteria without extra context.

### 4. Fix

For each task, in dependency order (shared contracts first; tasks touching the same files serialize):

- **TDD.** For an app bug, first write the failing test at the closest layer (unit/integration) that reproduces the root cause — the e2e failure is the symptom, not the regression test. Watch it fail, fix, watch it pass.
- **Prove the specific fix cheaply before the next full run:**
  - Hard failure → `pnpm e2e:failed`, or the matching `pnpm e2e:<area>` suite, or `pnpm e2e <path/to/spec.ts>` for a single spec.
  - Flake → a single pass proves nothing. Stress it: `pnpm e2e:stress <path/to/spec.ts>` — parallel workers stay on because parallelism is what surfaces shared-state bugs. A flake fix is proven only by repeated deterministic passes.
- Run the task's scoped checks. A fix that breaks unit tests, lint, or typecheck is not done.

### 5. Re-run

Back to step 1 with the full suite. Compare against the previous run:

- **Ratchet rule: the failure set must shrink monotonically.** A test that was green and is now red is a regression you introduced — fixing it is the immediate top priority, before any new fix work.
- New, previously unseen flakes surfaced by the run are new diagnoses, not noise.

### 6. The streak (verification phase)

When a full run comes back completely green, stop changing code and enter verification: run `pnpm e2e` two more times.

- Three consecutive greens on the identical tree → proceed to gates.
- Any failure or flake → streak resets to 0, return to step 2 with that run's report. Do not rationalize a "one-off" — on this suite there is no such thing; it is a determinism bug with a fresh report to mine.

### 7. Gates

After the streak:

```
pnpm pre-push
```

Any failure here becomes a new task through the same cycle — and after fixing, the streak must be re-earned, because the tree changed.

**Done = streak of 3 on the final tree + all gates green.** If gates were already green at streak completion and nothing changed after, you are done.

## Bookkeeping — the run ledger

Keep a ledger as a markdown file in your session scratchpad directory (never in the repo) and update it after every run — this task outlives context compaction, and the ledger is what carries state across it. Re-read it after any compaction before acting:

```
Run #7 — 2 failed, 1 flaky — streak: 0
  chat/stream-resume (chromium): FAIL — root cause RC-3 (membership cache eviction race) — task T4 in progress
  billing/topup (iphone-15): FLAKY — root cause RC-5 (new) — diagnosing
Fixed so far: RC-1 (T1, run 3), RC-2 (T2+T3, run 5)
Enforcement added: lint rule no-X (RC-1), contract test signals/Y (RC-2)
Intent conflicts pending: IC-1 (see below)
```

The ledger is what stops you from re-fixing, losing track of regressions, or miscounting the streak.

## Intent conflicts

When a diagnosis concludes the test and the application disagree about intended behavior, do **not** silently pick a side. Continue fixing everything unambiguous, collect the conflicts, and present them to the human in one batch per cycle: "the test expects X because…, the app does Y because…, which is intended?" Tests touched by a pending conflict are excluded from fix work (never from runs) until answered.

## Escalation

- **Same root cause survives 3 distinct fix attempts** → stop work on it and escalate to the human with the full diagnosis history. Persistent failure usually means the diagnosis is wrong or the intended behavior is ambiguous — more attempts burn time without new information.
- **Stall detection:** if the failure set has not shrunk across 3 consecutive full runs (fixes in between notwithstanding), stop and escalate with the ledger. A loop that isn't converging needs a human, not more iterations.
- **Environment failures** (Docker down, disk full, port conflicts, `e2e:prepare` failing) are not test results: fix the environment (`pnpm dev:restart`, `pnpm db:up`), don't count the run for or against the streak, and note it in the ledger. If the same environment failure recurs 3 times, treat it as a real infrastructure bug and diagnose it like any other failure.
- **A fix requires a schema change, new dependency, or architecture decision** → that is outside your decision authority; stop and ask.

## Hard rules

- **Never fix without a diagnosis.** Every code change traces to a root cause established through the investigation protocol.
- **One tree state per run.** No edits while a run is in flight; a result must be attributable to exact code.
- **Flaky = failed**, everywhere, always.
- **The streak is sacred.** Only identical-tree, full-suite `pnpm e2e` runs count, and flaky counts against green. Resets on any change or any non-green.
- **Fix the class, not just the instance** — every root cause gets an enforcement-ladder check.
- **No git writes.** Read-only inspection (`status`, `log`, `diff`, `show`) only; never create, move, or discard any git state. The human finalizes the finished unit.
- **Report staleness.** If any command or path referenced in this skill doesn't exist, stop and tell the user the skill needs updating.

## Final report

```
## E2E Green — Complete

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
