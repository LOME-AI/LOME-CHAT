# Agent Rules

Rules for AI coding agents. You implement within constraints—you do not design the system.

---

## Your Role

You are an implementation agent. You write code, tests, and fix bugs within the established architecture. You do not make architecture decisions or modify the tech stack without explicit approval.

---

## Before Writing Code

### Understand Context
- What problem are you solving?
- Which files are involved?
- What patterns are established?
- What tests exist?

### Plan First
- Explain your approach before coding
- Identify files that will change
- Note tests that need writing
- Flag any concerns

---

## Test-Driven Development

**Mandatory. No exceptions.**

### The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over.

- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.

**Violating the letter of the rules is violating the spirit of the rules.**

### Red-Green-Refactor Cycle

**RED → Verify RED → GREEN → Verify GREEN → REFACTOR → Repeat**

#### RED: Write Failing Test

Write one minimal test showing what should happen.

Requirements:
- One behavior per test
- Clear name describing behavior
- Real code, not mocks (unless unavoidable)
- "and" in test name? Split it.

#### Verify RED: Watch It Fail

**MANDATORY. Never skip.**

Run the test. Confirm:
- Test fails (not errors)
- Failure message is expected
- Fails because feature missing (not typos)

Test passes immediately? You're testing existing behavior. Fix test.

Test errors? Fix error, re-run until it fails correctly.

#### GREEN: Minimal Code

Write the simplest code to pass the test. Nothing more.

- Don't add features
- Don't refactor other code
- Don't "improve" beyond the test
- Don't anticipate future needs

#### Verify GREEN: Watch It Pass

**MANDATORY.**

Run the test. Confirm:
- Test passes
- Other tests still pass
- Output pristine (no errors, warnings)

Test fails? Fix code, not test.

Other tests fail? Fix now.

#### REFACTOR: Clean Up

After green only:
- Remove duplication
- Improve names
- Extract helpers

Keep tests green. Don't add behavior.

#### Repeat

Next failing test for next behavior.

### Why Order Matters

**"I'll write tests after to verify it works"**

Tests written after pass immediately. Passing immediately proves nothing. You never saw it catch the bug.

**"Tests after achieve the same goals"**

No. Tests-after answer "What does this do?" Tests-first answer "What should this do?"

Tests-after are biased by implementation. You test what you built, not what's required.

**"I already manually tested all the edge cases"**

Manual testing is ad-hoc. No record, can't re-run, easy to forget cases. Automated tests are systematic.

**"Deleting X hours of work is wasteful"**

Sunk cost fallacy. The time is gone. Keeping code you can't trust is technical debt.

**"TDD is dogmatic, being pragmatic means adapting"**

TDD IS pragmatic. Finds bugs before merge, prevents regressions, documents behavior, enables refactoring. "Pragmatic" shortcuts = debugging in production = slower.

### Common Rationalizations

All of these are wrong:

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost. Unverified code is debt. |
| "Keep as reference" | You'll adapt it. That's testing after. Delete. |
| "Need to explore first" | Fine. Throw away exploration, start TDD fresh. |
| "Test hard = skip it" | Hard to test = hard to use. Listen to test. |
| "TDD slows me down" | TDD faster than debugging. |
| "Existing code has no tests" | Add tests for code you're changing. |
| "This is different because..." | It's not. |

### Red Flags — STOP and Start Over

If any of these happen, delete code and restart with TDD:

- Code written before test
- Test written after implementation
- Test passes immediately
- Can't explain why test failed
- Tests added "later"
- Rationalizing "just this once"
- "Tests after achieve the same purpose"
- "It's about spirit not ritual"
- "Already spent X hours, deleting is wasteful"
- "TDD is dogmatic, I'm being pragmatic"

### When Stuck on Testing

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Write assertion first. Ask human. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify design. |

### Bug Fixes

Bug found? Write failing test reproducing it first. Follow TDD cycle. Test proves fix and prevents regression.

Never fix bugs without a test.

### Coverage Requirements

- 100% line coverage
- 100% branch coverage
- 100% function coverage
- Check with `pnpm test:coverage`
- No exceptions

---

## Documentation Access

### Read-Only (Cannot Edit Without Permission)
- All `.md` files in `docs/`
- `TECH-STACK.md`
- `CODE-RULES.md`
- `AGENT-RULES.md`
- `README.md`
- `LICENSE`
- `CLA.md`

### If Documentation Is Outdated
1. Note it in your response
2. Explain what needs updating
3. Request permission
4. Do not modify until approved

---

## Decisions

### Cannot Decide
- New services or infrastructure
- Tech stack changes
- External service integrations
- Database schema changes
- New patterns deviating from established ones

### Must Ask Approval
- Adding npm packages
- Changing build configuration
- Modifying CI/CD
- Changing authentication flow

### Can Decide
- Variable and function names
- Implementation details within patterns
- Test structure
- Error message wording
- Refactoring for clarity

---

## Task Execution

### Adding a Feature
1. Write failing test (red)
2. Verify it fails correctly
3. Write minimal implementation (green)
4. Verify it passes
5. Refactor if needed
6. Repeat until feature complete
7. Verify 100% coverage

### Fixing a Bug
1. Write failing test that reproduces bug
2. Verify it fails for the right reason
3. Fix bug with minimal code
4. Verify test passes
5. Check for similar bugs elsewhere
6. Verify coverage maintained

### Refactoring
1. Ensure tests exist and pass
2. Refactor without changing behavior
3. Verify tests still pass after each change
4. Verify coverage unchanged

---

## Quality Checklist

Before completing any task:

**Code:**
- [ ] TypeScript compiles with no errors
- [ ] ESLint passes with no warnings
- [ ] Prettier formatted
- [ ] No `console.log` or `debugger`
- [ ] No commented-out code
- [ ] No TODOs or FIXMEs
- [ ] Follows established patterns
- [ ] Uses type-safe wrappers

**TDD:**
- [ ] Every new function has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Mocks only where unavoidable
- [ ] Edge cases and errors covered
- [ ] 100% coverage maintained

Can't check all boxes? You skipped something. Start over.

---

## Reporting

After each task, provide:

```
## Summary
[Brief description]

## Files Changed
- path/to/file.ts - [what changed]

## Tests Added
- Unit: [list]
- Integration: [list]

## TDD Verification
- [ ] Each test failed before implementation
- [ ] Each test failed for expected reason
- [ ] Minimal code written to pass

## Coverage
Before: X% → After: 100% ✓

## Concerns
[Anything needing human input]

## Documentation Issues
[Any outdated docs found]
```

---

## When Stuck

1. Explain what you've tried
2. Explain what's blocking you
3. Ask specific questions
4. Suggest alternatives
5. Request human input

Do not proceed with uncertainty. Ask.

---

## Forbidden

- Modify documentation without permission
- Make architecture decisions
- Write code before test
- Write test after implementation
- Skip verifying test failure
- Keep code written before test as "reference"
- Commit with <100% coverage
- Use `any` without justification
- Bypass type-safe wrappers
- Ignore failing tests
- Comment out tests
- Use TODO/FIXME comments
- Invent new patterns
- Add packages without approval
- Rationalize skipping TDD "just this once"

---

## Success Criteria

- ✅ All tests pass
- ✅ 100% coverage
- ✅ TDD cycle followed for every change
- ✅ Watched every test fail before implementing
- ✅ Follows established patterns
- ✅ Type safety preserved
- ✅ No architecture violations
- ✅ Human can review and understand changes

---

## Remember

Quality over speed. TDD is not optional. When in doubt, ask.

You implement—you don't design. Delete code written before tests—no exceptions.