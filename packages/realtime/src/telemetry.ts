/**
 * The room's observability seam: a CLOSED event set instead of free-form
 * messages, so the package carries no content-capable logging surface at
 * all. The worker binds each event to its typed Telemetry port with a
 * literal message (packages never import apps).
 */
export interface RoomTelemetry {
  runStarted(fields: { conversationId: string; runId: string }): void;
  runFinished(fields: { conversationId: string; runId: string; errorCode?: string }): void;
  runRejected(fields: { conversationId: string; errorCode: string }): void;
  deadlineFired(fields: { conversationId: string; runId: string }): void;
  /** A principal failed broadcast-time revalidation and was cut. */
  principalEvicted(fields: { conversationId: string }): void;
  /** Verification infrastructure is down past the last-known-good window. */
  deliveryPaused(fields: { conversationId: string }): void;
  clientMessageRejected(fields: { conversationId: string }): void;
}
