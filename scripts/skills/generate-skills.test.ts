import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectSkillTargets,
  generateSkills,
  getSkillTemplateValues,
  withNotice,
} from './generate-skills.js';

const NOTICE = '<!-- test-notice -->';

function makeFragment(rootDir: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills/anti-ai-writing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'anti-slop-rules.md'), body);
}

function makeSkillTemplate(rootDir: string, name: string, body: string): void {
  const dir = path.join(rootDir, '.claude/skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.template.md'), body);
}

describe('withNotice', () => {
  it('inserts the notice after YAML frontmatter', () => {
    const out = withNotice('---\nname: x\n---\n\n# Body\ntext', NOTICE);

    expect(out).toBe('---\nname: x\n---\n\n<!-- test-notice -->\n\n# Body\ntext');
  });

  it('prepends the notice when there is no frontmatter', () => {
    const out = withNotice('# Hello\nworld', NOTICE);

    expect(out).toBe('<!-- test-notice -->\n\n# Hello\nworld');
  });

  it('prepends the notice when the frontmatter is unterminated', () => {
    const out = withNotice('---\nname: x\nno close', NOTICE);

    expect(out).toBe('<!-- test-notice -->\n\n---\nname: x\nno close');
  });
});

describe('getSkillTemplateValues', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-values-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('returns the trimmed fragment under ANTI_SLOP_CHECKLIST', () => {
    makeFragment(temporaryDir, '\n## Banned Vocabulary\n\nrules\n\n');

    const values = getSkillTemplateValues(temporaryDir);

    expect(values['ANTI_SLOP_CHECKLIST']).toBe('## Banned Vocabulary\n\nrules');
  });
});

describe('collectSkillTargets', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-targets-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('discovers only skill directories that contain a SKILL.template.md', () => {
    makeSkillTemplate(temporaryDir, 'write-blog', 'x');
    makeSkillTemplate(temporaryDir, 'anti-ai-writing', 'y');
    mkdirSync(path.join(temporaryDir, '.claude/skills/no-template'), { recursive: true });

    const targets = collectSkillTargets(temporaryDir);

    expect(targets.map((t) => t.name)).toEqual(['anti-ai-writing', 'write-blog']);
    expect(targets[1]?.outputPath).toBe(
      path.join(temporaryDir, '.claude/skills/write-blog/SKILL.md')
    );
  });
});

describe('generateSkills', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'skills-generate-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('substitutes the shared checklist and writes SKILL.md with the notice', () => {
    makeFragment(temporaryDir, '## Banned Vocabulary\n\nNever use em-dashes.');
    makeSkillTemplate(
      temporaryDir,
      'anti-ai-writing',
      '---\nname: anti-ai-writing\n---\n\n# Anti-Slop Rules\n\nintro\n\n{{ANTI_SLOP_CHECKLIST}}\n'
    );
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    generateSkills(temporaryDir);

    const output = readFileSync(
      path.join(temporaryDir, '.claude/skills/anti-ai-writing/SKILL.md'),
      'utf8'
    );
    expect(output).toContain('## Banned Vocabulary');
    expect(output).toContain('Never use em-dashes.');
    expect(output).not.toContain('{{ANTI_SLOP_CHECKLIST}}');
    expect(output).toContain('AUTO-GENERATED');
    // The notice must land after the frontmatter, never before the `---` fence.
    expect(output.indexOf('AUTO-GENERATED')).toBeGreaterThan(
      output.indexOf('name: anti-ai-writing')
    );

    mockLog.mockRestore();
  });

  it('exits with code 1 on an unmatched template variable', () => {
    makeFragment(temporaryDir, 'rules');
    makeSkillTemplate(
      temporaryDir,
      'write-blog',
      '---\nname: write-blog\n---\n\n{{ANTI_SLOP_CHECKLIST}} {{UNKNOWN_VAR}}'
    );
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const mockLog = vi.spyOn(console, 'log').mockImplementation(vi.fn());

    expect(() => {
      generateSkills(temporaryDir);
    }).toThrow('process.exit called');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith('ERROR: Unmatched template variables found:');
    expect(mockError).toHaveBeenCalledWith(' - {{UNKNOWN_VAR}}');

    mockExit.mockRestore();
    mockError.mockRestore();
    mockLog.mockRestore();
  });
});
