# G8 — Fix the standing `template-html` failure — impl report 1

## Objective

Fix the 7 standing snapshot failures in
`apps/api/src/slices/notifications/domain/templates/template-html.test.ts` **at their cause**,
so that `pnpm test:api` reaches its coverage report again and the per-file coverage gate becomes
a usable signal for the rest of the run.

---

## What the assertion is actually protecting

`template-html.test.ts` is **not** a font test. It is a characterization suite that pins the
**entire rendered HTML** of 7 transactional email templates byte-for-byte, one
`toMatchSnapshot()` per template:

welcome · password-changed · two-factor-enabled · two-factor-disabled ·
account-locked (login lockout) · account-deleted · chargeback-lock

The reason the pin is whole-document rather than targeted: every one of those templates renders
through a single shared wrapper. `builder.ts:76` — `defineEmailTemplate` returns
`html: wrapInBaseTemplate(replacePlaceholders(config.html, values, true))` — so **one edit to
`base.ts` changes every template at once**. The snapshots are the only place in the repo where
that blast radius is visible; nothing else asserts on the base wrapper's markup.

The Google-Fonts `<link>` is simply one line inside those pinned bytes. It was never the subject
of an assertion; it was collateral.

## Which drifted: the code, and it drifted deliberately and correctly

**The code changed; the snapshot was never re-recorded.** Evidence, in the order that decided it:

1. **Both files are clean in git.** `git status --porcelain -- apps/api/src/slices/notifications/`
   returned empty at task start. So this is committed state, not another agent's uncommitted work.
2. **The source edit is a single committed line-deletion.** `git show a0a0f4c6 -- …/base.ts`:

   ```diff
   -  <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">
   ```

   That is the file's *entire* diff in that commit — one line removed, nothing added.
3. **Ordering proves the snapshot is the stale side.** `base.ts` was last touched in `a0a0f4c6`;
   the `.snap` was last touched in `2ab91d7a`, which is **earlier** in `git log`. The snapshot
   therefore predates the source change and could not have been re-recorded against it.
4. **The removal was isolated and intentional, not incidental churn.** `a0a0f4c6` changed 98 files;
   filtering its stat for font/template/email paths yields exactly one file — `base.ts`. It is a
   deliberate one-line edit, not a stray hunk in a refactor.

**And the removal is the correct state, so the code must not be reverted:**

- **Merriweather is self-hosted repo-wide.** `packages/ui/src/styles/fonts.css` declares it from
  local `./fonts/merriweather-latin.woff2` / `-latin-ext.woff2` at weights 300/400/700. The product
  does not use Google's font CDN anywhere.
- **After this fix, `fonts.googleapis` appears in zero tracked files.** A repo-wide `grep -ra`
  (with `-a`, per §Known Breakage) over `apps packages e2e scripts` found it in exactly one tracked
  file before this change — the stale snapshot itself — plus one untracked `.turbo` log. The email
  template was the last holdout of a policy the rest of the repo already followed.
- **Nothing breaks visually.** The header keeps its inline fallback chain
  `font-family: 'Merriweather', Georgia, serif;` (`base.ts:27`), so the rendered header degrades to
  Georgia rather than to a default sans. Email clients strip `<style>` blocks and many strip
  `<link rel="stylesheet">` outright, so the removed line was never reliably doing anything.
- **Keeping it would be the defect.** A remote stylesheet in an email is fetched by the
  *recipient's* client at open time, leaking their IP and an open-signal to a third party — against
  the product's stated privacy position.

**Conclusion: the test data drifted, not the behaviour.** The fix is to re-record the pins against
the current, correct source — which is not "snapshot-updating past a defect", because the delta is
exactly the one intended source change and provably nothing else (see verification below).

## A second, quieter defect in the same file: 9 obsolete snapshots

The committed `.snap` held **16** keys for **7** assertions. Mapping each key to the `<h1>` it
renders exposed what the extras were:

| key | renders |
| --- | --- |
| `chargeback-lock 2` … `7` | Password Changed, 2FA Enabled, 2FA Disabled, Account Temporarily Locked, Account Permanently Deleted, Account Locked |
| `two-factor-disabled 2` … `4` | Password Changed, 2FA Enabled, 2FA Disabled |

These are duplicate passes over the suite's own templates, recorded under the wrong key because the
per-name snapshot counter ran ahead of the test name. They are unreachable: each test calls
`toMatchSnapshot()` exactly once, so only `<name> 1` is ever requested. Vitest reported them as
`9 obsolete` on every run. **No content is lost by removing them** — every distinct template body
they contained is already pinned under its own live key.

---

## Files changed

| path | why |
| --- | --- |
| `apps/api/src/slices/notifications/domain/templates/__snapshots__/template-html.test.ts.snap` | Re-recorded against current source: 7 live pins each lose the removed Google-Fonts `<link>`; the 9 unreachable obsolete keys are purged. |
| `apps/api/src/slices/notifications/domain/templates/template-html.test.ts` | Header comment and `describe` name asserted the snapshots were captured from *pre-refactor* markup — re-recording makes that false. Rewritten to state what the file guarantees instead. |

No production code changed. No other file in the repo was touched.

### The comment/name change, and why it is not scope creep

The old header read: *"The snapshots are captured from the pre-refactor markup, so the refactor is
proven byte-identical"*, under `describe('template html is byte-stable across the builder-helper
refactor')`. Both are claims about the snapshots' **provenance**, and re-recording is precisely what
falsifies them — my own edit created the wrong comment. Per CODE-RULES (a wrong comment is worse
than none; a wrong or transitional name is treated the same way) fixing both is repair of my own
change, not adjacent cleanup. Following the run's own rule against replacing an overstatement with a
smaller one, the replacement drops the unverifiable historical quantity entirely and states only
what the code guarantees — that every template routes through the shared wrapper, so a change there
lands here:

```ts
// Byte-level pins on the rendered HTML of the templates below. Each of them
// renders through the shared base wrapper, so an edit there reaches every
// template at once; these snapshots are where that lands instead of in a
// delivered email. Re-record only against a source change you can point at.
describe('email template html is byte-stable', () => {
```

The wrapper claim is bounded by the code and self-pinning: if a template stopped routing through
`wrapInBaseTemplate`, its snapshot changes and this file goes red.

## Tests added

None, and deliberately none.

The 7 existing assertions are unchanged — same templates, same inputs, same whole-document pins.
Nothing was loosened, narrowed or deleted; the only deletions are the 9 keys no assertion can reach.

A `expect(html).not.toContain('fonts.googleapis.com')` pin was considered and **rejected**: it is a
negative assertion, and §Known Breakage records that a negative assertion is satisfied by the named
thing ceasing to exist, so it would be vacuous by construction here. The whole-document snapshot
already pins the same fact positively and with a far wider reach.

---

## Verification that the re-record changed only what it should

The point of contention is whether re-recording quietly absorbed something other than the font line.
Three independent checks say it did not.

**1. The failing run's diffs, mechanically counted** (`g8-red.log`, 7 failures):

```
hunk headers matching "@@ -3,11 +3,10 @@":  7
total hunk headers:                          7
removed lines (excluding the "- Expected" banner):
      7 -   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">
added lines (excluding the "+ Received" banner):
      (none)
```

Every failure is the same single-line hunk at the same offset. **Zero added lines** across all 7.

**2. Whole-file diff of the re-record — pure deletion.** `diff snap-before snap-after` →
**607 removed lines, 0 added lines**. Of the removals: 16 `<link>` lines (7 from surviving pins +
9 carried inside the obsolete blocks) and 9 complete `"<!DOCTYPE html>` … blocks. Nothing was
inserted or altered anywhere in the file.

**3. Per-template body diff, the decisive one.** Both files were split into per-key bodies and
diffed pairwise:

```
account-deleted                1  <   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">
account-locked (login lockout) 1  <   <link href="…">
chargeback-lock                1  <   <link href="…">
password-changed               1  <   <link href="…">
two-factor-disabled            1  <   <link href="…">
two-factor-enabled             1  <   <link href="…">
welcome                        1  <   <link href="…">
```

Each of the 7 pinned documents differs by **exactly one line**, and it is the same line in all 7.

**4. The `describe` rename moved keys only.** The rename was staged separately so it could be
isolated. `diff` between the pre-rename and post-rename snapshot, with the 7 `exports[…]` key lines
filtered out, is **empty** — the markup bodies are byte-identical across the rename.

Resulting file: 7 keys, 0 obsolete, 0 `googleapis` occurrences, well-formed terminator.

---

## Self-gate

| command | result |
| --- | --- |
| `vitest run …/template-html.test.ts` (before fix) | **fail** — Test Files 1 failed; Tests 7 failed; Snapshots 7 failed, 9 obsolete |
| `vitest run …/template-html.test.ts` (after fix) | **pass** — Test Files 1 passed (1); Tests 7 passed (7); 0 obsolete |
| `npx eslint …/template-html.test.ts` from `apps/api` | **pass** — `ESLINT_EXIT=0`, no output. Run after the final edit; status captured on the command itself, not through a pipe. |
| `pnpm test:api` (run 3, the gating one) | **coverage table printed** — Test Files 474 passed \| 1 skipped (475); zero `FAIL` lines. Exit 1 comes *only* from the per-file coverage gate (see below). |

### Verbatim before

```
 FAIL  |api| src/slices/notifications/domain/templates/template-html.test.ts > template html is byte-stable across the builder-helper refactor > welcome
Error: Snapshot `… > welcome 1` mismatched

- Expected
+ Received

@@ -3,11 +3,10 @@
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <title>HushBox</title>
-   <link href="https://fonts.googleapis.com/css2?family=Merriweather:wght@700&display=swap" rel="stylesheet">
  </head>
…
 Snapshots  7 failed
            9 obsolete
 Test Files  1 failed (1)
      Tests  7 failed (7)
```

### Verbatim after

```
 RUN  v4.1.8 /workspace/popper-mobile/.superset/projects/HushBox/apps/api

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  13:10:36
   Duration  646ms
```

(No `obsolete` line — the 9 dead keys are gone.)

---

## The coverage gate is restored — and it immediately found something

This is the criterion the task exists for, so it is reported as an observation, not an assumption.

`pnpm test:api`, third run, tail:

```
 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   99.54 |    98.55 |    99.6 |    99.8 |
…
 src/platform/dev  |   99.62 |     97.8 |     100 |   99.79 |
  routes.ts        |     100 |    94.11 |     100 |     100 | 339,751
…
-------------------|---------|----------|---------|---------|-------------------
ERROR: Coverage for branches (94.11%) does not meet global threshold (95%) for src/platform/dev/routes.ts
ERROR: Coverage for branches (94.11%) does not meet "src/platform/**/*.ts" threshold (95%) for src/platform/dev/routes.ts
```

`Coverage enabled with v8` appears at the head of every run, including the red ones — coverage was
always *configured*; the red suite simply never reached the reporter. With the suite green the table
prints in full, per-file, and the threshold check fires.

**The gate's first act was to catch a live shortfall that had been invisible for the whole run:**
`src/platform/dev/routes.ts` at **94.11% branch** (uncovered 339, 751) against a 95% floor. That file
is unmodified in the tree, but its integration test — `platform/dev/routes.integration.test.ts` — is
modified by a concurrent workstream. **Not mine, not attributable from here, and raised rather than
touched.** It is exactly the class of defect the run has been unable to see; it is now visible.

### Three `pnpm test:api` runs, and why it took three

I am the only agent authorised to run this gate, so all three are mine and none raced another.

| run | result | cause |
| --- | --- | --- |
| 1 (13:14) | 4 files failed | 2 collection failures on `deps_ssr/@hushbox_crypto.js` and `@hushbox_shared.js` (the documented stale-pre-bundle class) + 4 tests in `chat/domain/smart-model-turn.test.ts` and 1 in `chat/routes.integration.test.ts` — **C5's declared territory, edited mid-run** (mtimes 13:16:43–13:20:46, i.e. *during* the 13:14:57→13:17:50 run). |
| 2 (13:22) | 2 files failed | Cleared `apps/api/node_modules/.vite` first, per §Known Breakage. C5's tests now green. Remaining: 2 **collection** failures on `deps_ssr/@hushbox_db.js` — the pre-bundle re-invalidated mid-run by concurrent `packages/db` edits (F8's territory). **Zero test failures: 6515 passed, 0 failed.** |
| 3 (13:29) | **474 passed \| 1 skipped, zero `FAIL` lines; coverage table printed** | A window with no concurrent workspace-package edit landing mid-run. |

`template-html.test.ts` does not appear in any failure list of any of the three runs.

Worth recording for whoever gates next: the pre-bundle staleness is a **race with concurrent
workstreams**, not a fixed condition. Any `packages/{db,shared,crypto}` write during the ~5–8 minute
run can re-trigger vite optimization and blow up unrelated files at *collection*. The remedy is the
documented one — `rm -rf apps/api/node_modules/.vite`, re-run — plus the patience to retry for a
quiet window. It took two retries here.

Also recorded because it nearly misled me: the background-task harness reported
**"completed (exit code 0)"** for a `pnpm test:api` run whose real status was `TESTAPI_EXIT=1`. That
is the wrapper trap Global Constraint 9 and §Known Breakage both document, one level further out. I
read the status only from the `echo "TESTAPI_EXIT=$?"` appended to the command itself.

---

## Acceptance criteria

| criterion | status | evidence |
| --- | --- | --- |
| Failing assertion fixed at the **cause**, not by loosening the assertion or deleting the case | **met** | The cause is a stale recorded expectation left behind by an intentional, correct source deletion (`a0a0f4c6`), established by four independent lines of evidence. All 7 assertions survive unchanged and still pin whole documents; the only deletions are 9 unreachable obsolete keys. Per-template diffs prove the recorded delta is exactly the intended source change and nothing else. |
| `pnpm test:api` produces a coverage table again | **met** | Full table reproduced above from run 3, read out of the log rather than inferred. `All files 99.54 / 98.55 / 99.6 / 99.8`. |
| Per-file gate re-established as a usable signal for the rest of the run | **met** | The threshold check now fires and named a real shortfall on its first green run (`src/platform/dev/routes.ts`, 94.11% branch). A gate that can fail is the deliverable; this one failed on something true and not mine. |

## Deviations

- **Rewrote the suite's header comment and `describe` name.** Not named in the criteria. Justified
  as repair of a claim my own re-record falsified, not as cleanup — reasoning above. The rename
  rewrites the 7 snapshot keys, which is why it was staged and diffed separately to prove no markup
  moved with it.
- **Deleted 9 obsolete snapshot keys.** Obsolete snapshots do not fail a run, so this was not
  strictly required to turn the suite green. Left in place they are dead bytes that make the file's
  key set disagree with its assertion set — the same class of stale recorded state as the failure
  itself. Removal is proven lossless.
- **Ran `rm -rf apps/api/node_modules/.vite`.** Build cache only, no source, and the remedy
  §Known Breakage prescribes for exactly the collection failure observed. It regenerates on the next
  run.
- **`vitest run -u <path>` does not honour the path filter** in vitest 4.1.8 — `-u` swallows the
  following argument, so both update runs executed the **entire** `apps/api` suite. Checked
  immediately for collateral snapshot writes: `git status` shows exactly one modified `.snap`
  repo-wide, mine. Recorded because the next agent to re-record a snapshot in this repo will hit it.

## Concerns and limitations

- **The run-3 green is a single observation, and §Known Breakage is explicit that no single green
  `apps/api` sweep proves the suite healthy.** It is sufficient for what is claimed here — that the
  coverage table prints and `template-html` is not among the failures — and it should not be cited
  as evidence that any other file is clean.
- **`src/platform/dev/routes.ts` at 94.11% branch will fail `pnpm test:api` for anyone who runs it
  next.** Restoring the gate means the exit code is now 1 for a *coverage* reason rather than a
  *test* reason. Whoever reads the next run must not mistake it for a regression from this task.
- **Several `notifications/ports/*.ts` files report 0/0/0/0** (`device-token-store.ts`,
  `membership-reader.ts`, `push-sender.ts`) and do not trip the threshold. Untouched, unexamined,
  noted only so the next reader of the table is not surprised by them.
- Whether the founder's font-link removal was itself reviewed is outside what I can determine. What
  I can determine — that it is isolated, deliberate, consistent with the repo's self-hosted-font
  policy, and leaves the fallback chain intact — is documented above. If it were ever to be
  reverted, this snapshot is now the thing that would catch it.

## Confidence

**High.** The drift direction is established from committed history rather than inference; the
re-record's delta is proven to be exactly one line per template by three independent methods
including a pure-deletion whole-file diff; the suite is green in isolation and under full load; and
the coverage table — the actual point of the task — was read out of a real run's output rather than
assumed. The one residue is environmental: the pre-bundle race that cost two retries is a property
of concurrent workstreams, not of this change.
