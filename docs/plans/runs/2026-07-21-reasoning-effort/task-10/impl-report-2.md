# T10 — Glazed thinking disclosure — impl report 2 (fix)

## Objective

Fix one validated audit finding: the literal `<think>` string at
`apps/web/src/components/chat/message/thinking-disclosure.test.tsx:25` violated the
G7-derived rule that delimiters stay module-private to
`packages/shared/src/reasoning-format.ts`. Suggested direction: pin the
bare-unclosed-open-tag behavior in the shared module's test (where literals are
module-scope legal) and drop the component test case, whose rendering outcome is
already covered by the "no reasoning → nothing" tests.

## Files changed

- `apps/web/src/components/chat/message/thinking-disclosure.test.tsx` — removed the
  `'renders nothing when a delimiter opened with no thoughts inside yet'` test case
  (the sole literal-delimiter occurrence in apps/web).

## Tests added

None. The shared test file **already pins the exact case** — verified before editing:
`packages/shared/src/reasoning-format.test.ts:123-125`,
`'parses a bare open delimiter as empty reasoning-so-far'` asserts
`parseReasoningText('<think>')` → `{ reasoning: '', answer: '' }`. Adding a duplicate
would violate one-behavior-per-test hygiene, so nothing was added. The component's
rendering outcome for that parse result (`reasoning === '' → null`) remains pinned by
`'renders nothing when the message carries no reasoning'` and
`'renders nothing for an empty message'`.

The removal is a test deletion with no production-code change, so no red-green cycle
applies.

## Self-gate

- `vitest run src/components/chat/message/thinking-disclosure.test.tsx` (from
  apps/web) — pass, 23/23.
- `vitest run src/reasoning-format.test.ts` (from packages/shared) — pass, 16/16.
- `eslint src/components/chat/message/thinking-disclosure.test.tsx` (from apps/web,
  after the final edit) — exit 0.
- `eslint src/reasoning-format.test.ts` (from packages/shared) — exit 0 (file
  untouched; linted for completeness since it is the finding's other named file).
- G7 grep check: `grep -rn '<think>' apps/web/src --include='*.ts' --include='*.tsx'`
  — zero hits.

## Acceptance criteria (the finding)

- No literal delimiter outside `packages/shared/src/reasoning-format.ts` in web code
  — **met** (grep clean).
- Bare-unclosed-open-tag behavior pinned in the shared test — **met** (pre-existing
  test at reasoning-format.test.ts:123, verified this session; no addition needed).
- Component rendering outcome still covered — **met** (the two no-reasoning tests).

## Deviations

None. The shared test file was not edited because the required pin already exists —
this is the suggested direction's "verify … add if missing" branch resolving to
already-present.

## Concerns and limitations

None new. Prior report's raised items (reasoningTokens plumbing → T13, share-view raw
delimiters → T14 sweep) are unchanged by this fix.

## Confidence

**High** — a pure test-case deletion; the deleted behavior is provably covered at the
correct layer, both suites green, lint clean, and the G7 grep check now passes.
