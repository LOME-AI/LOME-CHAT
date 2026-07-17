/**
 * Compact UTC rendering of an ISO timestamp for dense tables and feeds.
 * Minute precision for scanning; second precision where an operator compares
 * ordering (the audit drawer).
 */
export function formatTime(iso: string, precision: 'minute' | 'second' = 'minute'): string {
  return iso.replace('T', ' ').slice(0, precision === 'second' ? 19 : 16);
}
