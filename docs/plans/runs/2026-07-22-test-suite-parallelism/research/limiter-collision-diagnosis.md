# Diagnosis — concurrency breakage root cause (analyst)

## PREMISE CORRECTION (load-bearing)
The "shared un-namespaced Redis limiter key" hypothesis is NOT supported by code for the probe.

- Domain limiters key on PER-ACCOUNT-UNIQUE values (userId/email/token) — distinct accounts ⇒ distinct keys. (keys.ts:100-242, 165-180)
- The only genuinely shared key is the per-IP limiter's `hash('unknown')` sentinel (rate-limit.ts:66-77) — BUT the probe's `createApp()` (routes.integration.test.ts:258-263) does NOT mount the IP limiters (they live in app.ts:518-526 composition root). So that shared key is never written in the probe.
- Probe has ZERO sleeps/fake-timers.

## Actual root cause (Inferred, high confidence)
- 20 of 21 failures = `Test timed out in 15000ms` (NOT assertions). Real OPAQUE + Postgres(WS proxy) + Redis-HTTP serialized under 12-wide concurrency; cpu ~144% (~1.5 cores) ⇒ heavy crypto CPU queues past the 15s timeout. This is CONTENTION, not collision.
- The lone 429-vs-200 (enumeration `verification resend`) could NOT be traced to a shared key (per-email-unique, fresh accounts). UNEXPLAINED — likely a retry:1 timing artifact. MUST be instrumented (log the actual limiter key) before any "fix."

## Real collision class = elsewhere, already isolated
Full-app rate-limit suites mount shared limiters but already use the house pattern: per-test `uniqueIp()` (app-auth-rate-limit.integration.test.ts:53-98 — gold standard). Two files use file-scoped identifiers (app-share-read-rate-limit IP randomUUID; app-admin-rate-limit ADMIN_EMAIL) but no current file has two concurrent tests driving the SAME limiter def with a shared id ⇒ latent risk only.

## Options (analyst)
- A — per-test-unique identifier discipline (house pattern). Scope ~0-3 files (codify rule + optionally hoist 2 file-scoped ids). Does NOT fix the contention timeouts.
- B — tune concurrency/timeout for heavy-crypto suites (raise testTimeout, and/or lower maxConcurrency, and/or mark heavy describes non-concurrent). Fixes the DOMINANT 20/21 timeouts. Scheduling-only ⇒ preserves ALL security assertions verbatim. ~1 config change + a few describe annotations.
- C — global per-test Redis key namespace via AsyncLocalStorage. REJECTED: invasive (app builds its own Redis client from env), AND doesn't fix contention majority.
- D — fake clock: REJECTED (no test waits on a window; would weaken window semantics).
- E — inter-test Redis flush: REJECTED (incompatible with sequence.concurrent).

## Recommendation: B primary + A as standing invariant. NOT C.
Security fidelity: B is scheduling-only (safe). C/D/E touch state/clock the tests assert on. Any isolation touching limiter keys/TTLs/clock MUST re-prove enumeration-timing equivalence + exact-cap boundaries — do not relax those to make concurrency pass.

## Orchestrator note (tension to resolve)
B's "mark heavy suites non-concurrent" would REMOVE the speedup on exactly the slow OPAQUE tests we want faster. The speedup-preserving knob is RAISE testTimeout (+ tune maxConcurrency) so contention-queued tests still complete: the concurrent batch finishes faster than serial while no test blows the (raised) timeout. That is the config-tuning experiment to run — likely NO test rewriting needed for cluster B.
