# Task 27 — impl report 1

## Objective

Unblock the `pnpm lint` / pre-push gate: `scripts/skills/generate-skills.ts:48` failed
`@typescript-eslint/non-nullable-type-assertion-style` on `const name = match[1] as string;`.
Brief prescribed changing it to a non-null assertion `match[1]!`.

## Files changed

- `scripts/skills/generate-skills.ts` — replaced the `as string` assertion on the regex
  capture group with a fail-fast `undefined` guard (see deviation below).

## Self-gate

- `cd scripts && npx eslint skills/generate-skills.ts` — pass — EXIT:0 (run twice, both 0).

## Acceptance criteria

- Lint passes on the owned file — met — eslint exit 0.

## Deviations with reasons

The brief's prescribed fix (`const name = match[1]!;`) does NOT pass lint. The repo's
scripts ESLint config also has `@typescript-eslint/no-non-null-assertion` enabled as an
**error**, which forbids `!`. So the two rules are mutually exclusive on this line:
- `as string` → trips `non-nullable-type-assertion-style` (wants `!`)
- `match[1]!` → trips `no-non-null-assertion` (forbids `!`)

Verified: after applying `match[1]!`, eslint reported
`48:18 error Forbidden non-null assertion @typescript-eslint/no-non-null-assertion` (EXIT:1).

The capture group types as `string | undefined` under `noUncheckedIndexedAccess`, which is
why an assertion was there originally. The assertion-free, lint-clean, and project-doctrine
(fail-fast) fix is a runtime guard that throws on the structurally-impossible `undefined`:

```ts
const name = match[1];
if (name === undefined) {
  throw new Error(`section marker matched without a name: ${match[0]}`);
}
```

This narrows `name` to `string` with no assertion of any kind, satisfying both rules.

## Concerns and limitations

- The throw branch is unreachable (the marker regex's group 1 always matches when the
  overall regex matches), so it is an invariant assertion, not a live branch. If `scripts/`
  is under the per-file 95% branch-coverage gate, this uncovered branch could fail
  `pnpm test` for that package. I did NOT run tests (out of brief scope). Flagging for the
  orchestrator: if scripts is coverage-gated, this line needs a coverage carve-out or a
  test, or an alternative narrowing. `pnpm lint` itself is unaffected.

## Confidence

Medium — lint gate (the task's goal) is satisfied and verified twice. Confidence is not
high only because the brief's stated fix was wrong for this repo, forcing a deviation, and
the throw branch's coverage interaction is unverified (tests out of scope).

## Fix cycle 1

Orchestrator confirmed the flagged concern: the fail-fast throw guard dropped
`generate-skills.ts` branch coverage below the per-file 95% gate, failing `pnpm test`
(scripts) on coverage. Applied the coverage-ignore fix.

### Change

Added a `/* v8 ignore next 3 -- ... */` directive immediately before the guard, matching
the repo's established form (grepped `scripts/`: `worktree.ts:47` uses inline
`/* v8 ignore next -- reason */`; many files use `start`/`stop`). The `next 3` covers the
`if` + `throw` + closing brace of the guard. Kept the assertion-free guard (no `as`, no
`!`). Durable comment states why the branch is unreachable: the marker regex always
captures group 1 on a match, so `match[1]` is never undefined for a matched result.

### Self-gate

- `cd scripts && npx eslint skills/generate-skills.ts` — pass — ESLINT_EXIT:0.
- `npx turbo test --filter=@hushbox/scripts --force` — pass — Tasks: 1 successful;
  `generate-skills.ts | 100 | 100 | 100 | 100` (stmts | branch | funcs | lines). Re-run
  confirmed TURBO_EXIT:0.

### Result

Both gates green. Lint unblocked and the scripts coverage gate passes with the ignored
branch removed from the branch denominator. Confidence: high.
