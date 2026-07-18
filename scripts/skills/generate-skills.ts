import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../lib/is-main.js';
import { withCache } from '../readme/cache.js';

/**
 * The single source of truth for the anti-slop checklist. Every skill that
 * embeds the checklist injects this file at generate time; no skill duplicates
 * the rules by hand and no skill points at another skill to read them.
 */
const FRAGMENT_PATH = '.claude/skills/anti-ai-writing/anti-slop-rules.md';

const SKILLS_DIR = '.claude/skills';

/**
 * Prepended to every generated SKILL.md. It sits after the YAML frontmatter,
 * never before it: a skill's frontmatter `---` fence must be the file's first
 * line or Claude Code fails to parse it.
 */
const NOTICE =
  '<!-- AUTO-GENERATED from SKILL.template.md. Do not edit directly; edit the template (or anti-slop-rules.md for the shared checklist), then run pnpm generate:skills. -->';

export interface SkillTarget {
  name: string;
  templatePath: string;
  outputPath: string;
}

/**
 * Template values injected into every SKILL.template.md. The checklist is read
 * from the single-source fragment so editing one file updates every skill.
 */
export function getSkillTemplateValues(rootDir: string): Record<string, string> {
  const fragment = readFileSync(path.resolve(rootDir, FRAGMENT_PATH), 'utf8').trim();
  return { ANTI_SLOP_CHECKLIST: fragment };
}

/** Every skill directory that opts into generation by holding a SKILL.template.md. */
export function collectSkillTargets(rootDir: string): SkillTarget[] {
  const skillsDir = path.join(rootDir, SKILLS_DIR);
  return readdirSync(skillsDir)
    .filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.template.md')))
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      templatePath: path.join(skillsDir, name, 'SKILL.template.md'),
      outputPath: path.join(skillsDir, name, 'SKILL.md'),
    }));
}

/** Files whose contents determine the generated SKILL.md output. */
export function collectSkillInputs(rootDir: string): string[] {
  return [
    path.join(rootDir, 'scripts/skills/generate-skills.ts'),
    path.join(rootDir, FRAGMENT_PATH),
    ...collectSkillTargets(rootDir).map((target) => target.templatePath),
  ];
}

/**
 * Insert the do-not-edit notice after the frontmatter fence, or at the top when
 * the file has none. Leading blank lines of the body are collapsed so the
 * output stays Prettier-clean.
 */
export function withNotice(content: string, notice: string): string {
  const fence = '\n---\n';
  if (content.startsWith('---\n')) {
    const close = content.indexOf(fence, 3);
    if (close !== -1) {
      const insertAt = close + fence.length;
      const before = content.slice(0, insertAt);
      const after = content.slice(insertAt).replace(/^\n+/, '');
      return `${before}\n${notice}\n\n${after}`;
    }
  }
  return `${notice}\n\n${content.replace(/^\n+/, '')}`;
}

/**
 * Generate each skill's SKILL.md from its SKILL.template.md by injecting the
 * shared checklist. Exits code 1 on any unmatched `{{VARIABLE}}` (blocks the
 * commit). Cached: skips when inputs and outputs are unchanged.
 */
export function generateSkills(rootDir: string): void {
  const targets = collectSkillTargets(rootDir);
  withCache(
    {
      label: 'Skills',
      hashPath: path.join(rootDir, SKILLS_DIR, '.cache/skills.hash'),
      inputs: collectSkillInputs(rootDir),
      outputs: targets.map((target) => target.outputPath),
    },
    () => {
      const values = getSkillTemplateValues(rootDir);
      for (const target of targets) {
        let content = readFileSync(target.templatePath, 'utf8');
        for (const [key, value] of Object.entries(values)) {
          content = content.replaceAll(new RegExp(String.raw`\{\{${key}\}\}`, 'g'), () => value);
        }

        const unmatchedVariables = content.match(/\{\{[A-Z_]+\}\}/g);
        if (unmatchedVariables) {
          console.error('ERROR: Unmatched template variables found:');
          for (const variable of new Set(unmatchedVariables)) {
            console.error(` - ${variable}`);
          }
          console.error(`Fix the placeholders in ${target.templatePath}`);
          process.exit(1);
        }

        writeFileSync(target.outputPath, withNotice(content, NOTICE));
        console.log(`✓ Generated ${target.name}/SKILL.md from template`);
      }
    }
  );
}

/* v8 ignore start -- CLI wiring; generator covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain) generateSkills(process.cwd());
/* v8 ignore stop */
