import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('./workspaces.js', () => ({
  discoverWorkspaces: vi.fn(),
}));

import { execa } from 'execa';
import { discoverWorkspaces } from './workspaces.js';
import {
  parseArgs,
  validateFilters,
  filterByRule,
  filterByFile,
  formatOutput,
  extractJsonFromTurboOutput,
  runLint,
  type LintResult,
} from './lint-check.js';

const mockExeca = vi.mocked(execa);
const mockDiscoverWorkspaces = vi.mocked(discoverWorkspaces);

describe('lint-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('returns empty filters when no args provided', () => {
      const result = parseArgs([]);

      expect(result).toEqual({
        rules: [],
        packages: [],
        files: [],
      });
    });

    it('parses single --rule argument', () => {
      const result = parseArgs(['--rule=no-unused-vars']);

      expect(result.rules).toEqual(['no-unused-vars']);
    });

    it('parses multiple --rule arguments', () => {
      const result = parseArgs(['--rule=no-unused-vars', '--rule=complexity']);

      expect(result.rules).toEqual(['no-unused-vars', 'complexity']);
    });

    it('parses single --package argument', () => {
      const result = parseArgs(['--package=web']);

      expect(result.packages).toEqual(['web']);
    });

    it('parses multiple --package arguments', () => {
      const result = parseArgs(['--package=web', '--package=api']);

      expect(result.packages).toEqual(['web', 'api']);
    });

    it('parses single --file argument', () => {
      const result = parseArgs(['--file=src/index.ts']);

      expect(result.files).toEqual(['src/index.ts']);
    });

    it('parses multiple --file arguments', () => {
      const result = parseArgs(['--file=src/index.ts', '--file=src/utils.ts']);

      expect(result.files).toEqual(['src/index.ts', 'src/utils.ts']);
    });

    it('parses mixed arguments', () => {
      const result = parseArgs([
        '--rule=complexity',
        '--package=web',
        '--file=src/index.ts',
        '--rule=no-console',
      ]);

      expect(result).toEqual({
        rules: ['complexity', 'no-console'],
        packages: ['web'],
        files: ['src/index.ts'],
      });
    });

    it('ignores unknown arguments', () => {
      const result = parseArgs(['--unknown=value', '--rule=complexity']);

      expect(result.rules).toEqual(['complexity']);
      expect(result.packages).toEqual([]);
      expect(result.files).toEqual([]);
    });
  });

  describe('validateFilters', () => {
    const mockWorkspaces = [
      { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
      { name: 'api', path: 'apps/api', fullName: '@hushbox/api' },
      { name: 'shared', path: 'packages/shared', fullName: '@hushbox/shared' },
    ];

    it('does not throw for valid packages', () => {
      expect(() => {
        validateFilters({ rules: [], packages: ['web', 'api'], files: [] }, mockWorkspaces);
      }).not.toThrow();
    });

    it('throws for unknown package', () => {
      expect(() => {
        validateFilters({ rules: [], packages: ['unknown'], files: [] }, mockWorkspaces);
      }).toThrow('Unknown package: "unknown". Available: api, shared, web');
    });

    it('does not throw when no packages specified', () => {
      expect(() => {
        validateFilters({ rules: [], packages: [], files: [] }, mockWorkspaces);
      }).not.toThrow();
    });
  });

  describe('filterByRule', () => {
    const mockResults: LintResult[] = [
      {
        filePath: '/app/src/index.ts',
        messages: [
          { ruleId: 'no-unused-vars', line: 1, column: 1, message: 'Unused var', severity: 2 },
          { ruleId: 'complexity', line: 5, column: 1, message: 'Too complex', severity: 2 },
        ],
        errorCount: 2,
        warningCount: 0,
      },
      {
        filePath: '/app/src/utils.ts',
        messages: [
          { ruleId: 'no-console', line: 10, column: 1, message: 'No console', severity: 1 },
        ],
        errorCount: 0,
        warningCount: 1,
      },
    ];

    it('returns all results when no rule filter', () => {
      const result = filterByRule(mockResults, []);

      expect(result).toEqual(mockResults);
    });

    it('filters to single rule', () => {
      const result = filterByRule(mockResults, ['complexity']);

      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe('/app/src/index.ts');
      expect(result[0]?.messages).toHaveLength(1);
      expect(result[0]?.messages[0]?.ruleId).toBe('complexity');
    });

    it('filters to multiple rules', () => {
      const result = filterByRule(mockResults, ['complexity', 'no-console']);

      expect(result).toHaveLength(2);
    });

    it('removes files with no matching messages', () => {
      const result = filterByRule(mockResults, ['no-console']);

      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe('/app/src/utils.ts');
    });

    it('supports partial rule name matching', () => {
      const result = filterByRule(mockResults, ['unused']);

      expect(result).toHaveLength(1);
      expect(result[0]?.messages[0]?.ruleId).toBe('no-unused-vars');
    });
  });

  describe('filterByFile', () => {
    const mockResults: LintResult[] = [
      {
        filePath: '/app/src/index.ts',
        messages: [
          { ruleId: 'complexity', line: 1, column: 1, message: 'Too complex', severity: 2 },
        ],
        errorCount: 1,
        warningCount: 0,
      },
      {
        filePath: '/app/src/utils/helpers.ts',
        messages: [
          { ruleId: 'no-console', line: 10, column: 1, message: 'No console', severity: 1 },
        ],
        errorCount: 0,
        warningCount: 1,
      },
    ];

    it('returns all results when no file filter', () => {
      const result = filterByFile(mockResults, []);

      expect(result).toEqual(mockResults);
    });

    it('filters to matching file path', () => {
      const result = filterByFile(mockResults, ['index']);

      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe('/app/src/index.ts');
    });

    it('supports multiple file patterns', () => {
      const result = filterByFile(mockResults, ['index', 'helpers']);

      expect(result).toHaveLength(2);
    });

    it('matches anywhere in file path', () => {
      const result = filterByFile(mockResults, ['utils']);

      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe('/app/src/utils/helpers.ts');
    });
  });

  describe('formatOutput', () => {
    it('formats results with file path and line numbers', () => {
      const results: LintResult[] = [
        {
          filePath: '/app/src/index.ts',
          messages: [
            { ruleId: 'complexity', line: 5, column: 8, message: 'Too complex', severity: 2 },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      ];

      const output = formatOutput(results);

      expect(output).toContain('/app/src/index.ts');
      expect(output).toContain('5:8');
      expect(output).toContain('complexity');
      expect(output).toContain('Too complex');
    });

    it('returns empty message when no results', () => {
      const output = formatOutput([]);

      expect(output).toBe('No lint errors found.');
    });

    it('omits the rule id when ESLint reports none (parse errors)', () => {
      const results: LintResult[] = [
        {
          filePath: '/app/src/index.ts',
          messages: [
            {
              ruleId: null,
              line: 1,
              column: 1,
              message: 'Parsing error: Unexpected token',
              severity: 2,
            },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      ];

      const output = formatOutput(results);

      expect(output).toContain('Parsing error: Unexpected token');
      expect(output).not.toContain('null');
    });

    it('shows error and warning counts', () => {
      const results: LintResult[] = [
        {
          filePath: '/app/src/index.ts',
          messages: [
            { ruleId: 'complexity', line: 5, column: 8, message: 'Too complex', severity: 2 },
            { ruleId: 'no-console', line: 10, column: 1, message: 'No console', severity: 1 },
          ],
          errorCount: 1,
          warningCount: 1,
        },
      ];

      const output = formatOutput(results);

      expect(output).toContain('1 errors, 1 warnings');
    });

    it('skips files with no messages', () => {
      const results: LintResult[] = [
        {
          filePath: '/app/src/clean.ts',
          messages: [],
          errorCount: 0,
          warningCount: 0,
        },
        {
          filePath: '/app/src/dirty.ts',
          messages: [
            { ruleId: 'complexity', line: 5, column: 8, message: 'Too complex', severity: 2 },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      ];

      const output = formatOutput(results);

      expect(output).not.toContain('clean.ts');
      expect(output).toContain('dirty.ts');
    });
  });

  describe('extractJsonFromTurboOutput', () => {
    it('extracts JSON from turbo output lines', () => {
      const output = `• turbo 2.7.5
@hushbox/shared:lint: cache hit
@hushbox/shared:lint: [{"filePath":"/app/test.ts","messages":[],"errorCount":0,"warningCount":0}]`;

      const results = extractJsonFromTurboOutput(output);

      expect(results).toHaveLength(1);
      expect(results[0]?.filePath).toBe('/app/test.ts');
    });

    it('handles multiple packages', () => {
      const output = `@hushbox/web:lint: [{"filePath":"/web/a.ts","messages":[],"errorCount":0,"warningCount":0}]
@hushbox/api:lint: [{"filePath":"/api/b.ts","messages":[],"errorCount":0,"warningCount":0}]`;

      const results = extractJsonFromTurboOutput(output);

      expect(results).toHaveLength(2);
    });

    it('ignores non-JSON lines', () => {
      const output = `• turbo 2.7.5
• Packages in scope
Some other output
@hushbox/shared:lint: [{"filePath":"/app/test.ts","messages":[],"errorCount":0,"warningCount":0}]`;

      const results = extractJsonFromTurboOutput(output);

      expect(results).toHaveLength(1);
    });

    it('returns empty array for no JSON', () => {
      const output = 'No JSON here';

      const results = extractJsonFromTurboOutput(output);

      expect(results).toEqual([]);
    });
  });

  describe('runLint', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = path.join(tmpdir(), `lint-check-test-${String(Date.now())}`);
      mkdirSync(testDir, { recursive: true });

      mockDiscoverWorkspaces.mockReturnValue([
        { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
        { name: 'api', path: 'apps/api', fullName: '@hushbox/api' },
      ]);
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('runs turbo lint with json format', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);

      await runLint({ rules: [], packages: [], files: [] }, testDir);

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        expect.arrayContaining(['turbo', 'lint', '--', '--format', 'json']),
        expect.any(Object)
      );
    });

    it('filters by package using --filter flag', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);

      await runLint({ rules: [], packages: ['web'], files: [] }, testDir);

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        expect.arrayContaining(['--filter', '@hushbox/web']),
        expect.any(Object)
      );
    });

    it('throws for unknown package', async () => {
      await expect(
        runLint({ rules: [], packages: ['unknown'], files: [] }, testDir)
      ).rejects.toThrow('Unknown package: "unknown"');
    });

    it('applies rule filter to results', async () => {
      const turboOutput = `@hushbox/web:lint: [{"filePath":"/app/index.ts","messages":[{"ruleId":"complexity","line":1,"column":1,"message":"Too complex","severity":2},{"ruleId":"no-console","line":2,"column":1,"message":"No console","severity":2}],"errorCount":2,"warningCount":0}]`;
      mockExeca.mockResolvedValueOnce({ stdout: turboOutput, stderr: '' } as never);

      const result = await runLint({ rules: ['complexity'], packages: [], files: [] }, testDir);

      expect(result).toHaveLength(1);
      expect(result[0]?.messages).toHaveLength(1);
      expect(result[0]?.messages[0]?.ruleId).toBe('complexity');
    });

    it('applies file filter to results', async () => {
      const turboOutput = `@hushbox/web:lint: [{"filePath":"/app/index.ts","messages":[{"ruleId":"complexity","line":1,"column":1,"message":"a","severity":2}],"errorCount":1,"warningCount":0},{"filePath":"/app/utils.ts","messages":[{"ruleId":"complexity","line":1,"column":1,"message":"b","severity":2}],"errorCount":1,"warningCount":0}]`;
      mockExeca.mockResolvedValueOnce({ stdout: turboOutput, stderr: '' } as never);

      const result = await runLint({ rules: [], packages: [], files: ['index'] }, testDir);

      expect(result).toHaveLength(1);
      expect(result[0]?.filePath).toBe('/app/index.ts');
    });
  });
});
