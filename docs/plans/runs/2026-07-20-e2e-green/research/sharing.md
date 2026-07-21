# Sharing/group cluster diagnosis (run 2026-07-20T05-25-42, iphone-15)

10 failures → 4 root causes. (Persisted by orchestrator from the Explore diagnostician's inline return — the agent had no write tool.)

## RC1 — Guest share routes crash blank: runtime `env.isE2E` dynamic import of device-key E2E chunk cancelled mid-navigation

Tests (3): link-guest-chat (write-privileged guest) · link-guest-access (with-history guests) · shared-content (invite link view + revoked link error).

Evidence: guest pages render an empty `- document`; console: `TypeError: Importing a module script failed` → CatchBoundaryImpl. Trace network: `GET /assets/device-key-store.e2e-CI05kwdG.js` — 15 request snapshots with empty status (aborted) vs 23 with 200; link-guest flow re-navigates and cancels the in-flight ESM fetch → `import()` rejects uncaught → error boundary → blank.

Defect: app/harness — `apps/web/src/lib/device-key-store.ts:74-76, 99-101, 130-132`: `if (env.isE2E) { const e2e = await import('./device-key-store.e2e.js') }` on the auth-bootstrap critical path (auth provider calls `loadExportKeyProtected()` on mount for every route, guests included). Introduced by the a4b4483d fallback work.

Fix: resolve the variant at **build time** (Vite define/alias, e.g. VITE_E2E) so the E2E build statically bundles the `.e2e` variant into the entry chunk and prod tree-shakes it out — removes the cancellable runtime fetch entirely. Prod bundle must still never contain `.e2e` code (existing arch rule).

Enforcement: contract test asserting guest share routes load with no lazily-fetched chunk on the auth-bootstrap path; lint forbidding `await import('*device-key-store*.e2e*')` on the sync auth path.

## RC2 — Owner media generation `ChatRunFailedError: INTERNAL` ("minio down") — CROSS-CLUSTER

Tests (4): shared-content group-invite-link-image-and-video · share-create-post-body-stays-small · revoked-message-share-404 · shared-video-message-guest-plays.

Owner-side image/video generation fails at media persistence (media-persist ↔ MinIO), UI shows "This turn failed before anything was saved". Intermittent. Same cause as the chat image/video/multi-model-media cluster; NOT sharing code. Fix owned by the media cluster: deterministic storage edge / MinIO readiness. Enforcement: storage-edge auto-fail fixture + MinIO readiness gate.

## RC3 — Idempotent share-create replays stale wrapped key while client re-mints `shareSecret`

Tests (2): shared-message-link-shows-decrypted-content · shared-image-message-guest-sees-rendered-image.

Evidence: all guest fetches 200 (share GET, download-url, presigned GET), yet decrypt fails ("share link may be invalid or expired" / "couldn't load this media"); reproduces across all retries. Mechanism: `apps/web/src/hooks/chat/use-message-share.ts:63` calls `createShare(contentKey)` inside `mutationFn` — fresh random `shareSecret` per invocation; URL fragment built from it (line 82). The Idempotency-Key (idempotent-mutation.ts:21-27) is WeakMap-pinned to the stable `variables` object which excludes the secret. On retry: client URL carries S2, server dedups and returns the wrap under S1 → `openShare(S2, wrap(S1))` → garbage contentKey → AEAD fails. Same latent shape in `useCreateLink`/`useChangeLinkPrivilege` (use-conversation-links.ts).

Fix: mint `shareSecret` once per logical mutation (WeakMap-on-variables like the idempotency key, or onMutate + thread through variables) so retries reuse it; apply same to `useCreateLink`. Enforcement: round-trip contract test (forced retry → URL fragment still opens stored wrap); lint against re-randomizing key material inside an idempotent `mutationFn`.

## RC4 — Revoked invite link stays visible — INTENT CONFLICT

Test (1): group-chat-admin invite-link lifecycle.

Revoke POST 200 + query invalidation, but `listForConversation` (`apps/api/src/slices/conversations/adapters/stores.ts:870-891`) has no `isNull(revokedAt)` predicate (revoke/unrevoke/byPublicKey paths at 899-913 do), and the client never filters `revokedAt` — so the refetch keeps the row visible.

CONFLICT: test expects the row to disappear; API returns revoked rows (possibly intentional for a "revoked" badge). Either server-side hide (add `isNull(revokedAt)`) or client filter + spec asserts a revoked-badge state. Needs founder ruling before fixing. Enforcement after ruling: store-level contract test pinning the chosen read-model behavior.
