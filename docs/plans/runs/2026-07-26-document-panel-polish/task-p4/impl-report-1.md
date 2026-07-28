# impl-report-1 — remove false sandbox package claims

## Objective

Remove every claim that a Python package works in the document sandbox when it does not.
Three named sites (system prompt, `TECH-STACK.md`, `DOCUMENTS.md`), plus the prompt-hash
pin the prompt edit invalidates.

## Files changed

- `packages/shared/src/prompt/base-preamble.ts` — the live system prompt's `python` line
  named pandas/scipy as working; it now names what is vendored and states plainly that
  compiled packages cannot be installed.
- `packages/shared/src/prompt/base-preamble.test.ts` — two new tests pinning the corrected
  availability statement (written first, watched fail).
- `docs/TECH-STACK.md` — Pyodide row claimed pandas ships in the distribution.
- `docs/DOCUMENTS.md` — two sites: the Python-runtime bullet (site 3) and the iOS
  memory-ceiling bullet, which presupposed pandas runs.
- `apps/api/src/slices/models/adapters/language-adapter.test.ts` — the cassette-baseline
  prompt-hash pin, updated to the value observed from the failure.

## The three named sites, before and after

### 1. `packages/shared/src/prompt/base-preamble.ts` (the live system prompt)

Before:

> `- \`python\` — runs client-side when the user presses Run; printed output and matplotlib figures are displayed. numpy, pandas, matplotlib, scipy, and most scientific packages work; pure-Python PyPI packages auto-install from their imports.`

After:

> `- \`python\` — runs client-side when the user presses Run; printed output and matplotlib figures are displayed. numpy, matplotlib, and the standard library are available, and pure-Python PyPI packages auto-install from their imports. Packages with compiled extensions — pandas, scipy, scikit-learn and the like — cannot be installed; use numpy and plain Python instead.`

Naming the absent packages explicitly is what stops the model reaching for them; naming
the class ("compiled extensions") is what generalizes past the three examples.

### 2. `docs/TECH-STACK.md` — Pyodide row

Before:

> CPython on WebAssembly, self-hosted and version-pinned, run on the sandbox iframe's main thread (its required module worker cannot spawn from an opaque origin). numpy/pandas/matplotlib ship in the distribution; pure-Python PyPI installs via micropip.

After:

> CPython on WebAssembly, self-hosted and version-pinned, run on the sandbox iframe's main thread (its required module worker cannot spawn from an opaque origin). A pinned wheel closure of numpy + matplotlib is vendored; pure-Python PyPI installs via micropip, and no other compiled package can be added at runtime.

### 3. `docs/DOCUMENTS.md` — Python runtime bullet

Before:

> the worker.) Imports load from the bundled distribution (numpy/pandas/matplotlib and
> the rest of Pyodide's package set); pure-Python PyPI packages auto-install via
> micropip. Loading is lazy: …

After:

> the worker.) Imports resolve against a vendored, pinned wheel closure — numpy,
> matplotlib and their transitive deps — and pure-Python PyPI packages auto-install via
> micropip. Any other compiled package is unreachable: its Emscripten wheel lives on the
> Pyodide CDN, which `connect-src` blocks, and PyPI serves only the useless native
> wheel. Loading is lazy: …

Both halves of the original were false: pandas is absent, and "the rest of Pyodide's
package set" is not vendored at all. The replacement also records *why* it cannot be, so
the next reader does not re-add the claim.

### 4 (unnamed, same file) — `docs/DOCUMENTS.md` iOS memory-ceiling bullet

Before:

> iOS memory ceilings for WKWebView are unpublished and reported inconsistently; heavy
> pandas workloads on old devices may be memory-killed. That degrades to a failed run.

After:

> iOS memory ceilings for WKWebView are unpublished and reported inconsistently; heavy
> numpy or matplotlib workloads on old devices may be memory-killed. That degrades to a
> failed run.

Not in the brief's list of three. It presupposes pandas runs, so it falls inside the
objective ("every claim"), and it sits in a file already open for exactly this reason.
The bullet's durable fact — unpublished iOS memory ceilings degrade heavy work to a
failed run — is preserved; only the package name moved to one that exists. Raised to the
orchestrator rather than made silently.

## Prompt hash

`db959d833936e56f` → `4a56488739e04a99`
(`language-adapter.test.ts:1188`, "pins the canonical request shape with the base system
prompt (cassette baseline)"). Taken from the failure output, never computed by hand:

```
AssertionError: expected '4a56488739e04a99' to be 'db959d833936e56f'
```

Grepping the old hash across the repo found no other pin — the only non-test hits are
prior run-record reports in `docs/plans/runs/`, which are historical records and are not
updated.

## Tests added

- `names only the scientific packages the sandbox actually vendors` — the guidance names
  the vendored set (`numpy, matplotlib`) and not a pandas/scipy availability list.
- `declares compiled packages uninstallable so the model does not reach for them` — the
  guidance names pandas and scipy and states they cannot be installed.

Both watched fail first, for the right reason (`'cannot be installed'` absent;
`'numpy, matplotlib'` absent because the shipped text read `numpy, pandas, matplotlib`).

## Self-gate

| Command                                                                          | Result                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm test:shared`                                                               | pass — full package suite + coverage gate green         |
| `apps/api` `language-adapter.test.ts`                                            | pass — 48/48                                            |
| `apps/api` `src/slices/models/` + `chat/routes.integration.test.ts`              | 2 failed / 993 passed — see below                       |
| `apps/web` `use-prompt-budget.test.ts`                                           | pass — 68/68 (derives prompt length live, no pin)       |
| `npx prettier --check` (both docs + preamble + both test files)                  | pass                                                    |
| `npx eslint` from `packages/shared` (preamble + its test), after last edit       | exit 0                                                  |
| `npx eslint` from `apps/api` (language-adapter test), after last edit            | exit 0                                                  |
| `npx turbo typecheck --filter=@hushbox/shared --filter=@hushbox/api`             | pass                                                    |

`pnpm test:api` as a whole could not be gated: it aborted on
`Something removed the coverage directory ".../apps/api/coverage/.tmp"`. Six concurrent
`vitest` processes were running in this checkout at the time (`ps aux | grep -c vitest` →
6, and 21 source files under `apps/`/`packages/` had mtimes inside the preceding 20
minutes, including the `packages/shared/src/affordability/**` workstream the brief flagged
as red). That is a concurrent-run collision on a shared `coverage.reportsDirectory`, not a
test failure. The scoped re-run above, executed once contention cleared, reduced 11
failures across 2 files to the 2 genuine ones below — the other 9 (in
`chat/routes.integration.test.ts`) did not reproduce.

### The 2 genuine failures — caused by this change, in a file outside ownership

`apps/api/src/slices/models/domain/trial-eligibility.test.ts`

- `the per-message gate dominates the compiled turn floor > fails as shipped once input is ~32.5× output` —
  `expected 3370800 to be greater than 3581780`
- `the per-message gate dominates the compiled turn floor > measures the escape for a far-inverted shape by amount` —
  `expected 3380000n to be 3120000n`

The file derives `SYSTEM_PROMPT_CHARS` live from `buildTurnSystemPrompt`, but hard-codes
the *token count that length implies* (`805n`) and the price boundary that count produces
(`3254n`/`3255n`), plus three prose numbers in comments. Lengthening the prompt by 130
characters moves all of them.

Attribution is arithmetic, not inference:

- The python line grew 237 → 367 chars (+130). At the trial tier's `ceil(chars/2)`, that
  is +65 tokens.
- Full prompt: 1,609 → 1,739 chars; system-prompt input tokens 805 → 870
  (`ceil(1739/2) = 870`).
- Received `3380000n` = `870 × 4000 − 1000 × 100` exactly — the pinned expression with
  805 replaced by 870.
- Received floor `3581780` = `1070 × 3254 + 100000`, and `1070 − 200 = 870`. Consistent.

The surplus term the file documents (`1,000 × output + storage` = 2,620,000 at output 100)
does not involve the system prompt and is unchanged, so the boundary moves from
`2,620,000 / 805 = 3255` to `2,620,000 / 870 = 3011.49`.

**Not fixed here, deliberately.** `trial-eligibility.ts` and `trial-eligibility.test.ts`
were both modified at 23:37 today — inside the window this task ran, by a concurrent
workstream — and the file is not in this task's ownership. Editing prose-encoded economic
constants in a file another agent is mid-edit is exactly the parallel-work corruption the
ownership rule prevents. The follow-up is fully specified:

- `805n * 4000n` (line ~370) → `870n * 4000n`
- `pricing(3254n, 100n)` → `pricing(3011n, 100n)`; `pricing(3255n, 100n)` → `pricing(3012n, 100n)`
- test name `~32.5× output` → `~30.1× output` (3012/100)
- comment `2,620,000 − 805 × input, which turns negative at input 3,255` →
  `2,620,000 − 870 × input, which turns negative at input 3,012`
- comment `the gate carries 200 prompt tokens where the turn carries 1,005` → `1,070`
- describe doc-comment `system prompt (1,609 characters, 805 trial input tokens)` →
  `(1,739 characters, 870 trial input tokens)`
- comment `the boundary falls from input 3,256 to input 125: … a 26× wider band` →
  `from input 3,012 to input 125`, band `24×` (and the test name carrying `26× wider band`)

## Acceptance criteria

1. **Site 1 (system prompt) states what works and names compiled packages as unavailable** —
   met. Text above; pinned by two new tests.
2. **Site 2 (`TECH-STACK.md`) no longer claims pandas ships** — met. One-line diff; the
   table's column alignment survived `prettier --write` untouched (`git diff --stat` = 1
   insertion, 1 deletion).
3. **Site 3 (`DOCUMENTS.md`) corrected on both halves** — met. Names the real closure and
   states why nothing else can be added.
4. **Prompt-hash pin updated to the observed value** — met. Before/after above; hash taken
   from failure output.
5. **Other prompt-hash pins found and updated** — met (none exist; grep evidence above).
6. **`fetch-pyodide.sh` untouched** — met; read only, never edited.
7. **Docs keep register and wrapping; prettier-clean** — met.
8. **No change narration, no plan or task identifiers** — met; every edit states what is
   true in the present tense.

## Deviations

- **One edit beyond the three named sites**: `docs/DOCUMENTS.md` iOS memory-ceiling
  bullet (site 4 above). Same file, same objective, one package name.
- **Pillow is vendored but not advertised.** `fetch-pyodide.sh` pins
  `pillow-12.2.0-…wasm32.whl` as a matplotlib transitive dep, so `import PIL` would very
  likely resolve — but that was not verified live in the real frame, and this task's whole
  purpose is deleting unverified availability claims. Understating costs a user nothing;
  overstating is the bug being fixed. Worth a live check before adding it.

## Concerns and limitations

- The run directory's `plan.md` has no section for this task (it defines P1, P2, P3 only).
  The brief was self-contained, so this was not a blocker, but an auditor reconciling
  against `plan.md` will find no acceptance-criteria section to read.
- `apps/web/android/app/src/main/assets/public/assets/chat-error-BKLSWuB5.js` — a committed
  Capacitor build artifact — still contains the old prompt text verbatim, including
  "most scientific packages work". It is generated output regenerated by `cap sync`, not a
  source claim, and the founder owns mobile builds. Not edited.
- `docs/DOCUMENTS.md:269` summarizes the prompt as advertising "Python imports
  auto-install". Slightly overbroad (only pure-Python ones do) but it names no package and
  makes no availability claim, so it was left alone under surgical-changes.

## A concurrent agent committed this work mid-task

Between the last edit and the final verification, `HEAD` moved from `a10c9e9b` to
`53daba72` across three commits by another agent (`a whole lot`, `billing refactor` ×2).
All four of this task's edits were swept into `53daba72` by that agent's blanket stage —
`git status` for these paths is now empty, and the changes are verified present in the
working tree and in `HEAD`. No git write command was run from this task.

Consequence for the run: this task's diff is no longer separable from that agent's, and
the still-red `trial-eligibility.test.ts` was committed in its failing state.

## Confidence

**High** on the three named sites, the fourth pandas mention, and the hash pin: each was
verified by running the affected test, and the hash was read from failure output.

**High** on the attribution and the specified follow-up for `trial-eligibility.test.ts` —
every number was derived and cross-checked against two independent observed failure
values. The residual risk is not correctness but sequencing: the api suite stays red until
someone applies it.
