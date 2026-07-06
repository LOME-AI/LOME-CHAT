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
  /**
   * A WebSocket upgrade the DO refused (bad/mismatched attachment params). A
   * WAE metric — its watcher is the WAE-metrics auditor, which reads the
   * upgrade-failure rate to measure the proxy/middlebox-blocked population.
   */
  upgradeRejected(fields: { conversationId: string }): void;
  /**
   * One billable gateway generation completed (a `step-finish`). A WAE metric —
   * its watcher is the OpenRouter-usage reconciliation auditor. The metric
   * carries the actual `generationId` (an opaque provider id) so a killed run —
   * which commits no `usage_records` row — is still reconcilable against
   * OpenRouter by its exact generation; `runId` groups the run and
   * `conversationId` scopes it.
   */
  billableGeneration(fields: { conversationId: string; runId: string; generationId: string }): void;
}
