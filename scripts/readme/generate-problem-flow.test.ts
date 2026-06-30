import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBrandColors } from './brand.js';
import { generateProblemFlowSvg, generateProblemFlows } from './generate-problem-flow.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

describe('generateProblemFlowSvg', () => {
  it('produces a valid SVG document', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateProblemFlowSvg(brand.light);

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('includes all 5 step labels', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateProblemFlowSvg(brand.light);

    expect(svg).toContain('New model drops');
    expect(svg).toContain('Sign up');
    expect(svg).toContain('Learn another UI');
    expect(svg).toContain('History stuck');
    expect(svg).toContain('Repeat');
  });

  it('includes a loop-back arrow from last step to first', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateProblemFlowSvg(brand.light);

    // Dashed loop-back path uses brand red and dash-array
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('marker-end="url(#arrow-red)"');
  });

  it('uses brand colors from theme', () => {
    const brand = getBrandColors(REPO_ROOT);
    const svg = generateProblemFlowSvg(brand.dark);

    expect(svg).toContain(brand.dark.brandRed);
    expect(svg).toContain(brand.dark.background);
  });
});

describe('generateProblemFlows', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'problem-flow-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('writes both dark and light SVG files', () => {
    generateProblemFlows(temporaryDir, REPO_ROOT);
    const files = readdirSync(temporaryDir);

    expect(files).toContain('problem-flow-dark.svg');
    expect(files).toContain('problem-flow-light.svg');
  });

  it('written files are valid SVGs', () => {
    generateProblemFlows(temporaryDir, REPO_ROOT);
    const content = readFileSync(path.join(temporaryDir, 'problem-flow-dark.svg'), 'utf8');

    expect(content).toContain('<svg');
    expect(content).toContain('</svg>');
  });

  it('defaults to process.cwd() as the repo root when none is given', () => {
    const originalCwd = process.cwd();
    process.chdir(REPO_ROOT);
    try {
      generateProblemFlows(temporaryDir);

      expect(readdirSync(temporaryDir)).toContain('problem-flow-dark.svg');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
