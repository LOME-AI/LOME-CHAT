# impl-report-1 — correct stale information about `apps/crawler-view`

## Objective

Find and correct any surviving text (comment, doc line, test name, anything) stating or
implying that `apps/crawler-view` is verified or guarded by the bundle guard. No logic
change: map entry kept, no build script added, no behaviour or assertion changed.

## Search performed (how "one location" was established)

1. `git ls-files | xargs grep -ln 'crawler-view\|crawlerView\|CrawlerView'` (node_modules
   and `docs/plans/runs/**` excluded) → 20 tracked files.
2. Every one of those 20 grepped for `tts|verify|guard|bundle|build`. Only two relate to
   the bundle guard: `scripts/verify-bundle.ts` (the map entry) and
   `scripts/verify-bundle.test.ts` (the test below). The rest are the dev-only crawler-eye
   badge, its env var, its knip project entry, its worktree port, and an archived audit doc
   (`docs/plans/CODEBASE-AUDIT-2026-07-18.md`, whose crawler-view lines concern the
   test-coverage gate, not the bundle guard).
3. Reverse direction: `grep -rn 'verify:bundle\|verify-bundle'` over all tracked files →
   the guard's callers (`apps/admin/vite.config.ts`, `apps/sandbox/src/build.ts`,
   `scripts/build-web-bundle.ts`, three workflow files, `package.json`,
   `scripts/lib/build-seam.ts`). None of them mentions crawler-view.
4. `docs/DEVELOPMENT.md` (owned by a concurrent task) contains no occurrence of either
   `crawler` or `bundle` in its working-tree state — nothing to report there.
5. `scripts/verify-bundle.ts` header comment (lines 1–27), the `APPS_SHIPPING_TTS` doc
   comment (41–45), and the map lines themselves (46–53) carry no crawler-view claim; the
   comment deleted earlier in this run is confirmed absent. The `appBundleOptions` throw
   message (line 74, "an app whose bundle is verified must declare …") is a conditional
   statement about any app, names no app, and is an asserted string — left untouched.

Ground truth for the underlying fact: `apps/crawler-view/package.json:6-12` declares
`dev`, `lint`, `typecheck`, `test`, `test:watch` — no `build`.

## Locations found and disposition

| Location | Claim | Disposition |
| --- | --- | --- |
| `scripts/verify-bundle.test.ts:478` (test name) | Named "the crawler-view bundle", presupposing a built bundle the guard checks, plus a forward-looking "yet" clause | Renamed (below) |
| `scripts/verify-bundle.ts:50` (map entry) | none | Unchanged, per scope |

No second restatement exists anywhere in tracked, non-run-directory files.

## Files changed

- `scripts/verify-bundle.test.ts` — one test name corrected; nothing else in the file
  touched.

Old:

```
it('expects no TTS in the crawler-view bundle, which has no build script yet', () => {
```

New (`scripts/verify-bundle.test.ts:478`):

```
it('declares no TTS for crawler-view', () => {
```

The assertion on the next line (`expect(appBundleOptions('/repo', 'apps/crawler-view').shipsTts).toBe(false)`)
is byte-identical and untouched. The new name states exactly what the assertion checks —
the map declaration — and a reader verifies it in seconds against
`APPS_SHIPPING_TTS` in `scripts/verify-bundle.ts:46-53`. The bundle presupposition and the
"yet" clause were deleted rather than rewritten into a longer, more careful sentence, per
the deletion-over-rewriting instruction.

## Tests added

None. This is a stale-text correction with no behaviour change; the acceptance criteria
forbid changing behaviour or assertions, so there is no new behaviour to drive a test. The
existing test's assertion and count are preserved (41 before, 41 after).

## Self-gate

| Command (cwd) | Result |
| --- | --- |
| `pnpm test:watch scripts/verify-bundle.test.ts` (repo root) — baseline, before edit | pass — 1 file, 41 tests |
| `pnpm test:watch scripts/verify-bundle.test.ts` (repo root) — after edit | pass — 1 file, 41 tests |
| `npx eslint verify-bundle.test.ts` (`scripts/`, after the last edit) | pass — exit 0, no output |
| `npx tsgo --noEmit` (`scripts/`) | pass — exit 0 |

No failures to attribute. The known-broken areas named in the brief (`apps/api`,
`packages/shared/src/affordability/**`, the two stale-cache `scripts/` test files, the two
foreign unused-code findings) were not touched and were not in the scoped runs above.

## Acceptance criteria

- **Correct any surviving text stating or implying `apps/crawler-view` is verified** — met.
  The whole-repo search above found exactly one such text; it is corrected. Evidence:
  search steps 1–5 and the diff below.
- **No logic change; map entry kept; no build script added; no declaration removed** — met.
  `git diff --stat` shows `scripts/verify-bundle.test.ts | 2 +-` as the only file this task
  changed; `scripts/verify-bundle.ts` and `apps/crawler-view/package.json` are unmodified in
  the working tree (`git status --porcelain scripts/` reports only the foreign
  `scripts/.cache/seed-crypto.json`).
- **State it if short and checkable, otherwise delete** — met. The replacement is a
  five-word statement of what the assertion checks, verifiable against one map literal.

Full diff of this task's change:

```
-  it('expects no TTS in the crawler-view bundle, which has no build script yet', () => {
+  it('declares no TTS for crawler-view', () => {
```

## Explicit confirmations required by the brief

- **No new claim about coverage, contents, or future behaviour was added.** The replacement
  text contains no statement about what any bundle contains, what the guard covers, what
  imports what, or what will happen if the app gains a build script. No comment was added
  anywhere; no rationale for the map entry was written.
- **The map entry is unchanged**, byte-identical at `scripts/verify-bundle.ts:50`.
- **All behaviour is unchanged** — no production file was edited at all.
- **All test assertions are unchanged**; only one `it(...)` description string differs, and
  the test count is identical before and after.
- No task IDs, plan-section labels, or run references appear in the changed line.

## Deviations

None.

## Concerns and limitations

- The underlying gap is untouched by design: `apps/crawler-view` is still declared in
  `APPS_SHIPPING_TTS` while no build of it invokes the guard. The founder ruled this a
  stale-information correction only; nothing here narrows or documents that gap.
- The new test name deliberately departs from its siblings' "expects no TTS in the X
  bundle" phrasing, because that phrasing is precisely the presupposition being removed for
  this app. An auditor comparing the four sibling names will see the asymmetry; it is
  intentional.

## Confidence

High — the search was exhaustive over tracked files in both directions (by app name and by
guard name), the change is a single description string, and both the scoped test run and the
scoped lint/typecheck are green after the final edit.
