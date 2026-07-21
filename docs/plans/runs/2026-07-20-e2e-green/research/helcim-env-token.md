# helcim-env-token — .env.development VITE_HELCIM_JS_TOKEN leak assertion

## Failure
`scripts/generate-env.test.ts:132` — test "does not include CI/prod secrets" fails:
generated `.env.development` now contains `VITE_HELCIM_JS_TOKEN="mock-helcim-js-token"`,
but line 132 asserts `expect(content).not.toContain('VITE_HELCIM_JS_TOKEN')`.

## Q1 — introduced this run?
Not by Task-05 Helcim work. The var registration is pre-existing.
Commit `a551243a` ("audit remediation fixes 2") ADDED a Development literal
`[Mode.Development]: 'mock-helcim-js-token'` + `[Mode.CiVitest]: ref(Development)` to
`packages/shared/src/env.config.ts:473`. Previously it had no dev value, so the generator
never emitted it into `.env.development` and the stale assertion passed by accident.
Working tree has NO uncommitted diff to env.config.ts — the break is baked into a551243a.

## Q2 — public or secret?
PUBLIC by design. `VITE_HELCIM_JS_TOKEN` is `to: [Destination.Frontend]` (env.config.ts:473).
`VITE_` prefix ⟹ bundled into the client bundle intentionally. This is the Helcim.js
publishable/tokenization token used in-browser to init the card-tokenization iframe.
The real server SECRET is a SEPARATE var `HELCIM_API_TOKEN` (env.config.ts:345,
Destination.Backend, uses secret() for CI/prod) and is correctly excluded from the frontend.
Prod/CiE2E values of VITE_HELCIM_JS_TOKEN use secret() only to avoid hardcoding the string,
not because it is server-confidential.

## Q3 — what :132 asserts
Blanket `not.toContain('VITE_HELCIM_JS_TOKEN')`. The test's real purpose (name: "does not
include CI/prod secrets") is to keep BACKEND secrets out of the frontend file — the other
three asserts (RESEND_API_KEY, OPENROUTER_API_KEY, HELCIM_API_TOKEN) are all Backend-only.
The VITE_HELCIM_JS_TOKEN assertion is over-broad/STALE: it forbids a legit public frontend
var that the sibling test "all variants include VITE_HELCIM_JS_TOKEN from envConfig" (:1326)
requires to be emitted. No real leak — HELCIM_API_TOKEN (the secret) is still excluded.

## Q4 — VERDICT
(a) STALE TEST. VITE_HELCIM_JS_TOKEN is a legitimate public frontend var; emitting it into
`.env.development` is correct. Fix: delete the single assertion line
`scripts/generate-env.test.ts:132` (`expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');`).
Keep lines 129–131 (RESEND_API_KEY / OPENROUTER_API_KEY / HELCIM_API_TOKEN) — they preserve
the test's real purpose of catching server-secret leaks into the frontend.
