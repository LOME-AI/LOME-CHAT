# Task-09 — mock echo must not break markdown fences — impl report 1

## Objective

The mock provider echoed `Echo: ${prompt}` on one line, so a prompt starting with a code
fence put ``` mid-line (never a valid CommonMark fence opener), mangling the block and
preventing document extraction (document-panel e2e). Fix: newline-separate the echo prefix
so column-0-sensitive markdown round-trips intact.

## Files changed

- `apps/api/src/slices/models/adapters/mock-provider.ts` — echo content changed from
  `` `${MOCK_ECHO_PREFIX} ${prompt}` `` to `` `${MOCK_ECHO_PREFIX}\n${prompt}` `` (one
  line, plus a durable comment on why same-line prefixes corrupt column-0 markdown —
  fences, headings, lists — the class, not just fences).
- `apps/api/src/slices/models/adapters/mock-provider.test.ts` — new mock-fidelity
  contract test (Rung 3) + the 7 existing exact-echo expectations updated from the space
  form to the newline form.

## Tests added

- `keeps a leading code fence at column 0 so the echoed block round-trips intact`
  (mock-provider.test.ts, "language echo" describe) — feeds a 15-line fenced Python-style
  block through `provider.infer`, asserts the echoed text contains exactly the prompt's
  own opener (` ```python `) + closer, both at column 0, and that the trailing lines equal
  the prompt verbatim (one intact block of the same line count). Covers AC-1 and AC-2
  (the RC-8 enforcement rung: a fenced ≥15-line block stays extraction-eligible).

## TDD

- RED observed: `expected [ '```' ] to deeply equal [ '```python', '```' ]` — the opener
  was mid-line (`Echo: ```python`), exactly the RC-8 failure shape.
- GREEN: one-line fix above; 42/42 tests in the file pass.

## Self-gate

- `vitest run src/slices/models/adapters/mock-provider.test.ts` (via with-env, from
  apps/api) — **pass** (42/42).
- `eslint mock-provider.ts mock-provider.test.ts` (from apps/api) — **pass** (exit 0),
  run after the last edit.
- `turbo typecheck --filter=@hushbox/api --force` — **fail**, sole error is
  `src/slices/chat/routes.ts(734,16): TS6133 'regenerateTurnDefinitionOrRefusal' declared
  but never read` — a file I did not touch and my files do not import; pre-existing /
  concurrent-task state, outside my ownership (raised).
- `jscpd --threshold 2 --silent apps/api/src/slices/models/adapters/` — **pass**
  (0.57% < 2%; no clones introduced by this change).
- Proof: `flock … pnpm e2e e2e/ui/document-panel.spec.ts` — **pass, 72/72** across all 6
  projects (chromium, firefox, webkit, pixel-7, iphone-15, ipad-pro), including
  `code-document-extraction-panel-copy-download-and-close`. Report:
  `e2e/report/2026-07-20T06-20-57/REPORT.md` (0 failed).

## Acceptance criteria

1. **Met.** Echo prefix is newline-separated unconditionally (class fix: fences,
   headings, lists all stay at column 0). Sibling echo formats swept
   (`grep 'Echo: '` / `MOCK_ECHO_PREFIX` repo-wide):
   - `apps/api/src/platform/dev/routes.ts:276` builds `` `Echo: ${aiTurn.userContent}` ``
     (dev seed route) — same class, **out of my file ownership**; raised. Its seeded
     content is fixed dev data (no leading fences today), so it is latent, not live.
   - `mock-provider.ts` classifier stream echoes a bare model id (no prefix) — not
     affected.
   - e2e fixtures seed literal `Echo: …` strings directly (not via the mock) — cosmetic
     divergence only; e2e page objects match `/^Echo:/` / substring `Echo:`, both still
     match the newline form.
2. **Met.** Failing test first at the mock seam, watched RED for the right reason, then
   GREEN (evidence above).
3. **Met.** Full document-panel spec green, 72/72, under the run lock.

## Deviations

None from the criteria. I did not edit the two out-of-ownership consumers the format
change touches (below) — reported instead, per bounds.

## Concerns and limitations

- **Broken consumer (raised):**
  `apps/api/src/slices/chat/domain/regenerate.integration.test.ts:382` asserts the old
  exact string `'Echo: first prompt'` and now fails (verified by running it: 1 failed /
  1 passed). Exact fix: change the expectation to `'Echo:\nfirst prompt'`. Out of my
  ownership (chat slice) — needs a micro-task or fold into a chat-slice task.
- **Sibling format (raised):** `apps/api/src/platform/dev/routes.ts:276` — same
  same-line-prefix class in the dev seed route; latent (fixed seed content has no
  leading fences). Out of ownership.
- **Pre-existing api typecheck failure (raised):** `chat/routes.ts:734` TS6133, unrelated
  to this change.
- Residual risk assessed as low: no e2e spec asserts the exact space-form echo from the
  live mock (swept `e2e/` for `` `Echo: `` / `Echo: $`), and the proof spec plus the
  fixture-seeded flows exercised in it are green.

## Confidence

High — RED→GREEN observed at the unit seam, the exact failing e2e test (and its whole
spec) is green across all 6 projects, and all consumers of the echo format were swept
repo-wide with each impact either verified green or explicitly raised.
