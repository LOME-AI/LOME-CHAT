import type { AccessLogEvent, AccessLogReader } from '../ports/index.js';

/**
 * The local/CI Access-log source: canned events, no network. The real
 * Cloudflare Access API is not locally exercisable, so dev/CI bind this and
 * tests drive the audit rules through it.
 */
export function createFakeAccessLogReader(events: readonly AccessLogEvent[]): AccessLogReader {
  return {
    listEvents(): Promise<readonly AccessLogEvent[]> {
      return Promise.resolve([...events]);
    },
  };
}
