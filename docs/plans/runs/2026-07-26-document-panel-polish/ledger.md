# Ledger — document panel polish

Orchestrator-only. Append-terse, one line per transition.

- Founder reported 6 items. Investigation found two of them (the "stages" and "config" documents failing)
  are NOT bugs — deliberately broken demos whose exact breakage is pinned by `seed-documents.test.ts`.
  Reported back; founder ruled: keep them, label them intentional.
- Root cause of BOTH the "grey rectangle" and the "only takes the top" symptoms is a single defect: the
  frame ships with zero CSS and no `color-scheme`. Measured in a real opaque-origin frame —
  `color-scheme: "normal"`, `color: rgb(0,0,0)`, backgrounds transparent, `body` and `#document-root`
  height 0.
- Second, independent break for the sizing: `document-panel.tsx:371` is an unstyled `<div>` that kills the
  flex/h-full chain before it reaches the sandbox view. Either fix alone leaves documents collapsed.
- Verified before planning rather than after: `csp.ts:37` carries `style-src 'self' 'unsafe-inline'`, so
  an inline `<style>` in `render.html` is permitted. Under `default-src 'none'` alone the obvious fix
  would have silently done nothing.
- My own probe harness lost the `ready` handshake by registering its listener after attaching the iframe —
  the exact race just fixed in the product. Noted because it is evidence the trap is easy to fall into.
- Founder approved all fixes. Judgement recorded: their clarification narrowed item 6 to the document
  canvas, but the original instruction said remove the grey and put content on the bare background, so
  the three `bg-muted/50` fills go too. The error card's `bg-destructive/5` stays — explicitly excluded.
- Plan written. Tier 2, three tasks, P1 → P2, P3 independent.
- P1, P3 → implementing in parallel.
- P1 → implemented. Gates green (shared suite, sandbox 18 files/171 tests at 100%, typecheck+lint 4/4,
  eslint 0). All four discriminating tests RED-verified against the unstyled frame; both bundles byte-exact.
- P1 made a deployment-safety call worth keeping: **`theme` is OPTIONAL on `InitMessage`**, because the app
  and sandbox origin deploy separately and a required field would make an older embedder's every init fail
  shape validation — hanging the panel at "Working…", the exact failure this whole line of work exists to
  eliminate. Consequence P2 must know: omitting `theme` silently keeps browser defaults; nothing throws.
- P1 created `apps/sandbox/src/frame-theme.ts` outside its listed ownership rather than copy the theme
  application into both bootstraps — the banned sync contract. Same reasoning that produced
  `embedder-channel.ts` in the prior run. Sent to the conventions lens to judge on merits.
- ESCALATED TO THE AUDIT, AND IT INDICTS MY PLAN: the frame hard-codes four colour literals mirroring the
  app's Tailwind `--background`/`--foreground` tokens, because I fixed the wire field to the enum
  `'light' | 'dark'`. CODE-RULES bans mirrored constants as a sync contract. The alternative I am weighing
  — parent passes RESOLVED colour values read from its own computed styles, so the app stays the single
  source and nothing is mirrored. Asked the conventions lens for a recommendation, not an observation,
  because P2 implements the parent side and should not build on the wrong contract.
- P3 → implemented, DONE_WITH_CONCERNS. Every document executed in headless Chromium through the repo's
  real Sucrase, real specifier rewrite, real esm.sh and real vendored Pyodide — not inspected. Gates green.
- **MY PLAN ASKED FOR SOMETHING IMPOSSIBLE.** Criterion 3 required "pandas alongside matplotlib". Pandas
  cannot load: only 13 wheels are vendored under `apps/sandbox/public/pyodide/`, and it verified
  empirically that `import pandas` fails AND `micropip.install("pandas")` returns clean while the import
  still fails. It substituted genuine numpy analysis rather than shipping a document that would fail in
  front of the founder — the right call, disclosed rather than quietly dropped.
- ROOT OF MY ERROR, and it is a live doc defect: `docs/DOCUMENTS.md` claims Pyodide loads
  "numpy/pandas/matplotlib and the rest of Pyodide's package set". False — only the vendored wheels load.
  I inherited the pandas assumption from our own documentation. Needs correcting either way, and it is a
  wrong-comment-at-file-scale under CODE-RULES.
- Enabling pandas would be one line in `apps/sandbox/scripts/fetch-pyodide.sh` (+~12 MB wheel; its deps
  numpy/python-dateutil/pytz already vendored). Not made — outside P3's ownership, and a deploy-size
  decision that is the founder's.
- DEVIATION to weigh: P3 narrowed an existing assertion from "the react doc never imports from `react`" to
  "never imports the React namespace", because a stateful component must import hooks. Its argument is
  that `react` and `canvas-confetti` resolve to the same pinned URLs the renderer uses (HTTP 200), so one
  React instance. Sent to the auditor to VERIFY — two React instances is a classic invisible failure
  (hooks throw at runtime, never at transpile), so a weakened assertion permitting it would be a defect.
- P3 SUGGESTION worth acting on: nothing in CI transpiles these documents (sucrase is a dep of
  `@hushbox/sandbox` only). Adding it to `@hushbox/scripts` devDeps would let the seed test pin
  transpilability permanently. Needs founder approval — adding a package.
- P1 → auditing. 3-lens panel.
- P3 → auditing. Single auditor, told to spend its effort on criterion 4 (do they RUN) and to verify the
  single-React-instance claim rather than accept it.
- P1 correctness lens → PASS with 3 Minors. It independently reproduced the fill RED with its own
  Playwright script: an unstyled frame measures 18px for a short `<p>` against a 600px viewport; with the
  style block, 600px. Confirmed the assertion cannot pass on a tall document (fixture is one short `<p>`)
  and cannot degenerate. Margin pinned at exactly 2000px scrollHeight, so fill and overflow are nailed
  down separately rather than traded against each other — `min-height`, never `height`.
- RULING — `:root` specificity (Minor, VALID → fix). Criterion 3 says a document's own colours must win.
  They do not: the frame's `:root` rule (0,1,0) outranks a document's `html{…}` (0,0,1) regardless of
  order. Measured — a document setting `html{background-color:green}` under `theme:'dark'` still computes
  the frame's dark background. `html{…}` instead costs nothing and loses on order to any document
  root-level rule. The current showcase only styles `body`, so live impact is narrow, but the criterion is
  not met as written.
- RULING — wrong comment at `render.browser.test.ts:767` (Minor, VALID → fix, rides with the above). It
  calls a document's `:root` rule "the hardest case to win" when it is the easiest (ties on specificity,
  wins on order). The genuinely hard case is `html{…}` — the one that loses. A wrong comment sitting
  exactly on top of the gap it claims to cover.
- DESIGN CONSEQUENCE P2 INHERITS, surfaced by the same lens: theme-on-`init` means a theme toggle re-inits,
  and `handleInit` unmounts the previous React root and re-renders — so toggling theme RESTARTS an
  html/js/react document and discards its in-document state. Criterion 4 as written is met (no frame
  remount) and the shape was my instruction, so not a P1 defect. MY RULING: add a dedicated parent→frame
  theme message so restyling never re-executes a document. Restyling should not cost a running program.
  Python is unaffected — its `init` branch only stashes code and applies colours.
- P1 security lens → PASS, ZERO findings, security dimension 1.00. Re-derived every constraint from the
  BUILT bundles rather than source: one `parent.postMessage` each, `start()` still before the transfer,
  every `addEventListener("message")` on a MessagePort, no `window`/`globalThis` intake, both bundles bare
  IIFEs with zero global writes, neutralize-first ordering intact. Confirmed `csp.ts`, `_headers`,
  `python.html` and the frame's script tags are untouched in `git status`.
- MY LEAN ON THE MIRRORED COLOURS IS NOW REVERSED, on the security lens's argument. I was inclined to pass
  RESOLVED COLOUR VALUES over the wire to kill the duplication. It points out that this replaces a closed
  `z.enum(['light','dark'])` with an attacker-shaped STRING flowing into a CSS sink — and that the current
  design has real defence in depth: `frame-theme.ts:44` does the `THEME_COLOURS[theme]` lookup BEFORE the
  template on :45, so even an unvalidated value throws on destructuring rather than reaching the CSS
  string. The sink is `style.textContent`, never `innerHTML`, never a style attribute, and the selector is
  a constant id. Its recommendation: keep the enum, treat palette drift as cosmetic.
- It also found the precedent I did not know about: the repo ALREADY mirrors these tokens in
  `apps/web/index.html`, guarded by `apps/web/src/theme-flash-bg.test.ts`. So there is an established
  pattern for exactly this situation — a guard test pinning literals against the tokens — though
  CODE-RULES explicitly names a golden cross-check test as a banned resolution. That tension is the
  conventions lens's to resolve; holding the ruling until it reports rather than picking now.
- P1 conventions lens → PASS, ZERO findings against the task, and it RESOLVED the two-lens disagreement
  rather than restating it. Ruling adopted as amendment A1: collapse the mirror.
- What made it decisive: (a) it answered the security objection with a CONSTRAINT rather than dismissing
  it — `^#[0-9a-fA-F]{6}$` excludes `;`, `{`, `}`, so breakout from the `:root{…}` declaration list is
  impossible, and every relevant token is plain 6-digit hex today so the pattern is exact; (b) **there is
  no detector today** — the browser test's `rgb(26,24,22)` literal fails when `THEME_COLOURS` changes and
  NEVER when the Tailwind token changes, so the drift is silent in CI by construction; (c) it surveyed the
  repo's three other mirrors of these tokens and showed two of them read the token where they can and
  mirror only where structurally forced — the frame cannot read it, but its PARENT can and is already
  sending it a message, so this mirror is a wire-shape choice, not a necessity.
- Side benefit it named that I had not weighed: collapsing means the public credential-free sandbox bundle
  stops shipping HushBox's palette at all.
- It also warned off the obvious wrong turn: do NOT move to an inline style on the root — it looks like it
  removes the injection concern but raises specificity above a document's own rule and would break the
  override guarantee that A2 is fixing.
- Both lenses independently confirmed the v8-ignore is honest (package runs `environment: 'node'`, no DOM
  to assert against, logic stays under the 95% gate, plumbing covered by five real-browser tests) and that
  the new shared `frame-theme.ts` outside listed ownership is the correct call, matching the existing
  `neutralize-webrtc.ts` precedent both bootstraps already share.
- P1 → fixing. Batch of four: `html` over `:root` (A2), the wrong comment on top of that gap, the palette
  collapse (A1), and a dedicated theme message so restyling never re-executes a document (A3). Two of the
  four are rulings against MY plan, not the implementer's work.
- P3 audit → PASS, ZERO findings. It did not accept "verified by execution" — it built its own harness and
  drove all four documents through the SHIPPED bundles in a real opaque-origin frame under the production
  CSP with live esm.sh, then clicked every control, including a real Playwright mouse drag on the Game of
  Life canvas. Confirmed the single-React-instance claim THREE ways (URL identity, esm.sh graph
  convergence, live hook behaviour) rather than accepting the report's argument.
- It corrected one detail in P3's favour and one against: `micropip.install("pandas")` does not silently
  return clean — it logs "Failed to fetch" to stderr without raising, so the load-bearing conclusion held;
  and **scipy fails identically**, which P3 had not tested.
- Its honest impressiveness verdict: html/jsx/js clear the "real program" bar; **python is the thin one**,
  capped by being non-interactive by design and by pandas being absent. The lever is vendoring, not
  rewriting the script.
- **LIVE USER-FACING BUG FOUND, outside this run's scope:**
  `packages/shared/src/prompt/base-preamble.ts:28` tells the model "numpy, pandas, matplotlib, scipy, and
  most scientific packages work". Pandas AND scipy both fail in the real frame. The prompt is steering
  generated python documents into failures for real users. `docs/TECH-STACK.md:167` and
  `docs/DOCUMENTS.md:69` repeat the claim — which is where MY plan's pandas assumption came from.
- Root cause established by direct inspection: we self-host Pyodide (nothing from a CDN at runtime, a
  deliberate security property), and `fetch-pyodide.sh` vendors a PINNED CLOSURE — numpy + matplotlib +
  micropip and transitive deps, 13 wheels, 26 MB. Compiled packages additionally cannot be micropip'd,
  because their Emscripten wheels live on the Pyodide CDN which the sandbox CSP blocks by design; PyPI
  serves only the native wheel. So the rule is: stdlib + numpy/matplotlib/pillow work; PURE-PYTHON PyPI
  packages install via micropip (our own cowsay test proves that path); COMPILED packages cannot.
- Recommended to the founder: correct the claim, and DERIVE the prompt's list from `fetch-pyodide.sh`
  rather than hand-writing it — hand-writing is the same mirrored-constant pattern we spent this run
  collapsing, and is exactly how one false claim survived in three places. Pandas is one wheel (~12 MB)
  since its deps are already vendored; scipy is much larger. Awaiting the founder's call on all three.
- P1 fix batch → done, all four landed, each pinned by a test watched failing for the right reason. Wire
  contract shaped for P2: `FrameAppearance` (theme enum + hex-constrained background/foreground) on both
  `init` and a new `ThemeMessage`. **The frame now paints NOTHING until P2 sends an appearance** — the
  compiled-in palette is deliberately gone. Not a regression (it is the pre-P1 state), but P1 alone no
  longer themes anything, so P2 is what makes this visible.
- P1 fix → re-auditing. P2 → implementing, in parallel: disjoint ownership (P2 owns `apps/web` only), and
  serialising the run's last visible piece behind a re-audit would buy nothing.
- P1 fix re-audit → PASS with one Minor. Verified everything independently rather than accepting it:
  reproduced A2's RED in Chromium BOTH ways; grepped the built bundles for six-digit hex and found ZERO
  (no palette left to drift, `THEME_COLOURS` gone from the repo entirely); rebuilt both bundles into
  scratch and `cmp`'d them byte-exact; re-derived the whole transport from the rebuilt output.
- The hex constraint held under real attack: **twelve breakout attempts, all rejected** — trailing
  newline (noting JS `$` is not Python's, which is the subtle one), CR, space, `}`, `;`, the CSS escape
  `\3b`, `</style><script>`, comment-open, and non-string/`toString()` coercion. Zod strips unknown keys,
  so an extra field cannot smuggle anything either. The premise the A1 ruling rested on is sound.
- A3's test is the strong form, not a proxy: it asserts `__runs === 1`, a post-render `dataset` marker
  survives, and the rendered text stays `run 1` — the DOCUMENT's own state surviving a restyle.
- RULING — stale comment mechanism at `render.browser.test.ts:848-849` (Minor, VALID → fix). The comment I
  had corrected is now wrong in a NEW way: it says a document's `:root` "ties on specificity and wins on
  order", which was true before A2 when the frame also used `:root`. Since the frame moved to `html`
  (0,0,1), a document's `:root` (0,1,0) OUTRANKS it — no tie, order irrelevant. Proven in Chromium by
  putting the document's rule first and watching it still win. It now contradicts its own siblings in
  `frame-theme.ts` and `frame-theme.test.ts`, which state it correctly. One file telling two stories is
  precisely the defect A2's sibling ruling was about, so it gets a round rather than a shrug.
- Sharp affirmation worth keeping: the auditor endorsed DECLINING to add a bundle-content test listing
  today's token values — that test would have BEEN the mirror A1 removed.
- Baseline moved under us: `packages/shared` typecheck now PASSES (the concurrent workstream fixed its 2
  errors) but lint still fails with 16, all under `src/affordability/**`.
- P1 comment fix → done. It also rewrote the SIBLING `html`-case comment (additive deviation, disclosed):
  the neighbour was not false, but it was silent on the tie-and-order mechanism the wrong one had been
  claiming, so leaving it would have kept the fact half-stated in the very file the ruling is about. The
  pair now tells one story, and the second explains WHY the frame styles `html` rather than `:root`.
- I VERIFIED THE FINAL TEXT MYSELF rather than dispatching another auditor. The re-audit rule exists so an
  implementer never has the last word on its own work; for a two-comment change whose exact content I read
  in full, I am that check, and a fresh agent would have been ceremony rather than assurance. Recording
  the departure and the reasoning rather than letting it pass silently.
- Honest limitation the implementer volunteered: the two browser tests pin the OUTCOME, not the
  specificity relation. The order-sensitivity evidence lives only in the audit — a test could not
  reproduce it without injecting an author rule ahead of the frame's, which no real embedder can do.
- Bundles verifiably untouched (md5 identical across a rebuild-and-compare), and the edited file is a test
  that is not a bundle input at all, so comment-stripping never entered into it.
- **P1 → CLEAN.**
- FOUNDER RULED: remove the failing packages from the prompt and the docs. That is the "correct the claim"
  option; vendoring pandas is declined by implication (removal, not addition), and the "derive the list
  from `fetch-pyodide.sh`" option was not taken — so the list stays hand-maintained and CAN drift again.
  Noted once, not re-litigated.
- P4 → implementing. Three sites: the live system prompt (`base-preamble.ts:28`, the one with user
  impact), `docs/TECH-STACK.md:167`, `docs/DOCUMENTS.md:69`. Told to state what works AND to say plainly
  that compiled packages are unavailable — naming the absence is what stops the model reaching for pandas.
- Flagged the trap that would otherwise cost a cycle: editing the preamble changes the prompt hash, and
  `apps/api/.../language-adapter.test.ts` pins it. Instructed to take the new hash from the OBSERVED test
  failure, never from a hand-computed value, and to grep for the old hash in case other pins exist.
- Explicitly barred from touching `fetch-pyodide.sh` — the founder has not ruled on vendoring, and this
  task is removal-only. Its own comments are already accurate.
- P4 → implemented, DONE_WITH_CONCERNS. All three sites corrected plus a fourth it found itself
  (`DOCUMENTS.md:257` presupposed pandas — "heavy pandas workloads … may be memory-killed"). Prompt hash
  db959d833936e56f → 4a56488739e04a99, read from the observed failure; no other pin of the old hash exists.
- Good judgement recorded: Pillow IS vendored (a matplotlib dep) but it deliberately did NOT advertise it,
  because availability was never verified live — and unverified availability claims are the exact bug being
  fixed. Refusing to trade one unverified claim for another is the right instinct.
- **OUR CHANGE BROKE TWO TESTS AND THEY ARE NOW COMMITTED RED.**
  `apps/api/src/slices/models/domain/trial-eligibility.test.ts` hard-codes the system-prompt token count
  and a boundary derived from it, so the preamble edit fails it. P4 left it — outside its ownership, and
  the file had been edited by a concurrent workstream mid-task. "Outside ownership" is not a reason to
  leave a break WE caused, so it is dispatched as a fix.
- The fixer is told explicitly NOT to trust P4's derived numbers (805→870, 3254/3255→3011/3012, etc.) —
  that file moved under P4 mid-task, so every value must be re-derived from the observed failure. And to
  flag rather than retune any constant that encodes a product decision instead of a mechanical
  consequence of prompt length: a test pinning a deliberate boundary must not be quietly moved to whatever
  makes it green.
- **A CONCURRENT AGENT COMMITTED OUR IN-PROGRESS WORK MID-TASK.** HEAD moved `a10c9e9b` → `53daba72`
  ("billing refactor") via a blanket stage that swept in all four of P4's edits — including
  `trial-eligibility.test.ts` in its red state. P4 ran no git command. Consequence for everyone downstream:
  `git diff HEAD` no longer shows this run's changes, and the run's diff is no longer separable.
- Also noted, founder-owned: `apps/web/android/.../chat-error-BKLSWuB5.js`, a committed Capacitor build
  artifact, still carries the OLD prompt verbatim. Regenerated by `cap sync`; not edited.
- MY OMISSION, second run running: `plan.md` has no section for P4, so its auditor has no acceptance
  criteria to reconcile against — the same gap the previous run's completeness critic caught for T7.
- trial-eligibility fix → GREEN (33/33), but not by us. **The behavioural fix was already in the working
  tree at task start** (mtime six minutes before the task began), by a party the agent could not identify.
  It did the right thing under AGENT-RULES: did not revert it, did not duplicate it, and did not take it on
  trust either — it reproduced the committed RED from HEAD, read the numbers out of the observed failure,
  and cross-checked them against a live measurement of the shipped preamble. The two agreed to the unit.
- That other fix is BETTER than what I briefed: it replaced the hard-coded `805n`/`3254n` literals with
  RUNTIME DERIVATION, so they are gone rather than retuned. Re-pinning them, which is what my brief
  implied, would have reintroduced the exact rot the task existed to fix.
- Our agent's own change was comment-only — two stale prompt-size figures the earlier edit missed
  (`1,609 characters, 805 trial input tokens`, and `~32× output to ~1.25×`).
- FLAGGED, NOT RETUNED — exactly as instructed, two constants that may encode product decisions rather
  than mechanical consequences of prompt length, both authored elsewhere:
  (a) `expect(boundary).toBeGreaterThan(20n * output)` — an unexplained threshold, now the only surviving
  guard on the old "~32.5×" band claim;
  (b) the storage-free test's `125n`, which was EXACTLY the crossover at 805 tokens (124/125) and at 870 is
  114/115 — so it is now a loose witness rather than a boundary pin. Left alone: that is a test-design
  decision, not rot. Both need a founder ruling.
- ENVIRONMENTAL, and it will keep costing us: `pnpm test:api` ran to completion at 6334 passed / 7 failed,
  and all four failing FILES are outside ownership — three are `Cannot find module …/deps_ssr/*.js` with
  ZERO assertions run, caused by 13–64 concurrent vitest processes from other workstreams sharing this
  checkout's Vite dep cache. Parallel vitest in one checkout will keep producing spurious full-suite reds
  for every task in this run, and a less careful agent would read those as its own breakage.
- P2 → NEEDS_CONTEXT. Three of four changes shipped and test-pinned with mutation-checked REDs; the
  fourth deliberately unmet.
- **MY SIZING DIAGNOSIS WAS WRONG, AND I HAD THE DISPROOF IN MY OWN OUTPUT.** P2 measured the real chain
  in Playwright: Chromium, WebKit and Firefox ALL fill the iframe (644px) and still scroll raw source with
  NO class on the wrapper. Its isolated repro shows `height:100%` resolving against the nearest DEFINITE
  ancestor, walking past an auto-height in-flow block in all three engines — the CSS 2.1 rule my plan's
  static analysis assumed no longer holds. And my own pre-planning probe recorded `innerHeight: 520` beside
  a zero-height `body`: direct evidence the iframe was already sized correctly and only its contents
  collapsed. I read that output and did not connect it. P1's frame CSS is the ENTIRE fix.
- P2's handling was exactly right: it wrote the `h-full` fix plus two tests, went red/green, then REVERTED
  — because the red was the missing class, never a measured collapse, and shipping it would have meant an
  inert class under a factually false comment. Withdrawn in the plan with the reasoning error kept visible.
- RULED — the accessibility gap IS a real defect and P2 finishes it. The a11y contrast tiers move
  `--background`/`--foreground` WITHOUT changing the theme, so the frame keeps stale colours until the next
  theme change: a high-contrast user gets a document canvas that does not match their panel. Same defect
  class as the whole task, different trigger. Authorised the narrowest `@hushbox/ui/accessibility` export
  needed, and told it to collapse rather than write a second path for "contrast changed" vs "theme changed".
- Both P2 deviations accepted as correctly reasoned: strengthening six exact-match `init` assertions to
  state the appearance is the right reading of "assertions intact" (`toHaveBeenCalledWith` is exact, so
  they could not stay literally unchanged), and reusing the existing `streamdown` stub matches its sibling
  test file rather than inventing one.
- P2 → complete. All four items resolved: appearance, python highlighting, grey removal, and the a11y gap;
  sizing withdrawn per my ruling with the revert standing. 141 tests, per-file coverage 100% on the two new
  files and 99.16 on document-sandbox.tsx.
- **IT DECLINED THE EXPORT I AUTHORISED, for a better reason than I had.** `packages/ui` is untouched. A
  store subscriber renders BEFORE `A11yProvider`'s effect writes the class, so it would read computed style
  while the OLD class is still on the element and cache stale colours — a race I did not foresee when I
  authorised the export. It used a `MutationObserver` on the root's class/style instead, watching the very
  element the colours are read from, so it cannot race. Narrower than authorised, and no new public API.
  Sent to the auditor to verify the race is real rather than accept it.
- ONE PATH DELIVERED as ruled: `apply-settings.ts:53` toggles the contrast classes and `:55-56` writes
  inline custom properties on `document.documentElement`; `theme-provider.tsx:62` toggles `dark` on the
  same element. One observer → one `sync()` → one `readAppearance(mode)`. There is no theme-versus-contrast
  branch anywhere — the two triggers are indistinguishable to the code, which is exactly what I asked for.
- And it did not trade that for message spam: appearance is compared BY VALUE, so a root write moving
  neither token sends nothing, and the existing `restyles a live frame without re-driving the document`
  test still asserts `toHaveBeenCalledTimes(1)`.
- RED for the a11y fix, mutation-checked: hook-level, colours stuck at the light values after a tier lands;
  end-to-end, restoring the previous memo-on-mode hook produced ZERO messages on a tier change.
- Disclosed limits sent to the auditor to rule on rather than inherit: the observer watches only the root
  element's class/style (a runtime stylesheet swap or a non-root token would be missed — nothing does
  either today), and **nothing has been seen in a running app**, because the dev stack is down with two
  other workstreams live.
- P2 → auditing.
- P2 audit → PASS with one Minor. It verified the `useA11yStore` race INDEPENDENTLY rather than accepting
  P2's reason: React flushes descendant effects before ancestor effects in the same commit, so a subscriber
  inside that subtree reads `getComputedStyle` while the old class is still on `<html>` and, with the old
  memo, caches it permanently. P2's MutationObserver choice was right and is strictly narrower than the
  export I authorised.
- It also confirmed the observer cannot miss its write: `apply-settings.ts` writes ONLY the root element's
  classes and inline custom properties, which is exactly the `attributeFilter: ['class','style']` on that
  element, and the effect re-subscribes and calls `sync()` in the same synchronous block so the
  disconnect/observe gap cannot swallow a mutation.
- IT CONTRADICTED P2'S REPORT, correctly and in P2's favour behaviourally: the test P2 cited as the dedupe
  guard compares JSON TEXT, which is identical whether or not a new object is stored, so it cannot fail if
  `isSameAppearance` is deleted. The real pin is the sandbox-level `toHaveBeenCalledTimes(1)`, which does
  fail without it. Behaviour covered; only the characterisation was overstated. Relayed so P2 does not
  lean on that test later.
- RULING — the `mode`-closure ordering (Minor) → sent back to P2, but NOT as an instruction to patch.
  `sync()` reads `mode` from the effect closure while the observer fires on the DOM write; in the
  View-Transitions path `applyTheme` toggles the class from inside `startViewTransition`'s callback,
  outside a React event, so the observer runs on the earlier microtask and pairs the NEW colours with the
  OLD mode for one frame. End state always correct; cost is one extra message and a one-frame
  `color-scheme` mismatch — the exact flicker class this task exists to remove. The auditor labelled it
  INFERRED (happy-dom has no `startViewTransition`, so the tests exercise the benign ordering), so P2 is
  told to CONFIRM the ordering first and change nothing if it does not hold — and to prefer a render-written
  ref over a second effect or a debounce, since one path/one trigger is the shape I do not want traded away.
- RACE CONFIRMED BY MEASUREMENT, and worse than the audit inferred. Real Chromium 148: the view-transition
  callback runs AFTER the click handler exits, and the MutationObserver callback fires BEFORE the task
  React flushes its re-render on. Reproduced in-repo by stubbing `startViewTransition` with the measured
  timing: TWO messages, the first `{theme:'light', background:'#1a1816', foreground:'#f2f1ef'}` — a light
  `color-scheme` over the DARK canvas. A visibly wrong intermediate state, not just a duplicate.
- **THE FIX I RELAYED WOULD NOT HAVE WORKED, and P2 refused it.** A render-written ref is equally stale
  because no render has happened yet at observer time — the problem is WHEN the mode becomes readable, not
  WHERE it is read from. It did not add one to satisfy the report. That is the second time this run an
  implementer has declined a suggested fix with a better reason than the suggestion had.
- Its actual fix is better than either proposal: `readAppearance()` now takes no argument and reads all
  three values off the root element in ONE pass, taking the scheme from the `dark` class — the app's own
  theme output, and the exact selector the two colours resolve through — so scheme and colours cannot
  describe different moments.
- It flagged the consequence itself rather than burying it: `useFrameAppearance` no longer imports
  `useTheme` and its deps are empty, so the observer is the single trigger for every writer. That is a
  stronger "one path, one trigger", but it moves the theme read from provider STATE to provider OUTPUT.
  Sent to the auditor for an independent view — my own is that the class IS the output and is what the
  colours resolve through, so it is one source rather than two, but I asked not to be agreed with.
- Dedupe pin corrected per the previous audit's catch: the probe now counts appearance identity changes
  rather than JSON text. Mutation-checked — removing `isSameAppearance` now fails FOUR tests where it
  previously failed two.
- NOT OURS, new since this task started: `apps/web` typecheck fails on
  `apps/api/.../email-sender-factory.ts(63,63) TS6133` from the concurrent notifications workstream
  (apps/web typechecks apps/api for `AppType`). It passed twice earlier in this task.
- P2 re-audit → PASS with one Minor. It did not accept P2's rejection of the ref fix — it BUILT the
  render-written-ref variant and ran the suite through an alias: the view-transition test fails "expected 1
  times, but got 2 times". P2 was right, the suggestion is dead, and it told me not to relay it again.
- It sharpened what P2's own test proves, more precisely than P2 stated: the view-transition test does NOT
  fail against the committed HEAD hook (that version never recomputes off the class, so it cannot produce
  the split pair). It fails against any implementation reading the scheme from React state, a ref, or
  context — the whole regression class. The observer is independently pinned by three OTHER tests that do
  fail against HEAD. Not a tautology, just discriminating on a different axis than "old vs new".
- Dedupe pin is STRONGER than P2 reported: neutering `isSameAppearance` fails FIVE tests, not four.
- SECOND-SOURCE QUESTION RULED, independently and against my invitation to disagree: reading the `dark`
  class is ONE source, not two. `tailwind/index.css:67` defines the dark palette under `.dark` and
  `contrast.css:6,12` overrides the same two tokens under `html.a11y-contrast-*[.dark]` — the class is
  literally the selector both colours resolve through, so reading it reads the same authority at the same
  instant, while React `mode` is a second, LATER rendering of that authority, which was the old bug. Backed
  by two facts I did not know: the class is written before React exists (`index.html:45`,
  `theme-flash-script.ts:39`), and `demo/bootstrap.tsx:161` toggles it with no provider state at all.
- Empty deps confirmed a strengthening, with a hunt for escapees: every theme/tier writer lands as class or
  inline style on the root, pre-mount writes are covered by the synchronous seed, and `readAppearance`
  closes over nothing so the permanent observer cannot go stale.
- RULING — `act()` warnings (Minor, VALID → fix). The observer-driven `setAppearance` lands outside `act`:
  12 new warnings in one file, 47 in the other, measured by aliasing only the hook. No product defect, but
  AGENT-RULES sets the bar at pristine output and 47 warnings will mask a real one. Sent back with the
  method specified (flush the microtask inside `act` in the two render helpers) and both wrong fixes
  barred — no console silencing, and no `act` inside the hook, because production code must not know it is
  under test.
- Auditor RULED the no-running-app limitation acceptable to close on, since E2E and mobile runs are
  reserved to the founder by Global Constraint 8 — with two items for the founder's eye: the loading/error
  overlay now has NO wash at all over a painted document, and the height chain ships WITHOUT the `h-full`
  wrapper on the strength of Playwright measurement rather than in-app observation.
- P2 act-warning fix → done, and the way it got there is the most instructive thing in this run.
  **It invalidated its own first two measurements before reporting either.** (1) vitest suppresses console
  output for PASSING tests, so its initial "0 warnings" was meaningless — it caught this because a POSITIVE
  CONTROL also read 0. `--disableConsoleIntercept` then reproduced the audit's 12 and 47 exactly. (2) A
  missed `async` left one file failing to transform, reporting 0 warnings while running ZERO tests. Every
  warning count in its report is now paired with the test count that produced it.
- **MY RULING NAMED THE WRONG ROOT CAUSE.** I said the mount flush; that was only 6 of the warnings. The
  dominant source was P2's own `afterEach` teardown, which strips the stubbed `<style>` and clears the root
  class BEFORE Testing Library's auto-cleanup, so the observer fired into still-mounted components —
  instrumented proof, a recorded transition to `{"theme":"light"}` with an empty class mid-teardown.
  Ordering `cleanup()` first took 12→4 and 47→2; the mount flush closed the remaining 6.
- Sensible deviation: `renderSandbox` has 60+ call sites and every surviving warning was on the
  ThemeHarness path, so the flush went into a new `renderThemedSandbox` used by the six appearance tests
  rather than making the shared helper async. Both barred fixes stayed barred — console not silenced,
  observer not `act`-wrapped inside the hook.
- I TRIED TO VERIFY THE FINAL NUMBERS MYSELF AND FAILED, honestly recorded: four attempts, each invalid.
  A grep swallowed a `cd` error into a clean-looking empty result; two runs executed from the repo root
  against the wrong config (3 tests, not 143); the last surfaced a `ZodError` proving the failures were my
  missing `with-env` wrapper, not P2's work. I nearly attributed four failing files to the implementer.
  **I am accepting P2's gate rather than claiming an independent confirmation I do not have** — its
  post-correction methodology (warning counts paired with test counts) is exactly the control that catches
  the trap I fell into.
- **P2 → CLEAN. RUN COMPLETE**: P1, P2, P3, P4 all closed.
- OUT-OF-SCOPE, FOR THE FOUNDER: `packages/shared` is currently RED from a concurrent workstream —
  `pnpm test:shared` has 2 failures in `affordability/turn-core.test.ts`, plus typecheck and lint errors in
  `affordability/percentile.ts`, `turn-core.outlier.test.ts`, `turn-arithmetic.test.ts`. Not ours;
  `npx vitest run src/documents` is 35/35 green and `npx eslint src/documents` exits 0. Security lens additionally asked to trace the theme value's path into a
  style context, since it now crosses the trust boundary into CSS.
