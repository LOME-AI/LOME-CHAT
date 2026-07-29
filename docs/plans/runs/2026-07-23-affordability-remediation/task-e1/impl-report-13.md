# E1 — impl report 13 (the `pnpm test:web` gate)

## Status

**Single-purpose cycle: establish the gate.** No other work.

The previous cycle's gate was **RED**, and finding that required not trusting a green-looking
signal. One coverage failure, in a file I had edited. Fixed, and the gate re-run alone.

---

## The trap I nearly walked into

The background-task notification for my earlier `pnpm test:web` said:

```
Background command "Run pnpm test:web alone" completed (exit code 0)
```

**That exit code is the shell wrapper's, not the gate's.** My command was
`pnpm test:web > log 2>&1; echo "TESTWEB_EXIT=$?"` — the `echo` succeeds regardless, so the
wrapper exits 0 whatever `pnpm` did. The captured status inside the file said:

```
TESTWEB_EXIT=1
```

**The gate was red.** Reading the notification instead of the captured status would have let me
report a green gate on the one cycle whose entire purpose was to establish it. This is the same
family as the pipeline trap Global Constraint 9 names (`cmd | tail; echo $?` reports `tail`'s
status) — one level further out: **a wrapper around the gate is not the gate.** I have since
written the status to its own file so it cannot be confused with a wrapper's.

## What was red

```
ERROR: Coverage for branches (94.73%) does not meet global threshold (95%)
  for src/components/chat/model-selector/model-selector-button.tsx
```

**Exactly one failure**, not three — the earlier three-file report predated this cycle's work.

## Why it was mine, and why it is subtler than "I left a branch uncovered"

The uncovered branch is `if (!disabled)` inside `handleClick` (`:82`). The `<Button>` carries
`disabled={disabled}`, so React never fires `onClick` while disabled — the guard is unreachable
through the UI and always was.

**I did not add an uncovered branch. I removed COVERED ones.** Taking `canAccessPremium` out of
this file — including its `= true` default parameter, which is itself a branch — shrank the
denominator, and a pre-existing unreachable guard that had been diluted below visibility rose above
the threshold. A file can cross a coverage gate because of what you *deleted*, with nothing new
uncovered. That is worth recording: the usual mental model ("coverage fell because I added
untested code") does not fit this failure at all.

**Fix:** the repo's established idiom for a provably-unreachable defensive branch —
`/* v8 ignore next -- the Button carries \`disabled\`, so React never fires onClick while
disabled; this guard is defence for a caller that invokes the handler directly */`, matching
`use-resolve-default-model.ts:43` and `turn-core.ts`. I kept the guard rather than deleting it:
it is defence against a direct caller, and the annotation states *why* it cannot be reached rather
than hiding that it is not.

Scoped verification of that file after the fix: `COV_EXIT=0`, no rows listed (100%, omitted as
full). `eslint` on it: `LINT_EXIT=0`.

## The gate

Re-run **alone**, after `rm -rf apps/web/coverage`, with nothing else touching the coverage
directory, status written to its own file:

| Command | Status |
| --- | --- |
| `pnpm test:web` (alone, 5m19s) | **`TESTWEB_EXIT=1`** |
| — tests | **6,444 passed, 0 failed** |
| — coverage errors | **exactly 1** |

```
ERROR: Coverage for branches (75%) does not meet global threshold (95%)
  for src/components/chat/message/markdown-renderer.tsx
```

**That is the documented §Known-Breakage entry, at the exact recorded number.** The plan records it
as load-dependent, names 75% branches, states it is not this run's, and says explicitly: *"This
blocks any task that gates on `pnpm test:web`, which is F1, E1–E3 and G2; judge those on the file
list and the per-file numbers, not on the gate's exit code."*

The plan sets two preconditions before anyone may attribute a failure to that entry. Both are met:

1. **"Re-run in isolation before attributing anything to this entry."**
   `ISOLATED_EXIT=0`, and the file reports **100% branches** alone — versus 75% under full-suite
   load. The load-dependence is reproduced, not assumed.
2. **"Never excuse a coverage failure on a file your task touched by pointing here."**
   `git diff HEAD` is **empty** for both `markdown-renderer.tsx` and its test. Untouched by me
   across all thirteen slices.

**My own regression is fixed and gone.** `model-selector-button.tsx` no longer appears in the error
list. Owned files in that same full run: `model-list-item.tsx` 100%/98.27%, `use-tier-info.ts` and
`use-user-tier-info.ts` 100%, and every other owned file omitted as fully covered — including
`use-turn-options.ts`.

**So the gate's exit 1 is entirely the pre-existing entry, and E1's own files pass it.**

The earlier self-inflicted failure ("Something removed the coverage directory") came from running a
scoped `--coverage` run concurrently against the same `reportsDirectory`. Sequenced, not overlapped,
this time.

## Confidence

**High.** The gate ran to completion alone; its status was read from a file the wrapper cannot
touch. 6,444 tests pass with zero failures. The one coverage error is the documented entry, and I
satisfied both preconditions the plan sets before attributing to it — isolation (100% branches,
exit 0) and untouched-by-me (`git diff HEAD` empty). My own regression is closed and absent from
the error list.

**One honest limit:** the gate does not exit 0 and cannot, while that entry stands. I am reporting
it as red-with-attribution rather than green, because an exit code I did not earn is not mine to
claim — which is the same rule that made me re-read the wrapper's status in the first place.
