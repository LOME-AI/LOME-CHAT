const MB = 1_048_576;
const KB = 1024;

/**
 * Render "<loaded.X> / <total> MB" for the read-aloud model download.
 * Loaded uses one decimal so the digits visibly tick over; total is rounded
 * to an integer to match the disclosure copy ("80 MB, one-time download").
 */
export function formatBytesProgress(loaded: number, total: number): string {
  const loadedMb = (loaded / MB).toFixed(1);
  const totalMb = Math.round(total / MB).toString();
  return `${loadedMb} / ${totalMb} MB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= MB) return `${(bytesPerSecond / MB).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / KB).toString()} KB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) return '<1s left';
  if (seconds < 60) return `${Math.round(seconds).toString()}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m.toString()}m ${s.toString()}s left`;
}

export function estimateEtaSeconds(
  loaded: number,
  total: number,
  bytesPerSecond: number
): number | null {
  if (bytesPerSecond <= 0) return null;
  if (loaded >= total) return 0;
  return (total - loaded) / bytesPerSecond;
}

/**
 * Rolling-window average download rate. Drops samples older than `windowMs`
 * so a stalled or sped-up connection is reflected within the window. Returns
 * null until two samples within the window span a positive delta in both
 * time and bytes — avoiding noisy "Infinity B/s" readings from the first
 * burst of chunked progress events.
 */
export class DownloadRateTracker {
  private samples: { t: number; bytes: number }[] = [];

  constructor(private readonly windowMs = 3000) {}

  record(loaded: number, now: number): void {
    this.samples.push({ t: now, bytes: loaded });
    const cutoff = now - this.windowMs;
    // samples[0] is always present inside the length>0 loop; the `?? Infinity`
    // fallback satisfies noUncheckedIndexedAccess and never fires.
    /* v8 ignore next */
    while (this.samples.length > 0 && (this.samples[0]?.t ?? Infinity) < cutoff) {
      this.samples.shift();
    }
  }

  bytesPerSecond(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples.at(-1);
    // Both are present once length >= 2; the guard is defensive only.
    /* v8 ignore next */
    if (first === undefined || last === undefined) return null;
    const dtSec = (last.t - first.t) / 1000;
    if (dtSec <= 0) return null;
    const db = last.bytes - first.bytes;
    if (db <= 0) return null;
    return db / dtSec;
  }

  reset(): void {
    this.samples = [];
  }
}
