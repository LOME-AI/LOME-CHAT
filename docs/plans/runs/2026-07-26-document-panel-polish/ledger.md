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
- OUT-OF-SCOPE, FOR THE FOUNDER: `packages/shared` is currently RED from a concurrent workstream —
  `pnpm test:shared` has 2 failures in `affordability/turn-core.test.ts`, plus typecheck and lint errors in
  `affordability/percentile.ts`, `turn-core.outlier.test.ts`, `turn-arithmetic.test.ts`. Not ours;
  `npx vitest run src/documents` is 35/35 green and `npx eslint src/documents` exits 0. Security lens additionally asked to trace the theme value's path into a
  style context, since it now crosses the trust boundary into CSS.
