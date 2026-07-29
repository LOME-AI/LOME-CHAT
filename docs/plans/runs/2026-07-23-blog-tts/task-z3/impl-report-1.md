# impl-report-1 — Deduplicate model-host string; remove browser restriction

## Objective

Two independent fixes in `e2e/marketing-roadmap.spec.ts`:

1. Replace the twice-hardcoded `huggingface.co` route pattern with the shared constant
   the CSP allowlist derives from.
2. Remove the `@chromium-only` tag so the spec runs on every configured project.

No behaviour change beyond those two; no new dependency; no assertion weakened, added,
or removed; no new timeout.

## Files changed

- `e2e/marketing-roadmap.spec.ts` — imports `TTS_MODEL_HOST` from `@hushbox/shared` and
  builds both `page.route` patterns from it; drops the `@chromium-only` describe tag.

_(RESULTS PENDING)_
