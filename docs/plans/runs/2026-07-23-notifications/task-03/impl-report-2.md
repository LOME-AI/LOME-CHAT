# Task 03 — In-house Web Push sender — impl report 2 (fix)

## Objective

Fix the ONE validated finding both crypto auditors independently confirmed: gitleaks
`generic-api-key` fires on the committed inert dev VAPID private key and auth secret in the
webpush TEST files (4 findings), which — once committed — fails the gitleaks CI job and gates
the entire CI DAG. Crypto is correct and unchanged; only `.gitleaks.toml` is touched.

## Root cause (reproduced)

`gitleaks detect --no-git` (8.24.3, repo `.gitleaks.toml`) over the webpush dir reproduced
**4 findings**, all rule `generic-api-key`, captured `Secret` values verbatim:

- `encrypt.test.ts:16` — `BTBZMqHH6r4Tts7J_aSIgg` (the `authSecret:` label)
- `send.test.ts:10` — `BTBZMqHH6r4Tts7J_aSIgg` (the `auth:` label)
- `vapid.test.ts:13` — `SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0` (the `privateKey:` label)
- `send.test.ts:17` — `SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0` (the `privateKey:` label)

Report-1 mis-verified this by scanning only `env.config.ts`/`wrangler.toml` (genuinely clean —
their `[Mode.X]: '…'` layout breaks the keyword-proximity heuristic) and never scanning the new
test files, whose `authSecret:`/`auth:`/`privateKey:` labels DO satisfy the heuristic.

The two committed values are genuinely inert: `BTBZMqHH6r4Tts7J_aSIgg` is the RFC 8291
Appendix A public UA auth-secret vector; `SQ6hnT9IQ-…` is a throwaway P-256 scalar generated
once for these tests. Allowlisting them is correct, not secret-hiding.

## Files changed

- `.gitleaks.toml` — appended **three** narrow `[[rules.allowlists]]` entries (one per webpush
  test file), each `condition = "AND"`, `paths` pinned to the exact file, `regexTarget =
  "secret"`, regexes anchored `^…$` to the exact captured secret value(s) in that file. No
  broad path exemption; `env.config.ts`'s (nonexistent) allowlist untouched; no other rule
  changed.

### Exact entries added (quoted)

```toml
# Inert Web Push crypto vectors in the notifications webpush tests. The auth
# secret is the RFC 8291 Appendix A public UA auth vector; the private key is a
# throwaway P-256 scalar generated once for these tests. The `authSecret:` /
# `auth:` / `privateKey:` labels trip generic-api-key's keyword heuristic. Each
# entry AND-pins its exact captured secret to its one file.
[[rules.allowlists]]
description = "Web Push encrypt.test.ts RFC 8291 auth-secret vector; AND-pins the exact secret to that file."
condition = "AND"
paths = ['''^apps/api/src/slices/notifications/adapters/webpush/encrypt\.test\.ts$''']
regexTarget = "secret"
regexes = [
  '''^BTBZMqHH6r4Tts7J_aSIgg$''',
]

[[rules.allowlists]]
description = "Web Push vapid.test.ts throwaway P-256 private key; AND-pins the exact secret to that file."
condition = "AND"
paths = ['''^apps/api/src/slices/notifications/adapters/webpush/vapid\.test\.ts$''']
regexTarget = "secret"
regexes = [
  '''^SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0$''',
]

[[rules.allowlists]]
description = "Web Push send.test.ts auth-secret vector + throwaway private key; AND-pins the exact secrets to that file."
condition = "AND"
paths = ['''^apps/api/src/slices/notifications/adapters/webpush/send\.test\.ts$''']
regexTarget = "secret"
regexes = [
  '''^BTBZMqHH6r4Tts7J_aSIgg$''',
  '''^SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0$''',
]
```

### Precedent block matched

The existing stream-handler / media-assets entries in the same file, verbatim shape:

```toml
[[rules.allowlists]]
description = "Stream-handler SSE test fixtures; AND-pins exact secrets file."
condition = "AND"
paths = ['''^apps/api/src/lib/stream-handler\.test\.ts$''']
regexTarget = "secret"
regexes = [
  '''^d3JhcHBlZC1i$''',
  ...
]
```

Same structure: rule-scoped `[[rules.allowlists]]` (top-level `[[allowlists]]` is silently
ignored under `[extend] useDefault = true`), `condition = "AND"`, exact escaped path,
`regexTarget = "secret"`, anchored per-secret regexes. My values contain no regex-special
chars (`-` is literal outside a char class; no `+`/`/`), so no escaping is needed.

## Self-gate (all after the last edit)

- gitleaks `detect --no-git` over the whole webpush dir (source + tests), 8.24.3, repo config —
  **pass**: `no leaks found`, exit 0, JSON report `[]`. Per-file scan of all 7 files
  (encrypt/vapid/send `.test.ts` + encrypt/vapid/send/index `.ts`) each reports `no leaks
  found`. (Before the fix: 4 leaks.)
- `npx eslint src/slices/notifications/adapters/webpush/` (from `apps/api`) — **pass**, exit 0.
- webpush vitest (`vitest run … webpush`) — **pass**, 3 files / 25 tests.
- typecheck — unaffected: the only edit is `.gitleaks.toml` (no TypeScript touched); report-1's
  passing `turbo typecheck` stands unchanged.

## Acceptance criterion (the one previously UNMET)

- "gitleaks must not fire … dev private key needs an allowlist entry pinned to its exact path
  following seed-crypto precedent" — **now met**. Three exact-path, exact-value AND-pinned
  entries added; gitleaks reports 0 findings over all owned files, verified by scanning the
  test files this time (the exact gap in report-1).

## Byte-unchanged confirmation

`git status --short` shows `.gitleaks.toml` as the only modified tracked file; the entire
webpush dir remains untracked (`??`) and was only Read, never edited, this task. `git diff
--stat -- .gitleaks.toml` = `1 file changed, 33 insertions(+)`. Webpush source and test LOGIC
is byte-identical to report-1; the 25/25 green run confirms behavior is unchanged.

## Deviations

None. Report-1's deviation #1 ("no gitleaks allowlist added") is now corrected — the empirical
premise there was wrong (it never scanned the test files that fire).

## Concerns and limitations

- `.gitleaks.toml` is a repo-root shared file; other concurrent workstreams may also append
  allowlist entries. My three entries are appended at the end and are self-contained
  (rule-scoped, exact-path AND exact-value), so they neither collide with nor broaden any
  other entry. If another workstream's edit conflicts on this file, a re-merge that preserves
  all three entries is trivial.

## Confidence

**High** — the 4 findings were reproduced with the exact captured secret values, the fix mirrors
the file's own established precedent byte-for-byte in shape, and a full re-scan (whole dir +
every file individually) shows 0 findings. The webpush crypto is untouched and still 25/25 green.
