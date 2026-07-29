# Task 01 — fix round 2: console-strip height measured on the content box

## Objective

Address the one Minor from the audit: the python test's console-height assertion
compared a padded box against unpadded line units, so it would have accepted a
visible regression. Plus one wording correction to the `js` fixture's comment.

## Execution status — read this first

**Still not run.** No Playwright process was started in this round either, per the
task constraint. Everything below is a claim about code read against the shipped
app, type checked and linted — never about observed test behaviour.

## Files changed

- `e2e/pages/document-panel.page.ts` — `consoleMetrics()` now also returns
  `contentHeight` (`clientHeight` less the strip's own computed vertical padding).
  `clientHeight` is kept because the scroll assertion (`scrollHeight > clientHeight`)
  is a padding-box-to-padding-box comparison and is correct as it stands.
- `e2e/chat/runnable-documents.spec.ts` — the line assertion reads `contentHeight`;
  the `js` fixture's doc comment describes what Reset actually restores.

No app source touched. No other assertion changed. No constant changed.

## The corrected assertion

Before:

```ts
expect(strip.clientHeight).toBeGreaterThanOrEqual(strip.lineHeight * MIN_CONSOLE_LINES_VISIBLE);
```

After:

```ts
expect(strip.contentHeight).toBeGreaterThanOrEqual(strip.lineHeight * MIN_CONSOLE_LINES_VISIBLE);
```

with, in the page object:

```ts
const style = globalThis.getComputedStyle(element);
const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
// …
contentHeight: element.clientHeight - verticalPadding,
```

`MIN_CONSOLE_LINES_VISIBLE` stays at `4`, and now means four lines.

## What it catches that the old form passed

The strip is `max-h-[6.5rem] p-3 text-xs`
(`apps/web/src/components/document-panel/document-sandbox.tsx:273`): 104px
padding box = 80px of lines + 24px of padding, at a 16px line.

| Shipped or regressed strip | Visible lines | Old form (`clientHeight ≥ 64`) | New form (`contentHeight ≥ 64`) |
| --- | --- | --- | --- |
| `max-h-[6.5rem] p-3` (today) | 5 | 104 ≥ 64 pass | 80 ≥ 64 pass |
| `max-h-[4.5rem] p-3` | 3 | **72 ≥ 64 pass** | 48 ≥ 64 **fail** |
| `max-h-[5.5rem] p-3` | 4 | 88 ≥ 64 pass | 64 ≥ 64 pass (exactly at the floor) |
| `max-h-8 p-3` (squashed) | ~1 | 32 ≥ 64 fail | 8 ≥ 64 fail |

So the concrete regression now caught is **a cap trimmed from five visible lines
to three** — a third of a run's output disappearing behind the scroll, which the
old form waved through because the 24px of padding it was counting stood in for a
line and a half. Padding growing while the line band shrinks (`max-h-[6.5rem]`
kept, `p-3` → `p-6`, 2 visible lines) is likewise now caught (56 − 48 = 8 ≥ 64
fails) and was not before.

The failure the assertion is named for — squashed to one line — is caught by both
forms; nothing that used to be caught stops being caught, since `contentHeight`
is strictly less than `clientHeight` for any non-zero padding.

## Wording correction

`e2e/chat/runnable-documents.spec.ts:115-119`, the `JS_DOC` comment. The prior
text said Reset "restores the unsorted order", implying the algorithms mutate the
data. They do not: both `bubble` and `insertion` sort `[...VALUES]`, a fresh copy
of the pristine constant, so the values never change. What Reset restores is the
**painted** order. The comment now says that, and states the conclusion it exists
to support — Reset is what forces the second algorithm's click to redraw rather
than pass over bars the first left ascending. The test's logic is unchanged; only
the description was loose.

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo typecheck lint --filter=@hushbox/e2e --force` | pass (2/2 tasks, cache bypassed) |
| `npx eslint chat/runnable-documents.spec.ts pages/document-panel.page.ts` (run from `e2e/`, after the final edit) | exit 0, no findings |
| Playwright specs | **not run** — constraint of this task |

## Acceptance criteria

- **The console assertion measures the right thing** — met: content box against
  line units, constant unchanged and now truthful to its name.
- **No other assertion weakened, no app source touched** — met: the only other
  edit is comment prose; `clientHeight` is still returned so the scroll assertion
  reads exactly as before.
- **The Reset comment is accurate** — met.

## Concerns and limitations

- **Unverified by execution**, same as round 1. In particular `contentHeight` is
  computed from `getComputedStyle` padding values, which resolve to used pixels
  (`12px` for `p-3`) in every engine this file runs on — read from the CSS, not
  observed in a run.
- **A horizontal scrollbar would not perturb this**: the strip is
  `whitespace-pre-wrap`, so it never scrolls horizontally, and `clientHeight`
  already excludes a horizontal scrollbar's band in any case. Worth naming
  because it is the one way a content-box measurement can go quietly wrong.
- **Four lines is a floor, not the design.** The shipped strip shows five. If the
  founder wants the assertion to pin the design rather than a floor, the constant
  becomes 5 and the shipped 80px lands exactly on it — a rounding-tight boundary,
  which is why I left it at 4.
- **The working tree carries no diff for these two files** — `git status` shows
  them clean, so round 1's work was committed by something outside this task
  (HEAD is `a94ca204 billing refactor`). This round's edits are uncommitted. I
  changed nothing about that and ran no state-writing git command.

## Confidence

**High** for this round's change: it is a two-line arithmetic correction whose
effect is verifiable by reading the shipped CSS, and the table above enumerates
its behaviour at every relevant strip size. Confidence in the task overall stays
**medium** for the unchanged round-1 reason — nothing has been executed.
