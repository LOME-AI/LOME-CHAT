# Task 28 — impl report 1

## Objective
Remove the stale, internally-contradictory assertion `expect(content).not.toContain('VITE_HELCIM_JS_TOKEN')` from the "does not include CI/prod secrets" test in `scripts/generate-env.test.ts`, without weakening the real backend-secret-leak guards. `VITE_HELCIM_JS_TOKEN` is a PUBLIC frontend var (VITE_ prefix, Destination.Frontend, Helcim.js publishable tokenization token) legitimately emitted into `.env.development`; a sibling test requires it to be emitted.

## Files changed
- `scripts/generate-env.test.ts` — deleted the single line `expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');` (was line 132) from the frontend `.env.development` "does not include CI/prod secrets" test.

## Tests added
None. This corrects a stale assertion in an existing test (a wrong assertion, not a coverage gap). No production code changed, so no new test is warranted.

## Self-gate
- `cd scripts && npx vitest run generate-env.test.ts` — pass — Test Files 1 passed (1), Tests 106 passed (106).
- `cd scripts && npx eslint generate-env.test.ts` — pass — exit 0.

## Acceptance criteria
- Stale `VITE_HELCIM_JS_TOKEN` assertion removed — met (line deleted).
- The three real backend-secret guards remain intact in the same test — met. Confirmed present at lines 129–131:
  - `expect(content).not.toContain('RESEND_API_KEY');`
  - `expect(content).not.toContain('OPENROUTER_API_KEY');`
  - `expect(content).not.toContain('HELCIM_API_TOKEN');`
- No other test or assertion touched — met (single-line deletion only).
- Scripts test file passes; "does not include CI/prod secrets" green and all others green including the real-secret guards — met.

## Deviations with reasons
None.

## Concerns and limitations
None. The change is a one-line deletion; `packages/shared/src/env.config.ts` was not touched (out of bounds, and correct as-is per brief).

## Confidence
High — the deleted assertion was contradicted by a sibling test (line ~1326, `all variants include VITE_HELCIM_JS_TOKEN from envConfig`) and by the correct app behavior; the three backend guards are verified present and the full scripts test file passes (106/106) with eslint exit 0.
