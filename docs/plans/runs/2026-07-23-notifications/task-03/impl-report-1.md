# Task 03 — In-house Web Push sender + env registry — impl report 1

## Objective

A Workers-native in-house Web Push sender (RFC 8291 aes128gcm payload encryption,
RFC 8188 encoding, RFC 8292 VAPID ES256 JWT via `jose`) in the notifications slice
adapters, plus the VAPID env.config registry entries (I4/G5). No new npm dependency.

## Files changed

- `apps/api/src/slices/notifications/adapters/webpush/encrypt.ts` (new) — RFC 8291/8188
  aes128gcm payload encryption over WebCrypto (ECDH P-256 → HKDF-SHA-256 key-combining →
  CEK+nonce → AES-128-GCM); `generateEphemeralKey()` (fresh per message) and the injectable
  `encryptWebPushPayload()`.
- `apps/api/src/slices/notifications/adapters/webpush/vapid.ts` (new) — RFC 8292 VAPID:
  ES256 JWT via `jose` (`SignJWT`), `aud`=endpoint origin, `sub`=subject, `exp` capped at
  24h; returns the `vapid t=<jwt>, k=<publicKey>` Authorization value.
- `apps/api/src/slices/notifications/adapters/webpush/send.ts` (new) — `sendWebPush(sub,
  payload, options, deps): ResultAsync<WebPushSendResult, DomainError>`; validates Topic
  (≤32, `[A-Za-z0-9_-]`), TTL (non-negative int), Urgency (RFC 8030 enum), payload size;
  classifies 2xx→`delivered`, 404/410→`dead`, other→`failed`; transport throw→`unavailable`.
- `apps/api/src/slices/notifications/adapters/webpush/index.ts` (new) — module barrel for
  Task 04 (no slice `index.ts` edit — that wiring is Task 04's).
- `encrypt.test.ts` / `vapid.test.ts` / `send.test.ts` (new) — see tests below.
- `packages/shared/src/env.config.ts` — appended `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT` (backend) and `VITE_VAPID_PUBLIC_KEY` (frontend) registry entries + their
  Zod schema fields. Dev/CI = committed throwaway P-256 keypair; production = Workers
  secrets. Appended cleanly so Task 04's `NOTIFICATION_TAG_SECRET` append won't conflict.
- Generated (via `pnpm generate:env`, expected derived outputs): `.env.development`,
  `.env.scripts`, `apps/api/.dev.vars`, `apps/api/wrangler.toml`,
  `.github/workflows/{ci,release,build-android,run-ops-script}.yml`.

## Tests added (25, all green; 100% coverage on owned files)

- encrypt: **RFC 8291 Appendix A byte-exact** — injects the vector's ephemeral private key +
  salt, asserts `toBase64(body) === RFC 8291 §5 body` (header ‖ ciphertext). Ephemeral-keyid
  header layout; `generateEphemeralKey` shape + freshness.
- vapid: JWT verifies against the public key (jose `jwtVerify`, `currentDate` pinned) with
  `alg=ES256`, `aud`=origin, `sub`=subject, `exp` bounded; tampered signature rejected;
  custom expiry honored; >24h expiry fails fast.
- send: topic/ttl/urgency/size validation → `validation`; request shape (aes128gcm +
  octet-stream + TTL/Topic/Urgency/Authorization headers, encrypted body not plaintext,
  injected salt in header); outcome classification 201/404/410/503/429; transport
  throw→`unavailable`; global fetch/clock fallback.

## Self-gate

- `npx eslint webpush/` (from apps/api) — **pass** (exit 0) after the last edit.
- `turbo typecheck --filter=@hushbox/api --filter=@hushbox/shared` — **pass**.
- `turbo lint --filter=@hushbox/api` — **fail**, but only on concurrent-workstream files
  (`workflows/engine/smart-model.integration.test.ts`, `models/domain/estimate*.ts`,
  `chat/domain/smart-model-turn.test.ts` — all ` M` in git status, outside this task's
  ownership). Owned files lint clean in isolation.
- webpush coverage (`vitest --coverage.include=webpush/**`) — **100%** stmts/branch/func/lines
  (82/82, 40/40, 14/14, 78/78).
- `pnpm test:shared` — **pass** (env.config change safe; base64.ts 100%).
- notifications-slice api tests — webpush 25/25 pass; other failures are environmental
  (`DATABASE_URL is required` — no local stack) or concurrent (`template-html.test.ts`
  "byte-stable across the builder-helper refactor" — no email/template files in my diff).
- `pnpm verify:env --mode=development` and `--mode=production` — **green**; registry per-key
  completeness green across ALL modes. ciVitest/e2e/ciE2E overall runs fail only on runtime
  env-detection assertions (`isCI`/`isE2E`/`requiresRealServices`) that require actual CI/E2E
  process markers this shell can't set — unrelated to the registry keys.
- gitleaks (`8.24.3`, repo `.gitleaks.toml`) — **no leaks** on `env.config.ts` and
  `wrangler.toml` (the only tracked files carrying the dev keys). `.env.development` is
  gitignored.
- Zero new npm dependencies: `git diff apps/api/package.json packages/shared/package.json` =
  empty. `jose` (already `^6.2.3`) + WebCrypto + `@hushbox/shared` base64 only.

## Acceptance criteria

- aes128gcm pinned byte-exact to RFC 8291 Appendix A — **met** (encrypt.test.ts vector test).
- VAPID ES256 JWT structurally verified (aud/exp/sub + signature vs public key) — **met**.
- Topic ≤32 / `[A-Za-z0-9_-]` fail-fast — **met** (send.test.ts).
- Env registry for all four modes; dev/CI committed throwaway keypair; verify:env green;
  gitleaks not firing — **met** (see deviation on the allowlist below).
- Outcome classification 404/410→permanent dead, else transient, no retry machinery — **met**.
- No new npm dependency; 95% coverage on owned files — **met** (100%).
- Explicit return types, Result-typed seams, no `any` — **met**.

## Deviations (with reasons)

1. **No gitleaks allowlist entry added** — the brief said the dev private key "needs an
   allowlist entry pinned to its exact path." Empirically gitleaks 8.24.3 with the repo
   config does **not** fire on the VAPID keys in `env.config.ts` or `wrangler.toml` (verified
   directly, no leaks). The `[Mode.X]: '…'` assignment pattern breaks `generic-api-key`'s
   keyword-proximity heuristic, and the SAME file already carries a committed high-entropy dev
   key (`CF_ACCESS_DEV_PRIVATE_JWK`) with no allowlist and passes. Adding a path-pinned
   allowlist for `env.config.ts` would **broaden** the allowlist for no reason — the brief's
   own NEEDS_CONTEXT trigger flags a broadened allowlist as a defect. So `.gitleaks.toml` is
   left untouched. Raised.
2. `VAPID_SUBJECT` production value is a literal `mailto:notifications@hushbox.ai` (non-secret
   per RFC 8292 — it is public sender contact info). Founder may prefer a different address;
   trivially changed.
3. Public keys (`VAPID_PUBLIC_KEY`/`VITE_VAPID_PUBLIC_KEY`) use `secret(...)` in production
   even though a public key is not sensitive — because the production keypair is minted
   out-of-band and must stay consistent with the private key; a Workers secret is the natural
   carrier.

## Concerns and limitations

- **Concurrent edits to shared files.** `packages/shared/src/env.config.ts` is being edited
  live by the sandbox/document-renderer workstream (`SANDBOX_ORIGIN_URL`, `ESM_CDN_URL`
  appeared mid-session). My VAPID entries appended cleanly and coexist. My `generate:env`
  regenerated shared derived files (workflow YAMLs, `wrangler.toml`, `.env.*`, `.dev.vars`)
  that now bake in BOTH my VAPID vars and those sandbox vars — expected and consistent
  (generate:env is deterministic from the full registry), but the orchestrator should know
  the derived files are entangled with that workstream. `workflows/**` source files in the
  working tree are that other workstream's changes — untouched here.
- **Sender seam for Task 04:** `sendWebPush(subscription, payloadBytes, options, deps):
  ResultAsync<WebPushSendResult, DomainError>` — `WebPushSendResult = { outcome:
  'delivered'|'dead'|'failed', statusCode }`. The composite adapter maps `'dead'` →
  `PushDelivery.deadTokens`. Deps carry `vapid`, optional `fetchImpl`, and test-only
  `generateEphemeral`/`generateSalt`/`now`.
- Full `pnpm test:api` was not run to completion here: integration tests need the local stack
  (absent) and the suite carries concurrent-workstream unit reds; the owned surface is fully
  green.

## Confidence

**High** — the encryption is pinned byte-for-byte to the frozen RFC 8291 Appendix A vector,
the VAPID JWT verifies cryptographically, coverage is 100% on owned files, and every
non-owned red is attributed with evidence. Medium only on the two env-value judgment calls
(subject address; public-key-as-secret in prod), which are trivially adjusted.
