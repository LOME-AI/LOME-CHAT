# impl-report-1 — close-phase plan-identifier sweep

## Objective

Remove plan-identifier leaks (`G2`/`G5`/`G6`/`G9`/`T3`, plus a run-doc citation and a
`G3` describe name) from shipped code in `packages/ui`, rewriting each to state the
durable fact the identifier stood for. Comment/test-name edits only — no behavior change.

CODE-RULES §Code Organization → Durable Naming: "No task IDs or plan-section references
in code, comments, or test names."

## Files changed

- `packages/ui/src/components/blog-reader/blog-read-aloud.tsx` — three leaks (`G6`, `G2`,
  `G5`) plus a citation of a run-local design doc.
- `packages/ui/src/components/accessibility/lib/document-reader.ts` — `T3` leak; the
  sentence was unreadable without the plan, so it was rewritten to state the guard.
- `packages/ui/src/components/accessibility/tts-download-bar.tsx` — `G9` leak.
- `packages/ui/src/components/accessibility/tts-download-bar.test.tsx` — `G9` in a
  shipped test name.
- `packages/ui/src/components/accessibility/lib/chunk-highlighter.test.ts` — `G3` in a
  shipped describe name (found by the widened grep; not in the original six).

## The eight edits — before / after

**1. `blog-read-aloud.tsx:22` (`G6`)**

- Before: `// Canonical local-privacy disclosure (Global Constraint G6), split into the two`
  `// halves that render as the two desktop lines.`
- After: `// The blog reader's local-processing disclosure, split into the two halves`
  `// that render as the two desktop lines.`
- Why more than a parenthetical drop: "Canonical" implied a single shared source, which
  is false — the accessibility widget's audio section carries its own phrasing
  (`sections/audio.tsx`); only the MB figure is shared (`TTS_MODEL_DOWNLOAD_MB`). Naming
  the owner ("the blog reader's") is the accurate durable fact. The rest of the comment
  (authored break, balanced halves, shared figure) was already durable and is unchanged.

**2. `blog-read-aloud.tsx:254` (`G2`)**

- Before: `* dynamic import (G2), so the marketing island stays light. Voice comes from`
- After: `* dynamic import, so the marketing island stays light. Voice comes from the`
- The reason ("so the marketing island stays light") was already stated; the ID carried
  nothing extra. Reflowed with the next line.

**3. `blog-read-aloud.tsx:255` (`G5`)**

- Before: `* the shared accessibility store (G5); the read never gates on the chat`
  `* read-aloud toggles.`
- After: `* shared accessibility store; the read never gates on the chat read-aloud`
  `* toggles.`
- The fact ("shared accessibility store", "never gates on the chat read-aloud toggles")
  was already stated.

**4. `document-reader.ts:132` (`T3`) — real rewrite**

- Before: `* The block-level fallback is a fail-soft guard T3 also honors; unreachable here.`
- After: `* The unreachable no-match branch emits a whole-block span, which the chunk`
  `* highlighter degrades to a whole-block highlight — the same fail-soft result it`
  `* gives any range it cannot map.`
- Grounding: the `found === -1` branch in `offsetsForPieces` pushes
  `{startOffset: 0, endOffset: normalized.length}` (a whole-block span);
  `chunk-highlighter.ts` documents at its head that "A chunk that cannot be mapped
  degrades to a whole-block highlight" and `rangeForSpan` returns `null` → block-class
  fallback. So the collaborating module is named by its real name and the sentence now
  stands alone. Unreachability is established by the preceding sentences (the substring
  invariant), which are unchanged.

**5. `tts-download-bar.tsx:28` (`G9`)**

- Before: `* suppressed. No border stroke and no container background (G9): the track and`
- After: `* suppressed. No border stroke and no container background: the track and`
- The justification follows the colon ("the track and its fill are the only painted
  surfaces") and the doc comment already opens with "Borderless"; the ID carried nothing.

**6. `tts-download-bar.test.tsx:68` (`G9` in a test name)**

- Before: `it('renders no border stroke and no background box on the container (G9)', ...)`
- After: `it('renders no border stroke and no background box on the container', ...)`
- Body untouched — both assertions (`not.toMatch(/\bborder\b/)`,
  `not.toMatch(/\bbg-/)`) are byte-identical.

**7. `blog-read-aloud.tsx:18` — run-doc citation (found by the widened grep)**

- Before: `// The one blog article container on a post page (see blog-architecture.md §2).`
- After: `// A post page marks its rendered body with \`data-reading\` and carries exactly`
  `// one such article, so this selector is unambiguous there.`
- `blog-architecture.md` is not resolvable from the repo (no such path in any doc index);
  it was a run-local reference. The durable fact is verifiable in the source:
  `apps/marketing/src/pages/blog/[slug].astro:132` renders
  `<article class="prose-blog max-w-none" data-reading>` — one per post page.

**8. `chunk-highlighter.test.ts:259` (`G3` in a describe name)**

- Before: `describe('createChunkHighlighter — auto-scroll (G3)', () => {`
- After: `describe('createChunkHighlighter — auto-scroll', () => {`
- Same class of violation as #6 (shipped test name); block body untouched.

## knip.jsonc decision — left unchanged

`knip.jsonc:132-133` reads:

```
// docs/plans/runs/ holds subagent-driven-dev run records and throwaway
// spike artifacts — run history, not source to analyze for unused exports.
```

Decision: **leave as-is.** "spike artifacts" is not imprecise — it is the load-bearing
half of the justification. Verified: `docs/plans/runs/` contains 17 non-`.md` files,
including real analyzable source under
`2026-07-23-in-browser-code-execution/task-00/spike/` (`launch.mjs`, `serve.mjs`,
`sandbox/pyodide-worker.js`, `sandbox/probe-worker.mjs`, plus `.html`). The `.md` run
records alone would not need a knip ignore — knip does not analyze Markdown. The spike
JS is exactly what the ignore exists for, so dropping or softening that clause would
remove the reason the entry is needed. It is also not a plan-identifier leak: "spike"
here describes real files in the named directory, not an unresolvable run ID.

## Re-grep proof

```
$ cd packages/ui && grep -nE '\b[GT][0-9]\b' \
    src/components/blog-reader/blog-read-aloud.tsx \
    src/components/accessibility/lib/document-reader.ts \
    src/components/accessibility/lib/chunk-highlighter.test.ts \
    src/components/accessibility/tts-download-bar.tsx \
    src/components/accessibility/tts-download-bar.test.tsx
exit=1        (grep exit 1 = zero matches)
```

Widened sweep for run-doc citations in shipped source:

```
$ grep -rnE 'docs/plans/runs|blog-architecture' packages/*/src apps/*/src e2e scripts
exit=1        (zero matches)
```

## No logic or assertion changed

- Every edit is inside a `//` or `/** */` comment, except #6 and #8 which change only the
  string literal passed as the first argument to `it(` / `describe(`. No callback body,
  no `expect`, no import, no export, no runtime expression was touched.
- The five edited files are untracked (new in this run), so `git diff` cannot show the
  delta; edits were verified by reading each site back after the change.
- Strongest evidence: the coverage run after the edits is byte-identical to the run
  before them — same file count, same test count, same four coverage percentages, same
  uncovered-line lists. A logic change could not leave all of that unmoved.

## Self-gate

| Command (from `packages/ui`) | Result |
| --- | --- |
| `pnpm exec eslint <5 edited files>` (after the last edit) | **pass** — exit 0, no output |
| `npx turbo typecheck lint --filter=@hushbox/ui --force --continue` | **pass** — 2 successful, 2 total; `--force` used so a warm cache could not mask a failure |
| `pnpm exec vitest run --coverage` (after the last edit) | **pass** — 94 files, 1874 tests, 0 failed |

Coverage, after the last edit:

```
All files    99.85 stmts | 99.25 branch | 100 funcs | 99.91 lines
Statements : 99.85% ( 2681/2685 )
Branches   : 99.25% ( 1194/1203 )
Functions  : 100%   ( 665/665 )
Lines      : 99.91% ( 2402/2404 )
```

Identical in every figure — and in every per-file uncovered-line list (`tts-engine.ts`
405-406, `audio.tsx` 99, `chart.tsx` 108, `input.tsx` 27, `bottom-sheet.tsx` 76,
`sidebar-panel.tsx` 146, `cipher-wall.ts` 95,176,187, `use-reduced-motion.ts` 78) — to
the baseline run taken partway through this task, before edits #7 and #8.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| Six named plan-ID leaks removed | met | before/after #1–#6 above |
| Each rewritten to the durable fact, not merely deleted where that would strand the sentence | met | #1 (owner named, "canonical" was false), #4 (full rewrite naming the chunk highlighter), #5/#2/#3 (fact already adjacent, clean parenthetical drop) |
| No behavior, logic, or assertion changed | met | comments + two test-name strings only; identical coverage and test counts |
| Test at #6 keeps its body exactly | met | both `expect` lines byte-identical |
| knip.jsonc judgment reported | met | §knip.jsonc decision — left unchanged, with the file evidence |
| Zero remaining `\b[GT][0-9]\b` in the edited files | met | grep exit 1 |
| Checks pass | met | §Self-gate |

## Deviations

Two edits beyond the six named. Both are the same violation class the task exists to
close and both are in files already in bounds:

- #7 — `blog-read-aloud.tsx:18` cited `blog-architecture.md §2`, a run-local doc that
  does not resolve from the repo. The brief's own framing ("identifiers no reader outside
  the run can resolve") covers it, and the orchestrator's mid-task message explicitly
  confirmed it as in scope.
- #8 — `chunk-highlighter.test.ts:259` carried `(G3)` in a shipped describe name, found
  by widening the grep past the four named files. Leaving it would have failed the
  objective while passing a grep scoped to the original four.

`chunk-highlighter.test.ts` was consequently edited, a fifth file. No other file was
touched.

## Concerns and limitations

- The grep pattern `\b[GT][0-9]\b` catches single-digit `G`/`T` identifiers only. It
  would not catch a two-digit ID (`G10`), a differently-prefixed one (`P2`, `W3`), or a
  prose reference with no ID ("as the plan describes"). I swept the five edited files and
  ran the repo-wide `docs/plans/runs|blog-architecture` grep, both clean, but a
  repo-wide sweep for other ID shapes was outside this task's bounds and has not been done.
- #1's rewrite asserts the widget and blog disclosures are separate copy sharing only the
  MB figure. Verified today (`sections/audio.tsx` builds `"{N} MB"` for a
  `"one-time download"` phrasing; the blog builds two different sentence halves). If a
  later change unifies the copy, that comment needs revisiting.

## Confidence

**high** — the change surface is comments and two test-name strings; the checks are green
after the final edit; and the post-edit coverage run reproduces the pre-edit run in every
figure and every uncovered-line list, which is direct evidence that no executable code
moved.
