---
name: improve-codebase
description: Deep quality audit of the codebase (or a scope of it). Fans out research subagents to find defects, security flaws, weak spots, and improvement opportunities; adversarially verifies every finding; presents everything to the human for rulings; writes the final audit doc. Strictly audit, never fixes. Optional scope argument; no argument means the whole repo.
argument-hint: [scope]
---

# Improve Codebase

A full-depth audit run. The goal is the truth about the codebase's quality, held to the highest standard you can defend with evidence. You find problems and specify improvements; you never implement them. The human rules on every finding before anything becomes a task.

The skill is process. Facts about the codebase come from the loaded project docs and from reading code this run, never from this file. If something here contradicts what the repo actually contains, follow the repo and say the skill needs updating.

## Hard constraints

- **Audit only.** No fixes, no git writes, no edits to existing files. The only file you create is the final audit doc.
- **Do not run repo checks.** No tests, typecheck, lint, build, or coverage. Assume all gates are green. Evidence comes from reading code, not executing it.
- **At most 10 subagents in flight at once.** Queue the rest.
- **Runnable in any codebase state.** Make no assumptions about prior audits, migrations, or in-progress work. If the working tree is mid-change, audit what is there.
- Every claim that survives to the human is **Verified**: you (or a subagent) read the code this run and cite `file:line`. Inferred and Assumed claims either get verified or get cut.

## Ambition

Findings are not capped at bug reports. The scale runs from a one-line fix to a redesign of an entire subsystem, and everything between: a missing index, a confusing module boundary, a build step that wastes a minute per run, a hand-rolled mechanism a better-maintained library already solves, an architecture that fights the problem it serves. Any problem is fair game. Maintainability friction, developer-experience drag, operational risk, cost, a capability the current design forecloses. If an improvement exists, propose it at whatever size it actually is; don't shrink a structural problem into a cosmetic patch to make the ruling easier. Big proposals carry the same evidence standard as small ones, plus an honest account of migration cost and risk.

## Scope argument

The argument is interpreted loosely: a path (`apps/web`), a slice or domain ("billing", "the admin plane"), or a concern ("security", "error handling") are all valid. Resolve it into a concrete file-set and concern-set, and state that resolution in one or two sentences before fanning out, so a wrong reading dies early. No argument means global: derive the partition yourself from the repo's actual structure (packages, slices, apps) at run time. Never carry a hardcoded list of what the repo contains.

## Phase 1: Orient

One pass in your own context before any fan-out.

1. Read the loaded project docs and follow the on-demand doc index for anything the scope touches.
2. Search `docs/audits/`, `docs/plans/`, and memory for prior rulings. Build a suppression list: findings the human already rejected or explicitly accepted as-is. These do not get re-raised. A ruling the human approved that was then never implemented, or implemented wrong, is a live finding.
3. Produce a short run manifest: the partition, the review lenses you plan to apply, and a rough subagent count. Show it, then proceed.

## Phase 2: Fan out

Spawn research subagents across the partition. Brief each one with territory and a quality bar, not a checklist. A brief contains:

- The files or domain it owns, plus pointers to the project doctrine it should read first.
- The evidence standard: every claim cited with `file:line`, tagged Verified only.
- The bar: would a top-tier engineer, reading this cold, sign their name to it? Anything they wouldn't sign is reportable: correctness bugs, security holes, invariants the docs declare but nothing enforces, dishonest or missing tests, dead weight, confusing design, silent failure paths.
- An explicit charge to hunt **unknown unknowns**: the most valuable findings are the ones nobody thought to ask about. If something smells wrong and fits no named category, report it anyway.
- A requirement to also report what was inspected and found clean, so "no findings" is distinguishable from "didn't look".

Do not tell agents what specific problems to expect. Steering them toward predicted findings biases them away from real ones.

Derive the lenses per partition rather than fixing them globally. Three durable sources: the invariants the repo declares about itself (each one is a question: is this enforced, or just held by discipline?), the universal lenses any strong reviewer applies (correctness, security, data integrity, failure behavior, test honesty, readability), and whatever the territory itself suggests (a crypto package invites different scrutiny than a marketing page).

Online research agents are allowed and encouraged where the outside world holds the answer: what the current best practice is, whether a dependency is deprecated or has known CVEs, how other systems solve a problem the codebase solves awkwardly, what a library's newer versions offer. Web claims meet the same standard as code claims: cite the source, and mark anything you couldn't confirm.

Run each partition until dry: when a round of differently-angled agents on a territory surfaces nothing new twice in a row, it is done. A fixed agent count is a coverage claim you can't back.

## Phase 3: Adversarial verification

Nothing reaches the human unverified. For every candidate finding, spawn an independent verifier whose job is to **refute** it. The verifier gets the claim and its citations, not the finder's reasoning. Verdicts:

- **Confirmed**: stands as written.
- **Overstated**: kernel is real, framing is wrong. Rewrite to what the evidence supports.
- **Refuted**: drop it, but log the refutation. A plausible-but-wrong finding is itself information; it goes in the "checked, clean" record so the next run doesn't rediscover it.

Assign severity after verification, never before. Finders inflate. Then dedup: merge findings that share a root cause even when the symptoms were reported from different files.

Separate each surviving finding into one of two kinds. **Defects** have one correct resolution; propose it. **Decisions** have real tradeoffs; present multiple options and recommend one. Getting this split right matters, because the human rules on everything and mislabeled defects waste their time while mislabeled decisions hide choices from them.

## Phase 4: Findings artifact

Publish the full verified findings set as an artifact (load the artifact-design skill first). For every finding:

- Current behavior, with the `file:line` evidence.
- Proposed behavior: one proposal when the fix is obvious, multiple options with tradeoffs and a recommendation when it needs a human call.
- Severity and area.

Present it well. Use charts or visuals where they aid understanding (severity distribution, findings by area, dependency between findings). Include the "inspected and clean" record and the refuted-findings log. The artifact's job is to let the human understand every item fully without opening the codebase.

## Phase 5: Human rulings

The human rules on **every** finding. None proceeds without approval.

Walk the decision items in chat in the format that works: current behavior, options, recommendation. Batch related items. Expect back-and-forth; some findings will be discussed several times before a ruling lands. Track rulings as they arrive (approved, approved with modification, rejected). Push back with evidence when you disagree, and don't fold without new information. The phase ends only when every finding has a ruling.

## Phase 6: Finalize

With all rulings in hand:

1. Write the final audit doc to `docs/audits/<YYYY-MM-DD>.md` (today's date; suffix `-2` if the name is taken). Always a fresh doc, never a continuation of a prior one. It contains:
   - A summary board: ID, one-line description, severity, ruling, progress checkbox. Declare the board the single source of truth for the resulting work.
   - Per-finding cards detailed enough to hand to someone with zero context: what exists, what's wrong, evidence, the ruled resolution, acceptance criteria.
   - A "raised and rejected" ledger recording every finding the human rejected and why, so future runs suppress them.
2. Publish a second artifact rendering the final doc for the human to read.

The doc reflects rulings, not raw findings. An item the human modified appears in its ruled form; the original proposal is not preserved in the card.
