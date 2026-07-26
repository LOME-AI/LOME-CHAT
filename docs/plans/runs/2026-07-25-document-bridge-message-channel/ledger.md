# Ledger — document bridge MessageChannel

Orchestrator-only. Append-terse, one line per transition.

- Phase 1: bug root-caused by orchestrator before the run — parent posts to an opaque-origin frame with
  an explicit targetOrigin; every parent→frame message silently dropped. Verified in Chromium against the
  live dev sandbox. Alternatives `'null'` (throws) and `'/'` (dropped) verified dead; `allow-same-origin`
  refused.
- Phase 1: bridge surface mapped by explorer. Key facts — both bundles are esbuild IIFE so module state
  is already unreachable from `window`; `packages/shared/src/documents/bridge.ts` is transport-agnostic
  (no change needed); drift tests are byte-exact rebuild-and-diff; blast radius is 22 render browser
  tests + 11 python browser tests + 105 web unit tests + the streaming-preview tests.
- Phase 1: two load-bearing unknowns probed empirically, both green. (1) `MessageChannel` works in
  apps/web vitest — it is Node 22's native class leaking through happy-dom, and a port injected via
  `MessageEvent{ports}` arrives usable. (2) Opacity comes from the `sandbox` attribute alone, so test
  harnesses need one server, not two; the one-shot `ready` does not queue, so a harness must install its
  listener before attaching the iframe.
- Phase 1: plan.md written. Tier 2, five tasks, T1/T3 parallel.
- Phase 2: plan approved by founder.
- T1 → implementing (render bootstrap + shared embed harness + 22 browser tests + bundle).
- T3 → implementing (parent component + 105 unit tests + streaming-preview tests), parallel with T1.
- T1 → implemented. Self-gates green (157 tests, typecheck+lint 2/2, eslint 0, jscpd 1.02%). Render tests
  22→26. Bundle regenerated. Four items raised → recorded as plan amendments A1–A4: the vitest.config.ts
  coverage exclusion accepted as in-scope; the embed-harness/browser-harness duplication assigned to T2 as
  a hard criterion; three harness facts (localhost-not-127.0.0.1 for frame-ancestors, Node-side polling vs
  the mocked clock, probeFrame over page.evaluate) hoisted so T2 cannot rediscover them the hard way; the
  Chromium-only CSP `'self'` observation recorded as test-only, never a production dependency.
- T1 → auditing. 3-lens panel dispatched (correctness, security, conventions).
- T3 → implemented. Self-gates green (web suite 6397 tests, typecheck+lint, eslint 0, jscpd 0 clones,
  document-sandbox.tsx 99.21/97.91/100/99.1). Hijack guard is `if (portRef.current) return`, reset only by
  `stop()`. Two items raised → amendments A5, A6.
- A5 is the run's most dangerous finding: `port.start()` is mandatory in browsers under `addEventListener`
  (the repo's unicorn rule forbids the `onmessage` assignment form), but BOTH vitest environments get
  Node's auto-starting MessagePort — T3 proved a deleted `start()` leaves the whole suite green. A missing
  call would reproduce the original bug in a new form, invisible to every test in the repo. Auditors must
  verify by reading; only the founder-run e2e can execute it. T1's frame side is partly self-protecting
  (real Chromium); T3 and T4 are not.
- A6: my plan's "105 tests" for document-sandbox.test.tsx was a planning miscount — real counts 44→52 and
  10→10. Binding criterion (nothing weakened or deleted) unaffected; auditors judge against real counts.
- T3 → auditing. 3-lens panel dispatched.
- T1 security lens → FAIL. Security core itself passed at 0.95, verified in the BUILT artifact not just
  source: one wildcard, no window listener, port unreachable from the frame realm, neutralize-first
  ordering intact, no policy relaxed. Two findings.
- T1 conventions lens → FAIL. Conventions passed; failed on scope for the same misattributed item.
- RULING — `reportReactFailure` guard ordering (Important, raised independently by both lenses): INVALID,
  misattribution. Both auditors baselined on `git show HEAD`; the tree is entirely uncommitted, so HEAD
  predates the prior run. Verified: the 2026-07-23 run's task-19 report states it moved the guard to cover
  both branches deliberately, to make the existing docblock true, and verified 3/3 that two sibling
  effects throwing in one commit round yield exactly one error rather than going silent. Not T1's change.
  Not reverted — AGENT-RULES forbids reverting work we did not make. Process fixed at the source:
  amendment A7 defines the audit baseline as the working tree at run start and lists every pre-existing
  uncommitted delta; sent to all five in-flight auditors.
- RULING — stale intake comment at `render/bootstrap.ts:528-530` (Minor, conventions): VALID. The comment
  still says the sender's origin is deliberately unchecked and "authentication is by message shape alone".
  Both clauses are now false — a port message carries `origin === ""`, and possession of the port IS the
  authentication. It contradicts the file's own header and sits on the intake line, where it reads as
  licence to reinstate a shape-validated window listener. On a trust boundary that is worse than no
  comment. → fix.
- RULING — path traversal in `embed-harness.ts:130,160` (Minor, security): VALID. `decodeURIComponent`
  runs after `new URL()` normalizes, so `/%2e%2e/` escapes `public/`. Test-only, loopback, ephemeral port,
  and inherited from the pre-existing python harness pattern — but it is new code in a new file. → fix
  once, in the shared harness T2 collapses into.
- NOTED, then folded into the T1 fix batch as additive-only: the sibling-throw behaviour the prior run
  verified 3/3 has no permanent test, and `bootstrap.ts` is coverage-excluded so no gate sees it. All
  three lenses independently reached "this behaviour is unpinned", which is a real signal even though
  their attribution was wrong. T1 now has an opaque-origin harness that can express it cheaply, so the
  fixer pins the existing behaviour with a test. No production logic changes.
- T1 correctness lens → withdrew the misattributed finding on the A7 correction, re-verdict PASS with ZERO
  findings. It had independently reproduced criterion 6's RED against the pre-port bundle (`ready` arrives,
  `hasPort: false`) and proved criterion 7's forgery test discriminates (old bundle renders the forgery,
  new bundle ignores it) — both stand.
- T1 conventions lens → withdrew the same finding, re-verdict PASS, keeping only the stale-intake-comment
  Minor. It noted the withdrawal does not touch that Minor, since the comment sits on the line T1 itself
  moved.
- T1 security lens → its FAIL rested on the withdrawn finding plus the traversal Minor; the security
  dimension itself passed 0.95. The post-fix re-audit resolves the verdict rather than re-polling now.
- T1 → fixing. Batch: stale intake comment, harness traversal, additive sibling-throw pin. Explicitly
  instructed not to touch the guard.
- T3 security lens → PASS, ZERO findings, security dimension 0.95. Verified the A5 `port.start()` call by
  reading (`document-sandbox.tsx:540`, unconditional on the capture path) — the check no test in this repo
  can perform. Attacked the hijack guard on four routes, all closed: attacker `ready` from the real frame
  source (only the ref guard can save it — a genuine attack, not a shape check); the window between
  `stop()` and the replacement handshake; frame self-navigation (bridge fails closed, dies with the old
  document); and the debounced re-init racing a handshake. Judged the change a net reduction in attack
  surface: the window intake now accepts ONLY `ready`, closing a pre-existing hole where document code
  sharing the frame realm could forge `rendered`/`error`/`console`/`result` straight at the parent.
- T3 correctness lens → PASS, ZERO findings (correctness 0.96). Verified A5 by reading: the capture site
  is the only one in the file and its single early return sits BEFORE the capture, so no path stores a
  port or attaches a listener without reaching `start()`. Confirmed GC7 by comparison — `sandboxReducer`,
  `applyFrameMessage`, `displayStatus`, `superseded`, `hasRendered` retirement and the once-only guard are
  byte-identical; the staleness drop moved verbatim. Measured the new async-flush assumption itself (port
  delivery beats `setTimeout(0)` 200/200) rather than trusting it, and confirmed criterion 5's pin fails
  pre-change for the right reason (the old component records exactly one window post).
- Caught by the auditor, worth remembering: its first `pnpm test:web` returned FULL TURBO and executed
  NOTHING. It forced the re-run. Same hazard as the standing note that warm turbo cache can mask failures.
- Report overstatement recorded, not a finding: T3 claimed the stale-`isPython` closure on the port
  listener was a pre-existing property. It was not — the old window listener re-registered on `isPython`
  change, the port listener attaches once. Unreachable in practice (`DocumentContent` is keyed by
  selection id and a document's type is fixed per selection), so no fix; logged for accuracy.
- T3 conventions lens → PASS, ZERO findings. Ran the full comment-truth sweep A7 asked for: the old
  "never '*'" comment at `postToFrame` is gone and its replacement's three claims all hold; the component
  doc-comment is transport-agnostic and still true; the v8-ignore justification holds under BOTH intakes;
  test-file comments still true of the port path. Verified the `addEventListener` deviation is forced by a
  real rule (`unicorn/prefer-add-event-listener`, no override) rather than a rationalization — the harder,
  clean route over an unjustified disable. Confirmed A5's durable comment sits on the `start()` line,
  which is the single line most likely to be deleted as dead by a future editor.
- Confirmed repo-wide: the only surviving `contentWindow.postMessage` is `e2e/helpers/sandbox-harness.ts:113`
  — T4's file, and the last wildcard in the system.
- Design note, recorded not actioned: both T3 test files carry their own ~25-line channel/handshake helper.
  The implementer declared it and argued it fails the One-Implementation-Shared test; the auditor agreed on
  the stated test (different mount paths, nothing breaks if they drift, jscpd 0 clones). No work.
- **T3 → CLEAN.** All three lenses PASS with zero open findings.
- T1 fix round → done (159 package tests, drift byte-exact, eslint 0, jscpd 1.02%). All three items landed.
- MY BRIEF WAS WRONG on the traversal payload and the implementer caught it. I relayed the auditor's
  example `/%2e%2e/%2e%2e/x` verbatim; it does NOT escape, because the WHATWG URL parser normalizes `%2e`
  as a dot segment. The real payload class is the encoded SEPARATOR (`/..%2f…`), which survives parsing
  and becomes `../` only on decode. Vulnerability real, example wrong. It reproduced RED at HTTP 200
  serving `apps/sandbox/package.json` rather than trusting the brief — correct behaviour, and the reason
  the fix closes the class instead of the example. Re-audit asked to verify the payload class independently.
- ADD 3's judgement call, disclosed and sent for scrutiny: the test needed a test-local `react-dom/client`
  stand-in via `page.route`, because the shared `esm-stub.ts` reconciler returns at the first throwing
  effect and so its root can only report once. Grounded in react-dom 19.2 source. Risk if wrong: the test
  would pin a fake's behaviour, which is worse than no test — flagged to both the correctness and
  conventions lenses.
- ADD 3 RED confirmed by the implementer: guard moved below the settle branch → 2 `error` messages for one
  request; then restored. I verified the restoration MYSELF (byte-identical to its pre-fix state) rather
  than taking it on report, since not touching that guard was my explicit commitment.
- Left unfixed and flagged, correctly: `decodeURIComponent` still throws on a malformed escape (`/%zz`)
  instead of 400 — pre-existing, test-only, outside the requested fix. Sent to the security lens to rule on.
- T1 → re-auditing. 3 lenses, scoped to the delta only.
- T1 re-audit conventions lens → PASS, ZERO findings. Its own Minor is resolved: the intake comment now
  states the capability model, and it verified the load-bearing claim empirically in Chromium
  (`event.origin === ""`) rather than on spec-recall. Confirmed the `react-dom` stand-in is complementary
  rather than duplicative — it exists BECAUSE its behaviour must differ from the shared stub, which
  structurally reports once per root (esm-stub.ts:96,110,114); jscpd 0 clones; not a One-Implementation
  violation. Confirmed the stand-in is scoped per-test so it cannot leak into the other 27. Cross-checked
  the guard RED by reading rather than trusting: with the guard below the settle branch the second
  `onUncaughtError` finds `pendingRequestId === null` and falls through to `post(failure)` — the 2-error
  failure the report recorded, so the test discriminates.
- RULING PENDING BATCH — header/intake trust-model adjacency. The auditor cleared it as individually-true
  and explicitly handed me the call: the file header says "The embedding app is never trusted", the new
  intake comment says "a channel whose holder is already trusted". Both true in their own sense
  (containment vs authentication), but the adjacency reads as a stumble on the one file where the trust
  model must be unambiguous — and my original Minor was precisely "two adjacent accounts of the intake's
  security property". MY RULING: bring the header in line; a half-fixed trust narrative on the security
  boundary is the same defect I validated. Cheap — comments are stripped from the bundle (verified: grep 0
  in `public/render.js`), so no rebuild and drift stays green. Batching with whatever the other two lenses
  return rather than spending a cycle on one comment.
- T1 re-audit security lens → PASS, ZERO findings. Independently confirmed my brief's payload was wrong
  (`new URL('/%2e%2e/%2e%2e/x').pathname` === `/x`) AND that the real hole was far worse than reported:
  reconstructing the pre-fix expression, `/..%2f`×10 + `etc%2fpasswd` reaches `/etc/passwd` — arbitrary
  filesystem read, not one level up. Then fuzzed 17 payload classes against the fixed harness (case
  variants, double encoding, mixed literal+encoded, encoded backslash, null byte, absolute-form and
  `//`-prefixed request targets, opaque schemes) — all 404/400, nothing leaked. Verified no security
  property regressed in the BUILT bundle, and that the `page.route` stand-in is page-scoped, closed in
  `finally`, and touches neither the CSP nor the sandbox attribute.
- Ruled by that lens and accepted: the `decodeURIComponent` throw on `/%zz` stays. Test-only, never
  shipped, the identical unguarded pattern pre-exists in `dev-server.ts:139` so it is not a regression,
  the failure mode is a loud fail-closed crash rather than disclosure, and fixing it in one copy alone
  would add exactly the divergence that caused the traversal bug.
- ESCALATED BY THE AUDITOR, RULED BY ME → amendment A8. The package holds THREE implementations of "serve
  `public/` safely" (`dev-server.ts`, `python/browser-harness.ts`, `embed-harness.ts`) and they have
  already drifted where it counts: `dev-server.ts` exports `resolveWithinDir()` which refuses every
  payload, while the harness copy was exploitable until this round and now defends with a DIFFERENT
  technique. Two techniques for one job whose correctness depends on agreeing — the One-Implementation-
  Shared case, and the drift already produced a real hole. A2 was too narrow; A8 widens T2's collapse to
  route containment through the single shared helper.
- Flagged to the founder, NOT fixed (pre-existing, out of scope): `dev-server.ts:88-90`'s `v8 ignore`
  justification claims a real HTTP request can never reach that branch — the same `%2f` evidence
  falsifies it, though the guard itself holds and returns 403.
- T1 re-audit correctness lens → PASS, ZERO findings (correctness 1.0). It did not accept the ADD 3 RED —
  it rebuilt the bundle in scratchpad via an esbuild load-time patch (no repo mutation) and measured all
  three shapes: guard as shipped → 1 error; guard below the settle branch → 2 errors; guard deleted → 2
  errors. Then ran the control with the stand-in route removed → `rendered` with ZERO errors, proving the
  test times out rather than passing vacuously if the route silently fails to match.
- The stand-in risk I flagged is CLOSED, and closed properly. The auditor verified from installed
  react-dom 19.2 source that two sibling effects throwing in one commit round really do call
  `onUncaughtError` twice: `captureCommitPhaseError` → `captureCommitPhaseErrorOnRoot` creates its OWN
  root error update per error, `processUpdateQueue`/`commitCallbacks` invoke every callback, and the
  try/catch sits INSIDE the per-fiber effect walk so one sibling's throw does not stop the other's effect.
  The stand-in pins a behaviour production has, not a fake. Its deltas (microtask timing, never mounted)
  are irrelevant to `reportReactFailure`, which is synchronous and reads only two module flags.
- **T1 → substantively clean.** 3/3 lenses zero findings. One orchestrator-ruled comment item outstanding.
- ORCHESTRATION CALL: T2 dispatched in parallel with that comment fix rather than after it. The dependency
  T2 has on T1 is the shared embed harness, which is complete and audited clean three ways; the open item
  is a comment in `render/bootstrap.ts`, a file T2 never touches. Serializing the run's largest remaining
  task behind a comment edit would be poor sequencing with no correctness benefit. File ownership is
  disjoint, so the parallel-file rule still holds.
- T2 → implementing (python bootstrap + harness collapse + A8 containment consolidation).
- T1 header comment fix → done. Rewrote the header so trust rests on possession of the port, no origin is
  checked because none exists, shape validation is payload validation, and the untrusted party is the
  document code contained by the opaque origin. Everything true in the old text survived with its subject
  moved to the role it belongs to. Measured rather than assumed the no-rebuild claim: `public/render.js`
  md5 identical across the drift test that REWRITES it from source, and neither comment text appears in
  the bundle. A7 honored — guard untouched.
- MY CALL on the one style question it raised: the header and the intake comment now both state that a
  port message carries no sender origin, and the implementer offered to drop it from the intake. Leave it.
  The defect I was fixing was two CONTRADICTORY accounts; one true fact restated at its point of use is
  ordinary good commenting. Sent to the auditor with my reasoning AND an explicit instruction not to treat
  my view as settling it.
- T1 → re-auditing round 3. ONE lens (conventions), scoped to the comment edit. A 3-lens panel for a
  comment-only change that provably cannot alter the shipped artifact would be waste.
- T1 round-3 re-audit → PASS, ZERO findings, 1.0 across every dimension. Checked the new header clause by
  clause against the code and confirmed old→new preservation: shape validation kept, no-origin-check kept
  and strengthened to "there is none to check", the `capacitor://localhost` reason kept and re-sited as
  WHY nothing is checkable, containment kept nearly verbatim. Only the false subject — "The embedding app
  is never trusted" — was replaced. Nothing true was dropped.
- It proved comment-only rigorously rather than by argument: built the current source AND a reconstruction
  with the old header spliced back, and got byte-identical output. Plus the committed bundle equals a fresh
  build at the reported md5, at the same 540,313 bytes recorded before and after round 2.
- On my style call it agreed, with its own three reasons rather than deference — the intake statement
  carries a fact the header does not (`event.origin` is ALWAYS empty), the failure mode it guards is
  someone reintroducing an origin check at that exact parse site so the fact must live there, and the
  duplication ban targets logic that can drift, not prose restating a `MessagePort` spec invariant. It
  then named a denser repetition it declined to raise (the port-is-authority idea appears three times, two
  predating this edit). Consistent with my ruling; leaving it.
- **T1 → CLEAN.** Three lenses across two full rounds plus a scoped third, zero open findings.
- Attribution noted: the auditor measured 161 package tests against the report's 159. The delta is two of
  T2's new python port tests landing concurrently in the same package — not a contradiction, correctly
  attributed away from T1.
- T2 → implemented. Self-gates green (161 package tests, typecheck+lint 2/2, eslint 0, jscpd 0 clones over
  owned files). A5 satisfied by DELETION rather than by a green suite — the discipline A5 demands.
- A2 collapse complete: the 4 embed-harness↔browser-harness clone pairs are gone; jscpd over
  `apps/sandbox/src` went 5 clones / 2.3% → 1 clone / 0.41%. The survivor is pre-existing (esbuild options
  shared by the two bundle builders) and was left alone because collapsing it needs T1's file.
- A8 done: containment now routes through the single `resolveWithinDir` (`dev-server.ts:66`); the
  harness's `path.posix.normalize` clamp is deleted, which also removes A8's flagged posix/platform-path
  mixing as a side effect; `browser-harness.ts`'s own server is gone entirely. Three implementations of
  "serve public/ safely" are now one.
- Confirmed empirically by the implementer: the OLD python bootstrap really did accept a window-posted
  `init`+`run` — its forgery test went red on the forgery itself, not on a missing port. The realm-sharing
  hole was real on both sides, and is now closed and pinned on both.
- RULING REQUEST OUT, not decided unilaterally: `embed-harness` 404s where `dev-server` 403s on the same
  `null` containment result (404 kept to preserve T1's traversal assertion). My view — acceptable, both
  fail closed and 404 discloses less — sent to the security lens with an explicit instruction not to treat
  my view as settling it.
- T2 → auditing. 3-lens panel. Security lens additionally tasked with the python-specific realm question:
  Pyodide loads into this realm, so a Python document could try to reach the port through the JS FFI —
  plain-JS unreachability is not sufficient here.
- T4 → implementing, in parallel. Same disjoint-ownership reasoning as before: T4 owns only
  `e2e/helpers/sandbox-harness.ts`, which is now the LAST place in the repo posting into the frame window
  with a wildcard. Told to read the shipped bootstraps rather than the plan's summary of them, and that
  nothing in this run can execute its file — so `port.start()` must be right by construction.
- T2 correctness lens → PASS, ZERO findings. Verified the intake shape survived verbatim (the handler body
  shows as context lines in the diff), every outbound path still routes through the single `post()`, and
  neutralize-first ordering holds in the minified bundle (`jd();eg();`).
- It settled the two fragile tests properly rather than by reading alone. The mocked-clock `timed_out`
  test keeps all its assertions, and the whole file runs in 3.3s — impossible if the 60s real deadline
  were being waited out, which proves the mocked clock genuinely reaches the frame through the new
  harness. The WebRTC probe now evaluates via `probeFrame` in the child realm, which is the correct target
  once the bootstrap runs inside the opaque iframe.
- It also probed the one risk it could not settle by reading: whether `page.on('pageerror')` on the
  embedder still surfaces CHILD-frame exceptions now that the runtime is nested. Standalone Playwright
  script, frame script throws → `["Error: boom-from-frame"]` captured. So `runs without any uncaught page
  errors` still means what it meant.
- Weekly API limit killed three agents mid-flight: the T1 fixer (during fix 1), the T3 correctness lens
  (entering Phase B), the T3 conventions lens (entering Phase A). All three resumed from their own
  transcripts rather than respawned, so no context was lost.
