# Task 14 — Arch registry: table ownership (impl report 1)

## Objective

Register `notificationPreferences` as owned by the `notifications` slice in the
`single-writer-per-table` arch rule's `TABLE_OWNER` map so `pnpm arch:check` exits 0.

## Files changed

- `packages/config/arch/rules/single-writer-per-table.rule.ts` — one added registry line
  declaring the notifications slice as the owner of the new table.

Exact diff (the complete change, verified via `git diff -- packages/config/arch/rules/single-writer-per-table.rule.ts`):

```diff
@@ -67,6 +67,7 @@ const TABLE_OWNER: Record<string, string | string[]> = {
    newsletterDeliveries: 'newsletter',
    adminAudit: 'admin',
    deviceTokens: 'notifications',
+  notificationPreferences: 'notifications',
    feedback: 'feedback',
    customInstructions: 'account',
    preferences: 'account',
```

Entry style sanity-check against neighbors: the map is `Record<string, string | string[]>`
keyed by the schema barrel's **camelCase export name** (not the SQL table name), value =
slice directory name, entries grouped by owning slice. The new line uses the camelCase
export `notificationPreferences`, the same `'notifications'` owner string as its
immediate neighbor `deviceTokens`, and sits inside that slice's group — identical style,
single-quoted, trailing comma.

## Tests added

None — this is a config-registry entry with no unit-testable surface. Per the brief, the
pass/fail signal is the repo command `pnpm arch:check`, whose completeness check
(`completenessViolations`, same file) is the enforcing assertion: every schema-barrel
table export must appear in `TABLE_OWNER`, and every `TABLE_OWNER` key must still exist
in the barrel. Red-before / green-after was observed against that command (below), which
is the red-green cycle for this change.

## Self-gate

### `pnpm arch:check` — BEFORE the edit — **fail** (exit code 1, 1 violation)

```
> hushbox@0.0.0 arch:check /workspace/popper-mobile/.superset/projects/HushBox
> tsx packages/config/arch/run.ts

arch:check: ARCHITECTURE RULE VIOLATIONS
workspace/popper-mobile/.superset/projects/HushBox/packages/db/src/schema/index.ts:56 [single-writer-per-table] table 'notificationPreferences' has no owning slice — add it to TABLE_OWNER
 ELIFECYCLE  Command failed with exit code 1.
```

Exactly one violation, and it is the expected one — the failure was observed for the
right reason (missing owner for the new table), not a typo or unrelated breakage.

### `pnpm arch:check` — AFTER the edit — **pass** (exit 0)

```
> hushbox@0.0.0 arch:check /workspace/popper-mobile/.superset/projects/HushBox
> tsx packages/config/arch/run.ts

arch:check: OK — 11 rule(s) over 1933 file(s)
```

Shell-captured `EXIT=0`. All 11 rules over 1933 files clean.

### `turbo typecheck lint --filter=@hushbox/config` — **pass**, run AFTER the last edit

Run with `--force --continue` to defeat warm-cache masking:

```
@hushbox/config:lint: > eslint .
@hushbox/config:typecheck: > tsgo --noEmit

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
```

The package's `lint` script is `eslint .` executed from `packages/config` (the package
dir), so this satisfies the run-from-package-dir lint requirement on the owned file; no
findings, no warnings, prettier-as-ESLint-rule clean.

## Acceptance criteria

1. **`notificationPreferences` mapped to the notifications slice, following the file's
   existing entry style exactly** — **met**. Diff above; one line, camelCase key matching
   the schema-barrel export, `'notifications'` value, placed in the notifications group
   next to `deviceTokens`.
2. **`pnpm arch:check` exits 0** — **met**. Verified by running it: `EXIT=0`,
   `arch:check: OK — 11 rule(s) over 1933 file(s)`.
3. **No other rule, table entry, or unrelated line touched; no weakening of the rule** —
   **met**. `git diff -- packages/config/arch/rules/single-writer-per-table.rule.ts` is
   exactly `1 insertion(+), 0 deletions(-)`. No exemption, allowlist, skip, or predicate
   change; the rule body, the `completenessViolations` check, `WRITE_METHODS`, `DML`, and
   every other table entry are byte-identical to HEAD. The rule enforces exactly as much
   as it did before, over one more registered table.
4. **Any OTHER unregistered table reported, not fixed** — **met, none found**. The
   before-run listed exactly one violation. No other table was missing an owner, and no
   stale-key violation appeared, so nothing to report under this criterion.

## Deviations

None.

## Concerns and limitations

- **Diff-scope note (not my change):** `git diff --stat -- packages/config` also shows
  `packages/config/eslint-extensions/README.md` (+14). I did not touch it. Attribution
  evidence: its mtime is `2026-07-24 15:04:59`, ~10 minutes before my first command in
  this session (`15:15`), and my only write was to the rule file (mtime `15:15:23`). It
  is pre-existing/concurrent work in the shared tree and was left untouched.
- The registered ownership is asserted correct by the plan's prior audit (notifications is
  the sole writer of `notification_preferences`); I did not re-derive it, per the brief.
  The arch rule itself will enforce it going forward — any other slice writing the table
  now fails `arch:check`, which is the point of registering rather than exempting.

## Confidence

**high** — single-line registry entry; the enforcing command was observed red for the
exact expected reason before and green (exit 0) after, and the scoped typecheck+lint ran
force-uncached after the final edit.
