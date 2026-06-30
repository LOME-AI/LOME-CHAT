import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {
  categorizeTests,
  extractArtifactPaths,
  generateDebugReport,
  stripAnsi,
  slugify,
  formatDuration,
  buildRerunCommand,
  generateMarkdownReport,
  generateJsonReport,
  renderGlobalErrors,
  mergeHarFiles,
  extractTraceArchive,
  writePerTestArtifacts,
  renderResourceSection,
  renderSteps,
  serializeTestForJson,
  writeReport,
  enforceRetentionLimit,
  type DebugReport,
  type FailedTest,
  type FlakyTest,
  type FlattenedTestResult,
  type JsonReport,
  type PlaywrightReport,
  type PlaywrightSpec,
  type PlaywrightStep,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './e2e-debug.js';

function makeTraceZip(workDir: string, zipName: string, files: Record<string, string>): string {
  const zipPath = path.join(workDir, zipName);
  const zip = new AdmZip();
  for (const [relativePath, contents] of Object.entries(files)) {
    zip.addFile(relativePath, Buffer.from(contents));
  }
  zip.writeZip(zipPath);
  return zipPath;
}

/**
 * Drop keys from a fixture to mirror report JSON whose optional fields are
 * absent. The reader casts that JSON without validating, so values missing
 * fields the types declare required are real runtime inputs.
 */
function withoutKeys<T extends object>(value: T, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
}

describe('e2e-debug', () => {
  describe('stripAnsi', () => {
    it('removes color codes from text', () => {
      const input = '\u001B[31mError\u001B[0m: something failed';
      expect(stripAnsi(input)).toBe('Error: something failed');
    });

    it('removes bold and underline codes', () => {
      const input = '\u001B[1mbold\u001B[22m \u001B[4munderline\u001B[24m';
      expect(stripAnsi(input)).toBe('bold underline');
    });

    it('passes through plain text unchanged', () => {
      const input = 'no ansi codes here';
      expect(stripAnsi(input)).toBe('no ansi codes here');
    });

    it('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('removes multiple ANSI sequences', () => {
      const input = '\u001B[32m✓\u001B[0m \u001B[90mtest passed\u001B[0m';
      expect(stripAnsi(input)).toBe('✓ test passed');
    });
  });

  describe('slugify', () => {
    it('converts spaces to hyphens', () => {
      expect(slugify('hello world')).toBe('hello-world');
    });

    it('converts to lowercase', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('removes non-alphanumeric characters', () => {
      expect(slugify('test (chromium) #1')).toBe('test-chromium-1');
    });

    it('collapses consecutive hyphens', () => {
      expect(slugify('a---b')).toBe('a-b');
    });

    it('trims leading and trailing hyphens', () => {
      expect(slugify('--hello--')).toBe('hello');
    });

    it('handles file paths with slashes and dots', () => {
      expect(slugify('e2e/chat/chat.spec.ts')).toBe('e2e-chat-chat-spec-ts');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds only', () => {
      expect(formatDuration(5000)).toBe('5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(154_000)).toBe('2m 34s');
    });

    it('formats hours, minutes, and seconds', () => {
      expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
    });

    it('formats zero duration', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('formats exact minutes without seconds', () => {
      expect(formatDuration(120_000)).toBe('2m 0s');
    });

    it('formats sub-minute durations with tenths of a second', () => {
      expect(formatDuration(5500)).toBe('5.5s');
    });
  });

  describe('buildRerunCommand', () => {
    it('generates rerun command with file, grep, and project', () => {
      const result = buildRerunCommand({
        title: 'displays UI',
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
      });
      expect(result).toBe('pnpm e2e -- e2e/chat/chat.spec.ts -g "displays UI" --project=chromium');
    });

    it('escapes double quotes in title', () => {
      const result = buildRerunCommand({
        title: 'handles "edge" case',
        file: 'e2e/chat/chat.spec.ts',
        project: 'webkit',
      });
      expect(result).toBe(
        String.raw`pnpm e2e -- e2e/chat/chat.spec.ts -g "handles \"edge\" case" --project=webkit`
      );
    });
  });

  describe('categorizeTests', () => {
    const createTestResult = (
      overrides: Partial<FlattenedTestResult> = {}
    ): FlattenedTestResult => ({
      title: 'test title',
      file: 'path/to/test.spec.ts',
      projectName: 'chromium',
      status: 'passed',
      retry: 0,
      duration: 1000,
      errors: [],
      steps: [],
      attachments: [],
      ...overrides,
    });

    it('categorizes passed tests', () => {
      const tests = [createTestResult({ status: 'passed', retry: 0 })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(1);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('defaults attempts, error, and steps for flaky tests missing optional fields', () => {
      // Report JSON is cast, not validated, at the read boundary — these
      // fields really can be absent at runtime despite the required types.
      const tests = [
        withoutKeys(createTestResult({ testStatus: 'flaky', status: 'failed', retry: 1 }), [
          'attempts',
          'errors',
          'steps',
          'attachments',
        ]),
      ];

      const result = categorizeTests(tests);

      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]?.attempts).toBe(2);
      expect(result.flaky[0]?.error).toBe('');
      expect(result.flaky[0]?.steps).toEqual([]);
    });

    it('defaults error and steps for failed tests missing optional fields', () => {
      const tests = [
        withoutKeys(createTestResult({ status: 'failed' }), ['errors', 'steps', 'attachments']),
      ];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toBe('');
      expect(result.failed[0]?.steps).toEqual([]);
    });

    it('categorizes flaky tests (testStatus flaky, data from failing attempt)', () => {
      // Collector surfaces the failing attempt's data but tags testStatus='flaky'
      // and records the total attempt count on the flattened result.
      const tests = [
        createTestResult({
          testStatus: 'flaky',
          status: 'failed',
          retry: 0,
          attempts: 2,
          errors: [{ message: 'race' }],
          duration: 1500,
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]?.attempts).toBe(2);
      expect(result.flaky[0]?.error).toBe('race');
      expect(result.flaky[0]?.duration).toBe(1500);
      expect(result.failed).toHaveLength(0);
    });

    it('flaky tests carry full artifacts (trace, screenshot, console errors, har)', () => {
      const tests = [
        createTestResult({
          testStatus: 'flaky',
          status: 'failed',
          retry: 1,
          attempts: 3,
          line: 42,
          errors: [{ message: 'Timeout' }],
          steps: [{ title: 'click send', duration: 100 }],
          attachments: [
            { name: 'trace', path: 'trace.zip' },
            { name: 'screenshot', path: 'shot.png' },
            { name: 'video', path: 'video.webm' },
            {
              name: 'console-errors-authenticatedPage',
              body: 'TypeError: x',
              contentType: 'text/plain',
            },
            { name: 'har-authenticatedPage', path: 'network.har' },
          ],
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.flaky).toHaveLength(1);
      const flake = result.flaky[0];
      expect(flake?.line).toBe(42);
      expect(flake?.steps).toEqual([{ title: 'click send', duration: 100 }]);
      expect(flake?.artifacts.trace).toBe('trace.zip');
      expect(flake?.artifacts.screenshot).toBe('shot.png');
      expect(flake?.artifacts.video).toBe('video.webm');
      expect(flake?.artifacts.consoleErrors).toBe('TypeError: x');
      expect(flake?.artifacts.harFiles).toEqual(['network.har']);
    });

    it('categorizes failed tests', () => {
      const tests = [createTestResult({ status: 'failed', retry: 2 })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });

    it('categorizes timed out tests as failed', () => {
      const tests = [createTestResult({ status: 'timedOut' })];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
    });

    it('categorizes interrupted tests as failed', () => {
      const tests = [createTestResult({ status: 'interrupted' })];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
    });

    it('serial-mode interrupted tests are not falsely marked flaky', () => {
      // When a serial block fails, Playwright interrupts preceding tests that
      // already passed. On retry they pass again, making testStatus 'flaky'.
      // The interrupted result has no error — it should be skipped in favor of
      // the passing result, categorizing the test as passed, not flaky.
      const tests = [
        createTestResult({
          testStatus: 'flaky',
          status: 'passed',
          retry: 1,
          attempts: 2,
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.flaky).toHaveLength(0);
      expect(result.passed).toHaveLength(1);
    });

    it('skips skipped tests', () => {
      const tests = [createTestResult({ status: 'skipped' })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('handles multiple tests of different statuses', () => {
      const tests = [
        createTestResult({ title: 'passed test', status: 'passed', retry: 0 }),
        createTestResult({
          title: 'flaky test',
          testStatus: 'flaky',
          status: 'failed',
          retry: 1,
          attempts: 3,
          errors: [{ message: 'boom' }],
        }),
        createTestResult({ title: 'failed test', status: 'failed' }),
        createTestResult({ title: 'skipped test', status: 'skipped' }),
      ];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(1);
      expect(result.flaky).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
    });

    it('propagates duration to passed tests', () => {
      const tests = [createTestResult({ status: 'passed', retry: 0, duration: 5000 })];

      const result = categorizeTests(tests);

      expect(result.passed[0]?.duration).toBe(5000);
    });

    it('propagates duration, steps, and line to failed tests', () => {
      const steps: PlaywrightStep[] = [{ title: 'click button', duration: 100 }];
      const tests = [
        createTestResult({
          status: 'failed',
          duration: 3000,
          steps,
          line: 42,
          errors: [{ message: 'timeout' }],
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.failed[0]?.duration).toBe(3000);
      expect(result.failed[0]?.steps).toEqual(steps);
      expect(result.failed[0]?.line).toBe(42);
    });

    it('propagates labeled console-errors and har artifacts to failed tests', () => {
      const tests = [
        createTestResult({
          status: 'failed',
          attachments: [
            {
              name: 'console-errors-authenticatedPage',
              body: 'TypeError: x',
              contentType: 'text/plain',
            },
            { name: 'har-authenticatedPage', path: 'network.har' },
          ],
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.failed[0]?.artifacts.consoleErrors).toBe('TypeError: x');
      expect(result.failed[0]?.artifacts.harFiles).toEqual(['network.har']);
    });
  });

  describe('extractArtifactPaths', () => {
    it('extracts trace path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [{ name: 'trace', path: 'test-results/test-chromium/trace.zip' }],
      };

      const result = extractArtifactPaths(test);

      expect(result.trace).toBe('test-results/test-chromium/trace.zip');
    });

    it('extracts screenshot path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [{ name: 'screenshot', path: 'test-results/test-chromium/test-failed-1.png' }],
      };

      const result = extractArtifactPaths(test);

      expect(result.screenshot).toBe('test-results/test-chromium/test-failed-1.png');
    });

    it('extracts video path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [{ name: 'video', path: 'test-results/test-chromium/video.webm' }],
      };

      const result = extractArtifactPaths(test);

      expect(result.video).toBe('test-results/test-chromium/video.webm');
    });

    it('extracts all artifact types', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          { name: 'trace', path: 'trace.zip' },
          { name: 'screenshot', path: 'screenshot.png' },
          { name: 'video', path: 'video.webm' },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.trace).toBe('trace.zip');
      expect(result.screenshot).toBe('screenshot.png');
      expect(result.video).toBe('video.webm');
    });

    it('returns undefined for missing artifacts', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [],
      };

      const result = extractArtifactPaths(test);

      expect(result.trace).toBeUndefined();
      expect(result.screenshot).toBeUndefined();
      expect(result.video).toBeUndefined();
      expect(result.consoleErrors).toBeUndefined();
      expect(result.apiErrors).toBeUndefined();
      expect(result.pageSnapshot).toBeUndefined();
      expect(result.harFiles).toEqual([]);
    });

    it('extracts labeled console-errors body from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'console-errors-authenticatedPage',
            body: 'TypeError: foo is not a function',
            contentType: 'text/plain',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.consoleErrors).toBe('TypeError: foo is not a function');
    });

    it('extracts labeled api-errors body from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'api-errors-authenticatedPage',
            body: '2026-05-12T00:00:00Z 500 Internal Server Error POST /api/chat/abc/stream\n  body: {"code":"BILLING_ERROR"}',
            contentType: 'text/plain',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.apiErrors).toBe(
        '2026-05-12T00:00:00Z 500 Internal Server Error POST /api/chat/abc/stream\n  body: {"code":"BILLING_ERROR"}'
      );
    });

    it('concatenates multiple labeled api-errors bodies with headers', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'api-errors-unauthenticatedPage-1',
            body: '500 GET /api/conversations/xyz',
            contentType: 'text/plain',
          },
          {
            name: 'api-errors-authenticatedPage',
            body: '404 POST /api/links/abc',
            contentType: 'text/plain',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.apiErrors).toContain('--- unauthenticatedPage-1 ---');
      expect(result.apiErrors).toContain('--- authenticatedPage ---');
      expect(result.apiErrors).toContain('500 GET /api/conversations/xyz');
      expect(result.apiErrors).toContain('404 POST /api/links/abc');
    });

    it('concatenates multiple labeled page-snapshot bodies with headers', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          { name: 'page-snapshot-testDavePage', body: '- document', contentType: 'text/yaml' },
          {
            name: 'page-snapshot-authenticatedPage',
            body: '- document:\n  - main: content',
            contentType: 'text/yaml',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.pageSnapshot).toContain('--- testDavePage ---');
      expect(result.pageSnapshot).toContain('--- authenticatedPage ---');
      expect(result.pageSnapshot).toContain('- document:\n  - main: content');
    });

    it('returns single page-snapshot without header when only one exists', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'page-snapshot-authenticatedPage',
            body: '- document:\n  - main: chat',
            contentType: 'text/yaml',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.pageSnapshot).toBe('- document:\n  - main: chat');
      expect(result.pageSnapshot).not.toContain('---');
    });

    it('extracts labeled har path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'har-authenticatedPage',
            path: 'test-results/test-chromium/authenticatedPage.har',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.harFiles).toEqual(['test-results/test-chromium/authenticatedPage.har']);
    });
  });

  describe('generateDebugReport', () => {
    const createReport = (suites: PlaywrightReport['suites'] = []): PlaywrightReport => ({
      suites,
      config: {},
      stats: { duration: 5000 },
    });

    const createSuite = (
      specs: PlaywrightReport['suites'][number]['specs'] = []
    ): PlaywrightReport['suites'][number] => ({
      title: 'Suite',
      file: 'test.spec.ts',
      specs,
      suites: [],
    });

    const createSpec = (
      title: string,
      file: string,
      tests: PlaywrightTest[] = []
    ): PlaywrightSpec => ({
      title,
      file,
      tests,
    });

    const createTest = (projectName: string, results: PlaywrightTestResult[]): PlaywrightTest => ({
      projectName,
      status: 'expected',
      results,
    });

    const createResult = (overrides: Partial<PlaywrightTestResult> = {}): PlaywrightTestResult => ({
      status: 'passed',
      retry: 0,
      duration: 1000,
      errors: [],
      steps: [],
      attachments: [],
      ...overrides,
    });

    it('generates summary with correct counts', () => {
      const report = createReport([
        createSuite([
          createSpec('passed test', 'test.spec.ts', [
            createTest('chromium', [createResult({ status: 'passed' })]),
          ]),
          createSpec('failed test', 'test.spec.ts', [
            createTest('chromium', [createResult({ status: 'failed' })]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.duration).toBe(5000);
    });

    it('defaults missing errors, steps, and attachments on a result to empty lists', () => {
      const report = createReport([
        createSuite([
          createSpec('sparse result', 'test.spec.ts', [
            createTest('chromium', [
              withoutKeys(createResult({ status: 'failed' }), ['errors', 'steps', 'attachments']),
            ]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toBe('');
      expect(result.failed[0]?.steps).toEqual([]);
    });

    it('treats a flaky test whose attempts all passed as passed', () => {
      const report = createReport([
        createSuite([
          createSpec('serial collateral', 'test.spec.ts', [
            {
              projectName: 'chromium',
              status: 'flaky',
              results: [createResult({ status: 'passed' })],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.passed).toHaveLength(1);
      expect(result.flaky).toHaveLength(0);
    });

    it('skips tests that recorded no results at all', () => {
      const report = createReport([
        createSuite([
          createSpec('never ran', 'test.spec.ts', [
            { projectName: 'chromium', status: 'expected', results: [] },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
    });

    it('includes passed test details', () => {
      const report = createReport([
        createSuite([
          createSpec('should work', 'e2e/chat.spec.ts', [
            createTest('chromium', [createResult({ status: 'passed' })]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.passed).toHaveLength(1);
      expect(result.passed[0]).toEqual({
        title: 'should work',
        file: 'e2e/chat.spec.ts',
        project: 'chromium',
        duration: 1000,
      });
    });

    it('flaky tests surface the last failing attempt artifacts', () => {
      const report = createReport([
        createSuite([
          createSpec('flaky test', 'e2e/chat.spec.ts', [
            {
              projectName: 'firefox',
              status: 'flaky',
              results: [
                createResult({
                  status: 'failed',
                  retry: 0,
                  duration: 2000,
                  errors: [{ message: 'race condition' }],
                  steps: [{ title: 'step1', duration: 100 }],
                  attachments: [
                    { name: 'trace', path: 'failing-trace.zip' },
                    { name: 'screenshot', path: 'failing-shot.png' },
                    {
                      name: 'console-errors-authenticatedPage',
                      body: 'TypeError: bang',
                      contentType: 'text/plain',
                    },
                  ],
                }),
                createResult({
                  status: 'passed',
                  retry: 1,
                  duration: 3000,
                  attachments: [{ name: 'trace', path: 'passing-trace.zip' }],
                }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]).toMatchObject({
        title: 'flaky test',
        file: 'e2e/chat.spec.ts',
        project: 'firefox',
        attempts: 2,
        error: 'race condition',
        duration: 2000,
        steps: [{ title: 'step1', duration: 100 }],
        artifacts: {
          trace: 'failing-trace.zip',
          screenshot: 'failing-shot.png',
          consoleErrors: 'TypeError: bang',
        },
      });
    });

    it('includes failed test details with error and artifacts', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/billing.spec.ts', [
            createTest('webkit', [
              createResult({
                status: 'failed',
                retry: 1,
                duration: 2000,
                errors: [{ message: 'Timeout', stack: 'at line 42' }],
                steps: [{ title: 'Click button', duration: 100 }],
                attachments: [
                  { name: 'trace', path: 'test-results/broken-webkit/trace.zip' },
                  { name: 'screenshot', path: 'test-results/broken-webkit/screenshot.png' },
                ],
              }),
            ]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toEqual({
        title: 'broken test',
        file: 'e2e/billing.spec.ts',
        project: 'webkit',
        error: 'Timeout',
        duration: 2000,
        steps: [{ title: 'Click button', duration: 100 }],
        artifacts: {
          trace: 'test-results/broken-webkit/trace.zip',
          screenshot: 'test-results/broken-webkit/screenshot.png',
          video: undefined,
          consoleErrors: undefined,
          apiErrors: undefined,
          pageSnapshot: undefined,
          harFiles: [],
        },
      });
    });

    it('handles nested suites', () => {
      const report: PlaywrightReport = {
        suites: [
          {
            title: 'Outer Suite',
            file: 'test.spec.ts',
            specs: [],
            suites: [
              {
                title: 'Inner Suite',
                file: 'test.spec.ts',
                specs: [
                  {
                    title: 'nested test',
                    file: 'test.spec.ts',
                    tests: [
                      {
                        projectName: 'chromium',
                        status: 'expected',
                        results: [
                          {
                            status: 'passed',
                            retry: 0,
                            duration: 500,
                            errors: [],
                            steps: [],
                            attachments: [],
                          },
                        ],
                      },
                    ],
                  },
                ],
                suites: [],
              },
            ],
          },
        ],
        config: {},
        stats: { duration: 500 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(1);
      expect(result.passed).toHaveLength(1);
    });

    it('outputs valid JSON structure', () => {
      const report = createReport([]);

      const result = generateDebugReport(report);

      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = structuredClone(result);
      expect(parsed.summary).toBeDefined();
      expect(parsed.passed).toEqual([]);
      expect(parsed.flaky).toEqual([]);
      expect(parsed.failed).toEqual([]);
    });

    it('handles suites with undefined specs and suites arrays', () => {
      const report: PlaywrightReport = {
        suites: [
          {
            title: 'Suite without specs/suites',
            file: 'test.spec.ts',
          },
        ],
        config: {},
        stats: { duration: 100 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
      expect(result.passed).toHaveLength(0);
    });

    it('handles specs with undefined tests array', () => {
      const report: PlaywrightReport = {
        suites: [
          {
            title: 'Suite',
            file: 'test.spec.ts',
            specs: [
              {
                title: 'Spec without tests',
                file: 'test.spec.ts',
              },
            ],
          },
        ],
        config: {},
        stats: { duration: 100 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
      expect(result.passed).toHaveLength(0);
    });
  });

  describe('renderSteps', () => {
    it('renders flat step list', () => {
      const steps: PlaywrightStep[] = [
        { title: 'page.fill', duration: 100, category: 'pw:api' },
        { title: 'page.click', duration: 200, category: 'pw:api' },
      ];

      const result = renderSteps(steps);

      expect(result).toContain('page.fill');
      expect(result).toContain('100ms');
      expect(result).toContain('page.click');
      expect(result).toContain('200ms');
    });

    it('renders nested steps with indentation', () => {
      const steps: PlaywrightStep[] = [
        {
          title: 'Send message',
          duration: 500,
          category: 'test.step',
          steps: [
            { title: 'page.fill', duration: 100, category: 'pw:api' },
            { title: 'page.click', duration: 200, category: 'pw:api' },
          ],
        },
      ];

      const result = renderSteps(steps);
      const lines = result.split('\n');

      expect(lines[0]).toMatch(/^- /);
      expect(lines.some((l: string) => l.startsWith('  - '))).toBe(true);
    });

    it('marks failed steps', () => {
      const steps: PlaywrightStep[] = [
        {
          title: 'expect(locator).toBeVisible',
          duration: 10_000,
          category: 'expect',
          error: 'Timeout',
        },
      ];

      const result = renderSteps(steps);

      expect(result).toContain('FAILED');
    });

    it('limits nesting to 2 levels', () => {
      const steps: PlaywrightStep[] = [
        {
          title: 'level 0',
          duration: 100,
          steps: [
            {
              title: 'level 1',
              duration: 100,
              steps: [{ title: 'level 2 (should be hidden)', duration: 100 }],
            },
          ],
        },
      ];

      const result = renderSteps(steps);

      expect(result).toContain('level 0');
      expect(result).toContain('level 1');
      expect(result).not.toContain('level 2');
    });
  });

  describe('generateMarkdownReport', () => {
    it('shows PASSED result when no failures', () => {
      const report: DebugReport = {
        summary: { total: 3, passed: 3, flaky: 0, failed: 0, duration: 5000 },
        passed: [
          { title: 'test one', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
          { title: 'test two', file: 'e2e/chat/chat.spec.ts', project: 'firefox', duration: 1000 },
          {
            title: 'test three',
            file: 'e2e/billing/billing.spec.ts',
            project: 'chromium',
            duration: 1000,
          },
        ],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Result:** PASSED');
      expect(md).toContain('3 passed');
      expect(md).toContain('## Passed Tests (3)');
      expect(md).not.toContain('## Failed Tests');
      expect(md).not.toContain('## Flaky Tests');
    });

    it('shows FAILED result with failed test details', () => {
      const report: DebugReport = {
        summary: { total: 2, passed: 1, flaky: 0, failed: 1, duration: 10_000 },
        passed: [
          { title: 'test one', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
        ],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            project: 'webkit',
            error: 'Timeout waiting for selector',
            duration: 10_000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/abs/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Result:** FAILED');
      expect(md).toContain('## Failed Tests');
      expect(md).toContain('### `e2e/billing/billing.spec.ts`');
      expect(md).toContain('#### broken test [webkit]');
      expect(md).toContain('Timeout waiting for selector');
      expect(md).toContain(
        'pnpm e2e -- e2e/billing/billing.spec.ts -g "broken test" --project=webkit'
      );
    });

    it('includes the line number in the location when known', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            line: 42,
            project: 'webkit',
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('e2e/billing/billing.spec.ts:42');
    });

    it('points at the page snapshot artifact when one was captured', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            project: 'webkit',
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: '- document:\n  - main: content',
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('page-snapshot.txt');
    });

    it('groups failed tests by file', () => {
      const report: DebugReport = {
        summary: { total: 3, passed: 0, flaky: 0, failed: 3, duration: 5000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test A',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            error: 'error A',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
          {
            title: 'test B',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            error: 'error B',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
          {
            title: 'test C',
            file: 'e2e/billing/billing.spec.ts',
            project: 'chromium',
            error: 'error C',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      const chatHeadingCount = (md.match(/### `e2e\/chat\/chat\.spec\.ts`/g) ?? []).length;
      expect(chatHeadingCount).toBe(1);
      expect(md).toContain('#### test A [chromium]');
      expect(md).toContain('#### test B [firefox]');
      expect(md).toContain('### `e2e/billing/billing.spec.ts`');
    });

    it('renders flaky tests with full failure details and flaky/ artifact paths', () => {
      const report: DebugReport = {
        summary: { total: 2, passed: 1, flaky: 1, failed: 0, duration: 5000 },
        passed: [
          { title: 'stable', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
        ],
        flaky: [
          {
            title: 'flaky test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            attempts: 3,
            error: 'race condition',
            duration: 2000,
            steps: [{ title: 'click', duration: 100 }],
            artifacts: {
              trace: 'trace.zip',
              screenshot: 'shot.png',
              video: undefined,
              consoleErrors: 'TypeError',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('## Flaky Tests');
      expect(md).toContain('flaky test');
      expect(md).toContain('race condition');
      // Per-test artifact links point at flaky/, not failed/.
      expect(md).toContain('flaky/e2e-chat-chat-spec-ts-firefox-flaky-test');
      expect(md).not.toContain('failed/e2e-chat-chat-spec-ts-firefox-flaky-test');
    });

    it('renders API Errors line when apiErrors present', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'test error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '500 POST /api/chat/abc/stream',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**API Errors:** See `failed/');
      expect(md).toContain('/api-errors.txt`');
    });

    it('omits API Errors line when apiErrors absent', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'test error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: 'TypeError',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).not.toContain('**API Errors:**');
    });

    it('renders API Errors line under flaky/ for flaky tests', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        passed: [],
        flaky: [
          {
            title: 'flaky test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            attempts: 2,
            error: 'race',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '429 POST /api/chat/xyz/stream',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**API Errors:** See `flaky/');
      expect(md).toContain('/api-errors.txt`');
    });

    it('strips ANSI codes from error messages', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: '\u001B[31mError\u001B[0m: failed',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('Error: failed');
      expect(md).not.toContain('\u001B[31m');
    });

    it('truncates long error messages', () => {
      const longError = 'x'.repeat(3000);
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: longError,
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('... (truncated)');
      expect(md.length).toBeLessThan(longError.length);
    });

    it('shows screenshot path when present', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/some/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Screenshot:**');
      expect(md).toContain('failed/');
    });

    it('shows "none" when screenshot is missing', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Screenshot:** none');
    });

    it('includes formatted duration', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 154_000 },
        passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Duration:** 2m 34s');
    });
  });

  describe('renderGlobalErrors', () => {
    const reportWith = (globalErrors?: string[]): DebugReport => ({
      summary: { total: 0, passed: 0, flaky: 0, failed: 0, duration: 0 },
      passed: [],
      flaky: [],
      failed: [],
      ...(globalErrors && { globalErrors }),
    });

    it('returns no lines when there are no global errors', () => {
      expect(renderGlobalErrors(reportWith())).toEqual([]);
    });

    it('renders a section containing the error text', () => {
      const lines = renderGlobalErrors(reportWith(['Error: ENOTEMPTY: directory not empty']));

      expect(lines).toContain('## Global Errors');
      expect(lines).toContain('Error: ENOTEMPTY: directory not empty');
    });

    it('strips ANSI colour codes from the error text', () => {
      const esc = String.fromCodePoint(27);
      const lines = renderGlobalErrors(reportWith([`${esc}[31mboom${esc}[0m`]));

      expect(lines).toContain('boom');
    });
  });

  describe('run status and global errors', () => {
    const abortedReport = (): PlaywrightReport => ({
      suites: [],
      config: {},
      stats: { duration: 66_000 },
      status: 'failed',
      errors: [
        "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/chat-image-generation-firefox'",
      ],
    });

    it('generateDebugReport propagates run status and global errors', () => {
      const result = generateDebugReport(abortedReport());

      expect(result.status).toBe('failed');
      expect(result.globalErrors).toEqual([
        "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/chat-image-generation-firefox'",
      ]);
      expect(result.summary.failed).toBe(0);
    });

    it('generateDebugReport omits status and globalErrors for a clean run', () => {
      const result = generateDebugReport({ suites: [], config: {}, stats: { duration: 1000 } });

      expect(result.status).toBeUndefined();
      expect(result.globalErrors).toBeUndefined();
    });

    it('generateMarkdownReport shows FAILED when the run aborted with zero failed tests', () => {
      const md = generateMarkdownReport(generateDebugReport(abortedReport()));

      expect(md).toContain('**Result:** FAILED');
      expect(md).toContain('## Global Errors');
      expect(md).toContain('ENOTEMPTY');
    });

    it('generateMarkdownReport stays PASSED and omits the section for a clean run', () => {
      const md = generateMarkdownReport(
        generateDebugReport({
          suites: [],
          config: {},
          stats: { duration: 1000 },
          status: 'passed',
        })
      );

      expect(md).toContain('**Result:** PASSED');
      expect(md).not.toContain('## Global Errors');
    });

    it('generateMarkdownReport shows FAILED on an interrupted run with no test failures', () => {
      const md = generateMarkdownReport(
        generateDebugReport({
          suites: [],
          config: {},
          stats: { duration: 1000 },
          status: 'interrupted',
        })
      );

      expect(md).toContain('**Result:** FAILED');
    });

    it('generateJsonReport includes status and globalErrors when present', () => {
      const json = generateJsonReport(generateDebugReport(abortedReport()));

      expect(json.status).toBe('failed');
      expect(json.globalErrors).toHaveLength(1);
    });

    it('generateJsonReport omits status and globalErrors for a clean run', () => {
      const json = generateJsonReport(
        generateDebugReport({ suites: [], config: {}, stats: { duration: 1000 } })
      );

      expect(json.status).toBeUndefined();
      expect(json.globalErrors).toBeUndefined();
    });
  });

  describe('serializeTestForJson', () => {
    const baseArtifacts = {
      trace: 'trace.zip',
      screenshot: 'screenshot.png',
      video: 'video.webm',
      consoleErrors: 'console.txt',
      apiErrors: 'api.txt',
      pageSnapshot: 'snapshot.txt',
      harFiles: ['network.har'],
    };

    const failedSample: FailedTest = {
      title: 'sample fails',
      file: 'e2e/sample.spec.ts',
      line: 42,
      project: 'chromium',
      error: '[31mBoom[0m',
      duration: 1234,
      steps: [],
      artifacts: baseArtifacts,
    };

    it('strips ANSI from the error', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.error).toBe('Boom');
    });

    it('attaches a rerun command derived from the test', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.rerunCommand).toBe(buildRerunCommand(failedSample));
    });

    it('builds a fresh artifacts object holding the same field values', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.artifacts).toEqual(baseArtifacts);
      expect(entry.artifacts).not.toBe(baseArtifacts);
      // harFiles is forwarded by reference — the previous generateJsonReport
      // shape did the same, so preserve identity to keep behavior identical.
      expect(entry.artifacts.harFiles).toBe(baseArtifacts.harFiles);
    });

    it('preserves the title, file, line, project, duration, and steps', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.title).toBe(failedSample.title);
      expect(entry.file).toBe(failedSample.file);
      expect(entry.line).toBe(failedSample.line);
      expect(entry.project).toBe(failedSample.project);
      expect(entry.duration).toBe(failedSample.duration);
      expect(entry.steps).toBe(failedSample.steps);
    });

    it('serializes a flaky test with the same shape as a failed test', () => {
      const flakySample: FlakyTest = {
        title: 'sample flakes',
        file: 'e2e/flake.spec.ts',
        line: 7,
        project: 'webkit',
        attempts: 2,
        error: 'transient timeout',
        duration: 500,
        steps: [],
        artifacts: baseArtifacts,
      };

      const entry = serializeTestForJson(flakySample);

      expect(entry).toEqual({
        title: 'sample flakes',
        file: 'e2e/flake.spec.ts',
        line: 7,
        project: 'webkit',
        duration: 500,
        error: 'transient timeout',
        rerunCommand: buildRerunCommand(flakySample),
        steps: flakySample.steps,
        artifacts: baseArtifacts,
      });
    });
  });

  describe('writeReport', () => {
    let temporaryDir: string;

    const simpleReport: DebugReport = {
      summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 1000 },
      passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
      flaky: [],
      failed: [],
    };

    afterEach(() => {
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    it('creates timestamped subdirectory with REPORT.md', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
      const content = readFileSync(path.join(resultDir, 'REPORT.md'), 'utf8');
      expect(content).toContain('# E2E Test Report');
    });

    it('returns path inside baseDir with ISO-like timestamp', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(resultDir.startsWith(baseDir)).toBe(true);
      const dirName = path.basename(resultDir);
      expect(dirName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it('writes per-test artifacts in failed/ directory', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const sourceScreenshot = path.join(temporaryDir, 'source-screenshot.png');
      writeFileSync(sourceScreenshot, 'fake-png-data');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'test error message',
            duration: 1000,
            steps: [{ title: 'click', duration: 100 }],
            artifacts: {
              trace: undefined,
              screenshot: sourceScreenshot,
              video: undefined,
              consoleErrors: 'TypeError: x',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-broken-test';
      const failedDir = path.join(resultDir, 'failed', slug);
      expect(existsSync(failedDir)).toBe(true);
      expect(existsSync(path.join(failedDir, 'error.txt'))).toBe(true);
      expect(existsSync(path.join(failedDir, 'steps.json'))).toBe(true);
      expect(existsSync(path.join(failedDir, 'screenshot.png'))).toBe(true);
      expect(existsSync(path.join(failedDir, 'console-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(failedDir, 'error.txt'), 'utf8')).toBe('test error message');
    });

    it('writes per-test artifacts in flaky/ directory', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const sourceScreenshot = path.join(temporaryDir, 'flaky-source.png');
      writeFileSync(sourceScreenshot, 'fake-png-data');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        passed: [],
        flaky: [
          {
            title: 'intermittent test',
            file: 'e2e/chat/flaky.spec.ts',
            project: 'webkit',
            attempts: 2,
            error: 'race on first attempt',
            duration: 500,
            steps: [{ title: 'wait', duration: 50 }],
            artifacts: {
              trace: undefined,
              screenshot: sourceScreenshot,
              video: undefined,
              consoleErrors: 'oops',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-chat-flaky-spec-ts-webkit-intermittent-test';
      const flakyDir = path.join(resultDir, 'flaky', slug);
      expect(existsSync(flakyDir)).toBe(true);
      expect(existsSync(path.join(flakyDir, 'error.txt'))).toBe(true);
      expect(existsSync(path.join(flakyDir, 'steps.json'))).toBe(true);
      expect(existsSync(path.join(flakyDir, 'screenshot.png'))).toBe(true);
      expect(existsSync(path.join(flakyDir, 'console-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(flakyDir, 'error.txt'), 'utf8')).toBe('race on first attempt');
    });

    it('writes api-errors.txt in failed/ directory when apiErrors set', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'test error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '500 POST /api/chat/abc/stream\n  body: {"code":"BILLING_ERROR"}',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-broken-test';
      const failedDir = path.join(resultDir, 'failed', slug);
      expect(existsSync(path.join(failedDir, 'api-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(failedDir, 'api-errors.txt'), 'utf8')).toContain(
        'POST /api/chat/abc/stream'
      );
    });

    it('writes api-errors.txt in flaky/ directory when apiErrors set', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        passed: [],
        flaky: [
          {
            title: 'intermittent test',
            file: 'e2e/chat/flaky.spec.ts',
            project: 'webkit',
            attempts: 2,
            error: 'race condition',
            duration: 500,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '429 POST /api/chat/abc/stream',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-chat-flaky-spec-ts-webkit-intermittent-test';
      const flakyDir = path.join(resultDir, 'flaky', slug);
      expect(existsSync(path.join(flakyDir, 'api-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(flakyDir, 'api-errors.txt'), 'utf8')).toContain(
        '429 POST /api/chat/abc/stream'
      );
    });

    it('omits api-errors.txt when apiErrors is undefined', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'no api errors test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'oops',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: 'TypeError',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-no-api-errors-test';
      const failedDir = path.join(resultDir, 'failed', slug);
      expect(existsSync(path.join(failedDir, 'api-errors.txt'))).toBe(false);
    });

    it('writes report.json alongside REPORT.md', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(resultDir, 'report.json'))).toBe(true);
      const json = JSON.parse(
        readFileSync(path.join(resultDir, 'report.json'), 'utf8')
      ) as JsonReport;
      expect(json.summary.passed).toBe(1);
      expect(json.passed).toHaveLength(1);
    });

    it('includes apiErrors in report.json for failed tests', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'e',
            duration: 1,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '500 POST /api/x',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const json = JSON.parse(
        readFileSync(path.join(resultDir, 'report.json'), 'utf8')
      ) as JsonReport;
      expect(json.failed[0]?.artifacts.apiErrors).toBe('500 POST /api/x');
    });

    it('preserves previous reports', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const oldDir = path.join(baseDir, '2020-01-01T00-00-00');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(path.join(oldDir, 'REPORT.md'), 'old report');

      writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(oldDir, 'REPORT.md'))).toBe(true);
    });

    it('extracts trace.zip into trace/ subdirectory for failed tests', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const tracePath = makeTraceZip(temporaryDir, 'trace.zip', {
        'test.trace': '{"type":"context-options","title":"failure-trace"}',
        '1-trace.network': '{"type":"resource-snapshot"}',
        'resources/src@abc.txt': '<html><body>captured</body></html>',
        'resources/page@frame-1.jpeg': 'BINARY-JPEG-DATA',
      });

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken with trace',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'oops',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-broken-with-trace';
      const traceDir = path.join(resultDir, 'failed', slug, 'trace');
      expect(existsSync(path.join(traceDir, 'test.trace'))).toBe(true);
      expect(existsSync(path.join(traceDir, '1-trace.network'))).toBe(true);
      expect(existsSync(path.join(traceDir, 'resources', 'src@abc.txt'))).toBe(true);
      expect(readFileSync(path.join(traceDir, 'test.trace'), 'utf8')).toContain('failure-trace');
    });

    it('extracts trace.zip into trace/ subdirectory for flaky tests', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const tracePath = makeTraceZip(temporaryDir, 'flaky-trace.zip', {
        'test.trace': '{"type":"context-options","title":"flaky-trace"}',
      });

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        passed: [],
        flaky: [
          {
            title: 'intermittent with trace',
            file: 'e2e/chat/flaky.spec.ts',
            project: 'webkit',
            attempts: 2,
            error: 'race',
            duration: 500,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-chat-flaky-spec-ts-webkit-intermittent-with-trace';
      const traceDir = path.join(resultDir, 'flaky', slug, 'trace');
      expect(existsSync(path.join(traceDir, 'test.trace'))).toBe(true);
      expect(readFileSync(path.join(traceDir, 'test.trace'), 'utf8')).toContain('flaky-trace');
    });

    it('omits resources/page@*.jpeg frame screenshots when extracting trace', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const tracePath = makeTraceZip(temporaryDir, 'jpeg-trace.zip', {
        'test.trace': '{}',
        'resources/page@frame-1.jpeg': 'JPEG-1',
        'resources/page@frame-2.jpeg': 'JPEG-2',
        'resources/src@kept.txt': 'kept-source',
        'resources/abc123.dat': 'kept-response-body',
      });

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'jpeg trim',
            file: 'e2e/t.spec.ts',
            project: 'chromium',
            error: 'e',
            duration: 1,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-t-spec-ts-chromium-jpeg-trim';
      const traceDir = path.join(resultDir, 'failed', slug, 'trace');
      expect(existsSync(path.join(traceDir, 'resources', 'page@frame-1.jpeg'))).toBe(false);
      expect(existsSync(path.join(traceDir, 'resources', 'page@frame-2.jpeg'))).toBe(false);
      expect(existsSync(path.join(traceDir, 'resources', 'src@kept.txt'))).toBe(true);
      expect(existsSync(path.join(traceDir, 'resources', 'abc123.dat'))).toBe(true);
    });

    it('handles missing trace zip path gracefully', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'no trace file on disk',
            file: 'e2e/t.spec.ts',
            project: 'chromium',
            error: 'e',
            duration: 1,
            steps: [],
            artifacts: {
              trace: '/nonexistent/trace.zip',
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-t-spec-ts-chromium-no-trace-file-on-disk';
      expect(existsSync(path.join(resultDir, 'failed', slug, 'trace'))).toBe(false);
      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
    });

    it('handles missing artifact sources gracefully', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/nonexistent/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: ['/nonexistent/path/network.har'],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
    });
  });

  describe('mergeHarFiles', () => {
    let workDir: string;

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('merges entries from every existing har file into one archive', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-har-'));
      const harA = path.join(workDir, 'a.har');
      const harB = path.join(workDir, 'b.har');
      writeFileSync(harA, JSON.stringify({ log: { entries: [{ request: 'a' }] } }), 'utf8');
      writeFileSync(harB, JSON.stringify({ log: { entries: [{ request: 'b' }] } }), 'utf8');
      const outputPath = path.join(workDir, 'merged.har');

      mergeHarFiles([harA, path.join(workDir, 'missing.har'), harB], outputPath);

      const merged = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        log: { entries: { request: string }[] };
      };
      expect(merged.log.entries).toEqual([{ request: 'a' }, { request: 'b' }]);
    });

    it('writes nothing when no har files exist', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-har-'));
      const outputPath = path.join(workDir, 'merged.har');

      mergeHarFiles([path.join(workDir, 'missing.har')], outputPath);

      expect(existsSync(outputPath)).toBe(false);
    });
  });

  describe('extractTraceArchive', () => {
    let workDir: string;

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('extracts trace files while skipping directories and frame screenshots', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-trace-'));
      const zipPath = path.join(workDir, 'trace.zip');
      const zip = new AdmZip();
      zip.addFile('resources/', Buffer.alloc(0));
      zip.addFile('resources/page@abc.jpeg', Buffer.from('jpeg-bytes'));
      zip.addFile('test.trace', Buffer.from('{"type":"frame"}'));
      zip.writeZip(zipPath);
      const destination = path.join(workDir, 'extracted');

      extractTraceArchive(zipPath, destination);

      expect(existsSync(path.join(destination, 'test.trace'))).toBe(true);
      expect(existsSync(path.join(destination, 'resources', 'page@abc.jpeg'))).toBe(false);
    });
  });

  describe('writePerTestArtifacts', () => {
    let workDir: string;

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('writes the page snapshot artifact when one was captured', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-artifacts-'));
      const test: FailedTest = {
        title: 'broken test',
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
        error: 'boom',
        duration: 1000,
        steps: [],
        artifacts: {
          trace: undefined,
          screenshot: undefined,
          video: undefined,
          consoleErrors: undefined,
          apiErrors: undefined,
          pageSnapshot: '- document:\n  - main: content',
          harFiles: [],
        },
      };
      const testDir = path.join(workDir, 'broken-test');

      writePerTestArtifacts(test, testDir);

      expect(readFileSync(path.join(testDir, 'page-snapshot.txt'), 'utf8')).toBe(
        '- document:\n  - main: content'
      );
    });
  });

  describe('enforceRetentionLimit', () => {
    let temporaryDir: string;

    afterEach(() => {
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    it('deletes oldest directories when over limit', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      for (const name of ['2020-01-01T00-00-00', '2020-01-02T00-00-00', '2020-01-03T00-00-00']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01T00-00-00'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-02T00-00-00'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-03T00-00-00'))).toBe(true);
    });

    it('keeps all directories when at or under limit', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      for (const name of ['2020-01-01T00-00-00', '2020-01-02T00-00-00']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01T00-00-00'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-02T00-00-00'))).toBe(true);
    });

    it('ignores files, only counts directories', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      writeFileSync(path.join(temporaryDir, 'stray-file.txt'), 'data');
      mkdirSync(path.join(temporaryDir, '2020-01-01T00-00-00'));

      enforceRetentionLimit(temporaryDir, 1);

      expect(existsSync(path.join(temporaryDir, '2020-01-01T00-00-00'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, 'stray-file.txt'))).toBe(true);
    });

    it('handles nonexistent base directory gracefully', () => {
      expect(() => {
        enforceRetentionLimit('/nonexistent/path', 10);
      }).not.toThrow();
    });
  });

  describe('resource usage', () => {
    const resources = {
      summary: {
        durationMs: 125_000,
        sampleCount: 3,
        cores: 24,
        totalMemBytes: 32 * 1024 ** 3,
        cpu: { peak: 62, avg: 38 },
        mem: { peak: 44, avg: 30 },
        load: { peak: 19 },
      },
      samples: [{ t: 0, cpuPct: 62, memPct: 44, load1: 19 }],
      scan: {
        totalHits: 7,
        categories: [{ name: 'process/thread limit', count: 7, tests: ['a.spec.ts › b'] }],
      },
    };

    const emptyReport = (): DebugReport =>
      generateDebugReport({ suites: [], config: {}, stats: { duration: 1000 } });

    it('renderResourceSection returns nothing without resources', () => {
      expect(renderResourceSection()).toEqual([]);
    });

    it('renderResourceSection renders the table and error breakdown', () => {
      const md = renderResourceSection(resources).join('\n');
      expect(md).toContain('## Resource Usage');
      expect(md).toContain('| CPU | 62% | 38% |');
      expect(md).toContain('**Resource-limit errors:** 7');
      expect(md).toContain('process/thread limit ×7');
    });

    it('renderResourceSection omits the error block when there are no hits', () => {
      const md = renderResourceSection({
        ...resources,
        scan: { totalHits: 0, categories: [] },
      }).join('\n');
      expect(md).not.toContain('Resource-limit errors');
      expect(md).toContain('## Resource Usage');
    });

    it('generateMarkdownReport includes the resource section when present', () => {
      const report = emptyReport();
      report.resources = resources;
      expect(generateMarkdownReport(report)).toContain('## Resource Usage');
    });

    it('generateJsonReport embeds a lean resources object (no samples)', () => {
      const report = emptyReport();
      report.resources = resources;
      const json = generateJsonReport(report);
      expect(json.resources?.scan.totalHits).toBe(7);
      expect(json.resources?.summary.cpu.peak).toBe(62);
      expect(json.resources).not.toHaveProperty('samples');
    });

    it('writeReport emits resource-timeline.json when resources are present', () => {
      const report = emptyReport();
      report.resources = resources;
      const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-res-'));
      try {
        const out = writeReport(report, dir);
        const timeline = path.join(out, 'resource-timeline.json');
        expect(existsSync(timeline)).toBe(true);
        expect(JSON.parse(readFileSync(timeline, 'utf8'))).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
