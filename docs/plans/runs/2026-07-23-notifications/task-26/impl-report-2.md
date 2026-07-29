# Task 26 — fix round 2 — impl report

## Objective

Two one-line items from the passing audit: (1) strengthen the body-size boundary
assertion from an upper bound to an exact size, so an over-conservative ceiling can no
longer pass; (2) replace the now-stale guard message in `send.ts`, which restated the
misconception this task corrected.

## Files changed

- `apps/api/src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts`
  — boundary assertion `toBeLessThanOrEqual(4096)` → `toBe(4096)`; test name and
  comment updated to state the stronger claim.
- `apps/api/src/slices/notifications/adapters/webpush/send.ts` — one string literal:
  the payload-guard's validation message. Nothing else in the file touched.

## Item 1 — exact-size boundary assertion

Old (name understated the claim, assertion pinned only the upper direction):

```ts
it('fit inside the 4096-octet body limit at the maximum payload size', async () => {
  …
  expect(body.length).toBeLessThanOrEqual(4096);
});
```

New:

```ts
it('exactly fill the 4096-octet body limit at the maximum payload size', async () => {
  // RFC 8291 §4 / RFC 8030 §7.2: "A push service is not required to support more
  // than 4096 octets of payload body." A body that round-trips locally is still
  // undeliverable if it exceeds this, so the size is asserted, not just the decrypt.
  // Equality, not an upper bound: at the interoperable ceiling the body is exactly
  // header(86) + plaintext(3993) + delimiter(1) + tag(16) = 4096, so `toBe` also
  // catches an over-conservative ceiling, which would silently reject legitimate
  // payloads. An upper-bound assertion passes for any ceiling that is too low.
  const receiver = await generateSubscriptionKeys();

  const body = await encryptTo(receiver, randomBytes(MAX_PLAINTEXT_BYTES));

  expect(body.length).toBe(4096);
});
```

### Bidirectional teeth check (perturb `MAX_PLAINTEXT_BYTES`, both directions)

`encrypt.ts` was temporarily perturbed at the ceiling expression, then restored. The
NEEDS_CONTEXT trigger did not fire: `toBe(4096)` holds unperturbed.

| `MAX_PLAINTEXT_BYTES` expression | test result |
| --- | --- |
| `… - AUTH_TAG_LENGTH` (unperturbed, 3993) | PASS — `body.length` 4096 |
| `… - AUTH_TAG_LENGTH + 1` (3994, too high) | FAIL — `AssertionError: expected 4097 to be 4096` |
| `… - AUTH_TAG_LENGTH - 1` (3992, too low) | FAIL — `AssertionError: expected 4095 to be 4096` |

The too-low case is exactly what the old assertion could not catch (4095 ≤ 4096 passes).

`encrypt.ts` restored afterwards: line 59 reads
`MAX_BODY_BYTES - HEADER_LENGTH - PADDING_DELIMITER_LENGTH - AUTH_TAG_LENGTH;` again,
and `git diff --stat` on it shows the same 40/11 shape as after round 1 — no
perturbation residue.

## Item 2 — stale guard message

`send.ts:101`, old → new:

```
- validationError('web push payload exceeds the single-record size limit')
+ validationError('web push payload exceeds the RFC 8291 plaintext ceiling')
```

The old text named single-record capacity, which is the misconception this task
corrected; the guard now enforces the RFC 8291 §4 plaintext ceiling that keeps the body
within 4096 octets.

Wording note: the first draft read "the interoperable plaintext ceiling" but that line
was 101 columns, one past the 100-column Prettier width, so it would have wrapped to
three lines and broken the one-changed-line constraint. "RFC 8291" is both shorter (96
columns) and more precise about where the number comes from.

### Proof no test asserts the string (checked before editing)

- `grep -rn "single-record" apps/api/src apps/web/src packages/*/src e2e docs` — the only
  source hit was `send.ts:101` itself; remaining hits are this run's ledger/report/research
  markdown, none of them tests.
- `grep -rn "\.message" apps/api/src/slices/notifications/adapters/webpush/` — no hits at
  all; both boundary tests in `send.test.ts` assert on `.code`.
- Post-change `grep -rn "payload exceeds\|toBe('web push\|toContain('web push"` across
  `apps/*/src`, `packages/*/src`, `e2e` — the single hit is the new literal in `send.ts`.

### `git diff` on `send.ts`

```
@@ -98,7 +98,7 @@ export function sendWebPush(
     return errAsync(validationError('web push Urgency is not a recognized level'));
   }
   if (payload.length > MAX_PLAINTEXT_BYTES) {
-    return errAsync(validationError('web push payload exceeds the single-record size limit'));
+    return errAsync(validationError('web push payload exceeds the RFC 8291 plaintext ceiling'));
   }
```

`git diff --numstat` → `1 1` — exactly one line changed, file otherwise byte-identical.

## Self-gate

| Command | Result |
| --- | --- |
| webpush scoped suite (`vitest run --root apps/api src/slices/notifications/adapters/webpush`) | pass — 4 files, 35 tests |
| notifications slice suite (`… src/slices/notifications`) | 41/42 files pass, 387 passed / 7 failed / 1 skipped — all 7 in the known-red `template-html.test.ts` |
| `npx eslint <both owned files>` from `apps/api`, after the last edit | pass — exit 0 |
| `turbo lint typecheck --filter=@hushbox/api --force` | pass — 2/2 tasks successful, 0 cached |

The 7 failures are the founder-owned `template-html.test.ts` snapshot set the brief
pre-declared known-red and off-limits; they are `<link href="https://fonts.googleapis.com/…">`
snapshot drift in `domain/templates/`, a directory this task never touched and with no
import path to `adapters/webpush/`. Not run with `-u`, not touched.

Tests were run through `scripts/with-env.ts` as instructed (a bare `npx vitest` fails at
`requiredEnv` here). Note for future briefs: the usage is
`tsx scripts/with-env.ts <command> [...args]` — there is no `<mode> --` separator, and
passing one makes the wrapper exit 1 with no output at all.

## Acceptance criteria

- **Boundary test pins both directions** — met. `toBe(4096)` is correct by construction
  (86 + 3993 + 1 + 16) and demonstrated failing for a ceiling one octet high and one
  octet low.
- **Test name no longer undersells the assertion** — met. "fit inside" → "exactly fill",
  with the comment stating why equality is the right relation.
- **Guard message no longer restates the corrected misconception** — met.
- **`send.ts` otherwise byte-identical** — met (`numstat 1 1`).

## Deviations

None. One wording choice inside the criteria: "RFC 8291 plaintext ceiling" rather than
"interoperable plaintext ceiling", forced by the 100-column Prettier width (above).

## Concerns and limitations

- No test asserts the new message either — validation messages are not part of the wire
  contract here (routes surface `.code`), so the string remains uncovered by
  construction. Adding a test that pins it would couple a test to prose and was outside
  the authorized scope.

## Confidence

**High** — both items are one-line changes with directly demonstrated evidence: the
assertion was watched failing in both perturbation directions and passing unperturbed,
and the message change is provably unasserted anywhere in the repo's source or tests.
