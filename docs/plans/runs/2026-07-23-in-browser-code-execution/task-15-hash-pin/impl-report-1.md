# impl-report-1 — cassette-baseline hash pin

## Objective

Update the cassette-baseline descriptor-hash pin in
`apps/api/src/slices/models/adapters/language-adapter.test.ts` to the value the current
canonical outbound request actually produces, and replace the stale change-narrating
comment above the assertion with a durable statement of what the pin is and why it exists.

## Files changed

- `apps/api/src/slices/models/adapters/language-adapter.test.ts` — pinned hash literal
  updated from the stale value to the value the current request shape produces; the comment
  above the assertion rewritten to state the pin's purpose rather than narrate a past change.

## Tests added

None. This task updates an existing pin; no new behavior.

## Self-gate

- `npx vitest run src/slices/models/adapters/language-adapter.test.ts` (from `apps/api`) —
  **pass** — 48 passed / 48, 1 file passed.
- `npx eslint src/slices/models/adapters/language-adapter.test.ts` (from `apps/api`, run
  after the final edit) — **pass** — exit 0, no output.

Pre-edit run (evidence the pin was genuinely red, and the source of the new literal):

```
AssertionError: expected 'db959d833936e56f' to be '38c94f4a2781f374' // Object.is equality
Expected: "38c94f4a2781f374"
Received: "db959d833936e56f"
  ❯ src/slices/models/adapters/language-adapter.test.ts:1188:71
```

The new literal was taken from that observed `Received` value, not from the brief's stated
value (they happened to agree).

## Acceptance criteria

1. **Run the test first, read the actual received hash, update the literal to that value** —
   **met**. Test was run before any edit and failed with `Received: "db959d833936e56f"`; the
   literal now reads `'db959d833936e56f'` (old: `'38c94f4a2781f374'`).
2. **Replace the stale comment with a durable, change-agnostic statement of the pin** —
   **met**. New comment states the hash is the cassette lookup key derived from the canonical
   outbound request, that it is pinned so request-shape changes (notably system prompt text)
   fail loudly here rather than silently invalidating recorded cassettes, and that changing
   the literal declares cassettes must be re-recorded. No mention of any specific feature, no
   task narration, no run-internal labels.
3. **Test green after the change** — **met**. Full file: 48/48 pass.
4. **Only the literal and the comment changed** — **met**. `git diff` on the file is exactly
   two hunks: the 4-line comment replaced by 5 lines, and the one-character-class change of
   the hash literal on the assertion line. 6 insertions / 5 deletions, one file.

## Deviations

None.

## Concerns and limitations

- The updated pin means every previously recorded AI cassette keyed on the old canonical
  request no longer matches. Re-recording cassettes is out of this task's bounds and is not
  done here; CI's zero-miss cassette policy will surface it if it has not already been
  handled by the workstream that changed the prompt.
- The repo has heavy concurrent churn in `apps/api`; a package-wide lint/test run is red from
  files this task never touched (`money.test.ts`, `estimate-run.test.ts`,
  `trial-smart-model-candidates.test.ts`, `interpreter.test.ts`,
  `smart-model.integration.test.ts`). Those were not investigated or fixed, per brief.
- The test's own title still reads "with the base system prompt", which the brief scoped out
  of this change; it remains accurate as a description of the request shape being pinned.

## Confidence

**high** — the new literal is the value the current code produced under observation, the
targeted file is fully green, lint is clean on the edited file after the last edit, and the
diff is confined to the two intended lines.
