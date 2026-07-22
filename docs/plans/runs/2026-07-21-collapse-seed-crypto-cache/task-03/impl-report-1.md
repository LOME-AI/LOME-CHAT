# impl-report-1 — task-03: fix gitleaks allowlist for collapsed seed-crypto cache

## Objective

Update `.gitleaks.toml` so the seed-crypto allowlist matches the new SINGLE file
`scripts/.cache/seed-crypto.json` (the cache was collapsed from a per-entry directory
into one file). The old regex `^scripts/\.cache/seed-crypto/.*\.json$` requires a `/`
and subpath after `seed-crypto`, so it does not match the single file — leaving its
313×4 high-entropy base64 fields to trip the default `generic-api-key` rule and fail
the `gitleaks` CI job (blocking every `needs: [gitleaks]` job).

## Files changed

- `.gitleaks.toml` — line 16 path regex re-anchored to the exact single file
  `^scripts/\.cache/seed-crypto\.json$`; lines 11-15 comment + description de-pluralized
  to match the single file. No other allowlist or the `[extend]`/`[[rules]]` header touched.

## Tests added

None. `.gitleaks.toml` is a scanner config, not code under test; verification is the ERE
match check plus the config diff (below). No project test harness covers this file.

## Self-gate

- `git status --short .gitleaks.toml` before edit — clean (file was unmodified; the
  `M`-listed churn in the session snapshot is the seed-crypto cache files themselves, not
  this config).
- node ERE match test — pass: `newfile: true olddirstyle-nomatch: false` (expected exactly this).
- `git diff --stat .gitleaks.toml` — pass: `1 file changed, 4 insertions(+), 4 deletions(-)`;
  only `.gitleaks.toml` changed.
- `gitleaks` binary — not installed (`command -v gitleaks` empty; noted, installed nothing
  per brief). Relied on the ERE test above.

### node regex-test output (verbatim)

```
newfile: true olddirstyle-nomatch: false
```

### git diff .gitleaks.toml (verbatim)

```diff
@@ -8,12 +8,12 @@ useDefault = true
 [[rules]]
 id = "generic-api-key"

-# Deterministic dev-only seed-crypto cache committed for fast CI seeding (see
-# .gitignore). Files hold OPAQUE/ECIES output for fixed dev personas + dev
+# Deterministic dev-only seed-crypto cache file committed for fast CI seeding
+# (see .gitignore). File holds OPAQUE/ECIES output for fixed dev personas + dev
 # password + dev OPAQUE_MASTER_SECRET — high entropy but not secret.
 [[rules.allowlists]]
-description = "Dev-only seed-crypto cache; whole files exempt by path."
-paths = ['''^scripts/\.cache/seed-crypto/.*\.json$''']
+description = "Dev-only seed-crypto cache; whole file exempt by path."
+paths = ['''^scripts/\.cache/seed-crypto\.json$''']
```

## Acceptance criteria

- Path regex matches the new single file, not the old dir style — met (node ERE test:
  `newfile: true`, `olddirstyle-nomatch: false`).
- Triple-quoted raw-string syntax preserved — met (`paths = ['''…''']` intact).
- Comment/description de-pluralized to singular, durable factual wording, no change-narration
  — met (see diff: "cache file committed", "File holds…", "whole file exempt by path").
- Only `.gitleaks.toml` changed; other two allowlists and the header untouched — met
  (diff limited to lines 11-16; `--stat` shows one file, 4/4).

## Deviations

None.

## Concerns and limitations

- `gitleaks` binary is not installed in this environment, so the end-to-end scanner pass
  was not executed locally. The fix's correctness rests on the ERE match test, which is the
  exact predicate gitleaks applies to the `paths` allowlist. Confirmed the target file
  `scripts/.cache/seed-crypto.json` exists (249 KB, present on disk). CI will run the real
  `gitleaks` binary against it.

## Confidence

High — the regex change is exactly the reported fix, the new path is confirmed on disk, and
the ERE predicate that gitleaks uses tests true for the new file and false for the old form.
