/**
 * Fixed timeout budgets for E2E tests, in milliseconds.
 *
 * These are the single source of truth for every `timeout:` value in the E2E
 * suite. Values are fixed literals: there is no environment variable, no
 * multiplier, and no runtime scaling of any kind. A test is either reliable at
 * a given budget on every machine or it is broken — scaling timeouts hides the
 * breakage instead of surfacing it.
 *
 * Inline numeric `timeout:` literals are banned in specs and helpers (enforced
 * by lint); reference a named budget from this module instead.
 */
export const TIMEOUTS = {
  /** App reports it has finished its initial boot and is interactive. */
  APP_STABLE: 15_000,
  /** A client-side route transition has settled. */
  ROUTE: 20_000,
  /** A conversation's messages have loaded and decrypted. */
  CONVERSATION_LOAD: 15_000,
  /** A streamed LLM response has completed. */
  STREAM: 15_000,
  /**
   * A regeneration that clears the whole conversation and re-streams the first
   * turn — the heaviest single stream cycle (cascade-delete then a fresh
   * stream). Wider than STREAM so the cycle still completes when every browser
   * project's workers run at once and saturate the host (see resource-scan).
   */
  STREAM_CLEAR: 30_000,
  /**
   * A streamed turn whose first render can lag under the fully saturated matrix.
   * Wider than STREAM (which is sized for a warm, uncontended single stream) to
   * cover the two cases that legitimately run long when every browser project's
   * workers hammer the host at once: (1) a multi-model fan-out, where N streams
   * contend for the same CPU/socket/DB budget and a workerd recycle can drop one
   * mid-turn, forcing a reconnect+replay before all tiles settle; and (2) a
   * first message to a fresh conversation, whose ConversationRoom DO cold-starts
   * and competes for the ~128 MB shared isolate, so the first token can take far
   * longer than a warm follow-up. The token still arrives — it is starved, not
   * dropped — so the budget absorbs it instead of scaling at runtime.
   *
   * Coincides with STREAM_CLEAR at 30s today but is kept distinct: that one
   * bounds a regen's cascade-delete-then-restream, this one a saturated
   * first-token/fan-out. They can diverge if either profile changes.
   */
  STREAM_SATURATED: 30_000,
  /**
   * A media asset (image/video) has decoded and rendered. Covers the full
   * client chain after the turn streams: fetch the ciphertext (R2/MinIO),
   * decrypt it (WASM crypto), and decode the bytes — all main-thread work that
   * a saturated host serializes behind every other worker's browser, so the
   * rendered element can land past a 30s budget. Wider than STREAM so it absorbs
   * that without scaling at runtime.
   */
  MEDIA_DECODE: 45_000,
  /** A realtime WebSocket connection has completed its handshake. */
  WS_HANDSHAKE: 15_000,
  /** A modal/dialog has opened or closed. */
  MODAL: 5000,
  /** A scroll position has stabilized. */
  SCROLL_STABLE: 5000,
  /** An inbound webhook has been received and processed. */
  WEBHOOK: 30_000,
  /**
   * A transactional job enqueued for a near-future `scheduledAt` has been
   * claimed and executed by the alarm-clocked dispatcher. Sized as the spec's
   * deliberate schedule lead (the newsletter schedule op refuses non-future
   * instants, so specs must aim tens of seconds ahead) plus the dispatcher's
   * claim latency (alarm re-arm ≤30s) under a saturated host.
   */
  JOB_DISPATCH: 90_000,
  /**
   * A node-side API request has returned a terminal (non-transient) response.
   * Bounds the per-request retry budget that `withRequestRetry` wraps every
   * fixture context with: under host saturation a workerd/wrangler recycle
   * answers an in-flight request with a bare 5xx or severs the socket, and the
   * request is re-issued until it settles or this budget elapses.
   */
  API_SETUP: 15_000,
  /** A single web-first assertion. */
  ASSERT: 10_000,
  /** A fast, near-immediate expectation. */
  QUICK: 1000,
  /** A long-running flow. */
  LONG: 60_000,
  /** An extra-long-running flow. */
  XLONG: 120_000,
  /** The longest sanctioned flow. */
  XXLONG: 180_000,
} as const;
