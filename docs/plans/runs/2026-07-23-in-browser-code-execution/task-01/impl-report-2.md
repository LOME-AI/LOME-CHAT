# T1 — Sandbox origin app · impl-report-2 (FIX pass)

## Objective

Address the single validated audit finding on T1: shipped-code comments carry
run-internal identifiers (A#/T#/R#/G#, "amendment", "spike"/"proven-in-spike",
"per R#", "…workstream owns…") that violate CODE-RULES §Durable Naming and plan
G9. Keep every durable, load-bearing fact; delete only the run-scaffolding label.
No re-architecture.

## Files changed (label scrubbed, durable fact kept)

- `apps/sandbox/public/render.html` — "A7 / T0 INVARIANT for the real renderer:"
  → "Constraint for the real renderer:"; kept the import-map-before-first-dynamic-
  import fact and reworded "Android WebView 113"/"desktop Chromium masked this" to
  version-neutral durable phrasing ("Older Android WebView…", "desktop Chromium
  masks this").
- `apps/sandbox/public/python.html` — "A7 / T0 INVARIANT for the real runtime:"
  → "Constraint for the real runtime:"; kept the main-thread/blob:null/Pyodide-314-
  rejects-classic-workers/teardown-is-stop facts verbatim.
- `apps/sandbox/src/mime.ts` — dropped "(T0 spike)"; kept the load-bearing
  `.wasm`→`application/wasm` instantiation rationale.
- `apps/sandbox/src/dev-server.ts` — dropped "(T0 spike)"; kept the cross-origin
  CORS-for-opaque-iframe rationale.
- `apps/sandbox/src/config.ts` — dropped "(amendment A2)" from the `ESM_CDN_URL`
  reference; env-driven-CDN-base fact retained. (Not in the finding's explicit
  location list but the same violation class, in bounds — scrubbed.)
- `apps/sandbox/public/_headers` — dropped "(A7 / T0 spike)", "(G4)", "per R8",
  and the "OWNED by the headers workstream … Do not add CSP directives in this
  task" coordination scaffolding. Kept both concerns' durable content: the
  cross-origin-CORS/`application/wasm`/credential-free-origin rationale (reworded
  "credential-free (G4)" → "serves no credentials and reads no cookies") and that
  a CSP block (frame-ancestors limiting embedders + script-src/worker-src/
  connect-src) is appended below.
- `apps/sandbox/scripts/fetch-pyodide.sh` — dropped "self-hosted per R1"
  (kept the nothing-from-a-public-CDN-at-runtime rationale), "proven-in-spike
  baseline"/"spike-proven baseline" → "a baseline", and reworded the two
  "the Python runtime workstream owns/verifies … appends here" coordination
  clauses to durable phrasing, keeping the concrete transitive-dep list
  (kiwisolver/packaging/pillow/pyparsing/dateutil/pytz, filenames from
  pyodide-lock.json) and the pinned-filenames-only rule.
- `apps/sandbox/wrangler.toml` — dropped "(G4)" and "(owned by the headers
  workstream)"; kept the credential-free-static-origin and headers-come-from-
  ./public/_headers facts. (Same violation class beyond the finding's explicit
  list, in bounds — scrubbed.)
- `packages/shared/src/env.config.ts:123` — dropped "(amendment A2)" from the
  `ESM_CDN_URL` comment; the esm.sh-vs-test-stub rationale retained.

## Occurrences resolved

The finding named 15 occurrences across
render.html · python.html · mime.ts · dev-server.ts · _headers · fetch-pyodide.sh ·
env.config.ts. All resolved. Two additional in-bounds instances of the same
violation class surfaced by a full `grep` over `apps/sandbox/**` —
`src/config.ts:7` ("amendment A2") and `wrangler.toml:7,10` ("(G4)",
"headers workstream") — were also scrubbed, since the HOW-TO-FIX is a general
rule. A final grep for `A#|T#|R#|G#|amendment|spike|proven|workstream|invariant|
per R` over the owned files returns only legitimate Cloudflare **R2** storage-
product references (pre-existing, unrelated env.config.ts entries) — zero
run-scaffolding labels remain.

## No durable fact lost

Each edit preserves the underlying load-bearing fact and removes only the plan
label: import-map ordering constraint, `application/wasm` requirement, opaque-
iframe cross-origin CORS need, main-thread-Pyodide/teardown-stop constraint,
credential-free-origin safety rationale, self-hosted-no-runtime-CDN rationale,
and the pinned-wheel transitive-dep list. No comment that carried a durable fact
was deleted; only pure cross-references ("…owned by the headers workstream, do
not add in this task") lost their scaffolding wording while keeping the durable
"a CSP block is appended below" statement.

## Self-gate (final state, after last edit)

- `npx turbo typecheck lint --filter=@hushbox/sandbox --force` — **pass** (2/2 tasks).
- `pnpm --filter @hushbox/sandbox test` — **pass** (4 files, 40 tests; coverage
  100% stmts/branch/funcs/lines).
- `npx eslint .` from `apps/sandbox` — **pass** (exit 0) after the last edit.

## Acceptance criteria

- All named run-internal identifiers removed from shipped code — **met** (grep-verified).
- Durable facts retained — **met** (see "No durable fact lost").
- No test broke; gates green — **met**.

## Deviations

- Scrubbed two additional in-bounds files (`src/config.ts`, `wrangler.toml`) beyond
  the finding's explicit location list, as instances of the identical violation class
  the general rule targets. Both within `apps/sandbox/**` bounds.

## Concerns and limitations

- `wrangler.toml:4` retains "ARCHITECTURE §sandbox" — a documentation cross-reference,
  not a run-internal identifier; left in place as out of this finding's scope. Note
  that ARCHITECTURE.md currently has no "§sandbox" section, so a downstream task may
  need to add it or drop the pointer.

## Confidence

high — comment-only edits; full grep sweep confirms no run-scaffolding label
remains and no durable fact was dropped; all three gates green on final state.
