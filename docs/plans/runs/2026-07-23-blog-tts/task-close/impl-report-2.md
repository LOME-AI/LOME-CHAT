# impl-report-2 — close-phase sweep, fix round

## Objective

Fix the one validated audit finding: the `(G9)` plan-identifier leak still present in
`packages/ui/src/components/accessibility/styles/reading-highlight.css:5`, then close the
sweep properly by re-running a **wider** identifier grep across every file this run
touched — not just the five files previously known dirty.

Root cause of the miss (accepted): round-1's grep was scoped to the already-edited set,
while the charter was to sweep every file the run touched. `reading-highlight.css` is
run-created, shipped `packages/ui` source, cross-referenced from `chunk-highlighter.ts`,
and was never in the grep's path list.

## Files changed

- `packages/ui/src/components/accessibility/styles/reading-highlight.css` — dropped the
  `(G9)` parenthetical from the header comment. Comment text only; no CSS rule touched.

## The edit — before / after

`reading-highlight.css:5`, single parenthetical drop, no rewrite:

- **Before:** `* a bordered box (G9), and both inherit the accessibility contrast overrides`
- **After:** `* a bordered box, and both inherit the accessibility contrast overrides`

The durable fact ("a soft wash rather than a bordered box") is already stated by the
sentence itself, so no replacement justification was added — per instruction, and
consistent with the round-1 edits #2/#3/#5 where the adjacent prose already carried the
fact. Full sentence now reads:

> Both use the brand tint token so the currently-read text reads as a soft wash rather
> than a bordered box, and both inherit the accessibility contrast overrides because the
> token is redefined per contrast mode.

## CSS rules byte-identical — evidence

`.css` is not linted by ESLint (confirmed: `eslint .` for the package passes and does not
cover `.css`), so identity of the rule block was verified directly by checksum of
everything below the comment (lines 8–20, i.e. both rule blocks plus surrounding
whitespace):

| | md5 of lines 8-20 | file bytes |
| --- | --- | --- |
| Before edit | `35649eaee1235147131d428e15c8c08e` | 693 |
| After edit | `35649eaee1235147131d428e15c8c08e` | 688 |

Checksum unchanged ⇒ `::highlight(tts-reading) { background-color: var(--brand-red-subtle); }`
and `.tts-reading-block { background-color: var(--brand-red-subtle); }` are byte-identical.
The 5-byte file delta is exactly the removed `" (G9)"` (space + 4 chars) and nothing else.

`grep -n 'G9' reading-highlight.css` → exit 1 (no match).

## The wider sweep

### Exact pattern run

```
\b[GTBPWRS][0-9]{1,2}\b|criteri|the plan|the brief|Phase [0-9]|rev [0-9]|Global Constraint|docs/plans|research/|impl-report|task-|see .*\.md
```

Run as `grep -rnE` (single invocation) over the complete touched set:

- `packages/ui/src/components/accessibility/` (recursive — **includes `styles/`**)
- `packages/ui/src/components/blog-reader/` (recursive)
- `packages/shared/src/tts-hosts.ts`, `tts-hosts.test.ts`, `tts-model-download.ts`,
  `tts-model-download.test.ts` (the four files matching `packages/shared/src/tts-*`)
- `scripts/verify-web-bundle.ts`, `scripts/build-web-bundle.ts`,
  `scripts/lib/ort-assets-plugin.ts`
- `apps/web/vite.config.ts`, `apps/marketing/astro.config.mjs`,
  `apps/marketing/src/pages/blog/[slug].astro`
- `knip.jsonc`, `e2e/marketing-roadmap.spec.ts`

All 15 path arguments were confirmed to exist before the run (`ls -d`), so no path was
silently skipped.

### Complete result — every hit, triaged

**Zero plan-identifier leaks remain.** Every match is a false positive of the deliberately
over-broad `[GTBPWRS][0-9]{1,2}` arm. Full hit list:

| File:line | Match | Verdict |
| --- | --- | --- |
| `accessibility/lib/tts-worker-protocol.test.ts:30` | `requestId: 'S1'` | Test fixture — a worker-protocol request id |
| `accessibility/lib/tts.worker.test.ts:153,166,170,191,208` | `'P1'`–`'P4'` | Test fixtures — request ids for `progress` cases (`runLoad('P1', […])`) |
| `accessibility/lib/tts.worker.test.ts:255,269,308,319,334` | `'W1'`, `'W2'` | Test fixtures — request ids for `warmup` cases (`{ type: 'warmup', requestId: 'W1' }`) |
| `knip.jsonc:7` | `docs/plans/…` | Real, existing repo path — `docs/plans/behavioral-spec/coverage-check.mjs` (verified present, 3136 bytes). A knip entry-point config value, not a citation |
| `knip.jsonc:132,134` | `docs/plans/runs/`, `task-` | The ignore-entry comment the audit already ruled correct to leave unchanged. Not revisited |

The `S1`/`P1`/`W1` values are **runtime data**, not references: they are opaque
correlation ids passed into the worker and asserted back out, letter-prefixed by message
type (S=speak, P=progress, W=warmup, L=load). They resolve entirely within their own test
file and reference nothing outside the repo. Renaming them would change assertions, not
remove a leak.

Nothing additional was turned up beyond the one finding the auditor reported. The
auditor's count of "exactly one remaining leak" is confirmed, and it is now fixed.

## Self-gate

| Command (from `packages/ui` unless noted) | Result |
| --- | --- |
| `pnpm exec vitest run --coverage --coverage.reportsDirectory=<scratchpad>/cov-ui` | **pass** — 94 files, 1874 tests, 0 failed |
| `npx turbo typecheck lint --filter=@hushbox/ui --force --continue` (repo root) | **pass** — 2 successful, 2 total; `--force` so warm cache could not mask a failure |
| `grep -n 'G9' reading-highlight.css` | exit 1 — clean |

ESLint was not run against the `.css` file directly because ESLint does not lint `.css`;
the package-wide `eslint .` inside the `lint` task is the applicable gate and it passes.

Coverage after the edit, unchanged in every figure from the round-1 baseline:

```
All files          |   99.85 |    99.25 |     100 |   99.91
Statements   : 99.85% ( 2681/2685 )
Branches     : 99.25% ( 1194/1203 )
Functions    : 100%   ( 665/665 )
Lines        : 99.91% ( 2402/2404 )
```

Per-file uncovered-line lists also identical: `tts-engine.ts` 405-406, `audio.tsx` 99,
`chart.tsx` 108, `input.tsx` 27, `bottom-sheet.tsx` 76, `sidebar-panel.tsx` 146,
`cipher-wall.ts` 95,176,187, `use-reduced-motion.ts` 78. A CSS-rule change would have
been visible in the styles this suite renders against; none moved.

## Acceptance criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| `(G9)` removed from `reading-highlight.css:5` | met | §The edit; `grep 'G9'` exit 1 |
| Parenthetical dropped only, no rewrite or padding | met | §The edit — before/after differ by exactly `" (G9)"`, 5 bytes |
| CSS rules unchanged | met | §CSS rules byte-identical — md5 of lines 8-20 unchanged |
| Wider re-grep across the whole touched set | met | §The wider sweep — pattern, 15 paths, full hit list |
| Zero remaining leaks confirmed | met | All 12 hits triaged benign; no plan identifier survives |
| Checks green | met | §Self-gate |

## Deviations

None. Exactly one file edited, one line changed, within bounds. `pnpm install` was not run.

## Concerns and limitations

- The `[GTBPWRS][0-9]{1,2}` arm cannot distinguish a plan identifier from a short test
  fixture string; the residual risk is a leak using an unlisted prefix (e.g. `A4`, `F12`)
  or pure prose with no identifier at all ("as designed upstream"). The prose arms
  (`the plan`, `the brief`, `criteri`, `Global Constraint`, `see .*\.md`) cover the common
  phrasings and returned zero hits across the touched set.
- The sweep is scoped to the touched set given in the brief. Files this run touched that
  are not on that list — if any exist — remain unswept by construction.

## Confidence

**high** — the fix is a 5-byte comment deletion with a checksum proving the CSS rules did
not move; the sweep ran the specified wider pattern over every named path with all 15
paths existence-checked first, and every surviving hit is individually accounted for as
test data or a real repo path. Both gates green with cache bypassed.
