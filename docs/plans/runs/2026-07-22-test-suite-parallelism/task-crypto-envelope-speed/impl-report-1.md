# impl-report-1: crypto-envelope-speed

## Objective

Make `envelope > decryptContentEnvelope > round-trips a 5 MiB plaintext` comfortably fast
under coverage (well below the 30s fork-contention timeout) without weakening what it
proves — that a large multi-block plaintext round-trips to exact bytes.

## Files changed

- `packages/crypto/src/envelope.test.ts` — replaced the 5M-element
  `expect(decrypted).toEqual(large)` deep-equal with a native
  `expect(Buffer.compare(Buffer.from(decrypted), Buffer.from(large))).toBe(0)`. Kept the
  existing `expect(decrypted.length).toBe(5 * mib)` length assertion. Payload unchanged at
  5 MiB.

## What actually caused the slowness

Contrary to the brief's "two sources" hypothesis (deep-equal + genuine encrypt/deflate
compute), the deep-equal was essentially the entire cost. Measured deltas below show the
encrypt/round-trip compute is ~692ms; the remaining ~18.35s was the JS deep-equal.

Note: `envelope.ts` does a single-shot `xchacha20poly1305(contentKey, nonce, aad).encrypt(plaintext)`
(envelope.ts:63) with no application-level per-chunk framing and no deflate step in this
file (the "compress-then-encrypt" doc comment is descriptive of the scheme, not implemented
here). "Multi-block" therefore means ChaCha20's internal 64-byte cipher blocks — any
plaintext > 64 bytes crosses many blocks. The 5 MiB payload spans ~81920 cipher blocks, so
the multi-block path is exercised overwhelmingly.

## Measurement (coverage run, in isolation)

Command: `pnpm exec tsx scripts/with-env.ts vitest run --root packages/crypto --coverage src/envelope.test.ts`

- Before (deep-equal): 5 MiB test = **19044ms**
- After (Buffer.compare): 5 MiB test = **692ms**

692ms is far under the ~12s stop-here ceiling, so **step 1 alone sufficed**. The 5 MiB
payload was kept; no shrink was performed. Byte-exactness is preserved — `Buffer.compare`
returning 0 proves every one of the 5,242,880 bytes matches, the same strength as the deep
equal, and length is still asserted separately.

## Self-gate

- `vitest run --root packages/crypto --coverage src/envelope.test.ts` — pass — 21/21 tests
  green; file Duration 1.09s.
- `pnpm exec turbo typecheck lint --filter=@hushbox/crypto` — pass — 2/2 tasks successful.

Note: the isolated single-file coverage run prints global-threshold coverage errors
(63% lines) because only one file of the package is executed — an artifact of running one
file, not a regression from this change. The full-package `pnpm test:crypto` run is the
gate that satisfies the threshold; this change touches only a test assertion and adds no
production lines.

## Acceptance criteria

- Test comfortably fast under coverage (≤ ~12s target for margin under 30s timeout) — MET:
  692ms.
- Strength preserved (large multi-block plaintext round-trips to exact bytes) — MET: 5 MiB
  payload retained (~81920 ChaCha20 blocks), byte-exact equality via `Buffer.compare` plus
  length assertion.
- No timeout raised, no payload dropped below the multi-block threshold — MET: neither was
  changed.

## Deviations

None. Stopped at step 1 per the brief's instruction (measured ≤ ~12s → keep 5 MiB, done).

## Concerns and limitations

The brief anticipated needing to shrink the payload because it assumed real encrypt/deflate
compute was a second major cost; measurement showed it is not (~692ms), so the payload was
kept at full 5 MiB with ample margin.

## Confidence

high — measured before/after under coverage; the assertion change is byte-exact-equivalent
to the deep-equal; typecheck and lint clean.
