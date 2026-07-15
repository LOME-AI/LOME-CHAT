/**
 * The Cloudflare Access authentication-log read port: the ~6-hourly pull
 * cron audits these events — the ceremony is the only enrollment path, so
 * any enrollment-shaped event is an alert, and an authentication outside
 * the actor allowlist is a compromised edge wall. Behind a port because the
 * real Cloudflare API is not locally exercisable: tests and dev/CI bind the
 * fake adapter.
 */

export interface AccessLogEvent {
  readonly email: string;
  /**
   * `authentication` = an ordinary Access login. `enrollment` = anything
   * that is NOT a plain login — adapters map unknown event shapes here
   * fail-closed, so a new Cloudflare event type alerts instead of passing
   * silently.
   */
  readonly kind: 'authentication' | 'enrollment';
  /** ISO timestamp as reported by the log source. */
  readonly occurredAt: string;
}

export interface AccessLogWindow {
  readonly since: Date;
  readonly until: Date;
}

export interface AccessLogReader {
  listEvents(window: AccessLogWindow): Promise<readonly AccessLogEvent[]>;
}
