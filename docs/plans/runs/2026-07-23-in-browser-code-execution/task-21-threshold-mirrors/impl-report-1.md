# Implementation report — threshold mirrors

## Objective

Close the two surviving copies of the document-extraction line threshold left behind by the
hoist of `MIN_LINES_FOR_DOCUMENT` into `packages/shared/src/documents/extraction.ts`, and make
the e2e document fixtures that are sized to that threshold robust to it moving. Folded in
mid-task by coordinator message: correct the now-stale "import map" prose in
`e2e/chat/runnable-documents.spec.ts`.

## Search — every site that encodes the threshold

Grep over `e2e/`, `scripts/`, `mobile-tests/`, plus a repo-wide grep for the constant name:

| Site                                                    | What it encoded                                              | In bounds |
| ------------------------------------------------------- | ------------------------------------------------------------ | --------- |
| `scripts/mobile-test.test.ts:1192`                      | hardcoded `15` + comment pointing at the deleted web constant | yes       |
| `scripts/mobile-test.ts:495`                             | prose — **already** cites `MIN_LINES_FOR_DOCUMENT` by name, no number | yes |
| `e2e/ui/document-panel.spec.ts` × 3 fixtures + 2 comments | 15-line and "5 lines" fixtures, `toContainText('15 lines')`   | yes       |
| `e2e/chat/runnable-documents.spec.ts` × 4 fixtures + 2 assertions | "(≥15 lines)" prose, `toContainText('15 lines')` ×2 | yes |

No other e2e spec, mobile-tests flow, or script encodes the threshold. `apps/web` and
`scripts/lib/seed-documents.test.ts` already import the shared constant (untouched, other tasks own them).

## Latent bugs found by measuring the fixtures

Counting fence-body lines programmatically rather than trusting the comments:

```
e2e/ui/document-panel.spec.ts       PYTHON_CODE_BLOCK  15   MERMAID_BLOCK 4   SMALL_CODE_BLOCK 4
e2e/chat/runnable-documents.spec.ts HTML_DOC 15  REACT_DOC 14  PYTHON_DOC 15  SYNTAX_ERROR_DOC 14
```

`REACT_DOC` and `SYNTAX_ERROR_DOC` were **14 lines — one line below the threshold** while their
doc comments claimed "(≥15 lines)". Neither would have extracted as a document card, so both
tests would have failed at `scrollToCardInMessage` / `clickCardInMessage`. The suite is
founder-gated and has not run, so this had not surfaced. `SMALL_CODE_BLOCK`'s comment claimed
"5 lines" against an actual 4. Exactly the drift class this task exists to remove; all three are
fixed by the derivation below.

## Files changed

- `e2e/helpers/documents.ts` (new) — `documentFixture()` sizes a fenced block to
  `MIN_LINES_FOR_DOCUMENT + headroom` and returns the resulting `lineCount`;
  `belowThresholdFixture()` sizes one to exactly `MIN_LINES_FOR_DOCUMENT - 1`. Both derive from
  the shared constant, so no fixture and no card-label assertion can carry a stale number. Lives
  in `e2e/helpers/` because both specs are callers (CODE-RULES §One Implementation, Shared —
  narrowest scope covering all callers).
- `e2e/ui/document-panel.spec.ts` — `PYTHON_CODE_BLOCK` now built by `documentFixture` (headroom:
  the test is about the panel, not the boundary); `SMALL_CODE_BLOCK` by `belowThresholdFixture`
  (that step *is* about the boundary, so it must move with it); `toContainText('15 lines')` →
  `${PYTHON_DOCUMENT.lineCount} lines`; the "(5 lines, below …)" comment drops its number.
- `e2e/chat/runnable-documents.spec.ts` — all four fixtures built by `documentFixture` (all four
  merely need to *be* documents); both `toContainText('15 lines')` assertions derive from the
  fixture; "(≥15 lines)" prose removed from four doc comments; the file header states the sizing
  rule once. Also the coordinator's fold-in: the two "import map" claims (fixture doc comment and
  the in-test comment) now describe rewriting a bare specifier to an absolute module URL, and the
  JSX fixture's own copy line no longer mentions an import map.
- `scripts/mobile-test.test.ts` — imports `MIN_LINES_FOR_DOCUMENT` from `@hushbox/shared/documents`
  and asserts against it instead of `15`; the comment no longer points at the deleted
  `apps/web/src/lib/document-parser.ts` constant.
- `scripts/mobile-test.ts` — **unchanged**. Its comment already names the shared constant and
  states no number, which is the compliant shape the brief asked for. Changing it would have been
  churn.

## How each site now derives or justifies its number

| Site | Resolution |
| --- | --- |
| `scripts/mobile-test.test.ts` | asserts `>= MIN_LINES_FOR_DOCUMENT` (imported). The seed fixture itself keeps static headroom (18 lines); this test is the pin that fails loudly if the threshold ever passes it. |
| `scripts/mobile-test.ts` | prose cites the constant by name; no number to go stale. |
| `document-panel.spec.ts` PYTHON | derived with headroom — test is about the panel, must stay a document either way. |
| `document-panel.spec.ts` SMALL | derived to `threshold - 1` — the step *is* the boundary test. |
| `document-panel.spec.ts` MERMAID | untouched; mermaid is exempt from the line rule, so it encodes nothing. |
| `runnable-documents.spec.ts` × 4 | derived with headroom — none of these tests is about the boundary. |

## Bump demonstration (the decision rule)

`MIN_LINES_FOR_DOCUMENT` temporarily set to `25` in `packages/shared`, observed, restored. Restoration
verified by grep after each run; the constant reads `15` and the file is otherwise untouched.

1. **Before the fix** — `scripts/mobile-test.test.ts` threshold test **passed** at 25. That is the
   stale pass the task targets: the 18-line seed no longer clears the threshold, yet the hardcoded
   `15` kept the assertion green.
2. **After the fix** — same test **failed for the right reason**:
   `AssertionError: expected 18 to be greater than or equal to 25` at `mobile-test.test.ts:1197`.
3. **e2e fixtures** — the suite cannot be run (founder-gated), so the derivation was exercised
   directly through the helper:

   | | threshold 15 | threshold 25 |
   | --- | --- | --- |
   | `documentFixture` (15-line body) | 19 lines | 29 lines |
   | `documentFixture` (14-line body) | 19 lines | 29 lines |
   | `belowThresholdFixture` | 14 lines | 24 lines |

   Every fixture moves with the threshold, and the card-label assertions read `lineCount` from the
   fixture, so they move with it too. Nothing in the e2e specs is left pinned to a stale number.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:watch scripts/mobile-test.test.ts` | pass — 144/144 |
| `turbo typecheck lint --filter=@hushbox/scripts --force` | pass — 2/2 |
| `turbo typecheck lint --filter=@hushbox/e2e --force` | pass — 2/2 |
| `npx eslint mobile-test.ts mobile-test.test.ts` (from `scripts/`, after last edit) | exit 0 |
| `npx eslint helpers/documents.ts ui/document-panel.spec.ts chat/runnable-documents.spec.ts` (from `e2e/`, after last edit) | exit 0 |

The known/expected failures named in the brief (`seed-run.test.ts`, `refresh-catalog-run.test.ts`,
`generate-env.test.ts`) were not encountered — the scoped run was `mobile-test.test.ts` only.

## Acceptance criteria

- **Site 1 — `mobile-test.test.ts` imports the constant, stale comment fixed** — met; bump
  demonstration proves the assertion now moves.
- **Site 2 — `mobile-test.ts` prose cites the constant, not the number** — met; already compliant,
  no change needed (stated rather than churned).
- **Site 3 — e2e fixtures robust** — met; all seven document fixtures derive from the shared
  constant, and two of them were silently on the wrong side of the boundary before this change.
- **Decision rule — no test passes against a stale assumption after a bump** — met, demonstrated.
- **Fold-in — "import map" prose corrected** — met; no occurrence of "import map" remains in `e2e/`.

## Deviations

- **Created `e2e/helpers/documents.ts`, which is outside the literal BOUNDS list** (specs only).
  Inlining the derivation would have meant two copies of the same sizing logic across the two
  specs; the helper is a new file with no concurrent owner and no conflict risk.
- `scripts/mobile-test.ts` was left unchanged (see above) — a no-op where the brief expected an edit.

## Concerns and limitations

- The e2e specs themselves were not executed (founder-gated, per brief). The two fixed
  below-threshold fixtures are proven correct by construction and by the helper demonstration, not
  by a green run.
- Padding lines are literal filler comments in the fixture body. They are inert in every language
  used (`#`, `//`, `<!-- -->`), and in `SYNTAX_ERROR_DOC` they sit after the transpiler's rejection
  point, so they cannot change what any test observes.
- `DOCUMENT_LINE_HEADROOM = 4` is a judgment call; it only has to be non-zero for the "not on the
  boundary" property to hold, since the base is derived.

## Confidence

High — every claim is either a gate I ran or a measurement I took. The one unverifiable piece is
that the two repaired e2e tests now pass end to end, which no one can verify until the suite is
allowed to run.
