# B10 (fix round 2) — correct the three comments about unresolvable-entry behavior

## Objective

Three comments stated a verified-false fact about what happens when the
`optimizeDeps.include` entry cannot resolve. Correct them to the reproduced ground
truth: both apps emit a **named warning** and **both dev servers still start**; the
entry's dependable guarantee is the **structural** forced nested prebundle. Comment
text only — no code, no config value may change.

## Files changed

- `scripts/lib/ort-assets-plugin.ts` — the authoritative mechanism comment on
  `KOKORO_ORT_COMMON_INCLUDE`: replaced the false Astro-warns/Vite-drops-silently
  asymmetry with the symmetric warning behavior, and named the structural guarantee
  explicitly. Mechanism half (phantom dep, hoist-dir-only resolution, silent
  externalization, sticky cache, dev-only) left untouched.
- `apps/web/vite.config.ts` — call-site comment: dropped "Fails the dev server at
  start"; states the forced nested prebundle plus the stderr warning that does not
  abort.
- `apps/marketing/astro.config.mjs` — same correction, worded for Astro's `[WARN]`.

No other file edited.

## Comment 1 — `scripts/lib/ort-assets-plugin.ts`

Before (verbatim, the corrected tail of the doc comment):

```
 * `instanceof Tensor` keeps working across the boundary. When the chain does
 * break, the Astro dev server names the failing entry at start ("Failed to
 * resolve dependency: … present in client 'optimizeDeps.include'"); the Vite
 * dev server drops it without a message, so the entry is a guard there only in
 * the structural sense.
```

After (verbatim):

```
 * `instanceof Tensor` keeps working across the boundary. That forced nested
 * prebundle is the entry's dependable guarantee; it is structural, not
 * fail-fast. A broken chain is only a warning on both apps — the failing entry
 * is named ("Failed to resolve dependency: … present in client
 * 'optimizeDeps.include'"), on stderr under plain Vite and as a `[WARN]` under
 * Astro — and the dev server still starts either way.
```

## Comment 2 — `apps/web/vite.config.ts`

Before (verbatim):

```
      // Fails the dev server at start if kokoro-js's undeclared
      // `onnxruntime-common` import cannot be resolved, instead of letting the
      // optimizer externalize it silently and cache that (see the constant).
```

After (verbatim):

```
      // Forces a nested prebundle for kokoro-js's undeclared
      // `onnxruntime-common` import, so ORT lands in one shared chunk instead of
      // being externalized silently and cached broken (see the constant). If the
      // entry stops resolving, Vite names it in a stderr warning and the dev
      // server still starts — the guarantee here is structural, not fail-fast.
```

## Comment 3 — `apps/marketing/astro.config.mjs`

Before (verbatim):

```
      // Fails the dev server at start if kokoro-js's undeclared
      // `onnxruntime-common` import cannot be resolved, instead of letting the
      // optimizer externalize it silently and cache that (see the constant).
```

After (verbatim):

```
      // Forces a nested prebundle for kokoro-js's undeclared
      // `onnxruntime-common` import, so ORT lands in one shared chunk instead of
      // being externalized silently and cached broken (see the constant). If the
      // entry stops resolving, Astro logs it as a `[WARN]` and the dev server
      // still starts — the guarantee here is structural, not fail-fast.
```

## Proof the diff is comment-only

Two independent proofs, both zero.

**(a) Reconstruction diff.** A script inverse-substituted each new comment block
back to its previous text (each substitution is a single exact occurrence — the
edit tool rejects non-unique matches), then diffed the reconstruction against the
current file. Every `+`/`-` line in all three diffs begins with `//` or ` *`:

```
scripts/lib/ort-assets-plugin.ts: non-comment changed lines = 0
apps/web/vite.config.ts:          non-comment changed lines = 0
apps/marketing/astro.config.mjs:  non-comment changed lines = 0
TOTAL non-comment changed lines: 0
```

**(b) `git diff HEAD` — stronger, and independent of my reconstruction.** The repo
was committed by another actor between the previous round and this one (`HEAD` moved
from `a10c9e9b` → `39a07db0`, and `39a07db0` already carries the import at
`apps/web/vite.config.ts:12` and `include: KOKORO_ORT_COMMON_INCLUDE` at `:261`).
So `HEAD` is now the exact pre-edit baseline for this round, and the whole
worktree diff for these three files is my comment edits and nothing else:

```
 apps/marketing/astro.config.mjs  |  8 +++++---
 apps/web/vite.config.ts          |  8 +++++---
 scripts/lib/ort-assets-plugin.ts | 11 ++++++-----
 3 files changed, 16 insertions(+), 11 deletions(-)
```

Filtering that diff to lines not starting with `//`, `*`, or `/*` returns **no
output** — the constant's value, both `include:` lines, and every import are
byte-identical to `HEAD`.

## Self-gate

| command | result |
|---|---|
| `turbo typecheck lint --filter=@hushbox/web --filter=@hushbox/marketing --filter=@hushbox/scripts --force --continue` | **pass** — 6 successful, 6 total, 0 cached |
| `eslint lib/ort-assets-plugin.ts` (from `scripts/`, after last edit) | **pass** — exit 0, no output |
| `eslint astro.config.mjs` (from `apps/marketing/`, after last edit) | **pass** — exit 0, no output |
| `eslint vite.config.ts` (from `apps/web/`, after last edit) | **exit 0** — but the file matches the package's eslint ignore pattern, so it is not linted (see below) |
| `prettier --check` on all three files (repo root) | **pass** — "All matched files use Prettier code style!" |
| `vitest run lib/ort-assets-plugin.test.ts verify-web-bundle.test.ts` (from `scripts/`) | **pass** — 2 files, 33 tests |

`apps/web/vite.config.ts` is eslint-ignored (`File ignored because of a matching
ignore pattern`), so the lint gate does not cover it and the usual
prettier-as-an-eslint-rule coverage does not apply there. That is why the explicit
`prettier --check` above is the formatting proof for that file; it passes. This is
pre-existing repo configuration, not something this change introduced.

Ambient warnings during the marketing typecheck, all pre-existing and unrelated:
the `optimizeDeps.rollupOptions` deprecation notice (raised by
`@vitejs/plugin-react`, not by this config), the `plugin-react-oxc` recommendation,
and the rolldown `Invalid key: … "jsx"` input-option warning. Not fixed, not mine.

## Acceptance criteria

- **Comment 1 corrected** — met. The invented Astro-vs-Vite asymmetry is gone; the
  symmetric named-warning behavior and the non-aborting server are stated, and the
  structural guarantee is now the sentence the reader lands on.
- **Comment 2 corrected** — met. "Fails the dev server at start" removed.
- **Comment 3 corrected** — met. Same, worded for Astro's `[WARN]` rather than
  pasted from the web site.
- **Mechanism half preserved** — met. The paragraphs on the phantom dependency,
  hoist-dir-only resolution, silent externalization, the sticky cache key, the
  poisoning window, and the dev-only scope are byte-identical to `HEAD`; only the
  final sentence of that paragraph changed.
- **No code or config value changed** — met, by both proofs above.
- **No run/plan identifiers, no correction narration** — met. The comments state
  durable facts in the present tense; nothing references this run, a task, a plan,
  or anything under `docs/plans/runs/`. No "updated"/"corrected"/"was previously"
  wording.

## Deviations

None.

## Concerns and limitations

1. Per the brief, the dev-server behavior, dist hashes, and the shared-chunk
   property were not re-verified this round — the audit confirmed all three
   independently, and this change cannot move them (comment-only).
2. `apps/web/vite.config.ts` sitting outside the eslint gate means comment quality
   and formatting in that file rest on prettier alone. Pre-existing; flagged, not
   changed.

## Confidence

**High.** The change is three comment blocks; the comment-only property is proven
twice, once against `HEAD` itself; every scoped check is green; and the corrected
wording restates the auditor's reproduced behavior without adding any claim I did
not receive as verified.
