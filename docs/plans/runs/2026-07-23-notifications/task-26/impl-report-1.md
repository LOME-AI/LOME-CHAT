# Task 26 — Fix `MAX_PLAINTEXT_BYTES` (RFC 8291 §4 violation) — impl report 1

## Objective

Correct the Web Push plaintext ceiling so the sender can never build a body larger than
a push service is required to accept, and replace the boundary test that defended the
wrong number.

## RFC verification (done first, independently of the plan)

Both RFCs were fetched as raw text (`curl https://www.rfc-editor.org/rfc/rfc8291.txt`,
`…/rfc8188.txt`) and read directly.

**RFC 8291 §4, "Restrictions on the Use of the 'aes128gcm' Content Coding" — verbatim:**

> An application server MUST encrypt a push message with a single record. This allows
> for a minimal receiver implementation that handles a single record. An application
> server MUST set the "rs" parameter in the "aes128gcm" content coding header to a size
> that is greater than the sum of the lengths of the plaintext, the padding delimiter
> (1 octet), any padding, and the authentication tag (16 octets).

> A push message MUST include the application server ECDH public key in the "keyid"
> parameter of the encrypted content coding header. The uncompressed point form defined
> in [X9.62] (that is, a 65-octet sequence that starts with a 0x04 octet) forms the
> entirety of the "keyid".

> A push service is not required to support more than 4096 octets of payload body (see
> Section 7.2 of [RFC8030]). Absent header values (86 octets), padding (minimum 1
> octet), and expansion for AEAD_AES_128_GCM (16 octets), this equates to, at most,
> 3993 octets of plaintext.

**RFC 8188 §2.1 header layout — verbatim:**

> ```
> +-----------+--------+-----------+---------------+
> | salt (16) | rs (4) | idlen (1) | keyid (idlen) |
> +-----------+--------+-----------+---------------+
> ```

**RFC 8188 §2 — verbatim:**

> AEAD_AES_128_GCM produces ciphertext 16 octets longer than its input plaintext.
> Therefore, the unencrypted content of each record is shorter than the record size by
> 16 octets. Valid records always contain at least a padding delimiter octet and a
> 16-octet authentication tag.

**My own derivation (not taken from the plan):**

- Header for Web Push = `salt(16) + rs(4) + idlen(1) + keyid(65)` = **86 octets** —
  keyid is fixed at 65 because §4 mandates the uncompressed point form. Independently
  confirmed by §4's own parenthetical "(86 octets)".
- One final record = `plaintext + delimiter(1) + tag(16)`; this sender emits no extra
  padding.
- Body = header + record ⇒ `plaintext ≤ 4096 − 86 − 1 − 16 = ` **3993**. Matches §4's
  stated ceiling exactly.
- Second constraint: `rs > plaintext + 1 + padding + 16`. With `rs = 4096` and
  plaintext = 3993 the sum is 4010 < 4096 ⇒ satisfied, strictly.
- The old value 4079 (`rs − 17`) is RFC 8188's *per-record* capacity, which ignores the
  header. It fails **both** §4 constraints: body = `86 + 4079 + 1 + 16 = 4182` (86 over
  4096), and `4079 + 1 + 16 = 4096 = rs`, equal rather than greater.

Both were then confirmed empirically by the RED test output below (body measured at
4182; `rs` measured at 4096 against a required-greater-than of 4096). **My reading
agrees with the plan's arithmetic in full**; no NEEDS_CONTEXT trigger fired.

## Files changed

- `apps/api/src/slices/notifications/adapters/webpush/encrypt.ts` — ceiling re-derived
  from the 4096-octet body limit, named header/tag/delimiter constants introduced, and
  the header builder switched from bare offsets (`21`, `16`, `20`) to those same
  constants so the arithmetic has one source.
- `apps/api/src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts`
  — boundary coverage tightened: body size and declared `rs` are now asserted at the
  maximum plaintext, not only the round-trip.
- `apps/api/src/slices/notifications/adapters/webpush/send.test.ts` — the vague
  oversize-payload test replaced by two exact-boundary tests around the guard.

`send.ts` was **not** modified (verified: `git status` lists only the three files above).

## Old vs new constant, quoted

Old:

```ts
/** RFC 8188 header record size. A single small record fits well under this. */
const RECORD_SIZE = 4096;

/** GcM authentication tag length plus the one-octet padding delimiter. */
const GCM_OVERHEAD = 16 + 1;

export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - GCM_OVERHEAD;   // 4079
```

New:

```ts
/** RFC 8188 §2.1 header fields: salt(16) || rs(4) || idlen(1) || keyid(idlen). */
const SALT_LENGTH = 16;
const RECORD_SIZE_LENGTH = 4;
const ID_LENGTH_LENGTH = 1;
const HEADER_PREFIX_LENGTH = SALT_LENGTH + RECORD_SIZE_LENGTH + ID_LENGTH_LENGTH;

const KEY_ID_LENGTH = 65;
const HEADER_LENGTH = HEADER_PREFIX_LENGTH + KEY_ID_LENGTH;      // 86

const AUTH_TAG_LENGTH = 16;
const PADDING_DELIMITER_LENGTH = 1;
const MAX_BODY_BYTES = 4096;

export const MAX_PLAINTEXT_BYTES =
  MAX_BODY_BYTES - HEADER_LENGTH - PADDING_DELIMITER_LENGTH - AUTH_TAG_LENGTH;   // 3993
```

No bare `3993` anywhere, and no second literal for the header length: the encoder now
builds the header from `HEADER_PREFIX_LENGTH` / `SALT_LENGTH` / `RECORD_SIZE_LENGTH`,
the same constants `HEADER_LENGTH` is composed from. Changing any component moves both
the emitted header and the ceiling together. The doc comment cites §4 and states both
constraints, including why deriving from `RECORD_SIZE` satisfies neither.

The encoder still writes the header's keyid from `ephemeral.publicKey.length` at
runtime (unchanged behavior); `KEY_ID_LENGTH` is the RFC-mandated 65 that the ceiling
must budget for, and `generateEphemeralKey`'s existing test pins the key at 65 bytes.

## Tests added / changed

| Test | Behavior | Criterion |
| --- | --- | --- |
| `Web Push bodies this sender produces > fit inside the 4096-octet body limit at the maximum payload size` | at `MAX_PLAINTEXT_BYTES`, the produced body is `<= 4096` | tightened boundary test (body size, not round-trip) |
| `Web Push bodies this sender produces > declare a record size larger than the record they carry` | the header's `rs` is strictly greater than `plaintext + 1 + 16` | §4's second constraint |
| `sendWebPush — validation > rejects a payload one octet past the interoperable plaintext ceiling` | `MAX_PLAINTEXT_BYTES + 1` ⇒ `validation` error | `MAX + 1` rejection pin |
| `sendWebPush — validation > accepts a payload at exactly the interoperable plaintext ceiling` | `MAX_PLAINTEXT_BYTES` ⇒ `ok` | guard is not off-by-one in the rejecting direction |

The pre-existing `decrypt back to the plaintext at the maximum payload size` round-trip
test is kept unchanged (it still round-trips, now at 3993). The two new decryptor-test
cases are siblings rather than extra assertions inside it, to keep one behavior per test.

Replaced: `sendWebPush — validation > rejects a payload larger than a single record can
hold` (asserted only that `new Uint8Array(4096)` is rejected). It did not pin the old
numeric bound, but its premise — that the limit is single-record capacity — is the exact
misconception being corrected, and the new `MAX + 1` test strictly subsumes its case.
Intent is unchanged: an oversize payload is rejected.

### RED evidence (before the constant change)

```
FAIL … > fit inside the 4096-octet body limit at the maximum payload size
AssertionError: expected 4182 to be less than or equal to 4096
 ❯ …/rfc8291-decryptor.test.ts:145:25

FAIL … > declare a record size larger than the record they carry
AssertionError: expected 4096 to be greater than 4096
 ❯ …/rfc8291-decryptor.test.ts:158:24

 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```

4182 and the `4096 > 4096` failure are precisely the two derived violations — the RED
run independently reproduced both, so the diagnosis is confirmed by measurement rather
than by reading.

### GREEN evidence (after)

```
 Test Files  4 passed (4)
      Tests  35 passed (35)
```

This includes `reproduces the RFC 8291 Appendix A ciphertext byte-for-byte`, which
proves the header-constant refactor changed nothing on the wire.

### Teeth check on the two `send` boundary tests

Both pin an already-correct guard, so neither could start RED honestly. Instead the
guard was temporarily mutated in each direction and reverted:

- `>` → `>=` : `accepts a payload at exactly the interoperable plaintext ceiling` FAILED.
- `>` → `> MAX + 1` : `rejects a payload one octet past …` FAILED.

`send.ts` was restored byte-for-byte afterwards (`git diff` on it is empty; `git status`
does not list it).

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint <the three owned files>` (from `apps/api`, after the last edit) | pass — exit 0 |
| `npx turbo lint typecheck --filter=@hushbox/api --force` | pass — 2/2 tasks successful |
| `pnpm test:api` | 471 files passed / 1 failed; 6538 tests passed, 7 failed — all 7 in `template-html.test.ts` |
| webpush-scoped coverage (v8, `src/slices/notifications/adapters/webpush/**`) | 100% statements / branches / functions / lines |

The single failing file is `src/slices/notifications/domain/templates/template-html.test.ts`
— the founder-owned, deterministic snapshot set awaiting `-u`, pre-declared known-red in
the brief. Attribution evidence: it is snapshot drift on a `<link
href="https://fonts.googleapis.com/…">` line in email HTML templates, a file this task
never touched (`git status` lists only the three webpush files as modified), in a
different directory with no import path to `webpush/`. Nothing else failed.

## Acceptance criteria

- **Ceiling is RFC 8291 §4's interoperable value, derived not literal** — met.
  `MAX_PLAINTEXT_BYTES = 4096 − 86 − 1 − 16 = 3993`, composed from named constants; the
  header length reuses the encoder's own constants.
- **Doc comment cites §4 and states both constraints** — met (quoted above); it also
  records why the rejected `RECORD_SIZE − 17` derivation fails both.
- **Boundary test asserts the body is `<= 4096`, not merely that it round-trips** — met,
  with the RED output above showing it catches the bug class the round-trip could not.
- **A test pins `MAX_PLAINTEXT_BYTES + 1` is rejected by `sendWebPush`'s guard** — met,
  plus the complementary accept-at-exactly-`MAX` test.
- **Existing tests asserting the old bound updated, none whose intent would shift** — met.
  No test asserted `4079`; the one replaced test asserted a 4096-byte payload is
  rejected, which remains true and is subsumed. Nothing else in the repo referenced the
  constant (`grep` for `MAX_PLAINTEXT_BYTES|4079|GCM_OVERHEAD|RECORD_SIZE` across
  `apps/`, `packages/`, `docs/`).
- **No currently-passing send becomes rejected** — met. The only producer,
  `push-webpush.ts`, encodes `JSON.stringify({ category, conversationId })` — a fixed
  category enum plus a 36-char uuid, ~80 bytes, three orders of magnitude below both the
  old and new ceilings. The gap between 3993 and 4079 is unreachable by any payload this
  system can construct.

## Deviations

None from the acceptance criteria. One judgment call inside them: the vague
oversize-payload test was replaced rather than kept alongside the new `MAX + 1` test,
because its name encoded the wrong rationale and its case is subsumed (documented above).

## Concerns and limitations

- **Interoperability fix, not a security fix.** Nothing was decrypted incorrectly,
  leaked, or mis-billed. The old constant could only have produced a 4182-octet body
  that a push service was entitled to reject with a 413.
- **Latent, never live.** No message this system sends has ever been within ~3900 bytes
  of either bound; the fix changes no wire output for any real payload.
- `send.ts`'s guard message still reads "web push payload exceeds the single-record size
  limit" — the limit is now the 4096-octet body ceiling, not single-record capacity.
  `send.ts` is outside this task's file ownership so it was left alone; raised to the
  orchestrator. It is a `validation` `DomainError` message, not user-facing copy (API
  errors surface `code` only).
- The test-side RFC decryptor (`__tests__/rfc8291-decryptor.ts`) defines its own
  `SALT_LENGTH` / `RECORD_SIZE_LENGTH` / `HEADER_PREFIX_LENGTH`. That duplication is
  deliberate — it is an independent clean-room oracle; sharing constants with the encoder
  would weaken it. Left untouched.

## Confidence

**High** — the ceiling is derived from RFC text I fetched and quoted myself, both
violations were reproduced numerically in a RED run before the fix, the RFC 8291
Appendix A byte-for-byte vector still passes after it, and the only test failure in the
scoped suite is the pre-declared founder-owned snapshot set.
