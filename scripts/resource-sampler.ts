/**
 * OS-agnostic resource sampler.
 *
 * Samples system CPU / memory / load on an interval using only Node built-ins
 * (`os.*`) — no `/proc`, no cgroups, no external tools — so it runs identically
 * on Linux (CI/container), macOS, and Windows. Paired with the log-based
 * {@link ResourceScan}, the summary turns "tests crashed" into an actionable
 * verdict: e.g. CPU idle + process/thread-limit errors ⇒ raise the container's
 * process limit, not the worker count.
 */

import os from 'node:os';
import type { ResourceScan } from './resource-scan.js';

export interface ResourceSample {
  /** Milliseconds since sampling started. */
  t: number;
  /** System-wide CPU busy percentage [0,100] over the preceding interval. */
  cpuPct: number;
  /** Used memory percentage [0,100]. */
  memPct: number;
  /** 1-minute load average (0 on platforms that don't report it, e.g. Windows). */
  load1: number;
}

export interface ResourceSummary {
  durationMs: number;
  sampleCount: number;
  cores: number;
  totalMemBytes: number;
  cpu: { peak: number; avg: number };
  mem: { peak: number; avg: number };
  load: { peak: number };
}

export interface ResourceReport {
  summary: ResourceSummary;
  samples: ResourceSample[];
  scan: ResourceScan;
}

export interface ResourceSampler {
  start: () => void;
  /** Stops sampling and returns the collected series + summary. Safe to call
   *  without a prior {@link start} (returns an empty series). */
  stop: () => { summary: ResourceSummary; samples: ResourceSample[] };
}

type CpuTimes = ReturnType<typeof os.cpus>;

const DEFAULT_INTERVAL_MS = 2000;

/** Sum idle + total CPU jiffies across all cores in a snapshot. */
function aggregate(cpus: CpuTimes): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Aggregate busy% across all cores between two `os.cpus()` snapshots. */
export function computeCpuPercent(previous: CpuTimes, current: CpuTimes): number {
  const a = aggregate(previous);
  const b = aggregate(current);
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return 0;
  const busy = (1 - (b.idle - a.idle) / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(busy)));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarizeSamples(
  samples: readonly ResourceSample[],
  durationMs: number
): ResourceSummary {
  const cores = os.cpus().length;
  const totalMemBytes = os.totalmem();
  const base: ResourceSummary = {
    durationMs,
    sampleCount: samples.length,
    cores,
    totalMemBytes,
    cpu: { peak: 0, avg: 0 },
    mem: { peak: 0, avg: 0 },
    load: { peak: 0 },
  };
  if (samples.length === 0) return base;

  const sum = { cpu: 0, mem: 0 };
  for (const s of samples) {
    base.cpu.peak = Math.max(base.cpu.peak, s.cpuPct);
    base.mem.peak = Math.max(base.mem.peak, s.memPct);
    base.load.peak = Math.max(base.load.peak, s.load1);
    sum.cpu += s.cpuPct;
    sum.mem += s.memPct;
  }
  base.cpu.avg = round(sum.cpu / samples.length);
  base.mem.avg = round(sum.mem / samples.length);
  base.cpu.peak = round(base.cpu.peak);
  base.mem.peak = round(base.mem.peak);
  base.load.peak = round(base.load.peak);
  return base;
}

/** One-line-per-metric block for the end-of-run stdout. */
export function formatResourceStdout(report: ResourceReport): string {
  const { summary, scan } = report;
  const lines = [
    `\nResources over ${formatMs(summary.durationMs)} (peak / avg, system-wide):`,
    `  CPU     ${pct(summary.cpu.peak)} / ${pct(summary.cpu.avg)}`,
    `  memory  ${pct(summary.mem.peak)} / ${pct(summary.mem.avg)}  (of ${gib(summary.totalMemBytes)})`,
    `  load    ${String(summary.load.peak)}  (${String(summary.cores)} cores)`,
  ];
  if (scan.totalHits > 0) {
    const breakdown = scan.categories.map((c) => `${c.name}×${String(c.count)}`).join(', ');
    lines.push(`  resource-limit errors: ${String(scan.totalHits)} (${breakdown})`);
  }
  return lines.join('\n');
}

function pct(n: number): string {
  return `${String(n)}%`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m${String(seconds)}s` : `${String(seconds)}s`;
}

function takeSample(
  previous: CpuTimes,
  startMs: number
): { sample: ResourceSample; cpus: CpuTimes } {
  const cpus = os.cpus();
  const total = os.totalmem();
  const used = total - os.freemem();
  return {
    sample: {
      t: Date.now() - startMs,
      cpuPct: computeCpuPercent(previous, cpus),
      /* v8 ignore start -- os.totalmem() is always positive and os.loadavg() always returns a 3-element array on a real host */
      memPct: total > 0 ? Math.round((used / total) * 100) : 0,
      load1: round(os.loadavg()[0] ?? 0),
      /* v8 ignore stop */
    },
    cpus,
  };
}

export function createResourceSampler(intervalMs: number = DEFAULT_INTERVAL_MS): ResourceSampler {
  const samples: ResourceSample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let startMs = 0;
  let previousCpus: CpuTimes = [];

  return {
    start(): void {
      startMs = Date.now();
      previousCpus = os.cpus();
      timer = setInterval(() => {
        const { sample, cpus } = takeSample(previousCpus, startMs);
        previousCpus = cpus;
        samples.push(sample);
      }, intervalMs);
      // Don't keep the process alive solely for sampling.
      timer.unref();
    },
    stop(): { summary: ResourceSummary; samples: ResourceSample[] } {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      const durationMs = startMs > 0 ? Date.now() - startMs : 0;
      return { summary: summarizeSamples(samples, durationMs), samples: [...samples] };
    },
  };
}
