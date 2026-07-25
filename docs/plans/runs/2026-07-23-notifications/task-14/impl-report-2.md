# Task 14 — Arch registry: table ownership (impl report 2 — fix pass)

## Objective

Fix the validated Critical from the audit of impl-report-1: the registry entry added in
pass 1 (`notificationPreferences: 'notifications'`) was correct, but the rule's colocated
test hardcodes a `TABLE_NAMES` mirror of the registry keys used to build the default
synthetic schema barrel. Without the matching mirror entry, every default-barrel test also
received a stale-key violation, turning 16 of 17 tests in that file red and failing
`pnpm test:config` / CI's test gate.

Fix scope per the corrected brief: add `'notificationPreferences'` to `TABLE_NAMES` next
to `'deviceTokens'`. Registry entry kept as-is. No change to the rule, its assertions, the
stale-key check, or the structure of the mirror array.

## Files changed

- `packages/config/arch/rules/single-writer-per-table.rule.ts` — the pass-1 registry line
  (unchanged in this pass; carried forward).
- `packages/config/arch/rules/single-writer-per-table.rule.test.ts` — one added line in the
  `TABLE_NAMES` mirror so the default synthetic barrel contains the newly registered table.

The complete diff across both files (`git diff -- packages/config/arch/rules/`):

```diff
--- a/packages/config/arch/rules/single-writer-per-table.rule.test.ts
+++ b/packages/config/arch/rules/single-writer-per-table.rule.test.ts
@@ -34,6 +34,7 @@ const TABLE_NAMES = [
   'newsletterDeliveries',
   'adminAudit',
   'deviceTokens',
+  'notificationPreferences',
   'feedback',
   'customInstructions',
   'preferences',
--- a/packages/config/arch/rules/single-writer-per-table.rule.ts
+++ b/packages/config/arch/rules/single-writer-per-table.rule.ts
@@ -67,6 +67,7 @@ const TABLE_OWNER: Record<string, string | string[]> = {
   newsletterDeliveries: 'newsletter',
   adminAudit: 'admin',
   deviceTokens: 'notifications',
+  notificationPreferences: 'notifications',
   feedback: 'feedback',
   customInstructions: 'account',
   preferences: 'account',
```

**Diff-scope confirmation (requested evidence):** exactly two lines total, both additions,
one per file, nothing else. `git diff --numstat -- packages/config/`:

```
1	0	packages/config/arch/rules/single-writer-per-table.rule.test.ts
1	0	packages/config/arch/rules/single-writer-per-table.rule.ts
14	0	packages/config/eslint-extensions/README.md
```

The third entry is **not mine** — same pre-existing/concurrent change noted in report 1
(`packages/config/eslint-extensions/README.md`, +14, untouched by this task in either
pass). Inside `arch/`, the diff is exactly the two lines above.

Style note: the mirror entry is placed at the same ordinal position as the registry entry
(immediately after `'deviceTokens'`, before `'feedback'`), single-quoted with a trailing
comma, matching every surrounding element. The array's structure and the derived
`TABLE_NAMES`-based barrel construction are unchanged.

## Tests added

None. This pass repairs an existing test fixture rather than adding behavior — the enforcing
assertions are the file's own 17 tests plus the repo command `pnpm arch:check`. Red-before /
green-after was observed on `pnpm test:config` (below), which is the red-green cycle for
this change.

## Self-gate

### `pnpm test:config` — BEFORE the edit — **fail** (the audited regression, reproduced)

```
 Test Files  1 failed | 28 passed (29)
      Tests  16 failed | 332 passed (348)
 ELIFECYCLE  Test failed. See above for more details.
 ERROR  run failed: command  exited (1)
```

Failing file: `arch/rules/single-writer-per-table.rule.test.ts`; representative failure at
`:257` where `expect(rule.check(project)).toEqual([])` received the stale-key violation for
`notificationPreferences`. Counts match the audit finding exactly (`16 failed | 332
passed`), confirming the reported cause reproduces before the fix.

### `pnpm test:config` — AFTER the edit — **pass**, 0 failures

```
 Test Files  29 passed (29)
      Tests  348 passed (348)
 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
```

Shell-captured `EXIT=0`. All 16 previously-failing tests now pass; total test count is
unchanged at 348 (nothing skipped, removed, or weakened).

### `pnpm arch:check` — **pass** (exit 0), still

```
arch:check: OK — 11 rule(s) over 1933 file(s)
ARCH_EXIT=0
```

Same result as pass 1 — the registry entry still satisfies the completeness check.

### `turbo typecheck lint --filter=@hushbox/config` — **pass**, run AFTER the last edit

Run with `--force --continue` to defeat warm-cache masking:

```
@hushbox/config:lint: cache bypass, force executing 6cbb33ebf6ec9ffe
@hushbox/config:typecheck: cache bypass, force executing f173a683e54c5d33
@hushbox/config:typecheck: > tsgo --noEmit
@hushbox/config:lint: > eslint .

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
```

The package's `lint` script is `eslint .` executed from `packages/config`, satisfying the
run-from-package-dir requirement on both owned files. No findings, no warnings; prettier-as-
ESLint-rule clean (the added line is prettier-conformant).

## Acceptance criteria

1. **`notificationPreferences` mapped to the notifications slice, following the file's
   existing entry style exactly** — **met**. Registry line unchanged from pass 1 (verified
   correct by the audit); style matches its `deviceTokens` neighbor.
2. **`pnpm arch:check` exits 0** — **met**. `ARCH_EXIT=0`, `OK — 11 rule(s) over 1933
   file(s)`.
3. **No other rule, table entry, or unrelated line touched; no weakening of the rule
   itself** — **met**. Two insertions, zero deletions, zero modifications across both
   files. The rule body, `completenessViolations`, the stale-key check, `WRITE_METHODS`,
   `DML`, every test assertion, and every other `TABLE_OWNER`/`TABLE_NAMES` entry are
   byte-identical to HEAD. No exemption, allowlist, skip, or `expect` relaxation was added;
   the rule and its suite enforce exactly as much as before, over one more registered table.
4. **Any OTHER unregistered table reported, not fixed** — **met, none found**. `arch:check`
   is fully green with no other violations, and the config suite has no other failures.

## Deviations

None.

## Concerns and limitations

- **The mirror array is a duplication of the registry keys.** `TABLE_NAMES` in the test file
  must stay set-identical to `TABLE_OWNER`'s keys or the whole suite goes red — exactly the
  failure this pass repaired, and a `keep in sync` coupling of the kind CODE-RULES §One
  Implementation, Shared calls a smell. Per the brief this is an open design question for
  the human and was deliberately left alone; I neither restructured it nor added a comment
  about it. Flagging so it is not lost: any future table addition hits the same trap.
- `packages/config/eslint-extensions/README.md` (+14) remains modified in the shared tree by
  concurrent work; untouched by this task, left as found.

## Confidence

**high** — two-line change; the audited failure was reproduced verbatim before the fix
(16 failed | 332 passed), the full config suite is green after (348/348), and `arch:check`
plus a force-uncached scoped typecheck+lint were run after the final edit.
