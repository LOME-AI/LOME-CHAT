# impl-report-1 — hoist the document line threshold to shared

## Objective

Remove the mirrored `MIN_LINES_FOR_DOCUMENT = 15` constant (authoritative copy in
`apps/web/src/lib/document-parser.ts`, mirror in `scripts/lib/seed-documents.ts`) by hoisting it
to the `@hushbox/shared/documents` subpath and having both consumers import the single
definition — CODE-RULES §One Implementation, Shared.

## Files changed

- `packages/shared/src/documents/extraction.ts` (new) — the single `MIN_LINES_FOR_DOCUMENT`
  definition, carrying the durable comment about what the threshold governs and why it is shared.
- `packages/shared/src/documents/extraction.test.ts` (new) — colocated test; also what makes the
  file visible to the shared package's per-file coverage gate.
- `packages/shared/src/documents/index.ts` — re-export the new module from the existing narrow
  subpath (`export * from './extraction.js'`).
- `apps/web/src/lib/document-parser.ts` — local definition deleted; the constant now rides the
  existing `@hushbox/shared/documents` import. `shouldExtractAsDocument` is otherwise untouched.
- `apps/web/src/lib/document-parser.test.ts` — imports the constant from
  `@hushbox/shared/documents` instead of from `./document-parser` (the parser no longer re-exports
  it, deliberately: a re-export would be a second place a consumer could re-pin).
- `scripts/lib/seed-documents.ts` — mirrored definition deleted. The durable fact that the untagged
  block clears the line count yet stays plain code (because it declares no language) moved onto the
  `UNTAGGED_LOG` fixture it describes, so it was not lost with the constant's doc block.
- `scripts/lib/seed-documents.test.ts` — the fixture assertions now read the constant from
  `@hushbox/shared/documents`.

## Tests added

- `MIN_LINES_FOR_DOCUMENT counts whole lines` — the threshold is an integer, so a fractional value
  cannot silently shift the boundary. Covers the hoisted constant's invariant.
- `MIN_LINES_FOR_DOCUMENT takes more than a single line for a block to become a document` — guards
  the degenerate value that would turn every fenced block into a document.

No new consumer tests: the web parser's and the seed fixtures' existing assertions already read the
constant, and they are what proves the hoist removed the drift (below).

TDD sequence observed: the shared test was written first and failed with
`Cannot find module './extraction.js'`; it passed once `extraction.ts` existed. Deleting the web
definition before repointing its test produced a real red
(`shouldExtractAsDocument('typescript', MIN_LINES_FOR_DOCUMENT)` → `expected false to be true`,
the constant resolving to `undefined`), which confirms that test genuinely reads the constant
rather than a literal.

## Drift demonstration (the acceptance question)

With both consumers repointed, `MIN_LINES_FOR_DOCUMENT` in `packages/shared` was temporarily raised
`15 → 400` and both sides moved together:

- web — a probe assertion at a fixed line count (`shouldExtractAsDocument('typescript', 20)`,
  temporarily added to `document-parser.test.ts`) flipped to
  `AssertionError: expected false to be true`. The parser's extraction decision follows the shared
  value.
- scripts — `seed-documents.test.ts` failed 2 tests
  (`makes every block long enough to clear the document-extraction threshold`,
  `leaves exactly one block without a language so it stays a plain code block`): the seeded fixtures
  no longer cleared the raised threshold, which is exactly the signal the mirror used to swallow.

The value was restored to 15 and the probe assertion removed; both suites are green again (verified
below). No consumer re-pins the number: `grep -rn MIN_LINES_FOR_DOCUMENT` over the three owned files
shows one definition (`packages/shared/src/documents/extraction.ts:12`) and one use site
(`apps/web/src/lib/document-parser.ts:94`), with the rest being imports.

## Self-gate

| command | result |
| --- | --- |
| `pnpm test:shared --force` | pass — 108 files / 2401 tests; `src/documents/extraction.ts` 100/100/100/100 under the per-file 95 gate |
| `pnpm test:web --force -- --coverage.reportsDirectory=<scratchpad>` | pass — 393 test files, exit 0 (`document-parser.test.ts` 46 tests) |
| `pnpm test:watch scripts/lib/seed-documents.test.ts --run` | pass — 12 tests |
| `pnpm test:watch scripts/seed.test.ts --run` | pass — 30 tests (the only other non-broken importer of `seed-documents`) |
| `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/web --filter=@hushbox/scripts --force` | pass — 6/6 tasks |
| `eslint` on owned files from `packages/shared`, `apps/web`, `scripts` (after last edit) | exit 0 in all three |

A private `--coverage.reportsDirectory` under the scratchpad was used for the web run to avoid the
shared `apps/web/coverage/.tmp` race with concurrent agents.

`scripts/seed-run.test.ts` was not run — it is a known dep-optimizer load failure that reproduces
against HEAD's own files. None of the known concurrent-workstream web failures appeared in this run
(the web suite was fully green).

## Acceptance criteria

- **Constant hoisted to `packages/shared/src/documents/` and exported from the existing
  `@hushbox/shared/documents` subpath** — met. `packages/shared/src/documents/extraction.ts`,
  re-exported by `packages/shared/src/documents/index.ts`; both consumers import from the narrow
  subpath, neither reaches for the top-level barrel.
- **Both local definitions deleted, both consumers import the shared one** — met (files-changed
  list above; grep shows a single definition).
- **The hoist removes the drift rather than relocating it** — met, demonstrated by the temporary
  bump above moving the web parser's behavior and the scripts fixture assertions together.
- **Durable comment kept with the constant, no run-internal labels** — met: the comment states that
  a fenced block at or above the threshold becomes an openable document (mermaid exempt) and why
  the number is shared rather than copied. No task/plan identifiers anywhere in the change.

## Deviations

None.

## Concerns and limitations

- **A third mirror exists, out of my bounds:** `scripts/mobile-test.test.ts:1192` asserts
  `toBeGreaterThanOrEqual(15)` against a hardcoded literal, with a comment pointing at
  `apps/web/src/lib/document-parser.ts MIN_LINES_FOR_DOCUMENT`; `scripts/mobile-test.ts:495` carries
  the same reference in prose. That is the identical drift shape this task removed, in a file I do
  not own (colocated test of `scripts/mobile-test.ts`). `e2e/ui/document-panel.spec.ts` likewise
  builds 15-line and 5-line fixtures against comments naming the threshold. Both should be
  repointed at `@hushbox/shared/documents`, but that is a separate scoped change.
- `packages/shared/src/index.ts` already re-exports `./documents/index.js`, so the constant is now
  also reachable from the top-level `@hushbox/shared` barrel. No name collision exists there
  (checked), and every consumer added here uses the narrow subpath.

## Confidence

High — the hoist is mechanical, and the drift removal was demonstrated empirically (bump moved both
consumers, restore returned both to green) rather than argued.
