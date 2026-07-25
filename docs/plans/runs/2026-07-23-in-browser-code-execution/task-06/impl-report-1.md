# T6 — Headers & CSP (both origins) — impl report 1

## Objective

Lock the network posture that is the security model: app origin allows framing the
document sandbox origin; sandbox origin permits module + wheel loads and no other
network egress from document code.

## Files changed

- `scripts/generate-headers.ts` — added `frame-src 'self' <sandbox-origin>` to the app
  SPA CSP (per-mode value from `SANDBOX_ORIGIN_URL`); new exported `deriveSandboxOrigin`
  (URL→bare origin, fail-fast on malformed/non-http(s)); `sandboxOrigin` option +
  fail-fast env read in `generateHeaders`; banner directive note. No existing directive
  altered.
- `scripts/generate-headers.test.ts` — deterministic `SANDBOX_ORIGIN_URL` in
  beforeEach/afterEach (mirrors the MinIO pattern); `generateHeaders — sandbox frame-src`
  describe (8 tests) + `deriveSandboxOrigin` describe (5 tests).
- `apps/sandbox/public/_headers` — added the strict CSP directive to the `/*` block;
  expanded the header comment to state the containment posture in durable terms.
- `apps/sandbox/src/headers.test.ts` (new) — pins the static sandbox CSP (connect-src
  allowlist, script-src sources, worker-src, frame-ancestors, default-src, CORS baseline).
- `apps/sandbox/wrangler.toml` — micro-item: dropped the dangling `(ARCHITECTURE §sandbox)`
  parenthetical, kept the security-boundary fact.

## Final CSP values (for T7 to pin)

- APP origin frame-src (prod): `frame-src 'self' https://sandbox.hushbox.ai`
  (dev/E2E: `frame-src 'self' http://localhost:7400`, per-worktree-offset).
- SANDBOX script-src: `script-src 'self' 'wasm-unsafe-eval' blob: https://esm.sh`
- SANDBOX connect-src: `connect-src 'self' https://pypi.org https://files.pythonhosted.org`
- SANDBOX worker-src: `worker-src 'self'`
- SANDBOX frame-ancestors: `frame-ancestors https://hushbox.ai capacitor://localhost http://localhost`
- SANDBOX full: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob: https://esm.sh; worker-src 'self'; connect-src 'self' https://pypi.org https://files.pythonhosted.org; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors https://hushbox.ai capacitor://localhost http://localhost; base-uri 'self'; form-action 'self'`

## Tests added

- `deriveSandboxOrigin` — bare origin passthrough / strip-path / dev-port / malformed-throw
  / non-http(s)-throw — covers the URL→origin seam.
- `frame-src on /*` — present + points at env sandbox origin — app-origin frame-src criterion.
- `frame-src keeps 'self'` — same-origin /demo embed preserved — no-loosen criterion.
- `frame-src origin-only (strips path)` — token hygiene.
- `frame-src dev origin` — per-mode templating.
- `frame-src on marketing blocks` — /welcome inherits it.
- `does not loosen existing SPA policy` — pins default-src/script-src/frame-ancestors/
  base-uri/form-action verbatim — no-loosen criterion.
- `reads SANDBOX_ORIGIN_URL from env` + `throws when unset` — fail-fast, no fallback.
- Sandbox `_headers` (8): connect-src is exactly self+pypi+pythonhosted; no wildcard/no
  esm.sh in connect-src; script-src has self/esm.sh/blob:/wasm-unsafe-eval; worker-src self;
  frame-ancestors includes capacitor://localhost + http://localhost + hushbox.ai and no
  wildcard; default-src self; CORS+CORP baseline intact — R8 no-network + A7 embed criteria.

## Self-gate

- `vitest generate-headers.test.ts` — pass — 81/81. RED verified: removing the frame-src
  directive fails 6 frame-src tests; verified GREEN after restore.
- `vitest apps/sandbox/src/headers.test.ts` — pass — 8/8. RED verified: wildcarding
  connect-src + dropping http://localhost fails 3 tests; GREEN after restore.
- full `@hushbox/sandbox` vitest — pass — 79/79 (8 files).
- coverage `generate-headers.ts` — 100% stmts/branches/funcs/lines.
- `turbo typecheck lint --filter=@hushbox/scripts` — pass (both).
- `turbo typecheck --filter=@hushbox/sandbox` — pass.
- `eslint` owned files (scripts/generate-headers.ts, .test.ts; apps/sandbox/src/headers.test.ts)
  — exit 0 after final edit.
- `pnpm verify:env` — development ✓, production ✓; registry per-key completeness ✓.
  ciVitest/e2e/ciE2E FAIL — see deviations (not mine).

### Failures attributed outside my ownership

- `turbo lint --filter=@hushbox/sandbox` fails on `apps/sandbox/src/render/import-map.test.ts`
  and `src/render/specifier.ts` (prettier + unicorn/prevent-abbreviations +
  restrict-template-expressions). Those are T2 files, explicitly out of my bounds; my owned
  files lint clean.
- `verify:env --mode=ciVitest|e2e|ciE2E` fails on Backend + Frontend `.env` verification —
  the local `.env.development`/`.dev.vars` are generated for `development` mode, so a
  cross-mode verify mismatches. `packages/shared/src/env.config.ts` shows Modified and all
  of `apps/sandbox` is untracked — both are T1/concurrent uncommitted work. I touched no env
  config or `.env` file; the failure reproduces on files I never changed.

## Acceptance criteria

- App origin frame-src present + points at env sandbox origin — MET (per-mode from
  `SANDBOX_ORIGIN_URL`, fail-fast, no hard-coded domain/fallback; tests + 100% cov).
- No existing app directive loosened — MET (regression test pins every pre-existing
  directive; frame-src is purely additive and retains 'self').
- Sandbox connect-src = wheel hosts + self only, excludes arbitrary hosts — MET
  (`'self' https://pypi.org https://files.pythonhosted.org`; esm.sh deliberately excluded
  from connect-src — it is a script-src source, so import works, fetch does not = R8).
- Sandbox script-src allows self + module CDN — MET (+ `blob:` for the transpiled-module
  import the renderer does, + `'wasm-unsafe-eval'` for Pyodide WASM — both functionally
  required by T2/T3 and confirmed by the T0 spike's blob-import + WASM paths).
- worker-src self — MET.
- frame-ancestors = app origins + capacitor://localhost — MET, with http://localhost added
  (see deviation) so the Android shell can embed.
- T1 CORS/CORP/application-wasm baseline kept — MET (unchanged; test pins CORS+CORP).
- img-src/style-src for rendered output — MET (`img-src 'self' blob: data:`,
  `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:` — all local-only, exfil-safe).
- Micro-item (wrangler.toml dangling doc pointer) — MET.

## Deviations with reasons

- **frame-ancestors includes `http://localhost` beyond the brief's literal
  `capacitor://localhost`.** `apps/web/capacitor.config.ts` sets `androidScheme: 'http'`, so
  the Capacitor Android WebView origin is `http://localhost`, not `capacitor://localhost`.
  The brief's A7 named only `capacitor://localhost` (the iOS default). Omitting
  `http://localhost` would block the sandbox embed on Android — the tested mobile platform
  (R5/T9) — defeating R4. I read "our app origins" as the actual app origins
  (web `https://hushbox.ai` + Android `http://localhost`) plus the iOS shell
  `capacitor://localhost`, and included all three.

## Concerns and limitations

- **`'unsafe-eval'` is omitted from the sandbox script-src.** The T0 spike ran under a
  permissive (no-CSP) static server, so Pyodide 314.x under a strict script-src with only
  `'wasm-unsafe-eval'` + `blob:` is unverified. If T3's Pyodide runtime needs `'unsafe-eval'`,
  T6's sandbox script-src must add it — this does not affect the R8 network posture (eval is
  code execution, not network; running untrusted code is the whole point).
- **connect-src excludes any package CDN (jsdelivr etc.).** This assumes T3 configures
  Pyodide with a self-hosted `indexURL` for built packages (the spike did:
  `loadPyodide({ indexURL: ${base}/pyodide/ })`) and micropip only reaches PyPI. If T3's
  install path reaches a CDN, connect-src needs it added.
- **The static sandbox `_headers` CSP is enforced only by Cloudflare in production.** The T1
  local Node dev-server sends CORS only, no CSP. The values here are the production values
  (esm.sh, hushbox.ai). In test modes the module CDN is a local stub on the sandbox's own
  origin, covered by `'self'`.

## Confidence

High for the app-origin frame-src (100% cov, RED-verified, no-loosen pinned) and the R8
connect-src posture. Medium on two sandbox script-src judgment calls (`'unsafe-eval'`
omission, no package-CDN in connect-src) that the T0 spike could not verify under a real
strict CSP — flagged for T3/T7.
