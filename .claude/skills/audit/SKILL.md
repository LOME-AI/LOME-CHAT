---
name: audit
description: Audit completed work for plan adherence, code quality, duplication, lint, typecheck, and project standards. Invoke after completing a task to get a fix plan.
disable-model-invocation: true
argument-hint: [additional-instructions]
---

# Post-Completion Audit

Comprehensive audit of just-completed work. Runs automated checks AND manual analysis, then presents all findings as an actionable fix plan.

$ARGUMENTS

## Step 1 — Gather Context

1. **Identify what was just completed** from the conversation context — summarize the task, files changed, and scope
2. **Locate the plan file:**
   - Check conversation context for a referenced plan file
   - If no plan found, skip plan adherence checks and note it in the report
3. **Get the git diff** to understand exactly what changed:
   - Run `git diff --stat` for an overview of changed files
   - Run `git diff` for the full diff (use this to drive code quality analysis)

## Step 2 — Automated Checks

Run each check and capture output. Do NOT stop on failure — run all checks and report results together.

**Run these commands in parallel where possible:**

1. **TypeScript** — `pnpm typecheck`
2. **ESLint** — `pnpm lint`
3. **Duplication** — `pnpm lint:duplication` (jscpd, threshold 3)
4. **Unused Code** — `pnpm lint:unused` (knip)
5. **Tests** — Run tests for affected packages only:
   - If files changed in `apps/api/` → `pnpm test:api`
   - If files changed in `apps/web/` → `pnpm test:web`
   - If files changed in `packages/shared/` → `pnpm test:shared`
   - If files changed in `packages/db/` → `pnpm test:db`
   - If files changed in `packages/crypto/` → `pnpm test:crypto`
   - If files changed in `packages/ui/` → `pnpm test:ui`
   - If files changed in `packages/realtime/` → `pnpm test:realtime`

Record pass/fail and error counts for each.

## Step 3 — Plan Adherence

**Skip if no plan file is available.** Otherwise:

1. Read the plan file
2. Extract each task/requirement from the plan
3. For each task, check the git diff and changed files to determine:
   - **Completed** — implemented as specified
   - **Partial** — partially done, note what's missing
   - **Missing** — not implemented at all
   - **Deviated** — implemented differently than planned, note how
4. Check for **scope creep** — changes not in the plan that were added
5. Check for **skipped verification steps** — did the plan have a verification section that wasn't followed?

## Step 4 — Code Quality Analysis

Read each changed file (from git diff) and check for:

**Error Handling:**

- External calls (fetch, DB, Redis) wrapped in try/catch
- No silently swallowed errors (`catch {}` or `catch { /* empty */ }`)
- Custom error classes with context where appropriate

**Type Safety:**

- No `any` types without documented justification
- No `@ts-ignore` without explanation
- Explicit return types on functions
- Zod/Drizzle inference used (not manually duplicated types)

**DRY Violations:**

- Copy-paste code across changed files
- Similar logic that should be extracted to a shared utility
- Duplicated constants or magic numbers

**Dead Code & Artifacts:**

- `console.log` or `debugger` statements left in
- Commented-out code that should be deleted
- TODO/FIXME comments indicating unfinished work
- Unused imports or variables

**Security:**

- User input validated with Zod at boundaries
- No user input interpolated in queries
- No hardcoded secrets or credentials
- Rate limiting on auth-related endpoints

**Pattern Adherence (per CODE-RULES.md):**

- Environment detection uses `envUtils`, not direct `NODE_ENV` checks
- No `??` fallback defaults for env vars
- API calls use the typed client (`api-client.ts`), not raw `fetch()`
- State in database or Redis only (no persistent in-memory state)
- Single source of truth: types flow from Drizzle/Zod, never duplicated

**Import Organization:**

1. External dependencies
2. Internal packages (`@hushbox/*`)
3. Relative imports
4. Type imports last

## Step 5 — Test Adequacy

For each new or modified function in the diff:

1. Does it have a corresponding test?
2. Does the test cover the happy path?
3. Are error conditions tested?
4. Are edge cases and boundary conditions covered?
5. Are mocks minimal — testing real behavior, not mock behavior?
6. Do test names clearly describe behavior (no "and" in test names)?

## Step 6 — Present Audit Report

Present findings in this exact format:

```
## Audit Report

### Summary
[1-2 sentence summary of overall quality]

### Automated Check Results
| Check | Status | Details |
|-------|--------|---------|
| TypeScript | PASS/FAIL | N errors |
| ESLint | PASS/FAIL | N errors, M warnings |
| Duplication (jscpd) | PASS/FAIL | N clones found |
| Unused Code (knip) | PASS/FAIL | N unused exports |
| Tests (package) | PASS/FAIL | N pass, M fail |

### Plan Adherence
(skip section if no plan file)
- [x] Task 1: Completed as specified
- [ ] Task 2: Missing — [details]
- [~] Task 3: Partial — [what's missing]
- [!] Scope creep: [unplanned changes]

### Issues Found

#### Critical (Must Fix)
[Bugs, security issues, data loss risks, broken functionality, failing checks]
1. **[Issue title]** — `file:line` — [Why it matters] — [How to fix]

#### Important (Should Fix)
[Architecture problems, missing error handling, test gaps, DRY violations]
1. **[Issue title]** — `file:line` — [Why it matters] — [How to fix]

#### Minor
[Code style, naming, optimization opportunities]
1. **[Issue title]** — `file:line` — [Why it matters] — [How to fix]

### Fix Plan
[Ordered list of concrete actions to resolve all Critical, Important, and Minor issues]
1. [Action] in `file.ts:line`
2. [Action] in `file.ts:line`
3. ...
```

**Do not make any file changes until the audit report has been presented and the user has addressed it.** The audit's job is to surface findings, not to fix them in the same pass.

## Rules

- **Run ALL automated checks** even if early ones fail — the user needs the full picture
- **Be specific** — always include `file:line` references, never vague feedback
- **Severity matters** — not everything is Critical. Reserve Critical for things that would break production or lose data
- **Acknowledge strengths** — note what's well done before listing issues
- **Fix plan is ordered** — Critical fixes first, then Important, with concrete file paths
- **Pre-existing failures** — if lint/typecheck/test failures existed before this work, note them separately so the user knows what's new vs pre-existing
- **No false positives** — only flag real issues. If something looks intentional and correct, don't flag it just to be thorough
- **Never use** `git stash`, `git checkout --`, `git checkout .`, `git restore`, `git reset --hard`, or `git clean` — these commands are forbidden
