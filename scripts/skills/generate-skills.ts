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

/**
 * The single source of truth for the subagent-driven orchestration engine.
 * Its `<!-- @section: NAME -->` markers split it into named values injected into
 * both the subagent-driven-dev and subagent-driven-e2e-green templates, so
 * neither skill hand-duplicates the shared dispatch loop, scoped checks, or
 * subagent roster.
 */
const CORE_PATH = '.claude/skills/subagent-driven-dev/subagent-driven-core.md';

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
 * Split the shared core file into named values, one per `<!-- @section: NAME -->`
 * marker. Each value is the text from its marker to the next marker (or EOF),
 * trimmed. Text before the first marker (the file's header comment) is ignored.
 */
export function parseCoreSections(core: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const marker = /<!-- @section:\s*([A-Z0-9_]+)\s*-->/g;
  const matches = [...core.matchAll(marker)];
  for (const [index, match] of matches.entries()) {
    const name = match[1] as string;
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? core.length;
    sections[name] = core.slice(start, end).trim();
  }
  return sections;
}

/**
 * Template values injected into every SKILL.template.md. The checklist and the
 * subagent-driven core sections are read from their single-source files so
 * editing one file updates every skill that consumes it.
 */
export function getSkillTemplateValues(rootDir: string): Record<string, string> {
  const fragment = readFileSync(path.resolve(rootDir, FRAGMENT_PATH), 'utf8').trim();
  const core = readFileSync(path.resolve(rootDir, CORE_PATH), 'utf8');
  return { ANTI_SLOP_CHECKLIST: fragment, ...parseCoreSections(core) };
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
    path.join(rootDir, CORE_PATH),
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
