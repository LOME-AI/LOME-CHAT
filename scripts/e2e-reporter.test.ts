import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullResult, Suite } from '@playwright/test/reporter';
import E2EReportWriter, {
  buildPlaywrightReport,
  captureServerApiLog,
  apiServerLogSource,
} from './e2e-reporter.js';
import { wranglerLogPath } from './wrangler-dev.js';

// Minimal stubs matching Playwright's Reporter API shapes
interface StubStep {
  title: string;
  duration: number;
  category?: string;
  steps: StubStep[];
  error?: { message?: string };
}

interface StubTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  duration: number;
  startTime: Date;
  errors: { message?: string; stack?: string }[];
  steps: StubStep[];
  attachments: { name: string; path?: string; body?: Buffer; contentType: string }[];
}

interface StubTestCase {
  title: string;
  location: { file: string; line: number; column: number };
  results: StubTestResult[];
  outcome(): 'expected' | 'unexpected' | 'flaky' | 'skipped';
}

interface StubSuite {
  title: string;
  type: 'root' | 'project' | 'file' | 'describe';
  suites: StubSuite[];
  tests: StubTestCase[];
  location?: { file: string; line: number; column: number };
  project(): { name: string } | undefined;
}

function createStubResult(overrides: Partial<StubTestResult> = {}): StubTestResult {
  return {
    status: 'passed',
    retry: 0,
    duration: 1000,
    startTime: new Date('2026-01-01T00:00:00Z'),
    errors: [],
    steps: [],
    attachments: [],
    ...overrides,
  };
}

function createStubTest(
  overrides: {
    title?: string;
    file?: string;
    results?: StubTestResult[];
    outcome?: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  } = {}
): StubTestCase {
  const outcomeVal = overrides.outcome ?? 'expected';
  return {
    title: overrides.title ?? 'test title',
    location: { file: overrides.file ?? '/abs/e2e/chat/chat.spec.ts', line: 1, column: 1 },
    results: overrides.results ?? [createStubResult()],
    outcome: () => outcomeVal,
  };
}

function createStubSuite(
  overrides: {
    title?: string;
    type?: StubSuite['type'];
    suites?: StubSuite[];
    tests?: StubTestCase[];
    projectName?: string;
  } = {}
): StubSuite {
  const name = overrides.projectName;
  return {
    title: overrides.title ?? 'Suite',
    type: overrides.type ?? 'file',
    suites: overrides.suites ?? [],
    tests: overrides.tests ?? [],
    project: () => (name ? { name } : undefined),
  };
}

describe('e2e-reporter', () => {
  describe('buildPlaywrightReport', () => {
    it('maps a root suite with one passing test', () => {
      const test = createStubTest({
        title: 'displays chat',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      const fileSuite = createStubSuite({
        title: 'chat.spec.ts',
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        title: 'chromium',
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 5000 }
      );

      expect(result.stats.duration).toBe(5000);
      expect(result.suites).toHaveLength(1);
      // Navigate: projectSuite → fileSuite → specs
      const fileSuiteResult = result.suites[0]!.suites![0]!;
      expect(fileSuiteResult.specs).toHaveLength(1);
      expect(fileSuiteResult.specs![0]!.title).toBe('displays chat');
      expect(fileSuiteResult.specs![0]!.file).toBe('e2e/chat/chat.spec.ts');
      expect(fileSuiteResult.specs![0]!.tests![0]!.projectName).toBe('chromium');
      expect(fileSuiteResult.specs![0]!.tests![0]!.results[0]!.status).toBe('passed');
    });

    it('falls back to the suite title when the suite has no project', () => {
      const test = createStubTest({
        title: 'orphan test',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      const fileSuite = createStubSuite({
        title: 'standalone-suite',
        type: 'file',
        tests: [test],
      });
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [fileSuite] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.specs![0]!.tests![0]!.projectName).toBe('standalone-suite');
    });

    it('maps failed test with attachments', () => {
      const test = createStubTest({
        title: 'broken test',
        file: `${process.cwd()}/e2e/billing/billing.spec.ts`,
        results: [
          createStubResult({
            status: 'failed',
            retry: 1,
            errors: [{ message: 'Timeout', stack: 'at line 42' }],
            attachments: [
              // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture paths, not production code
              { name: 'screenshot', path: '/tmp/screenshot.png', contentType: 'image/png' },
              // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture paths, not production code
              { name: 'trace', path: '/tmp/trace.zip', contentType: 'application/zip' },
            ],
          }),
        ],
        outcome: 'unexpected',
      });
      const fileSuite = createStubSuite({
        title: 'billing.spec.ts',
        type: 'file',
        tests: [test],
        projectName: 'webkit',
      });
      const projectSuite = createStubSuite({
        title: 'webkit',
        type: 'project',
        suites: [fileSuite],
        projectName: 'webkit',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'failed', startTime: new Date(), duration: 10_000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      const spec = result.suites[0]!.suites![0]!.specs![0]!;
      const testResult = spec.tests![0]!.results[0]!;
      expect(testResult.status).toBe('failed');
      expect(testResult.retry).toBe(1);
      expect(testResult.errors![0]!.message).toBe('Timeout');
      expect(testResult.attachments![0]!.name).toBe('screenshot');
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      expect(testResult.attachments![0]!.path).toBe('/tmp/screenshot.png');
    });

    it('makes file paths relative to cwd', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      expect(result.suites[0]!.suites![0]!.specs![0]!.file).toBe('e2e/chat/chat.spec.ts');
    });

    it('derives suite file from suite.location when present', () => {
      const test = createStubTest({ file: `${process.cwd()}/e2e/chat/chat.spec.ts` });
      const fileSuite: StubSuite = {
        ...createStubSuite({ type: 'file', tests: [test], projectName: 'chromium' }),
        location: { file: `${process.cwd()}/e2e/chat/chat.spec.ts`, line: 1, column: 1 },
      };
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.file).toBe('e2e/chat/chat.spec.ts');
    });

    it('handles nested describe suites', () => {
      const test = createStubTest({
        title: 'nested test',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      const describeSuite = createStubSuite({
        title: 'describe block',
        type: 'describe',
        tests: [test],
        projectName: 'chromium',
      });
      const fileSuite = createStubSuite({
        title: 'chat.spec.ts',
        type: 'file',
        suites: [describeSuite],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        title: 'chromium',
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites!).toBeDefined();
    });

    it('maps test outcome to PlaywrightTest status', () => {
      const test = createStubTest({
        title: 'flaky test',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [createStubResult({ status: 'passed', retry: 1 })],
        outcome: 'flaky',
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'firefox',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'firefox',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.status).toBe('flaky');
    });

    it('includes test location line number', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      test.location.line = 42;
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.specs![0]!.line).toBe(42);
    });

    it('maps steps recursively with category and error', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [
          createStubResult({
            steps: [
              {
                title: 'Send message',
                duration: 500,
                category: 'test.step',
                steps: [{ title: 'page.fill', duration: 100, category: 'pw:api', steps: [] }],
              },
              {
                title: 'expect(locator).toBeVisible',
                duration: 10_000,
                category: 'expect',
                steps: [],
                error: { message: 'Timeout' },
              },
            ],
          }),
        ],
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'failed', startTime: new Date(), duration: 10_000 }
      );

      const steps = result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.steps!;
      expect(steps).toHaveLength(2);
      expect(steps[0]!.category).toBe('test.step');
      expect(steps[0]!.steps).toHaveLength(1);
      expect(steps[0]!.steps![0]!.title).toBe('page.fill');
      expect(steps[1]!.error).toBe('Timeout');
    });

    it('maps body attachments to string', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [
          createStubResult({
            attachments: [
              {
                name: 'console-errors',
                body: Buffer.from('TypeError: x is not a function'),
                contentType: 'text/plain',
              },
            ],
          }),
        ],
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      const attachments =
        result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.attachments!;
      expect(attachments[0]!.body).toBe('TypeError: x is not a function');
      expect(attachments[0]!.contentType).toBe('text/plain');
    });

    it('includes startTime on test results', () => {
      const startTime = new Date('2026-03-21T12:00:00Z');
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [createStubResult({ startTime })],
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.startTime).toBe(
        '2026-03-21T12:00:00.000Z'
      );
    });

    it('forwards run status and global errors', () => {
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'failed', startTime: new Date(), duration: 66_000 },
        ["Error: ENOTEMPTY: directory not empty, rmdir 'test-results/x'"]
      );

      expect(result.status).toBe('failed');
      expect(result.errors).toEqual([
        "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/x'",
      ]);
    });

    it('omits errors when none are given and tolerates a missing root suite', () => {
      const result = buildPlaywrightReport(undefined, {
        status: 'passed',
        startTime: new Date(),
        duration: 1000,
      });

      expect(result.status).toBe('passed');
      expect(result.errors).toBeUndefined();
      expect(result.suites).toEqual([]);
    });
  });
});

type SigintListener = (signal: string) => void;

describe('E2EReportWriter (interrupt handling)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let baseSigintListeners: SigintListener[];

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    baseSigintListeners = process.listeners('SIGINT') as SigintListener[];
  });

  afterEach(() => {
    // Manual handler invocation in tests doesn't trigger `once` auto-removal,
    // so drop any SIGINT listener the reporter added to keep tests isolated.
    for (const listener of process.listeners('SIGINT') as SigintListener[]) {
      if (!baseSigintListeners.includes(listener)) {
        process.removeListener('SIGINT', listener);
      }
    }
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (temporaryDir && existsSync(temporaryDir)) {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  function rootSuiteStub(): Suite {
    const test = createStubTest({
      title: 'snapshot test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
    });
    const fileSuite = createStubSuite({
      title: 'chat.spec.ts',
      type: 'file',
      tests: [test],
      projectName: 'chromium',
    });
    const projectSuite = createStubSuite({
      title: 'chromium',
      type: 'project',
      suites: [fileSuite],
      projectName: 'chromium',
    });
    const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });
    return rootSuite as unknown as Suite;
  }

  const fullResult = (status: FullResult['status']): FullResult =>
    ({ status, startTime: new Date(), duration: 1234 }) as FullResult;

  const reportBase = (): string => path.join(temporaryDir, 'e2e', 'report');

  const flushLogCount = (): number =>
    logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('E2E report')
    ).length;

  it('registers a SIGINT listener on begin', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();

    reporter.onBegin({}, rootSuiteStub());

    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  it('writes a report when interrupted via SIGINT', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;
    handler('SIGINT');

    const base = reportBase();
    expect(existsSync(base)).toBe(true);
    const directories = readdirSync(base);
    expect(directories).toHaveLength(1);
    expect(existsSync(path.join(base, directories[0]!, 'REPORT.md'))).toBe(true);
    expect(flushLogCount()).toBe(1);
  });

  it('writes the report only once across an interrupt and onEnd', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;
    handler('SIGINT');
    reporter.onEnd(fullResult('interrupted'));

    expect(flushLogCount()).toBe(1);
    expect(readdirSync(reportBase())).toHaveLength(1);
  });

  it('removes its SIGINT listener after the first signal so repeat Ctrl+C still kills', () => {
    const preexisting = process.listeners('SIGINT') as SigintListener[];
    for (const listener of preexisting) process.removeListener('SIGINT', listener);
    try {
      const reporter = new E2EReportWriter();
      reporter.onBegin({}, rootSuiteStub());
      expect(process.listenerCount('SIGINT')).toBe(1);

      process.emit('SIGINT', 'SIGINT');

      expect(process.listenerCount('SIGINT')).toBe(0);
    } finally {
      for (const listener of preexisting) process.on('SIGINT', listener);
    }
  });

  it('does not throw if writing the interrupted snapshot fails', () => {
    const reporter = new E2EReportWriter();
    // A malformed suite makes buildPlaywrightReport throw inside flush; the
    // SIGINT handler must swallow it (and log) rather than throw mid-signal.
    reporter.onBegin({}, {} as unknown as Suite);

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;

    expect(() => {
      handler('SIGINT');
    }).not.toThrow();
    expect(
      errSpy.mock.calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('failed to write')
      )
    ).toBe(true);
  });

  it('reports the failed/ artifact path when there are failures', () => {
    const failing = createStubTest({
      title: 'broken test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
      results: [createStubResult({ status: 'failed', errors: [{ message: 'boom' }] })],
      outcome: 'unexpected',
    });
    const fileSuite = createStubSuite({
      title: 'chat.spec.ts',
      type: 'file',
      tests: [failing],
      projectName: 'chromium',
    });
    const projectSuite = createStubSuite({
      title: 'chromium',
      type: 'project',
      suites: [fileSuite],
      projectName: 'chromium',
    });
    const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });

    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuite as unknown as Suite);
    reporter.onEnd(fullResult('failed'));

    expect(
      logSpy.mock.calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Failed test details')
      )
    ).toBe(true);
  });

  const testError = (fields: {
    message?: string;
    stack?: string;
  }): Parameters<E2EReportWriter['onError']>[0] =>
    fields as Parameters<E2EReportWriter['onError']>[0];

  const readWrittenReport = (): { md: string; json: Record<string, unknown> } => {
    const base = reportBase();
    const dir = path.join(base, readdirSync(base)[0]!);
    return {
      md: readFileSync(path.join(dir, 'REPORT.md'), 'utf8'),
      json: JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Record<
        string,
        unknown
      >,
    };
  };

  it('reports FAILED with a Global Errors section, preferring the error stack', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());
    reporter.onError(
      testError({
        stack: "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/x'\n    at clearOutput",
      })
    );
    reporter.onEnd(fullResult('failed'));

    const { md, json } = readWrittenReport();
    expect(md).toContain('**Result:** FAILED');
    expect(md).toContain('## Global Errors');
    expect(md).toContain('at clearOutput');
    expect(json['status']).toBe('failed');
    expect(json['globalErrors']).toHaveLength(1);
  });

  it('falls back to the error message when there is no stack', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());
    reporter.onError(testError({ message: 'Error: ENOTEMPTY: directory not empty' }));
    reporter.onEnd(fullResult('failed'));

    expect(readWrittenReport().md).toContain('ENOTEMPTY');
  });

  it('falls back to a placeholder when the error has neither stack nor message', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());
    reporter.onError(testError({}));
    reporter.onEnd(fullResult('failed'));

    expect(readWrittenReport().md).toContain('Unknown global error');
  });

  it('still writes a FAILED report when a global error aborts before onBegin', () => {
    const reporter = new E2EReportWriter();
    // No onBegin: Playwright's output-dir cleanup can abort the run before the
    // report-begin task fires. The global error must still surface.
    reporter.onError(testError({ message: 'Error: ENOTEMPTY: directory not empty' }));
    reporter.onEnd(fullResult('failed'));

    expect(existsSync(reportBase())).toBe(true);
    const { md } = readWrittenReport();
    expect(md).toContain('**Result:** FAILED');
    expect(md).toContain('ENOTEMPTY');
  });

  it('prints to stdio', () => {
    expect(new E2EReportWriter().printsToStdio()).toBe(true);
  });

  it('writes nothing when onEnd runs without a begun suite', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();

    reporter.onEnd(fullResult('passed'));

    expect(existsSync(reportBase())).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('writes the report and unregisters its listener on clean onEnd', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());

    reporter.onEnd(fullResult('passed'));

    const base = reportBase();
    const directories = readdirSync(base);
    expect(directories).toHaveLength(1);
    expect(existsSync(path.join(base, directories[0]!, 'report.json'))).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('captureServerApiLog / apiServerLogSource', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-apilog-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('copies the api log into the report dir as server-api.log', () => {
    const source = path.join(temporaryDir, 'wrangler.log');
    writeFileSync(source, 'NoSuchBucket stack trace\n');
    const reportDir = path.join(temporaryDir, 'report');
    mkdirSync(reportDir);

    const destination = captureServerApiLog(reportDir, source);

    expect(destination).toBe(path.join(reportDir, 'server-api.log'));
    expect(readFileSync(path.join(reportDir, 'server-api.log'), 'utf8')).toBe(
      'NoSuchBucket stack trace\n'
    );
  });

  it('returns null and writes nothing when the source log does not exist', () => {
    const reportDir = path.join(temporaryDir, 'report');
    mkdirSync(reportDir);

    expect(captureServerApiLog(reportDir, path.join(temporaryDir, 'absent.log'))).toBeNull();
    expect(captureServerApiLog(reportDir, null)).toBeNull();
    expect(existsSync(path.join(reportDir, 'server-api.log'))).toBe(false);
  });

  it('derives the source from HB_API_PORT, null when unset', () => {
    const saved = process.env['HB_API_PORT'];
    try {
      process.env['HB_API_PORT'] = '59993';
      expect(apiServerLogSource()).toBe(wranglerLogPath('59993'));
      delete process.env['HB_API_PORT'];
      expect(apiServerLogSource()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env['HB_API_PORT'];
      else process.env['HB_API_PORT'] = saved;
    }
  });
});

describe('E2EReportWriter (server-api.log capture)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-flushlog-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  function reporterRootSuite(): Suite {
    const test = createStubTest({
      title: 'capture test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
    });
    const fileSuite = createStubSuite({
      title: 'chat.spec.ts',
      type: 'file',
      tests: [test],
      projectName: 'chromium',
    });
    const projectSuite = createStubSuite({
      title: 'chromium',
      type: 'project',
      suites: [fileSuite],
      projectName: 'chromium',
    });
    return createStubSuite({
      title: '',
      type: 'root',
      suites: [projectSuite],
    }) as unknown as Suite;
  }

  const passedResult = (): FullResult =>
    ({ status: 'passed', startTime: new Date(), duration: 10 }) as FullResult;

  it('lands server-api.log in the timestamped report dir on flush', () => {
    const apiLog = path.join(temporaryDir, 'wrangler.log');
    writeFileSync(apiLog, 'PUT returned 404: NoSuchBucket\n');
    const reporter = new E2EReportWriter({ apiLogPath: apiLog });
    reporter.onBegin({}, reporterRootSuite());

    reporter.onEnd(passedResult());

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = readdirSync(base)[0]!;
    expect(readFileSync(path.join(base, runDir, 'server-api.log'), 'utf8')).toBe(
      'PUT returned 404: NoSuchBucket\n'
    );
  });

  it('still writes the report when the api log is absent', () => {
    const reporter = new E2EReportWriter({
      apiLogPath: path.join(temporaryDir, 'absent.log'),
    });
    reporter.onBegin({}, reporterRootSuite());

    reporter.onEnd(passedResult());

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = readdirSync(base)[0]!;
    expect(existsSync(path.join(base, runDir, 'report.json'))).toBe(true);
    expect(existsSync(path.join(base, runDir, 'server-api.log'))).toBe(false);
  });
});
