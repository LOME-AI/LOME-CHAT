# T22 — R8: DO WebSocket close-handshake parity (impl-report-1)

## Objective
Restore legacy DO WebSocket close handling (R8) via the SURGICAL path:
1. Add the targeted compat flag `web_socket_auto_reply_to_close` to `apps/api/wrangler.toml`
   (runtime provides the reciprocal Close-frame echo for hibernatable sockets — the legacy
   `webSocketClose` code/reason echo). Keep `compatibility_date = "2026-03-01"` (no date bump).
2. Restore `webSocketError` → close `1011` / "WebSocket error" (the flag does NOT cover the
   error path), hibernation-safe (no double-close), keeping untrack + presence-rebroadcast.

## Files changed
- `apps/api/wrangler.toml` — appended `web_socket_auto_reply_to_close` to `compatibility_flags`
  (now `["nodejs_compat", "web_socket_auto_reply_to_close"]`); `compatibility_date` unchanged at
  `2026-03-01`. Comment records why a targeted flag, not a date bump.
- `packages/realtime/src/room-core.ts` — new `RoomCore.handleError(socket)`: closes the errored
  socket `1011`/"WebSocket error" via the existing `closeQuietly` (swallows an already-closing
  socket → hibernation-safe, no double-close), then delegates to `handleClose` for the untrack +
  presence-rebroadcast. Reuses the existing `CLOSE_INTERNAL_ERROR` (1011) constant.
- `packages/realtime/src/conversation-room.ts` — the DO shell's `webSocketError` handler now calls
  `core.handleError(...)` instead of `core.handleClose(...)`; `webSocketClose` left untouched
  (untrack + presence only — the runtime now supplies the code/reason echo via the flag).
- `packages/realtime/src/room-core.test.ts` — added `describe('handleError')` (3 tests).

## Wrangler diff (exact)
```
 compatibility_date = "2026-03-01"
-compatibility_flags = ["nodejs_compat"]
+# web_socket_auto_reply_to_close: the runtime auto-sends a reciprocal Close frame
+# echoing the peer's exact code/reason for hibernatable WebSockets — the
+# hibernation-race-safe equivalent of legacy `ws.close(event.code, event.reason)`
+# in webSocketClose. A targeted flag, NOT a compatibility_date bump (a date bump
+# would enable unrelated behaviors, including a WS reason-byte limit that throws).
+compatibility_flags = ["nodejs_compat", "web_socket_auto_reply_to_close"]
```
Date is unchanged; flag appended to the existing array (no conflict — array previously held only
`nodejs_compat`).

## Parity evidence (G1)
Legacy anchor independently opened: `legacy/packages/realtime/src/legacy_conversation-room.ts`
- `:161-168` `webSocketClose` → `try { ws.close(code, reason) } catch { /* already closed */ }`
  then `broadcastPresence()`. The code/reason echo is now runtime-provided by
  `web_socket_auto_reply_to_close`, so no manual echo is added to the new `webSocketClose`
  (which keeps its untrack + presence). Corroborated by report L165 (R8) and legacy report
  L3573/L3613 ("`webSocketError` → 1011 / WebSocket error").
- `:173-180` `webSocketError` → `try { ws.close(1011, 'WebSocket error') } catch {}` then
  `broadcastPresence()`. Reproduced exactly by `handleError`: same code (1011), same reason
  ("WebSocket error"), same swallow-on-already-closed, same presence rebroadcast (via
  `handleClose`). The new code additionally runs the untrack step (new-system active-room-set
  bookkeeping that legacy had no equivalent of — additive, in-bounds).

## Tests added (room-core.test.ts, `describe('handleError')`)
1. `closes the errored socket with 1011 "WebSocket error"` — proves the error-path close
   (the R8 error half). Covered acceptance step 2.
2. `broadcasts presence to the remaining sockets after an error` — proves untrack+presence
   preserved on the error path.
3. `swallows a close failure so an already-closing socket is hibernation-safe` — a socket whose
   `close()` throws; `handleError` resolves without throwing → proves no double-close hazard.

TDD: all 3 failed first with `h.core.handleError is not a function` (right reason — method
missing), then passed after implementing `handleError`.

## Self-gate
- `pnpm test:realtime` — PASS. Full suite green (node vitest + the `test:workers` workerd harness
  `conversation-room.workers.test.ts`, 15 tests). Coverage gate passed. `room-core.ts` at 99.29%
  stmt / 97.1% branch / 100% func; the 4 uncovered branch lines (459, 728, 781, 902) are
  pre-existing and outside the new `handleError` region — the 3 new tests cover every new line.
- `npx eslint src/room-core.ts src/conversation-room.ts src/room-core.test.ts` (from
  `packages/realtime`, after the last edit) — exit 0.
- `pnpm --filter @hushbox/realtime typecheck` — PASS (clean).
- Repo-wide `pnpm typecheck` — fails ONLY on `apps/api/src/middleware/pipeline-bindings.ts(59,29):
  TS2304 Cannot find name 'ExecutionContext'`. Foreign/pre-existing: not in my diff, not an edited
  file, and named explicitly in the brief as an error to attribute out. My edited package
  (`@hushbox/realtime`) typechecks clean.

## Acceptance criteria
1. Targeted compat flag added, date kept — MET (diff above; array append, no conflict).
2. `webSocketError` → 1011 restored, hibernation-safe, untrack+presence kept — MET (handleError +
   DO-shell wiring; test 1 + test 3 + test 2). `webSocketClose` echo left to the runtime flag
   (no manual echo added) — MET.

## Concerns / coordination
- The workerd test harness config `packages/realtime/vitest.workers.config.ts:19` sets
  `compatibilityFlags: ['nodejs_compat']` — it does NOT include `web_socket_auto_reply_to_close`.
  This is a separate miniflare config (test-env only) and is OUT OF MY BOUNDS, so I did not edit
  it. No workers-validation test exercises `webSocketError` (grep: zero references), so the suite
  is unaffected. Parity note only: the workerd-level auto-close-echo is not validated in-repo
  because the harness lacks the flag; a follow-up could add it for full test parity. Not blocking.

## Confidence
High — behavior matches the legacy anchor line-for-line (1011 / "WebSocket error" / swallow /
presence); the flag is the documented Cloudflare mechanism for the close-echo half; self-gate green;
the only typecheck failure is the pre-named foreign error.
