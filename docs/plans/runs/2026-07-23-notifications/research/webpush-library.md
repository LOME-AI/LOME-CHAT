# Web Push library research — sending RFC 8291/8292 push from a Cloudflare Worker

Date: 2026-07-24. Researcher: package-research subagent. All source claims verified by
downloading and reading each package's GitHub source this session.

## The decisive finding: three of the four named candidates are disqualified on standards grounds

Apple's push service (`web.push.apple.com`) accepts **only** RFC 8291 `aes128gcm`; the
legacy draft `aesgcm` encoding gets a 403 (MDN `PushManager.supportedContentEncodings`
returns `["aes128gcm"]`; multiple field reports of 403s fixed by switching encodings —
https://developer.mozilla.org/en-US/docs/Web/API/PushManager/supportedContentEncodings_static,
https://github.com/web-push-libs/webpush-java/issues/207). Safari/iOS PWA users are a real
audience for HushBox (Capacitor + web), so aesgcm-only libraries cannot ship.

Verified by reading source:

- **`@pushforge/builder` 2.0.5** — implements only legacy `aesgcm`: HKDF info strings
  `Content-Encoding: auth\0` / `aesgcm\0` / `nonce\0` and headers
  `Content-Encoding: aesgcm`, `Encryption: salt=…`, `Crypto-Key: dh=…`
  (`packages/builder/lib/payload.ts`, `lib/vapid.ts` at tag of v2.0.5). The README's
  "modern, cross-platform, full VAPID" marketing does not mention this. **Disqualified.**
- **`@block65/webcrypto-web-push` 1.0.2** — same legacy scheme
  (`packages/web-push/lib/payload.ts`: `'content-encoding': 'aesgcm'`). Also last
  published 2024-12-15, and carries 3 deps incl. `type-fest` and a custom-error package.
  **Disqualified.**
- **`webpush-webcrypto` 1.0.5** — same legacy scheme (`lib/constants.js`:
  `"Content-Encoding: aesgcm\0"`; `lib/payload.js:267`). Plain JS + JSDoc, no shipped
  `.d.ts` (`npm view … types` empty), 902 downloads/week, last release 2025-04-22.
  **Disqualified.**

## Remaining candidates

### `web-push-neo` 0.1.2 (found during search; not in the original list)

- Repo: https://github.com/ryoppippi/web-push-neo — 10 stars, 0 open issues, pushed
  2026-03-27; npm 5,475 dl/week; single maintainer (ryoppippi, prolific OSS author).
- **Correctness: textbook RFC 8291.** `src/encryption.ts` (128 lines) is a literal
  transcription of the RFC: `WebPush: info\0` IKM, `Content-Encoding: aes128gcm\0` CEK,
  `nonce\0`, 0x02 delimiter, header `[salt|rs(4, big-endian via DataView.setUint32)|
  keyid_len|keyid]`. aes128gcm **only** (correct choice — it is the only encoding all
  current push services accept).
- **Full header coverage:** TTL (validated), Urgency (validated against the RFC enum),
  Topic, extra headers, AbortSignal (`src/web-push.ts`).
- **VAPID:** ES256 JWT via `jose` — the **same `jose` v6 already a direct dependency of
  `apps/api`** (apps/api/package.json: `"jose": "^6.2.3"`; neo wants `^6.2.2`), so the
  effective new-dependency footprint is one 900-line package. Accepts both raw 32-byte
  (classic `web-push`-compatible) and PKCS8 private keys (`src/vapid.ts`).
- **TypeScript-first**, colocated vitest tests, typed `WebPushError` (status/headers/body
  attached), `sendNotification` throws on non-2xx — callers still must map 404/410 to
  subscription pruning.
- **License: MPL-2.0** — fine to consume as an unmodified npm dependency in a proprietary
  app; file-level copyleft only binds if we modify/vendor its files. Do **not** vendor
  its code verbatim.
- Risk: v0.1.x, bus factor 1, 10 stars — young.

### `web-push-browser` 1.4.2

- Repo: https://github.com/colecrouter/web-push-browser — 2 stars, ISC, last release
  2025-08-18; 1,374 dl/week; zero runtime deps; TypeScript.
- Supports both `aes128gcm` (default) and legacy `aesgcm`; TTL + Urgency headers; **no
  Topic header** (verified: no `topic` anywhere in `src/`).
- **Endianness bug found reading `src/crypto/helpers.ts:71-80`:** record-size and
  key-length fields are built with `new Uint32Array([4096]).buffer` /
  `new Uint16Array([len]).buffer` — platform-endian (little-endian on V8), where RFC 8188
  requires network byte order. For the aes128gcm path this is masked (a bogus rs of
  0x00100000 still decrypts single-record messages); for the aesgcm path it is outright
  wrong. It "works" by accident. That is not the crypto hygiene this repo holds itself to.
- One test file (`test/encryption.test.ts`). **Runner-up at best; not recommended.**

### Stock `web-push` (baseline)

5.9M dl/week, but built on Node `crypto.createECDH` + `https.request`; Workers support is
a long-standing open issue (https://github.com/web-push-libs/web-push/issues/718).
Confirmed out of scope per the task premise.

## In-house implementation: sizing and fit

`web-push-neo` is the existence proof of the size: **~250 lines of production code**
(encryption ~130, VAPID JWT ~60 using the already-present `jose`, headers/validation
~60) + base64url helpers the repo already has in `packages/crypto`. Everything needed is
plain WebCrypto — ECDH P-256 `deriveBits`, HKDF-SHA-256, AES-GCM, ECDSA P-256 — all
supported by workerd and by Node 20+ `globalThis.crypto` (apps/api's vitest projects run
`environment: 'node'`, apps/api/vitest.config.ts:37, so tests need no shim). RFC 8291
**Appendix A ships a complete test vector** (fixed keys + salt → exact ciphertext), so a
clean-room implementation can be pinned deterministically by injecting the ephemeral key
and salt in tests — this satisfies the 95%-coverage rule with *stronger* assurance than
any of these packages' own suites. RFC 8292 §2 likewise has a signable example.

Fit against HushBox values:

- **Minimal vendor lock-in / bus factor:** every viable third-party option here is a
  bus-factor-1 hobby package (10 stars is the *largest* correct one). In-house removes
  that entirely; the "spec" cannot drift (RFCs are frozen).
- **Audited-crypto preference:** all primitives stay in WebCrypto (platform-audited);
  no new crypto dependency at all. `@noble/curves` is *not* needed — WebCrypto covers
  P-256 ECDH/ECDSA natively on Workers.
- **Fail-fast / Result seams:** an in-house module returns typed `Result`s and maps
  404/410 (prune subscription), 429, 413 explicitly instead of a foreign throw taxonomy.
- **License:** no MPL in the tree. Write from the RFCs (+ neo as a *reference to check
  against*, not to copy).

## Recommendation

**Primary: write the ~250-line in-house implementation** (WebCrypto + existing `jose`),
clean-room from RFC 8291/8188/8292, pinned by the RFC Appendix-A test vectors with
injectable ephemeral key/salt, living behind the notifications slice's push port.
**Runner-up: depend on `web-push-neo`** if the run decides a dependency is still worth
it — it is the only candidate that is RFC-correct with full TTL/Urgency/Topic support,
and its `jose` dep is already ours; accept v0.1.x/bus-factor-1/MPL-2.0 as the trade.

Explicitly rejected: `@pushforge/builder`, `@block65/webcrypto-web-push`,
`webpush-webcrypto` (all legacy-aesgcm-only → Apple 403), `web-push-browser` (endianness
sloppiness, no Topic, 2 stars), stock `web-push` (Node-crypto-bound).

## Sources

- Package sources downloaded & read: draphy/pushforge, block65/webcrypto-web-push,
  colecrouter/web-push-browser, alastaircoote/webpush-webcrypto, ryoppippi/web-push-neo
  (GitHub tarballs, default branches, 2026-07-24)
- npm registry: versions/dates/deps/downloads via `npm view` + api.npmjs.org (2026-07-24)
- https://developer.mozilla.org/en-US/docs/Web/API/PushManager/supportedContentEncodings_static — aes128gcm-only reality
- https://github.com/web-push-libs/webpush-java/issues/207 — Apple 403 on legacy aesgcm
- https://github.com/web-push-libs/web-push/issues/718 — stock web-push on Workers
- /workspace/popper-mobile/.superset/projects/HushBox/apps/api/package.json — jose ^6.2.3 already present
- /workspace/popper-mobile/.superset/projects/HushBox/apps/api/vitest.config.ts — node-env test projects
