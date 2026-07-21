# Task-05 — Helcim mock must drive the app's tokenization contract

## Objective

Unfreeze the 5 RC-A billing e2e tests. The mock set hidden-input `.value`s (a
property write), which produces no MutationRecord in a real browser, so the
app's `#helcimResults` MutationObserver never fired and the charge POST never
dispatched. Replace the incidental-DOM-mutation contract with one both the real
Helcim.js path and the mock genuinely satisfy.

## Contract choice (AC-1) — typed tokenization-complete signal, justified

I chose the **typed signal** (the preferred option), not the "make the mock
mutate the DOM structurally" fallback. Justification comes from reading the real
loader path:

- The real Helcim.js v2 `helcimProcess()` (downloaded and inspected from
  `https://secure.myhelcim.com/js/version2.js`) **returns a Promise**. On
  success it writes the result fields into `#helcimResults` via
  `innerHTML = helcimParseXMLtoFields(responseXML)` and then `resolve(...)`s;
  on validation/communication failure it sets `#helcimResults.innerHTML` to a
  plain-text error and **`reject`s with that string** (never an `Error`).
- So the real script already exposes a completion signal that does not depend
  on anyone observing DOM mutations: awaiting the returned Promise. The mock can
  satisfy the identical contract by writing its result fields synchronously and
  returning (its Promise resolves immediately).
- The old MutationObserver approach was doubly fragile: it depended on the real
  script's `innerHTML` replacement *incidentally* producing a MutationRecord,
  and the mock's `.value` property writes never produce one in a real browser.
  Awaiting the call is the one contract both paths honestly meet.

New seam: `tokenizeWithHelcim()` in `helcim-loader.ts` — awaits
`globalThis.helcimProcess()`, then reads the DOM result via the existing
`readHelcimResult()`. A **string** rejection is treated as a completed-with-
failure tokenization (Helcim's own error contract) and mapped to a failure
`HelcimTokenResult`; any non-string throw is a trigger defect and propagates to
the caller (surfaced on the retryable error card, since nothing was charged).

## Files changed

- `apps/web/src/lib/helcim-loader.ts` — added `tokenizeWithHelcim()` (the typed
  contract over both tokenizer paths) and the program-wide `helcimProcess`
  global declaration widened to `() => unknown` (real returns a Promise, mock
  returns undefined).
- `apps/web/src/lib/helcim-mock.ts` — removed its now-duplicate `helcimProcess`
  global declaration (moved to the loader, single source). No behavior change:
  the mock still writes the same result fields; those writes are now consumed
  via the awaited-Promise contract, not an observer.
- `apps/web/src/components/billing/payment-form.tsx` — deleted the
  `#helcimResults` MutationObserver effect, `observerRef`, and
  `expectingTokenizationRef`; `handleSubmit` now calls
  `runTokenizationAndCharge()` (async) which `await`s `tokenizeWithHelcim()`
  then the existing `handleTokenizationResult()`. Charge/settlement logic
  (`initiatePayment.mutateAsync`, awaiting-webhook polling, unconfirmed/terminal
  states) is untouched.
- `apps/web/src/lib/helcim-loader.test.ts` — added a `tokenizeWithHelcim`
  describe (6 cases: not-installed rejects; sync mock resolve; async
  Promise-returning resolve; string reject → failure result; empty-string reject
  → generic message; non-string reject rethrows).
- `apps/web/src/components/billing/payment-form.test.tsx` — migrated the mocked
  seam from `readHelcimResult` to `tokenizeWithHelcim` (mockResolvedValue /
  mockRejectedValue); removed the now-obsolete `helcimProcessSuccess` DOM helper
  and the two "mutation observer guards" describes (the observer no longer
  exists); processing-state and processor-missing tests re-expressed against the
  new seam.
- `apps/web/src/components/billing/payment-form.helcim-contract.test.tsx` —
  **new** parity/readiness contract test (AC-3): the enforcement rung.

## Enforcement rung (AC-3)

`payment-form.helcim-contract.test.tsx` is a **web unit/component** test (not
e2e), so mock↔form drift fails at merge. It renders `PaymentForm` in local-dev
mode with the **real** `helcim-loader` and `helcim-mock` (only env and the
billing hooks are mocked), clicks the real simulate-success / simulate-failure
dev buttons, and asserts the charge mutation is dispatched with a
mock-minted token / the form reaches terminal success / a declined mock card
reaches terminal error without dispatching a charge.

Critically, it installs a `BrowserFaithfulMutationObserver` that refuses to
observe `#helcimResults`. Rationale: jsdom (verified v28) reflects
`input.value = …` property writes into the `value` content attribute and fires
an attribute MutationRecord — real browsers never do. That infidelity is exactly
what let the old observer approach look green in unit tests while freezing in a
real browser. Neutralizing it means the test passes only through the typed
loader signal — so if anyone reintroduces observer-on-`#helcimResults`
dependence, this test fails.

## TDD verification

- RED 1 (component): wrote the contract test first. It passed immediately at
  first because jsdom's `.value`→attribute reflection fired the observer — a
  false green that proved the infidelity. Added `BrowserFaithfulMutationObserver`
  to make it faithful; re-ran → **3 failed** ("stuck at Processing…", charge
  never dispatched) — the exact production symptom. Verified RED for the right
  reason.
- RED 2 (loader): added the `tokenizeWithHelcim` describe → **6 failed**
  (`tokenizeWithHelcim is not a function`). Verified RED.
- GREEN: implemented `tokenizeWithHelcim`, rewired `payment-form.tsx` →
  loader+mock tests 31/31, contract test 3/3, full payment-form 70/70.

## Self-gate

- `pnpm test:watch run` payment-form.test.tsx — **pass** (70/70).
- `pnpm test:watch run` the 4 affected files — **pass** (104/104).
- `pnpm test:watch run` helcim-loader.test.ts + helcim-mock.test.ts — **pass**
  (31/31).
- `turbo typecheck lint --filter=@hushbox/web --force` — **pass** (2/2 tasks).
- `eslint` on the 6 owned files (from apps/web) — **pass** (exit 0). Two
  justified `eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors`
  in helcim-loader.test.ts pin the real Helcim.js **string**-rejection contract
  (rejecting with a string is the behavior under test, not a defect).
- `jscpd` on changed paths — **pass** (0 clones).
- `pnpm e2e e2e/billing/billing.spec.ts` (under the run lock, foreground) —
  see "E2E proof" below.

## Acceptance criteria

1. Tokenization signalled through a contract both paths satisfy — **met**
   (typed `tokenizeWithHelcim` awaiting the real script's Promise; justified
   above).
2. TDD failing test first, no timeout raises anywhere — **met** (RED verified
   for both new suites; no `timeout`/wait constants touched).
3. Enforcement rung lives in the web suite — **met**
   (`payment-form.helcim-contract.test.tsx`, a component test).
4. Proof: billing spec RC-A tests green — **deferred to the orchestrator's
   consolidated e2e run** (see E2E proof). Proven at the closest layer by the
   enforcement rung; Task-06's unauthenticated-token test is out of scope.

## E2E proof

**Deferred to the orchestrator's consolidated run.** Per-task e2e is deprecated
for this run: `pnpm e2e` resets the shared local DB and would corrupt other
tasks' in-flight vitest, and the shared `e2e-run.lock` was heavily contended by
many parallel implementers (a 10-min foreground window could not win it). The
orchestrator will confirm `e2e/billing/billing.spec.ts` on the central pass.
The RC-A fix is proven at the closest layer (the new
`payment-form.helcim-contract.test.tsx` enforcement rung reproduces the exact
"stuck at Processing…, no charge POST" freeze and is made green by the fix).

Residue to expect on that central run: the
`unauthenticated-user-completes-payment-via-billing-token` test is **Task-06's**
scope (RC-C, missing `Idempotency-Key`), not RC-A — attribute, do not chase.

## Deviations

None from the acceptance criteria. The contract test's
`BrowserFaithfulMutationObserver` is an added test-fidelity guard (not a
deviation) — without it jsdom's non-browser `.value` reflection would let the
enforcement rung pass vacuously.

## Concerns and limitations

- The contract test uses a jsdom-fidelity shim (`BrowserFaithfulMutationObserver`)
  rather than a real browser. It is a faithful negative (blocks the exact jsdom
  infidelity); the true cross-browser proof is the e2e run in the proof section.
- `handleTokenizationResult` retains its own try/catch around the charge
  mutation (unchanged) — the new `runTokenizationAndCharge` catch only handles
  tokenization-phase throws, so the charge-phase "unconfirmed" no-re-charge
  semantics are preserved.

## Confidence

High — the fix matches the real Helcim.js v2 Promise/`resolve`/string-`reject`
contract inspected directly from the live script; all scoped checks pass; the
enforcement rung fails on the exact regression class it guards.
