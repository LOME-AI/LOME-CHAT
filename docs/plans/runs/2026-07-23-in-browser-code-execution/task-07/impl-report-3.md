# T7 — Security containment tests — impl report 3

## Objective

Close the validated audit finding: the certification suite had NO assertion for
the credential-free-sandbox-origin invariant (DOCUMENTS.md §Security model
invariant 4 — "The sandbox origin never serves anything requiring credentials"),
the one the founder-approved subdomain decision was gated on. impl-report-1
claimed this was "folded into the header pin"; it was not. Add the missing
Set-Cookie assertion to the existing header-pin test so a future cookie-setting
endpoint on the sandbox origin fails a test before review.

## Files changed

- `e2e/security/document-sandbox-containment.spec.ts` — in the existing
  header-pin test (`the served sandbox CSP and headers match the shipped policy
  exactly`), added `expect(response.headers()['set-cookie']).toBeUndefined()` on
  the `/render.html` response the test already fetches, with a durable comment on
  WHY the credential-free origin is what makes the subdomain safe (a Set-Cookie
  would create a cookie jar that could bleed across the app/sandbox boundary and
  is also what makes the origin's `*` CORS safe). No new server, no test reshape,
  no new fetch.

## Tests added

- (assertion added to existing test) `the served sandbox CSP and headers match
  the shipped policy exactly` — now also asserts the sandbox origin's response
  carries no `Set-Cookie` header — covers DOCUMENTS.md §Security model invariant 4
  (credential-free origin), the subdomain-gating invariant.

## Self-gate

- `tsgo --noEmit` (from `e2e/`, after last edit) — pass (exit 0).
- `eslint security/document-sandbox-containment.spec.ts` (from `e2e/`, after last
  edit) — pass (exit 0).
- Full E2E suite through the runner — NOT run (founder owns the close-phase E2E
  run; stack not started for this small fix). The assertion is grounded in the
  shipped policy: `apps/sandbox/public/_headers` sets no `Set-Cookie` and its own
  comment states "This origin serves no credentials and reads no cookies" (the
  stated justification for the `*` CORS), so the pin passes against reality and
  would go red if a cookie-issuing endpoint were ever added to the origin.

## Acceptance criteria (this fix)

- Set-Cookie/credential-free assertion exists on a sandbox-origin response in the
  pin test — MET. The assertion inspects `response.headers()['set-cookie']`
  (Playwright lowercases header keys) on the `/render.html` GET the header-pin
  test already performs and requires it undefined.
- Kept to the response the test already fetches; no new server, no reshape — MET.
- Durable WHY comment, no run-internal labels — MET.

## Deviations with reasons

- Did not add a separate "sandbox origin does not reflect credentials" request.
  The brief made that conditional on the harness making it easy; the header-pin
  test uses a raw `request.get` (no credential context to reflect), and localhost
  cookie jars are host-scoped/port-independent so the production subdomain
  isolation is not reproducible in e2e (noted in impl-report-1). The faithful,
  achievable pin is the no-Set-Cookie assertion on the already-fetched response,
  which is exactly what invariant 4 states.

## Concerns and limitations

- Same as prior reports: the full fixture-stack run is the founder's close gate;
  this assertion was gated statically (tsgo + eslint) and grounded in the shipped
  `_headers`, not executed through the runner.

## Confidence

High. The assertion is a one-line, exact-match header inspection on a response
the test already fetches; it is grounded in the shipped `_headers` (no Set-Cookie,
explicitly credential-free); both static gates are green.
