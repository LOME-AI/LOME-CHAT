// Import the bridge from the narrow `@hushbox/shared/documents` subpath, never the
// top-level barrel: the barrel `export *`s the backend env-config registry, which
// esbuild cannot tree-shake out of the bundle. Pulling it in would embed every
// backend env-var name (and dev-mode secret-shaped values) into the bundles this
// credential-free public sandbox origin serves.
import {
  parseParentToFrameMessage,
  type FrameToParentMessage,
  type ParentToFrameMessage,
  type ReadyMessage,
} from '@hushbox/shared/documents';

/**
 * The frame side of the document bridge: the one handshake both sandbox pages
 * perform, written once so the two cannot drift.
 *
 * A `MessageChannel` is forced, not preferred. A sandboxed frame's origin is
 * opaque, so an embedder targeting it by origin string has nothing to name —
 * `postMessage` to a `"null"` origin is discarded silently, and the literal
 * `'null'` is rejected as a target. It is also the stronger boundary in both
 * directions. Inbound, the port is a capability held by whoever received it, so
 * a document sharing this realm cannot forge a message by posting at the window
 * the way it could when a window listener was the intake. Outbound, a document's
 * console output and results go to the one holder of the port instead of being
 * broadcast to every listener on the embedding page.
 *
 * Drift between two copies of this would be invisible: a dropped `start()` or a
 * changed transfer list leaves the page loading and silent, and no test in a
 * Node or happy-dom environment can see it (both supply Node's `MessagePort`,
 * which starts itself when a listener is attached). Only a real browser can, and
 * only for whichever copy it exercises. Hence one copy.
 */

/**
 * Mint the channel, take its receiving end, and hand the other to the embedder.
 *
 * `onMessage` receives every inbound message that passes shape validation; the
 * returned function is the page's only way to send. No `window` message listener
 * is installed, and that absence is the security property: the only way into the
 * frame is the port, which reaches whoever the `ready` transfer handed it to and
 * nobody else.
 *
 * The port never leaves this closure. Both pages bundle to an esbuild IIFE, so
 * nothing here is reachable from the frame's `globalThis` — which matters,
 * because untrusted document code shares that realm, and the port is the
 * embedder's authority over the frame.
 */
export function connectToEmbedder(
  onMessage: (message: ParentToFrameMessage) => void
): (message: FrameToParentMessage) => void {
  const channel = new MessageChannel();
  // Holding the other end of this channel is the embedder's authority, and it is
  // unforgeable: a document sharing the frame's realm has no way to obtain the
  // port and no window listener to post at. A port event carries no sender origin
  // to check either way (`event.origin` is always empty), so the parse below is
  // input validation on a channel whose holder is already trusted — not the thing
  // that decides whom to trust.
  channel.port1.addEventListener('message', (event: MessageEvent) => {
    const parsed = parseParentToFrameMessage(event.data);
    if (!parsed.success) return;
    onMessage(parsed.data);
  });
  // A port delivers nothing until it is started, and `addEventListener` (unlike
  // assigning `onmessage`, which the lint rules forbid) does not start it
  // implicitly. Started before the transfer, so anything the embedder sends the
  // instant it receives the port is queued, not dropped.
  channel.port1.start();
  // The one broadcast a sandbox page makes, sent once per frame instance. It
  // cannot be narrowed: an opaque frame cannot learn its embedder's origin (it is
  // capacitor://localhost on mobile), and `parent` names exactly one window
  // regardless. The payload is a bare type tag; the capability is the port.
  const ready: ReadyMessage = { type: 'ready' };
  // eslint-disable-next-line sonarjs/post-message -- intentional '*' to an unknowable embedder origin; payload is a bare type tag
  parent.postMessage(ready, '*', [channel.port2]);
  return (message: FrameToParentMessage): void => {
    channel.port1.postMessage(message);
  };
}
