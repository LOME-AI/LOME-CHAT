import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDIT_CARD_FEE_RATE,
  HUSHBOX_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
  STORAGE_COST_PER_CHARACTER,
  TOTAL_FEE_RATE,
} from '../../packages/shared/src/constants.js';
import { formatFeePercent } from '../../packages/shared/src/fees.js';
import { generateReadme, getTemplateValues } from './generate-readme.js';
import { countLinesChurned } from './lines-churned.js';
import { countLinesOfCode } from './lines-of-code.js';

describe('getTemplateValues', () => {
  it('returns fee percentages derived from constants', () => {
    const values = getTemplateValues();

    expect(values['TOTAL_FEE_PERCENT']).toBe(formatFeePercent(TOTAL_FEE_RATE));
    expect(values['HUSHBOX_FEE_PERCENT']).toBe(formatFeePercent(HUSHBOX_FEE_RATE));
    expect(values['CC_FEE_PERCENT']).toBe(formatFeePercent(CREDIT_CARD_FEE_RATE));
    expect(values['PROVIDER_FEE_PERCENT']).toBe(formatFeePercent(PROVIDER_FEE_RATE));
  });

  it('returns storage cost from constants', () => {
    const values = getTemplateValues();

    expect(values['STORAGE_COST_PER_1K']).toBe(`$${String(STORAGE_COST_PER_1K_CHARS)}`);
  });

  it('calculates messages per dollar correctly', () => {
    const values = getTemplateValues();
    const averageMessageChars = 200;
    const expectedMessages = Math.floor(1 / (STORAGE_COST_PER_CHARACTER * averageMessageChars));

    expect(values['MESSAGES_PER_DOLLAR']).toBe(expectedMessages.toLocaleString('en-US'));
  });

  it('returns 16,666 messages per dollar with current constants', () => {
    const values = getTemplateValues();

    expect(values['MESSAGES_PER_DOLLAR']).toBe('16,666');
  });

  it('includes tier-related values', () => {
    const values = getTemplateValues();

    expect(values['FREE_ALLOWANCE']).toBe('$0.05');
    expect(values['TRIAL_LIMIT']).toBe('5');
    expect(values['WELCOME_CREDIT']).toBe('$0.20');
  });
});

describe('generateReadme', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'generate-readme-test-'));
    // The generator computes {{LINES_CHURNED}} from git history, so the
    // temporary root must be a repository (empty history = zero churn).
    execaSync('git', ['-C', temporaryDir, 'init', '--quiet']);
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  function commitAll(message: string): void {
    execaSync('git', ['-C', temporaryDir, 'add', '--all']);
    execaSync('git', [
      '-C',
      temporaryDir,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--message',
      message,
    ]);
  }

  it('replaces template variables with values', () => {
    const template = `# Test
Fee: {{TOTAL_FEE_PERCENT}}
Storage: {{STORAGE_COST_PER_1K}} per 1k chars
`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output).toContain(`Fee: ${formatFeePercent(TOTAL_FEE_RATE)}`);
    expect(output).toContain(`Storage: $${String(STORAGE_COST_PER_1K_CHARS)} per 1k chars`);
  });

  it('replaces the lines-of-code variable with the repo line count', () => {
    writeFileSync(
      path.join(temporaryDir, 'count-me.ts'),
      'const a = 1;\nconst b = 2;\nconst c = 3;\n'
    );
    writeFileSync(path.join(temporaryDir, 'README.template.md'), 'Lines: {{LINES_OF_CODE}}');
    // Computed at the same filesystem state generateReadme sees (before it writes
    // README.md), so the assertion is independent of the counted-extension set.
    const expected = countLinesOfCode(temporaryDir);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output).toContain(`Lines: ${expected.toLocaleString('en-US')}`);
  });

  it('formats the line count with thousands separators', () => {
    writeFileSync(path.join(temporaryDir, 'big.ts'), 'x\n'.repeat(1234));
    writeFileSync(path.join(temporaryDir, 'README.template.md'), '{{LINES_OF_CODE}}');
    const expected = countLinesOfCode(temporaryDir);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(expected).toBeGreaterThan(999);
    expect(output).toContain(expected.toLocaleString('en-US'));
  });

  it('replaces the lines-churned variable with the git history churn', () => {
    writeFileSync(path.join(temporaryDir, 'churn-me.ts'), 'one\ntwo\nthree\n');
    commitAll('add three lines');
    writeFileSync(path.join(temporaryDir, 'churn-me.ts'), 'one\ntwo\n');
    commitAll('delete one line');
    writeFileSync(path.join(temporaryDir, 'README.template.md'), 'Churned: {{LINES_CHURNED}}');
    const expected = countLinesChurned(temporaryDir);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(expected).toBeGreaterThan(0);
    expect(output).toContain(`Churned: ${expected.toLocaleString('en-US')}`);
  });

  it('adds auto-generated notice at top', () => {
    const template = '# Hello';
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    expect(output.startsWith('<!-- AUTO-GENERATED from README.template.md')).toBe(true);
  });

  it('replaces all occurrences of same variable', () => {
    const template = `{{TOTAL_FEE_PERCENT}} here and {{TOTAL_FEE_PERCENT}} there`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    generateReadme(temporaryDir);

    const output = readFileSync(path.join(temporaryDir, 'README.md'), 'utf8');
    const totalPercent = formatFeePercent(TOTAL_FEE_RATE);
    expect(output).toContain(`${totalPercent} here and ${totalPercent} there`);
  });

  it('exits with code 1 when unmatched variables found', () => {
    const template = `Valid: {{TOTAL_FEE_PERCENT}}, Invalid: {{UNKNOWN_VAR}}`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());

    expect(() => {
      generateReadme(temporaryDir);
    }).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith('ERROR: Unmatched template variables found:');
    expect(mockError).toHaveBeenCalledWith('  - {{UNKNOWN_VAR}}');

    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('succeeds when all variables are matched', () => {
    const template = `{{TOTAL_FEE_PERCENT}} {{HUSHBOX_FEE_PERCENT}} {{CC_FEE_PERCENT}} {{PROVIDER_FEE_PERCENT}} {{STORAGE_COST_PER_1K}} {{MESSAGES_PER_DOLLAR}} {{FREE_ALLOWANCE}} {{TRIAL_LIMIT}} {{WELCOME_CREDIT}} {{LINES_OF_CODE}} {{LINES_CHURNED}}`;
    writeFileSync(path.join(temporaryDir, 'README.template.md'), template);

    const mockExit = vi.spyOn(process, 'exit');
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    generateReadme(temporaryDir);

    expect(mockExit).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('✓ Generated README.md from template');

    mockExit.mockRestore();
    mockLog.mockRestore();
  });
});
