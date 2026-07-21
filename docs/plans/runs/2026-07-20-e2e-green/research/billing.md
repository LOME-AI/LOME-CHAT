# Billing cluster diagnosis (run 2026-07-20T05-25-42, iphone-15)

7 failures → 3 root causes. (Persisted by orchestrator from the Explore diagnostician's inline return.)

## RC-A — Mock Helcim tokenization never fires the app's MutationObserver (5 tests)

Tests: simulates-successful-payment, simulates-failed-payment, completes-full-payment-flow, handles-declined-card, validates-real-helcim-webhook-signature.

Evidence: all 5 freeze at "Processing payment…" (button disabled); network trace has NO `POST /billing/payments` — tokenization never resolved. Mechanism: `payment-form.tsx:685-703` handleSubmit → `globalThis.helcimProcess()`; the only tokenization→charge path is the MutationObserver at `payment-form.tsx:597-631` observing `#helcimResults` `{childList, subtree, attributes}`. The mock (`apps/web/src/lib/helcim-mock.ts:26-31,40-73`) sets hidden inputs via the `.value` **property** + a bubbling `change` event — neither produces a MutationRecord → observer never fires → stuck forever. Real Helcim.js injects nodes (CI passes) — mock↔prod drift. Both `@local-only` and `@webhook` tests run the mock under `e2e:fast` (env.isLocalDev → `loadHelcimScript({useMock:true})`, payment-form.tsx:440,571).

Defect: harness/mock (`helcim-mock.ts`); secondary: app waits on an incidental DOM mutation rather than a typed readiness signal. Violates mock-parity + typed-readiness pillars.

Fix: make the mock produce the same observable structural mutation the real script does — or better, replace the DOM-observer contract with a typed tokenization-complete signal emitted by both the real loader and the mock, contract-tested. Never a longer timeout.

Enforcement: contract test asserting mock tokenization drives the form to a terminal state and dispatches `POST /billing/payments`.

## RC-B — Free-allowance fall-through refused: Smart-Model worst-case ceiling >> 5¢ allowance — INTENT CONFLICT (1 failed + 1 serial-skipped)

Test: group-chat-billing "member budget exhausted: falls through to free allowance" (+ serial sibling skipped).

Evidence: `POST /chat` → 402 `{"code":"INSUFFICIENT_ADMISSION"}`. Mechanism: member budget 0 → fall-through to self-funding → free wallet → only the daily-allowance scope (5¢ = `DAILY_ALLOWANCE_NANO_USD`, billing/domain/constants.ts:21) gates admission (free wallets skip balance, admission.ts:218). Admission holds the Smart Model's full-context worst-case ceiling (estimate-run.ts:295-306,356-386; runtime.ts:472-484) — orders of magnitude above 5¢ → budget-exceeded, structurally always.

CONFLICT: test expects a free-tier member to complete a turn on the 5¢ allowance; admission doctrine reserves full-context worst case for the default Smart Model. Ruling options: (a) free tier defaults/pins to a bounded model whose ceiling fits the allowance; (b) free-tier admission prices a bounded per-turn ceiling; (c) the test selects a cheap bounded model. Billing-sensitive; do not fix until ruled.

Enforcement after ruling: contract test pinning "free-tier default-model worst-case admission ceiling ≤ daily allowance".

## RC-C — `POST /billing/login-link` 400: missing `Idempotency-Key` (1 test)

Test: unauthenticated-user-completes-payment-via-billing-token, fails at `billing.spec.ts:273` (`expect(response.ok())`).

Evidence: trace shows 400 Bad Request → `IDEMPOTENCY_KEY_REQUIRED` (middleware.ts:133-140; route non-exempt at billing/routes.ts:204-221). Test call sites `billing.spec.ts:272,325` (via `billingTokenRequest` fixture, e2e/fixtures.ts:1147-1155) attach no header; other helpers do (helpers/budget.ts:140,158, helpers/banner.ts:61).

Defect: test code. Fix: shared wrapper auto-attaching a fresh `Idempotency-Key` on all E2E raw mutating requests; use at both call sites. Enforcement: lint banning raw mutating request-context calls in e2e/ that bypass the wrapper.
