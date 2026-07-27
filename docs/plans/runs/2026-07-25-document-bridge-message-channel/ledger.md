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
- T2 security lens → PASS, ZERO findings (security 0.97). Answered the python-specific realm question
  EMPIRICALLY: a Python document enumerating `js.Object.getOwnPropertyNames(js.globalThis)` in the real
  frame sees 1225 globals and ZERO MessagePort/MessageChannel instances — the port survives only in the
  IIFE closure. The one indirect vector (prototype-hooking `MessagePort.prototype.postMessage` to capture
  `this`) is closed by the sandbox CSP: both `js.eval` and `pyodide.code.run_js` fail on `unsafe-eval`.
  Inbound forgery is closed independently — `port2` left the realm with the transfer.
- It also proved A8's collapse STRENGTHENED containment rather than merely deduplicating it:
  `resolveWithinDir` returns null for payloads the deleted clamp would have silently rewritten into an
  in-tree path (`/../package.json` → clamp gave `/srv/public/package.json`; helper gives null), and the
  third implementation — `browser-harness.ts`'s `path.join(publicDir, '.' + pathname)` with NO containment
  check at all — is deleted outright rather than repaired. 19 traversal payloads, all 404.
- Ruled on the 404-vs-403 nit, agreeing with my view and sharpening it: the property CODE-RULES demands is
  one containment DECISION, which `resolveWithinDir` now is; the status code is presentation belonging to
  each server's role, and 404 discloses strictly less than 403. The helper's contract is "null = do not
  serve", not "null = 403", and both callers honour it. No change.
- **T2 → CLEAN.** 3/3 lenses, zero findings.
- T4 → PASS, ZERO findings. The auditor converted all three of the implementer's reasoning-not-measurement
  claims into measurement via a Chromium probe of the byte-exact parent template against a stub frame:
  the WindowProxy gate admits the opaque frame's ready; recreate reaches ready:2 AND the new frame is
  drivable; and deleting `p.start()` leaves ready:1 with nothing ever delivered — A5's failure mode
  reproduced directly.
- It ruled the deliberate non-close of the old port SOUND, by counterfactual: shipped behaviour lets a
  surviving frame keep delivering (beacons 10→34) so the zombie assertion can see it; adding
  `port.close()` gives 10→10, making a real zombie invisible and the test vacuously green. The retention
  is the assertion's teeth, not a leak.
- Refined the founder-facing failure guidance: a HANDSHAKE failure fails early and legibly inside `open()`
  at `waitForReady(1)`; a captured-but-undelivered port fails later as a timeout on the first
  `toContainText` that reads like containment but is transport. Also: the spec declares EIGHT test entries
  (the frame-src pair is a two-iteration loop), six of which drive the harness — the plan's "seven" was my
  count, not the runner's.
- **T4 → CLEAN.**
- CORRECTION TO MY OWN CLAIM → amendment A9. I stated repo-wide that the e2e harness held the last
  wildcard `contentWindow.postMessage`. Wrong — I generalised a T3 auditor's statement that was correctly
  scoped to the product path. `embed-harness.ts` also posts `'*'`, but it is T1's deliberate forgery probe
  whose purpose is to be ignored. Accurate inventory now in A9 for T5 to document instead of my version.
- FOUNDER RULED: collapse the duplicated frame-side handshake. → T6 added to the plan and dispatched.
  The duplication was MY plan's fault (GC2 said "in each of the two bootstraps"), surfaced by T2's
  conventions lens, which correctly declined to score it against T2.
- T6 → implementing. Parent-side triplication explicitly OUT of scope: independent embedders in different
  packages, and the e2e copy is a classic-script string served over HTTP that cannot import a module.
- T6 → implemented. One shared `apps/sandbox/src/embedder-channel.ts`; both bootstraps call it. Gates
  green (161 tests, 8/8 drift, 39/39 browser, eslint 0, jscpd 0 clones owned / 0.99% package).
- The evidence that makes this real rather than cosmetic: deleting the SHARED `start()` killed delivery in
  BOTH runtimes in real Chromium, and restoring it rebuilt both bundles byte-identically. One deletion,
  two runtimes — which is exactly the coupling the collapse was meant to create.
- MY CRITERION WAS WORDED WRONG, flagged rather than quietly satisfied → A10. Criterion 3 said `start()`
  must exist "exactly once in the tree"; that is false and unachievable — `settleTick`'s macrotask clock,
  `document-sandbox.tsx`, and the e2e harness all legitimately call it. What I meant, and what holds, is
  exactly one frame-side HANDSHAKE `start()`.
- Coverage decision, made deliberately and defended rather than defaulted: the shared module is excluded
  like the bootstraps, because a Node-level test of it would PASS with `start()` deleted — false assurance
  of exactly the kind this run exists to eliminate. Including it failed the gate at 0%, so this was a real
  choice, not the path of least resistance. Sent to the security lens for a view, my agreement stated but
  explicitly not binding.
- Residue flagged, not decided unilaterally: each bootstrap keeps a ~5-line send guard because criterion 1
  specifies the helper RETURNS a send function. My view — acceptable, it is an unset-port invariant check
  rather than correctness-coupled logic — sent to the correctness lens with the specific question of
  whether the two guards could drift in a way that matters.
- 161 → 161, no test added or edited. Unusual for a refactor this size; I asked the correctness lens to
  judge whether the Chromium deletion experiment is adequate pinning or whether a test is missing.
- QUEUED → A11: python has no STANDING test for port-unreachability from the Pyodide realm, while render
  does. Twice now (T2's security auditor, T6) the answer came from a throwaway script. Follow-on task,
  deliberately not folded into T6 — it does not own `python-core.browser.test.ts`, and adding it would
  have moved the test count mid-audit.
- T6 → auditing. 3-lens panel.
- T6 conventions lens → PASS, ZERO findings. Confirmed the duplication is genuinely gone rather than
  merely under jscpd's threshold: the mint/register/start/transfer/send tail exists once, and each bundle
  carries exactly one minified copy with no shared runtime object and no new global surface.
- It reached MY view on the residue independently, blind, before reading the report — applying the rule's
  own test ("if these two drift, does something break?" → no) and noting that every line whose drift is
  invisible and fatal (`start()`, the transfer list, the wildcard target, the parse) is now single. It
  called it not worth the orchestrator's time. Blind-first working as intended: agreement that was reached
  independently, not inherited from my framing.
- Verified the comment migration landed all three load-bearing facts and that the A5 `start()` fact sits
  directly above the call with its lint-corollary intact — "the strongest part of this change", in its
  words, since that is the line most likely to be deleted as dead.
- Confirmed neither bootstrap docblock now over- or under-claims: render attributes the port to the shared
  helper, python describes what its own page does.
- T6 correctness lens → PASS, ZERO findings (correctness 1.0, security 1.0, conventions 1.0). Verified
  both intakes stayed genuinely different (python's `init`-stashes/`run`-executes/no-`stop` quoted from
  the minified artifact) — the helper did NOT homogenise two intentionally different handler bodies.
- It caught an ordering change neither I nor the implementer had named: `sendToEmbedder` is now assigned
  AFTER the `ready` broadcast rather than before. Ruled safe, with the mechanism — port delivery is
  task-queued so nothing can dispatch inside the synchronous start call, and render's error/rejection
  listeners reach `post()` only via `reportUncaught`, which returns early while `captureRequestId` is null.
  No new window where `post()` can throw.
- IMPORTANT CLARIFICATION OF MY OWN A5 FRAMING: A5's "no test in this repo can see a missing `start()`" is
  scoped to the Node/happy-dom PARENT side. The FRAME side is self-protecting — `render.browser.test.ts`
  and `python-core.browser.test.ts` run in real Chromium against the SHIPPED bundles, so a dropped
  `start()`, changed transfer list, lost return value, or leaked global all fail existing tests. That is
  why 161→161 with no new test is adequate here and would not be elsewhere. The deletion experiment
  corroborates rather than substitutes.
- Ruled with me on the residue, with the structural reason: each guard reads only its own module-scoped
  state and has no third party requiring the two to agree — unlike the handshake, whose other side the
  PARENT implements once, making divergence a protocol mismatch. It also noted the alternative would force
  a singleton into the helper for no correctness gain.
- T6 security lens → PASS, ZERO findings. It did not re-run the implementer's experiment; it built a
  stronger one that never touched the repo — served the SHIPPED bundles through the real harness with the
  handshake `start()` stripped from the served bytes only. Render: no delivery in 12s. Python: none in
  60s. Both with `ready` and the port transfer still succeeding. One line, two runtimes, silent.
- Re-established python realm unreachability against the NEW shape rather than carrying the prior result
  forward: from inside Python via the FFI, 1225 own properties of `js.globalThis` enumerated by
  constructor name, PORT_HITS empty; plus a depth-3 object-graph walk in both realms. Structural reason it
  cannot leak — esbuild inlines the shared module into each IIFE under a DIFFERENT minified name, so there
  is no shared runtime object and no new global surface: two closures, one source.
- Corrected a claim in the implementer's report without it being a finding: "globalThis assignments: 0" is
  true for the literal pattern grepped, but both bundles carry Zod's `__zod_globalConfig` /
  `__zod_globalRegistry` writes. Pre-existing, holds no port, no exploit path — recorded so a future
  auditor running the same grep does not read "zero global writes" as literal.
- Agreed on the coverage exclusion with a stronger reason than mine, and named the residual cost nobody
  else would: a Node test here would be ACTIVELY MISLEADING (green with `start()` deleted, sitting in the
  report as a covered file named after the handshake), and the exclusion is classification-preserving
  since both bootstraps are excluded for the identical reason. The cost: pure logic added to that file
  later goes uncovered silently. Instrument if wanted is a standing realm probe plus keeping the module
  small — not a Node unit test.
- **T6 → CLEAN.** All five implementation tasks (T1, T2, T3, T4, T6) now clean.
- T7 → implementing (A11's standing python realm test; owns only `python-core.browser.test.ts`).
- T5 → implementing (docs). Told to use A9's corrected wildcard inventory rather than my earlier wrong
  assertion, and to carry T6's A5 scoping clarification: frame side self-protected by real-Chromium tests,
  parent side not.
- T5 → implemented (docs). Verified its claims against the shipped bundles and tests rather than lifting
  them from the plan — which was right, because it caught my A9 table going stale the moment T6 landed.
- MY A9 TABLE WAS STALE, caught by T5 → addendum written. A9 attributes a `parent.postMessage` source site
  to each bootstrap; after T6's collapse there is ONE source site (`embedder-channel.ts`) compiled into
  both bundles, and NEITHER bootstrap contains `parent.postMessage` at all. Shipped count unchanged (two,
  one per bundle) — what changed is that they are two compilations of one source. The doc states the
  version a reader grepping `bootstrap.ts` will actually find.
- FOR THE FOUNDER'S DOC BATCH: `docs/ARCHITECTURE.md:201` says "Parent↔frame traffic is a Zod-typed
  postMessage bridge shared from packages/shared". Schema half true, transport half now false. T5 grepped
  every loaded doc and nested CLAUDE.md and reports it is the ONLY falsified transport claim. Not touched
  — outside T5's ownership and docs need founder approval. Its auditor is re-verifying that the grep was
  exhaustive, since an incomplete list would make the batch wrong.
- T5 → auditing. Told explicitly NOT to verify the doc against the plan — the plan has itself been wrong
  twice this run (A9 addendum, A10) — but against the code as it stands.
- T7 → implemented. 11→12 in file, 161→162 package, no existing test altered, no pole (3237ms, 20.9%).
  Falsified properly: RED naming `['__leakedPort']` against a scratchpad-served leak, GREEN after revert,
  plus by-construction guards (an in-run control port must register as a hit; the scan must read >100
  constructor names). 1226 own props observed, count deliberately NOT asserted to avoid brittleness.
- Honest limitation the implementer volunteered: the scan covers own properties of `globalThis` only, so a
  port behind a prototype, nested object, or closure is out of reach — same shape as render's existing
  test, but WEAKER than the depth-3 object-graph walk T6's security auditor ran ad-hoc. Put to T7's
  auditor as a judgement call with a recommendation demanded, not just an observation.
- T7 → auditing.
- T7 audit → PASS, ZERO findings. Reproduced the falsification independently rather than trusting it
  (GLOBAL_HITS `['__leakedPort']` under injection, `[]` clean) and matched the implementer's numbers
  exactly (1226 names, 1063 read). Confirmed `git diff` is +40/−0 — nothing reverted imperfectly.
- It verified the by-construction guards are load-bearing, which is what protects the test after the
  one-off falsification is forgotten: 163 of 1226 names legitimately throw on read, so the `read > 100`
  floor genuinely catches a regression that made the FFI throw on everything and would otherwise pass by
  emptiness.
- DEPTH QUESTION RULED — keep depth-1, on the auditor's recommendation, which it earned by RUNNING the
  deeper walk rather than reasoning about it:
  (1) a deeper walk has a structural false positive at every depth — `globalThis.MessagePort.prototype`'s
  `constructor.name` is "MessagePort", so the standing version would need a prototype exclusion list, and
  exclusion lists in a negative test are exactly the rot vector this run exists to remove;
  (2) the extra reach misses the actual failure mode — GC4's risk is an accidental global assignment (a
  debug line, or the bundle ceasing to be `iife`), which lands at depth 1, while the closure being
  defended is unreachable at ANY depth, so deeper is a bigger sample of an already-indirect proxy, not a
  closer proof;
  (3) ~670ms vs ~65ms, file 3.2s→4.0s — not a pole problem, but paying a maintenance hazard for a
  ruled-out shape. Plus symmetry: deepening python alone re-creates A11's asymmetry pointing the other way.
  If ever wanted, the bounded version is depth 2 (which caught everything depth 3 did) with an explicit
  prototype skip and a per-depth read floor.
- **T7 → CLEAN.** Six of seven tasks clean; only T5's audit outstanding.
- T5 audit → PASS with one Minor. Independently verified the wildcard inventory and confirmed the
  IMPLEMENTER was right and MY earlier version wrong: one wildcard source site repo-wide
  (`embedder-channel.ts:74`), neither bootstrap containing `parent.postMessage` at all, one per built
  bundle. Also corrected the implementer's own framing — it reported relocating a paragraph; the diff
  shows no move, the paragraph is unchanged context. End state right, description wrong.
- RULING — `DOCUMENTS.md:83-84` (Minor): VALID. The doc says the shared schemas "name no window, origin,
  or port", which is false of the file it cites — `bridge.ts` comments mention the parent window, a single
  `message` listener, authenticating the sender by origin, and a stray `postMessage`. The load-bearing
  half (transport can change without touching the schemas) is true and this run proved it; only the
  parenthetical over-claims. A checkable statement a reader disproves by opening the cited file costs the
  doc its credibility. → fix.
- THE DOC BATCH I WAS ABOUT TO HAND THE FOUNDER WAS INCOMPLETE, caught by this auditor. Beyond
  `ARCHITECTURE.md:201` (which is misleading rather than false — `port.postMessage` IS a postMessage — so
  the fix is precision), the same falsified transport prose survives in CODE COMMENTS no task owns:
  `packages/shared/src/documents/bridge.ts:4, :8, :11-14, :243` still describe a parent-window
  `message` listener and origin-string authentication. Wrong-comment class under CODE-RULES, and falsified
  BY THIS RUN — so they are ours to fix, not a founder doc proposal. Global Constraint 1 froze the
  SCHEMAS, not their prose.
- **T5 → PASS**, fix pending. Phase 4 close pass started: typecheck, lint, duplication, unused running
  repo-wide with `--force` (warm turbo cache has masked real failures here before).
- CLOSE PASS results so far: typecheck 16/16 packages, 0 errors, 0 cached (forced). Duplication 0.99%
  against a 2% threshold — PASS. Lint and the sandbox/web suites still running.
- CLOSE PASS — `pnpm lint:unused` (knip) FAILS. Attributed: **pre-existing, not this run.** Two items:
  (a) `packages/config/vitest.package.config.ts` reported unused — the file is unmodified by this run and
  is still referenced from `packages/config/package.json:15`, which knip cannot resolve because the path
  is a CLI arg to a custom runner; (b) a `wrangler`/`ignoreDependencies` config hint for `apps/sandbox` —
  neither `knip.jsonc` nor any dependency list was touched here. Corroborated independently: a T1 auditor
  observed these exact two items early in the run and reached the same attribution. Nothing this run did
  adds or removes a dependency or a config reference. Flagged to the founder, not fixed — and worth their
  attention because knip is a CI gate, so it is red on the tree independently of this work.
- CLOSE PASS: lint 16/16 packages clean, 0 cached (forced). So typecheck PASS, lint PASS, duplication
  PASS, unused FAIL-but-pre-existing. Sandbox and web suites still running.
- Completeness critic dispatched, pointed at the question single-task audits structurally cannot answer.
  The sharpest instance: T6 rewrote the handshake in BOTH bootstraps AFTER T1 and T2 had already been
  audited clean, so their criteria were verified against a state that no longer exists — asked whether
  every criterion still holds on the tree AS IT STANDS. Also asked to check the parent, two frames, two
  test harnesses and the e2e harness against EACH OTHER rather than each against the protocol, since that
  seam is exactly what no per-task audit could see. Told plainly that I have been wrong at least three
  times in the plan and to assume more, and that a clean answer is a real answer — no manufactured items.
- CLOSE PASS COMPLETE. typecheck 16/16 · lint 16/16 · duplication 0.99%/2% · sandbox suite · web suite —
  all green, every one cache-bypassed. Sole failure is knip, attributed pre-existing above.
- Close fix batch dispatched (one fixer, both items): the `DOCUMENTS.md` over-claim, and the falsified
  transport comments in `bridge.ts`. Told explicitly that Global Constraint 1 froze the SCHEMAS, not their
  prose — Zod definitions, exported types and both parse functions must not change, and if a comment
  cannot be made true without a code change, escalate instead. `ARCHITECTURE.md:201` deliberately withheld
  from this batch: it is a loaded doc outside the run's approved scope and belongs to the founder.
- Close fix batch → done. `DOCUMENTS.md` keeps the true, run-proven half and narrows the checkable
  parenthetical to the Zod definitions. `bridge.ts`'s header now states the real model, and the
  "stray `postMessage` from an unrelated source" line is replaced with the accurate reason to ignore an
  unrecognised payload: the port's holder is already the trusted embedder, so the guard is against SKEW
  between the two sides, not an attacker. Gates green (shared suite 2970 tests, bridge.ts 100%).
- Global Constraint 1 confirmed MECHANICALLY, not by assertion: `git diff -U0` on bridge.ts filtered to
  non-comment lines is empty. No comment turned out to need a code change, so nothing escalated.
- The fixer left one comment deliberately unchanged and said so — `parseFrameToParentMessage`'s
  ignore-as-noise note — reasoning it is still true because the PARENT does keep a window listener for the
  handshake. Sent to the re-auditor as a judgement call rather than accepted, along with the related risk
  that "the frame keeps no window listener" could be misread as "no window listener exists anywhere".
- Close fix batch → re-auditing.
- Close fix batch re-audit → PASS, ZERO findings, 1.0 across every dimension. Reproduced the schema freeze
  with a STRICTER filter than the implementer's (dropping any line starting `*`, `//`, `/*` — zero lines
  remain) and cross-confirmed via the byte-exact bundle drift test, which could not pass if compiled
  output had moved. Verified `event.origin === ""` in real Chromium rather than on spec recall.
- It endorsed the fixer's decision NOT to touch `parseFrameToParentMessage`, with the reason that makes it
  more than a style call: the app parses through that function on TWO intakes — the window handshake AND
  the port — and on the window path the "unrelated source" case it describes is STILL LIVE, because
  document code can `parent.postMessage` with a matching `event.source` and first-ready-wins is what
  contains it. The parent→frame counterpart became unreachable when the window intake disappeared. A less
  careful pass would have rewritten both "consistently" and introduced a falsehood.
- COMPLETENESS CRITIC → FAIL, and it earned it. No shipped-behaviour defect, every re-checkable criterion
  still holding after T6 rewrote both bootstraps, but three real gaps no per-task audit could see:
  (1) **the product parent has the exact race both harnesses were rebuilt to avoid** — it registers the
  one-shot `ready` listener in a PASSIVE `useEffect` while committing the iframe in the same render. My
  own "Verified facts" section asserted this ordering was safe; that was Inferred reasoning I labelled
  Verified, and it did not consider Capacitor, where sandbox assets are local files with no network round
  trip — the fastest frame load and the least tested. Losing `ready` means no port, which is "Working…"
  forever: the exact symptom this run exists to eliminate.
  (2) the three parent-side handshakes have DIVERGED on the run's most dangerous line — `embed-harness.ts`
  uses auto-starting `port.onmessage` with no source gate and no ready-type gate, and it is the only
  real-Chromium embedder inside a `pnpm test` gate, so the product's `addEventListener`+`start()` pattern
  is exercised in a real browser nowhere at all.
  (3) the product silently drops a parent→frame send when no port is captured, where both harnesses throw
  — unreachable today, but it is the guard that turns a future regression into an error instead of a hang.
  All three dispatched as a close-gap fix.
- Critic also caught MY run record: T7 had no task section at all (implemented and audited against A11's
  prose), the plan still said "Five tasks", the dependency graph omitted T6/T7, and §T5's depends-on was
  wrong — T5 ran after T6 and depends on it. All fixed; §T7 written retroactively with its criteria as
  executed plus the depth ruling.
- A7 SUPERSEDED and marked historical: the founder committed mid-run at `ada0341c`. T1–T5 are in HEAD;
  only T6/T7/docs/close-fixes are not. `git diff HEAD` is now the CLEANEST baseline, so A7's instruction
  to distrust it would mislead in the opposite direction. Verified directly rather than taken from the
  critic. A8's Windows path-mixing observation struck through — T2 deleted that clamp.
- Close-gap fixes → done. FIX 1 `useEffect` → `useLayoutEffect` (iframe mount point untouched, so no
  observable behaviour change); FIX 2 the parent→frame send now throws instead of silently dropping;
  FIX 3 the embed harness moved to the product's handshake shape. Gates green: web 6411 tests
  (document-sandbox 52→53), sandbox 162, all four drift tests byte-exact, eslint 0 on all three files.
- THE RACE WAS REAL AND NOTHING WOULD HAVE CAUGHT IT. RED was `Number of calls: 0` — `ready` genuinely
  lost. The implementer confirmed plainly that none of the 52 existing tests could have seen it: they all
  dispatch `ready` after `render()` returns, by which point `act()` has already flushed passive effects.
- METHODOLOGICAL TRAP, recorded because it nearly produced a false all-clear: the first RED attempt used
  `flushSync(() => root.render(…))` and PASSED against the UNFIXED code — `flushSync` flushes passive
  effects, so it never opens the window the bug lives in. A naive reproduction would have "proved" there
  was no bug. The kept test dispatches `ready` from a sibling's `useLayoutEffect`, inside the commit that
  inserted the iframe. Sent to the re-auditor as the single most important check in the audit.
- FIX 2 ships ONE untested line and says so rather than manufacturing coverage: the throw is unreachable
  today (readyRef/portRef set and cleared together, python controls disabled while booting, re-drive gated
  on readyRef, `stop()` has no render-view caller), and testing it would need a backdoor in the component,
  so it carries a `v8 ignore` matching the file's two existing markers. Put to the auditor to rule on.
- FIX 3 MATERIALLY NARROWS A5: with the harness on `addEventListener` + `start()`, deleting that
  `start()` now FAILS the port-delivery test in real Chromium (15s timeout). That parent-side `start()`
  was gated by nothing before and is gated by `pnpm test` now. Asked the auditor to state precisely which
  parent-side `start()` calls are gated and which remain unpinnable.
- Close-gap re-audit → PASS, ZERO findings. It reproduced BOTH REDs itself rather than accepting them:
  probe A ran the kept test against a `useLayoutEffect`→`useEffect` source transform (vite plugin, no repo
  file touched) — 1 failed / 52 passed with `Number of calls: 0`, 2/2 both directions. Probe B stripped
  the harness `start()` — two transport tests fail at 15s each, and the implementer had UNDERSTATED it as
  one. Probe C stripped the product's `start()` — 53/53 still pass, confirming it stays unpinnable.
- It confirmed the kept FIX 1 test is not a `flushSync` variant: the sibling `useLayoutEffect` dispatch
  runs inside the commit that inserted the iframe, strictly earlier than a passive effect, so the window
  the bug lives in is genuinely open. Also confirmed `useLayoutEffect` is safe here (createRoot only, no
  `renderToString`/`hydrateRoot` anywhere in apps/web) and that the remove/add pair on `code` change is now
  synchronous — strictly safer than before, not merely different.
- It traced FIX 2's unreachability independently BEFORE reading the report and reached the same
  conclusion, including the one theoretical leak (a pending re-drive timer surviving `stop()`), which
  cannot occur because the re-drive effect returns early for python and `stop` is wired only into the
  python view. Ruled the untested throw correct: fake coverage would be worse, and leaving the silent drop
  worse still.
- **A5 FINALISED BY MEASUREMENT** — recorded as a table in the plan. Gated: the embed harness (only
  because the close-out moved it onto the product's shape) and, in effect, the frame side. Unpinnable: the
  product parent and the e2e harness. "No test can pin `start()`" is now true of two of four sites, not
  all four — and the product parent is the dangerous one.
- **RUN COMPLETE.** T1–T7 clean, close pass green, two close-out fix batches clean. Nothing committed.
- Weekly API limit killed three agents mid-flight: the T1 fixer (during fix 1), the T3 correctness lens
  (entering Phase B), the T3 conventions lens (entering Phase A). All three resumed from their own
  transcripts rather than respawned, so no context was lost.
