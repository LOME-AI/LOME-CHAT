# G12 — Source files stop being invisible to the repo's own grep

## Objective

Two source files carried a raw NUL byte, which makes `ugrep` (the repo's `grep`) classify them as
binary and skip them with no match, no warning and exit 0. Express the same character as an escape
so the files are text to every tool, with behaviour provably identical, and add a check that fails
if a tracked source file gains a raw NUL again.

## Files changed

| Path                                                          | Why                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web/src/hooks/billing/use-turn-options.ts`              | The `useMemo`-key `join` separator re-spelled `'\u0000'` — same character, now plain text.       |
| `apps/web/src/lib/conversation-socket-registry.ts`            | `TRIAL_KEY_PREFIX` re-spelled `'trial\u0000'` — same character, now plain text.                  |
| `packages/config/eslint-extensions/rules/no-raw-nul.mjs`      | New vendored ESLint rule: raw NUL anywhere in source text is an error.                          |
| `packages/config/eslint-extensions/no-raw-nul.config.mjs`     | New topic file wiring the rule repo-wide through the existing extension slot.                   |
| `packages/config/eslint-extensions/rules/no-raw-nul.test.mjs` | New colocated rule suite.                                                                       |

## Byte-level evidence (offsets and counts, not a rendered view)

Measured with `python3` reading raw bytes. Both files carried exactly one NUL.

**Before**

| File                                | Size  | NUL count | NUL offset | Line | sha256 (prefix)  |
| ----------------------------------- | ----- | --------- | ---------- | ---- | ---------------- |
| `use-turn-options.ts`               | 11100 | 1         | 9558       | 216  | `872639e82a0b26…` |
| `conversation-socket-registry.ts`   | 2160  | 1         | 545        | 17   | `d08d95fb8a2342…` |

Raw byte windows before the edit:

```
b"selected.map((entry) => entry.id).join('\x00');\n\n  return React.useMemo((): UseTurn"
b"try>();\n\nconst TRIAL_KEY_PREFIX = 'trial\x00';\n\nfunction acquire(key: string, creat"
```

**After** — each edit replaced the single NUL byte with the six bytes `\u0000`; the script asserted
`new[:off] == old[:off]` and `new[off+6:] == old[off+1:]`, so the offending byte is provably the only
byte that moved.

| File                                | Size  | NUL count | sha256 (prefix)  |
| ----------------------------------- | ----- | --------- | ---------------- |
| `use-turn-options.ts`               | 11105 | 0         | `5abf4ffcefe1fa…` |
| `conversation-socket-registry.ts`   | 2165  | 0         | `af38a4e2e04097…` |

Raw byte windows after the edit:

```
b"ds = selected.map((entry) => entry.id).join('\\u0000');\n\n "
b"g, Entry>();\n\nconst TRIAL_KEY_PREFIX = 'trial\\u0000';\n\nfu"
```

Repo-wide confirmation over `git ls-files`: **181 tracked files still contain a raw NUL and every one
is a genuine binary** (png/gif/mp4/woff/ico/jar/whl). Zero source files remain.

### The lossy-authoring trap, hit and caught

The `Read` tool renders a raw NUL as a space — line 216 displays as `join(' ')` — so no rendered view
could have been used to drive or verify this edit. More sharply: **the `Write` tool emitted a raw NUL
twice** where the authored text was the six characters `\u0000`, once in the rule's doc comment and
once in its message string. Both were found only by byte inspection (offsets 614 and 1773 of
`no-raw-nul.mjs`) and repaired at the byte layer. Every file this task touched was byte-checked after
its final write; all five are at NUL count 0.

## Guard: location and reasoning

The guard is a **vendored ESLint rule in the existing extension slot**
(`packages/config/eslint-extensions/`), the same mechanism as `no-legacy-imports`.

Why there, and why not the two alternatives:

- **`arch:check` (rejected).** Its harness is scoped to the backend source trees; both offenders are
  under `apps/web`. Covering them would mean widening `run.ts`'s glob list, which its README names as
  the statement of scope and explicitly warns hands **every** arch rule a new file set at once. A
  text-hygiene check is not worth that blast radius.
- **A `scripts/` guard plus a new CI step (rejected).** It would add a second gate mechanism and
  require a CI/CD change, which is approval-gated.
- **The lint gate (chosen).** It already runs over every package's source in CI and on pre-push, it
  needs no CI change because the extension slot is auto-loaded, and it **fronts the whole CI DAG** —
  a violation blocks everything downstream immediately.

Detection is over the raw source text rather than string-literal AST nodes, because the damage is
textual: a NUL in a comment, template or regex blinds grep exactly as completely as one in a literal.
The rule and its test build their NUL with `String.fromCodePoint(0)` and use only inline fixtures, so
neither the guard nor its fixtures can carry the byte they ban.

`.astro` is deliberately excluded from the globs, and this was measured rather than assumed: piping
astro source containing a raw NUL through `eslint --stdin --stdin-filename …/probe.astro` produced
`Parsing error: Bad control character in string literal in JSON` — the astro parser hard-fails before
any rule runs, so lint already fails loudly there and the rule could never fire. Including the glob
would have been an artifact that never discriminates. The reason is recorded in the config file.

## Guard observed failing, then passing

**On the real occurrences (before the fix).** `npx eslint src/hooks/billing/use-turn-options.ts
src/lib/conversation-socket-registry.ts` from `apps/web`, `EXIT=1`:

```
apps/web/src/hooks/billing/use-turn-options.ts
  216:63  error  Raw NUL byte (U+0000) — text tools classify this file as binary …  text/no-raw-nul
apps/web/src/lib/conversation-socket-registry.ts
  17:32  error  Raw NUL byte (U+0000) — text tools classify this file as binary …  text/no-raw-nul
✖ 2 problems (2 errors, 0 warnings)
```

**On a deliberately introduced occurrence.** A raw NUL was injected into
`packages/config/eslint-extensions/rules/no-raw-nul.mjs` (byte offset 1149, size 2063 → 2081).
`npx eslint eslint-extensions/rules/no-raw-nul.mjs` from `packages/config`, `EXIT=1`, reporting the
injected byte at `25:12` (and, unexpectedly, the tool-emitted one at `12:45` — see the trap above).
Reverted; the file now contains no NUL, `grep -an "injected"` returns exit 1, and the same lint
command exits 0.

**After the fix.** The identical `apps/web` command exits 0, and the identical `packages/config`
command exits 0.

## The tool has stopped lying

`grep` **without** `-a`, on the file the sweeps were blind to:

```
$ grep -n "hasServedFunding" apps/web/src/hooks/billing/use-turn-options.ts
20:import { hasServedFunding, useSpendable } from '@/hooks/billing/use-spendable';
212:    hasServedFunding(input.isAuthenticated, conversationId) && served === undefined;
EXIT=0
```

Before the fix the same command printed nothing and exited 1, while `-a` returned both lines — the
measurement that grounds the whole task. The second file behaves the same way (`TRIAL_KEY_PREFIX`,
3 hits, exit 0).

A related observation worth recording: the blindness also applies to **`ugrep` on a pipe**. Piping a
grep result that contains a NUL line into a second `grep` silently drops everything, so `grep … | grep
-v node_modules` was itself producing false empties before the fix.

## Tests added

| Test                                                   | Behavior                                                      | Criterion covered |
| ------------------------------------------------------ | ------------------------------------------------------------- | ----------------- |
| `flags a raw NUL inside a string literal`               | The exact shape both offenders had.                            | guard fails       |
| `allows the escaped spelling of the same character`     | `'\u0000'` is accepted — the remedy is not itself a violation. | guard fails       |
| `flags a raw NUL outside any string literal`            | A NUL in a comment is caught (text-level, not literal-level).  | guard fails       |
| `reports every raw NUL in the file, not only the first` | Two NULs ⇒ two reports.                                        | guard fails       |
| `reports at the position of the offending byte`         | Line/column point at the byte, not the file.                   | guard fails       |
| `applies repo-wide, not just to one package tree`       | Fires under an `apps/web` path.                                | guard fails       |
| `leaves a file with no NUL alone`                       | No false positive on clean source.                             | guard fails       |

TDD: the suite was written first and watched fail (`Cannot find module '../no-raw-nul.config.mjs'`,
`EXIT=1`) before the rule existed, then went green on the minimal implementation. The two source-file
edits then took the guard from red (2 errors) to green — the guard was the failing test for the fix
itself.

## Self-gate

| Command                                                                                    | Result             |
| ------------------------------------------------------------------------------------------ | ------------------ |
| `npx vitest run eslint-extensions/rules/no-raw-nul.test.mjs` (packages/config)              | pass — 7/7         |
| `npx vitest run …no-raw-nul.test.mjs …load-extensions.test.mjs` (packages/config)           | pass — 17/17       |
| `npx vitest run src/hooks/billing/use-turn-options.test.ts src/lib/conversation-socket-registry.test.ts` (apps/web) | pass — 38/38, 2 files |
| `npx eslint <2 owned files>` from `apps/web`                                                | pass — exit 0      |
| `npx eslint <3 owned files>` from `packages/config`                                         | pass — exit 0      |
| `npx tsgo --noEmit` (packages/config)                                                       | pass — exit 0      |
| `npx tsgo --noEmit` (apps/web)                                                              | pass — exit 0      |

Lint ordering: the last edit anywhere was in `packages/config` (the `.astro` scoping comment), and
`packages/config` was linted after it. `apps/web` was linted after its own final edit and untouched
since. Both packages present in my changed-file set were linted from their own directory, each with
the exit status captured on the command itself.

The scoped check named in the plan is `pnpm test:web`; the brief forbids running it under this run's
concurrency rule (no two suites sharing a coverage directory), so the two affected `apps/web` test
files were run in isolation with coverage disabled instead. No coverage number was taken for
`apps/web`; the change adds no branches there.

## Acceptance criteria

1. **Both files express the NUL through an escape rather than a literal byte** — met. Byte table
   above: NUL count 1 → 0 in each, single-byte-window diff proven by assertion.
2. **Behaviour provably identical** — met. It is the same character; the diff replaces the byte with
   its escape and nothing else. No test moved: 38/38 pass in the two colocated suites, unchanged.
   Neither value crosses a wire, a store, or a byte-for-byte comparison (see stop-and-report below).
3. **A check fails if a tracked source file gains a raw NUL again** — met. Observed failing on both
   real occurrences and on a deliberately introduced one, passing after revert, with a 7-test suite
   pinning its discrimination.

## Stop-and-report check (not triggered)

Both NULs were checked for load-bearing use before being touched:

- `use-turn-options.ts:216` — `selectedIds` is a local `const`, not exported, used at exactly one
  site: the `useMemo` dependency array on line 265. It exists only to make a selection array
  referentially stable within a render. Nothing reads it, stores it, or transmits it.
- `conversation-socket-registry.ts:17` — `TRIAL_KEY_PREFIX` is module-private, used only to build
  keys for the in-memory `Map` at line 15. Repo-wide grep (run **with** `-a`) finds no other
  consumer of either symbol.

Neither is a wire format, a stored key, or compared against data written earlier, so the escape
preserves meaning as well as spelling. Had either been persisted, the report would have stopped here.

## Deviations

- **`pnpm test:web` not run** — forbidden by the brief's concurrency rule; replaced by isolated runs
  of the two affected test files. Stated above rather than silently substituted.
- **`.astro` excluded from the guard's globs** — a narrower scope than "every tracked source file"
  might imply, justified by measurement (the astro parser fails first) and recorded in the config.
- **Two lint fixes inside my own new files** (`unicorn/prefer-string-raw` on the rule message,
  `prettier/prettier` on two call sites) applied during the cycle; both are in files this task
  created.

## Concerns and limitations

- **Cross-task side effect:** the extension slot is auto-loaded, so **every package's lint now carries
  this rule** — including runs by concurrent agents. Verified safe before shipping: the only tracked
  files still containing a NUL are binaries, and binaries are not linted. No new violation exists
  anywhere in the repo.
- **Coverage of the guard is source-file-shaped, not tracked-file-shaped.** A raw NUL in a `.json`,
  `.yml`, `.md` or `.sh` file would still slip through. That was judged out of scope: the failure
  class this run measured was in TypeScript source, and widening to non-linted file types would need
  the CI-step mechanism that was rejected above. Worth a follow-up only if it recurs elsewhere.
- **The `Write`/`Read` tools normalise this byte in both directions.** Any future agent editing these
  two lines from a rendered view will silently reintroduce the raw byte — the guard now catches that,
  which is precisely why the guard, not the two edits, is the deliverable.

## Confidence

**High.** The defect, the fix and the guard were each measured at the byte layer rather than viewed;
the guard was observed red on real and injected occurrences and green after both; and the direct
end-state proof — plain `grep` finding `hasServedFunding` in the file that used to return exit 1 —
is the thing the task existed to produce.
