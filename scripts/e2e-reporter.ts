/**
 * Custom Playwright Reporter — AI-Friendly E2E Debug Report
 *
 * Thin adapter: maps Playwright's live Suite/TestCase objects into the
 * existing PlaywrightReport shape from e2e-debug.ts, then feeds it through
 * the existing generateDebugReport() → writeReport() pipeline.
 */

import path from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';
import {
  generateDebugReport,
  writeReport,
  type PlaywrightReport,
  type PlaywrightSuite,
  type PlaywrightSpec,
  type PlaywrightStep,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './e2e-debug.js';
import { wranglerLogPath } from './wrangler-dev.js';
import {
  createResourceSampler,
  formatResourceStdout,
  type ResourceSampler,
} from './resource-sampler.js';
import { scanResourceErrors, type ScanEntry } from './resource-scan.js';
import type {
  Reporter,
  FullResult,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

function mapStep(step: TestStep): PlaywrightStep {
  return {
    title: step.title,
    duration: step.duration,
    category: step.category,
    steps: step.steps.map((s) => mapStep(s)),
    ...(step.error?.message !== undefined && { error: step.error.message }),
  };
}

function mapTestResult(result: TestResult): PlaywrightTestResult {
  return {
    status: result.status,
    retry: result.retry,
    duration: result.duration,
    startTime: result.startTime.toISOString(),
    errors: result.errors.map((e) => ({
      ...(e.message !== undefined && { message: e.message }),
      ...(e.stack !== undefined && { stack: e.stack }),
    })),
    steps: result.steps.map((s) => mapStep(s)),
    attachments: result.attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      ...(a.path !== undefined && { path: a.path }),
      ...(a.body !== undefined && { body: a.body.toString('utf8') }),
    })),
  };
}

function mapTestCase(test: TestCase, projectName: string): PlaywrightSpec {
  const relativeFile = path.relative(process.cwd(), test.location.file);
  const mappedTest: PlaywrightTest = {
    projectName,
    status: test.outcome(),
    results: test.results.map((r) => mapTestResult(r)),
  };
  return {
    title: test.title,
    file: relativeFile,
    line: test.location.line,
    tests: [mappedTest],
  };
}

function mapSuite(suite: Suite): PlaywrightSuite {
  const projectName = suite.project()?.name ?? suite.title;

  return {
    title: suite.title,
    file: suite.location?.file ? path.relative(process.cwd(), suite.location.file) : '',
    specs: suite.tests.map((test) => mapTestCase(test, projectName)),
    suites: suite.suites.map((s) => mapSuite(s)),
  };
}

export function buildPlaywrightReport(
  rootSuite: Suite | undefined,
  result: FullResult,
  globalErrors: string[] = []
): PlaywrightReport {
  return {
    suites: rootSuite ? rootSuite.suites.map((s) => mapSuite(s)) : [],
    config: {},
    stats: { duration: result.duration },
    status: result.status,
    ...(globalErrors.length > 0 && { errors: globalErrors }),
  };
}

export interface E2EReportWriterOptions {
  /**
   * Absolute path to the api worker's teed log (see wrangler-dev.ts). Overridable
   * for tests; defaults to the log for the current run's HB_API_PORT.
   */
  apiLogPath?: string | null;
}

/**
 * The api worker's stdout/stderr is teed to a per-port log by wrangler-dev.ts.
 * Derive that path from the run's HB_API_PORT so flush() can snapshot it into
 * the report dir; null when the port is unset (nothing to capture).
 */
export function apiServerLogSource(): string | null {
  const port = process.env['HB_API_PORT'];
  if (port === undefined || port === '') return null;
  return wranglerLogPath(port);
}

/**
 * Snapshot the api worker log into the report dir as `server-api.log` so
 * server-side stacks (e.g. `NoSuchBucket`/`UNAVAILABLE`) are captured as a
 * report artifact rather than being lost with the ephemeral worker process —
 * the report dir is the single source of truth for E2E debugging. A missing
 * source (no port, or the worker never wrote a log) is a no-op, never a
 * failure: the report itself must still land.
 */
export function captureServerApiLog(reportDir: string, source: string | null): string | null {
  if (source === null || !existsSync(source)) return null;
  const destination = path.join(reportDir, 'server-api.log');
  copyFileSync(source, destination);
  return destination;
}

export default class E2EReportWriter implements Reporter {
  private rootSuite: Suite | undefined;
  private written = false;
  private startMs = 0;
  private readonly apiLogPath: string | null;

  constructor(options: E2EReportWriterOptions = {}) {
    this.apiLogPath = options.apiLogPath === undefined ? apiServerLogSource() : options.apiLogPath;
  }
  // Run-level errors collected via onError. Kept so flush() can mark an aborted
  // run as FAILED even when no individual test failed (or no test ran at all).
  private readonly globalErrors: string[] = [];
  private readonly sampler: ResourceSampler = createResourceSampler();

  // Bound once so the same reference can be added and removed as a SIGINT listener.
  private readonly onInterrupt = (): void => {
    // A signal listener must never throw; an interrupted run can leave partial
    // trace artifacts that the writer rejects. Write a best-effort snapshot and
    // log on failure so Playwright's own SIGINT handlers still exit the process.
    try {
      this.flush({
        status: 'interrupted',
        startTime: new Date(this.startMs),
        duration: Date.now() - this.startMs,
      });
    } catch (error) {
      console.error(`E2E report: failed to write interrupted snapshot: ${String(error)}`);
    }
  };

  onBegin(_config: unknown, suite: Suite): void {
    this.rootSuite = suite;
    this.startMs = Date.now();
    this.sampler.start();
    // Playwright (and playwright-core, via browser launch) install their own
    // SIGINT handlers that exit the process before onEnd runs, so the report
    // would never be written on Ctrl+C. Flush synchronously from our own
    // listener instead. `once` so a second Ctrl+C falls through and still kills.
    process.once('SIGINT', this.onInterrupt);
  }

  onError(error: TestError): void {
    // Global errors (global setup throwing, a webServer crash, output-dir
    // cleanup failing before any test runs) arrive here, never as a test
    // result. Capture them so the report reflects the abort instead of a
    // misleading "0 failed → PASSED".
    this.globalErrors.push(error.stack ?? error.message ?? 'Unknown global error');
  }

  onEnd(result: FullResult): void {
    process.removeListener('SIGINT', this.onInterrupt);
    this.flush(result);
  }

  private flush(result: FullResult): void {
    if (this.written) return;
    // A run that aborted before onBegin has no rootSuite; still emit a report
    // when there are global errors so the failure is visible rather than silent.
    if (!this.rootSuite && this.globalErrors.length === 0) return;
    this.written = true;

    const report = buildPlaywrightReport(this.rootSuite, result, this.globalErrors);
    const debugReport = generateDebugReport(report);

    // Attach resource time-series + a log scan for resource-exhaustion symptoms
    // (pthread/EAGAIN, EMFILE, OOM, browser crashes) the report already collects.
    const sampled = this.sampler.stop();
    const scanEntries: ScanEntry[] = [...debugReport.failed, ...debugReport.flaky].flatMap((t) => {
      const test = `${t.file} › ${t.title}`;
      return [
        { test, text: t.error },
        { test, text: t.artifacts.consoleErrors ?? '' },
        { test, text: t.artifacts.apiErrors ?? '' },
      ];
    });
    const resources = {
      summary: sampled.summary,
      samples: sampled.samples,
      scan: scanResourceErrors(scanEntries),
    };
    debugReport.resources = resources;

    const reportDir = path.join(process.cwd(), 'e2e', 'report');

    const timestampedDir = writeReport(debugReport, reportDir);
    captureServerApiLog(timestampedDir, this.apiLogPath);
    const relativePath = path.relative(process.cwd(), timestampedDir);

    const { summary } = debugReport;
    const globalErrorNote =
      this.globalErrors.length > 0 ? `, ${String(this.globalErrors.length)} global error(s)` : '';
    console.log(
      `\nE2E report (source of truth for debugging): ${relativePath}/REPORT.md (${String(summary.failed)} failed, ${String(summary.flaky)} flaky, ${String(summary.passed)} passed${globalErrorNote})`
    );
    console.log(`  Structured data: ${relativePath}/report.json`);
    if (summary.failed > 0) {
      console.log(`  Failed test details: ${relativePath}/failed/`);
    }
    if (this.globalErrors.length > 0) {
      console.log(`  Global errors (run aborted): ${relativePath}/REPORT.md`);
    }
    console.log(formatResourceStdout(resources));
    console.log();
  }

  printsToStdio(): boolean {
    return true;
  }
}
