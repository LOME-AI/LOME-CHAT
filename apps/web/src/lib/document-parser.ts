import { bundledLanguagesInfo } from 'shiki';

export interface Document {
  id: string;
  type: 'code' | 'mermaid' | 'html' | 'react';
  language?: string;
  title: string;
  content: string;
  lineCount: number;
}

export const MIN_LINES_FOR_DOCUMENT = 15;

const DISPLAY_NAMES = new Map<string, string>();
for (const lang of bundledLanguagesInfo) {
  DISPLAY_NAMES.set(lang.id, lang.name);
  if (lang.aliases) {
    for (const alias of lang.aliases) {
      DISPLAY_NAMES.set(alias, lang.name);
    }
  }
}

const FILE_EXTENSIONS = new Map<string, string>();
for (const lang of bundledLanguagesInfo) {
  const candidates = (lang.aliases ?? [])
    .filter((a) => /^[a-z\d]+$/i.test(a))
    .toSorted((a, b) => a.length - b.length);
  const extension = candidates[0];
  if (extension) {
    FILE_EXTENSIONS.set(lang.id, extension);
    // Reaching here means `candidates` (derived from `lang.aliases`) was
    // non-empty, so `lang.aliases` is defined; the `?? []` fallback is unreachable.
    /* v8 ignore next */
    for (const alias of lang.aliases ?? []) {
      FILE_EXTENSIONS.set(alias, extension);
    }
  }
}

export function getLanguageDisplayName(language: string): string {
  return (
    DISPLAY_NAMES.get(language.toLowerCase()) ??
    language.charAt(0).toUpperCase() + language.slice(1)
  );
}

export function getFileExtension(language: string): string {
  return FILE_EXTENSIONS.get(language.toLowerCase()) ?? language.toLowerCase();
}

export function getDocumentType(language: string): Document['type'] {
  const lang = language.toLowerCase();
  if (lang === 'mermaid') return 'mermaid';
  if (lang === 'html') return 'html';
  if (lang === 'jsx' || lang === 'tsx') return 'react';
  return 'code';
}

export function generateDocumentId(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index++) {
    /* v8 ignore next -- `index` is always < content.length, so codePointAt never returns undefined; the `?? 0` fallback is unreachable. */
    const char = content.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `doc-${Math.abs(hash).toString(36)}`;
}

export function shouldExtractAsDocument(language: string | undefined, lineCount: number): boolean {
  if (!language) return false;
  if (language.toLowerCase() === 'mermaid') return true;
  return lineCount >= MIN_LINES_FOR_DOCUMENT;
}

const MERMAID_TITLES: Record<string, string> = {
  flowchart: 'Flowchart Diagram',
  sequenceDiagram: 'Sequence Diagram',
  classDiagram: 'Class Diagram',
  stateDiagram: 'State Diagram',
  erDiagram: 'ER Diagram',
  gantt: 'Gantt Chart',
  pie: 'Pie Chart',
  graph: 'Graph Diagram',
};

function getMermaidTitle(firstLine: string): string {
  for (const [prefix, title] of Object.entries(MERMAID_TITLES)) {
    if (firstLine.startsWith(prefix)) return title;
  }
  return 'Mermaid Diagram';
}

const CODE_PATTERNS: { regex: RegExp; group: number }[] = [
  {
    regex: /(?:function|const|let|var|export\s+(?:default\s+)?(?:function|const))\s+(\w+)/,
    group: 1,
  },
  { regex: /(?:class|interface|type|enum)\s+(\w+)/, group: 1 },
  { regex: /(?:def|class)\s+(\w+)/, group: 1 },
];

function isCommentLine(line: string): boolean {
  return (
    line.startsWith('//') ||
    line.startsWith('#') ||
    line.startsWith('/*') ||
    line.startsWith('*') ||
    line.startsWith('*/')
  );
}

function extractCodeTitle(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;

    for (const { regex, group } of CODE_PATTERNS) {
      const match = regex.exec(trimmed);
      if (match?.[group]) return match[group];
    }
    break;
  }
  return null;
}

export function extractTitle(content: string, language: string, type: Document['type']): string {
  const lines = content.split('\n');

  if (type === 'mermaid') {
    // `split('\n')` always yields at least one element and `trim()` returns a
    // string, so the `?? ''` fallback is unreachable.
    /* v8 ignore next */
    return getMermaidTitle(lines[0]?.trim() ?? '');
  }

  const codeTitle = extractCodeTitle(lines);
  if (codeTitle) return codeTitle;

  return getLanguageDisplayName(language);
}
