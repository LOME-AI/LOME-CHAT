# Task 19 — impl report 1

## Objective

Prove that Web Push bodies our sender produces are decryptable by an implementation that
is not ours: an RFC 8291 / RFC 8188 receiver written from the specification text, anchored
against the RFC's own published vector in the decrypt direction, then used as the oracle
for randomized round-trips of our `encryptWebPushPayload` output.

## Files changed

- `apps/api/src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.ts` (new)
  — the independent receiver. Lives in `__tests__/` because that directory is the
  repo's established home for test-only helper modules
  (`slices/billing/__tests__/orphan-wallet-sweep.ts`, `slices/models/__tests__/model-catalog-lock.ts`)
  and is coverage-excluded by `packages/config/vitest.config.ts` (`'**/__tests__/**'`).
- `apps/api/src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts` (new)
  — the anchor test, the randomized round-trips, and the negative controls.
- `.gitleaks.toml` — one AND-pinned path+value allowlist entry for the RFC 8291
  Appendix A auth secret at the new test path, matching the four existing webpush entries.

No production file was touched. `encrypt.ts`, `vapid.ts`, `send.ts` and the barrel are
unchanged (`git status` for the webpush directory shows only the new untracked
`__tests__/` directory).

## Derivation notes — where each step of the decryptor came from

The decryptor was written before `encrypt.ts` was opened at all; the RFC texts were
fetched from `rfc-editor.org` and read directly. Only after the oracle decrypted the RFC
vector was `encrypt.ts` consulted, and then only for the exported signature of
`encryptWebPushPayload` needed to call it.

| Step | Source |
| --- | --- |
| Header parse `salt(16) ‖ rs(4, network byte order) ‖ idlen(1) ‖ keyid(idlen)`; `rs < 18` invalid | RFC 8188 §2.1 |
| `keyid` is the sender's 65-octet X9.62 uncompressed point (leading `0x04`) | RFC 8291 §4 |
| ECDH: receiver private × sender public from `keyid` | RFC 8291 §3.1 |
| IKM: `PRK_key = HMAC(auth_secret, ecdh_secret)`, `key_info = "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public`, `IKM = HMAC(PRK_key, key_info ‖ 0x01)` | RFC 8291 §3.3 and the §3.4 pseudocode |
| `PRK = HMAC(salt, IKM)`; `CEK = HMAC(PRK, "Content-Encoding: aes128gcm" ‖ 0x00 ‖ 0x01)[0..16)` | RFC 8188 §2.2 |
| `NONCE = HMAC(PRK, "Content-Encoding: nonce" ‖ 0x00 ‖ 0x01)[0..12)` XOR SEQ; SEQ is 0 for the single record | RFC 8188 §2.3, RFC 8291 §3.4 note and §4 |
| AES-GCM decrypt, 16-octet tag, zero-length additional data | RFC 8188 §2 |
| Padding: delimiter is the last non-zero octet; fail if no non-zero octet; fail if the last record's delimiter is not 2 | RFC 8188 §2, restated in RFC 8291 §4 |

The HKDF steps are written as the RFC's own single-HMAC pseudocode rather than through
`crypto.subtle`'s HKDF, so each expansion is visibly the specification's formula.

## Tests added

All in `__tests__/rfc8291-decryptor.test.ts`:

1. `RFC 8291 decryptor > decrypts the RFC 8291 Appendix A body to the specification plaintext`
   — the external anchor. Criterion: "verified against RFC 8291 Appendix A in the decrypt
   direction first".
2. `Web Push bodies this sender produces > decrypt back to the plaintext across independently generated subscriptions`
   — 25 iterations, each with a freshly generated P-256 subscription key pair, a fresh
   random 16-octet auth secret, a fresh random salt, a fresh production ephemeral key
   (`generateEphemeralKey()`), and a random plaintext length in [1, 512]. Criterion:
   "round-trip proven over freshly generated keypairs … several independent iterations".
3. `… > decrypt back to the plaintext at the maximum payload size` — `MAX_PLAINTEXT_BYTES`,
   the record-size boundary.
4. `bodies an independent receiver must reject > rejects a body whose ciphertext has one flipped bit`
   — negative control (AEAD tag).
5. `… > rejects a body decrypted with the wrong authentication secret` — negative control
   (key derivation).
6. `… > rejects a record whose padding delimiter is not the last-record value` — negative
   control on the RFC 8188 §2 MUST. Uses a body forged in the test around a `… ‖ 0x01`
   padded block, which our sender by construction never emits.
7. `… > rejects a record that contains no non-zero octet` — the other RFC 8188 §2 MUST.

TDD sequence actually followed:

- Test 1 written first → RED (`Cannot find module './rfc8291-decryptor.js'`) → decryptor
  implemented → GREEN, captured before any round-trip test existed (pasted below).
- Tests 2–5 written next → RED (`generateSubscriptionKeys is not a function`) → generator
  added → GREEN.
- Tests 6–7 written → RED against the then-current oracle, which returned the plaintext
  instead of failing (received `Uint8Array [0,0,0,0,0,0,0]` where a rejection was expected)
  → the two padding MUST checks implemented → GREEN.

Tests 4 and 5 passed the first time they ran: they assert a property of AES-GCM and of the
key schedule, not new decryptor code. They are honest negative controls, not TDD steps.

## Self-gate

- `npx vitest run --project api src/slices/notifications/adapters/webpush/` — **pass** —
  4 files, 32 tests (7 new, 25 pre-existing in `encrypt`/`vapid`/`send`).
- `pnpm test:api` — **fail, none of it mine**. 7 files / 13 tests failed; the new file is
  green inside the full run:
  `✓ api src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts (7 tests) 88ms`.
  Failures and attribution:
  - `slices/notifications/domain/templates/template-html.test.ts` (7 tests) — stale
    committed snapshots: the snapshot expects a `fonts.googleapis.com` `<link>` the
    generator no longer emits. `git status` shows the templates directory (source **and**
    snapshot) unmodified, and the failure reproduces in isolation on that untouched tree —
    a pre-existing red at HEAD.
  - `slices/models/domain/estimate-run.test.ts`,
    `slices/models/domain/trial-smart-model-candidates.test.ts`,
    `slices/chat/domain/smart-model-turn.test.ts` — the concurrently-edited estimator
    workstream; `git status` shows those files and
    `packages/shared/src/affordability/estimate/**` modified by another agent right now.
  - `slices/admin/routes-reads.integration.test.ts`, `slices/media/domain/gc.integration.test.ts`,
    `slices/chat/domain/media-turn.integration.test.ts` — `Hook timed out in 10000ms`
    against shared Postgres/MinIO while other agents' suites run; an earlier run of the
    same command failed a different set (6 files / 50 tests), which is the signature of
    load, not of a code change.
  None of these files is in this task's ownership and none imports anything this task
  added (the new module is imported only by its own test).
- `npx turbo typecheck lint --filter=@hushbox/api --force`, run from `apps/api` after the
  final edit — **pass**: `Tasks: 2 successful, 2 total`, no eslint output.
  Two earlier runs of the lint half failed on other agents' work and are recorded for
  honesty: one aborted with `ENOENT … push-fcm.integration.test.ts` (Task 18 deleting that
  file mid-run), the next reported 5 prettier errors in
  `src/slices/models/domain/trial-eligibility.test.ts` (the concurrent estimator
  workstream, since fixed by its owner). No run ever reported an error in this task's files.
- `npx eslint src/slices/notifications/adapters/webpush/__tests__/` run from `apps/api`
  after the final edit — **pass**, exit 0, no output.
- `pnpm arch:check` — **pass** — `OK — 11 rule(s) over 2031 file(s)`.
- `pnpm lint:duplication` — **pass** — 0.98% (threshold 2%). The first version of the
  helper produced one 12-line clone against `encrypt.ts`'s `concatBytes`; the helper's
  concatenation was rewritten (`Uint8Array.from(parts.flatMap(...))`) so the oracle shares
  no code with the sender it checks. The report now lists **0** clones involving it.
- `pnpm gitleaks detect --no-git --source apps/api/src/slices/notifications/adapters/webpush …`
  — **pass** after the allowlist entry (before it: 1 finding, `generic-api-key`, the
  RFC auth secret). Also scanned `.gitleaks.toml` itself: no leaks.
- `pnpm lint:unused` (knip) — reports one unused file,
  `packages/config/vitest.package.config.ts`, plus a wrangler config hint; neither is this
  task's. No export or file added here is flagged.

### Pasted proof — the oracle decrypts RFC 8291 Appendix A, run BEFORE any round-trip test existed

```
 RUN  v4.1.8 /workspace/popper-mobile/.superset/projects/HushBox/apps/api

 ✓ |api| src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts > RFC 8291 decryptor > decrypts the RFC 8291 Appendix A body to the specification plaintext 65ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

At that moment the test file contained exactly one test: RFC Appendix A body + RFC
receiver keys in, the string `When I grow up, I want to be a watermelon` out.

### Pasted proof — negative controls fail as required

RED, before the padding checks existed (the oracle wrongly returned data):

```
- Error {
-   "message": "rejected promise",
- }
+ Uint8Array [
+   0, 0, 0, 0, 0, 0, 0,
+ ]
 ❯ src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts:162:62
 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)
```

GREEN, final state of the whole file:

```
 ✓ … > RFC 8291 decryptor > decrypts the RFC 8291 Appendix A body to the specification plaintext 5ms
 ✓ … > Web Push bodies this sender produces > decrypt back to the plaintext across independently generated subscriptions 52ms
 ✓ … > Web Push bodies this sender produces > decrypt back to the plaintext at the maximum payload size 6ms
 ✓ … > bodies an independent receiver must reject > rejects a body whose ciphertext has one flipped bit 2ms
 ✓ … > bodies an independent receiver must reject > rejects a body decrypted with the wrong authentication secret 2ms
 ✓ … > bodies an independent receiver must reject > rejects a record whose padding delimiter is not the last-record value 2ms
 ✓ … > bodies an independent receiver must reject > rejects a record that contains no non-zero octet 1ms

 Test Files  4 passed (4)
      Tests  32 passed (32)
```

### Pasted proof — gitleaks

Before the allowlist entry:

```
Finding:     authSecret: 'REDACTED'
RuleID:      generic-api-key
Entropy:     4.095795
File:        apps/api/src/slices/notifications/adapters/webpush/__tests__/rfc8291-decryptor.test.ts
Line:        23
12:15AM WRN leaks found: 1
```

After (scan of the whole `webpush/` directory, and of `.gitleaks.toml` itself):

```
12:43AM INF scanned ~47099 bytes (47.10 KB) in 79.9ms
12:43AM INF no leaks found
...
12:43AM INF scanned ~0 bytes (0) in 79.1ms
12:43AM INF no leaks found
```

## Acceptance criteria

- **Decryptor verified against RFC 8291 Appendix A in the decrypt direction first, then
  used as the oracle** — **met**. Evidence: the pasted single-test run above, taken before
  the round-trip tests existed; the file's derivation table cites the RFC sections, and the
  helper imports nothing from `encrypt.ts` (its only import is `@hushbox/shared`'s base64
  codec, which takes no part in the key schedule).
- **Round-trip over freshly generated P-256 subscription keypairs, random auth secrets and
  random salts, several independent iterations** — **met**. 25 iterations, each generating a
  new subscription key pair, a new auth secret, a new salt, a new ephemeral sender key and
  a random-length random plaintext, plus a maximum-payload-size case.
- **At least one negative control that must FAIL to decrypt** — **met**, four of them: a
  flipped ciphertext bit, a wrong auth secret, a non-final padding delimiter, and a record
  with no non-zero octet. The last two were RED before the corresponding checks were
  written, which is direct evidence the oracle is not a pass-through.
- **Test-only, no production code changes, no new dependency** — **met**. Only WebCrypto
  (`crypto.subtle`), as `encrypt.ts` already uses; `package.json` untouched.
- **New fixed test secret AND-pinned in `.gitleaks.toml`; gitleaks run on the new files** —
  **met**. One new entry, path-and-value pinned in the shape of the four existing webpush
  entries; gitleaks pasted above.

## Deviations

None from the criteria. Two implementation choices worth naming:

- The helper exports `deriveRecordKeys` in addition to the decrypt entry point. Without it
  the two padding negative controls are unreachable: our sender never emits a delimiter
  other than `0x02`, so the only way to present the receiver with one is to forge a record
  from the receiver's own derived keys. That is the same derivation the decrypt path uses,
  so the forged fixtures cannot drift from it.
- The oracle validates `rs >= 18` and the `keyid` point form even though those branches
  have no dedicated test. They are single-line spec MUSTs on the parse path, exercised on
  every passing decrypt; the file is coverage-excluded, so they impose no gate cost.

## Concerns and limitations

- **CAVEAT, as required by the plan: this proves the CRYPTO and the wire format only.** It
  says nothing about whether a real push service accepts our HTTP request — the endpoint
  URL, `TTL`, `Topic`, `Urgency`, `Content-Encoding` headers and the VAPID `aud`/`sub`
  claims are untouched by this task. A body can be perfectly RFC-8291-correct and still be
  rejected at the HTTP layer.
- It also does not prove any real user agent's implementation agrees with the RFC; it
  proves ours agrees with an independent reading of the RFC that reproduces the RFC's own
  vector.
- The round-trip's randomness is per-run (`crypto.getRandomValues`), not seeded. That is
  deliberate — the point is arbitrary inputs, not one fixed case — but it means a failure
  would need the reported bytes to reproduce exactly. The fixed anchor test is fully
  deterministic.
- The concurrent edits by Tasks 18/20 and the estimator workstream mean `pnpm test:api`
  and `turbo lint --filter=@hushbox/api` cannot be green from this task alone right now;
  see the attribution above.

## Confidence

**High.** The anchor decrypt of the published vector was obtained before our encryptor was
read at all, the round-trip covers randomized inputs including the size boundary, and two
of the four negative controls were demonstrated RED before their checks existed. Every
scoped check that is within this task's ownership is green.
