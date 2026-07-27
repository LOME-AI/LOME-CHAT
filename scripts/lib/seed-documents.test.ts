import { describe, expect, it } from 'vitest';
import { MIN_LINES_FOR_DOCUMENT } from '@hushbox/shared/documents';

import { DOCUMENT_SHOWCASE_MESSAGES, DOCUMENT_SHOWCASE_TITLE } from './seed-documents.js';

interface FencedBlock {
  leadIn: string;
  language: string;
  body: string;
}

/**
 * Reads a seeded assistant message the way the renderer does: a lead-in line,
 * then one fenced block whose info string is the language (empty when the fence
 * declares none).
 */
function readFencedMessage(content: string): FencedBlock {
  const match = /^(?<leadIn>[^\n]+)\n\n```(?<language>[a-z]*)\n(?<body>[\s\S]*)\n```$/.exec(
    content
  );
  if (match?.groups === undefined) throw new Error(`not a lead-in + single fence:\n${content}`);
  const { leadIn = '', language = '', body = '' } = match.groups;
  return { leadIn, language, body };
}

function assistantBlocks(): FencedBlock[] {
  return DOCUMENT_SHOWCASE_MESSAGES.filter((message) => message.senderType === 'ai').map(
    (message) => readFencedMessage(message.content)
  );
}

function lineCount(body: string): number {
  return body.split('\n').length;
}

/** Where each document sits in the transcript, so the order lives in one place. */
const POSITIONS = {
  html: 0,
  react: 1,
  js: 2,
  python: 3,
  mermaid: 4,
  compileFailure: 5,
  runtimeFailure: 6,
  plain: 7,
} as const;

function documentAt(position: keyof typeof POSITIONS): FencedBlock {
  const block = assistantBlocks()[POSITIONS[position]];
  if (block === undefined) throw new Error(`no document at ${position}`);
  return block;
}

/** Every bare (npm) specifier a document imports, in source order. */
function bareImports(body: string): string[] {
  return [...body.matchAll(/\bfrom\s+'([^']+)'/g)]
    .map(([, specifier = '']) => specifier)
    .filter((specifier) => !specifier.startsWith('.') && !specifier.includes(':'));
}

describe('DOCUMENT_SHOWCASE_MESSAGES', () => {
  it('names the conversation so it is recognisable in the sidebar', () => {
    expect(DOCUMENT_SHOWCASE_TITLE).toBe('Document showcase');
  });

  it('opens with a user prompt and answers with one assistant message per document', () => {
    expect(DOCUMENT_SHOWCASE_MESSAGES[0]?.senderType).toBe('user');
    expect(DOCUMENT_SHOWCASE_MESSAGES.slice(1).map((message) => message.senderType)).toEqual(
      Array.from({ length: 8 }, () => 'ai')
    );
  });

  it('gives every assistant message a lead-in line above exactly one fence', () => {
    for (const block of assistantBlocks()) {
      expect(block.leadIn.length).toBeGreaterThan(0);
      expect(block.body).not.toContain('```');
    }
  });

  it('covers every runnable kind, the diagram, both failures, and a plain block, in order', () => {
    expect(assistantBlocks().map((block) => block.language)).toEqual([
      'html',
      'jsx',
      'js',
      'python',
      'mermaid',
      'jsx',
      'jsx',
      '',
    ]);
  });

  it('makes every block long enough to clear the document-extraction threshold', () => {
    for (const block of assistantBlocks()) {
      expect(lineCount(block.body)).toBeGreaterThanOrEqual(MIN_LINES_FOR_DOCUMENT);
    }
  });

  it('leaves exactly one block without a language so it stays a plain code block', () => {
    const untagged = assistantBlocks().filter((block) => block.language === '');
    expect(untagged).toHaveLength(1);
    // Long enough that only the missing language keeps it out of the panel.
    expect(lineCount(untagged[0]?.body ?? '')).toBeGreaterThanOrEqual(MIN_LINES_FOR_DOCUMENT);
  });

  it('wires the html document to a button that mutates the page', () => {
    const html = documentAt('html').body;
    expect(html).toContain('<script>');
    expect(html).toContain('addEventListener');
    expect(html).toContain('<button');
  });

  it('draws to a canvas from several controls in the html document', () => {
    const html = documentAt('html').body;
    expect(html).toContain('<canvas');
    expect(html).toContain("getContext('2d')");
    expect(html).toContain('<select');
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('imports an npm package by bare specifier in the react document and never imports React itself', () => {
    const react = documentAt('react').body;
    expect(react).toContain("from 'canvas-confetti'");
    expect(react).toContain('export default function');
    // The automatic JSX runtime supplies the element factory, so the React
    // namespace is never imported — only the hooks the component actually calls.
    expect(react).not.toMatch(/import\s+(?:React|\*)/);
  });

  it('holds real state across several components in the react document', () => {
    const react = documentAt('react').body;
    expect(react).toContain('useReducer');
    expect(react).toContain('useMemo');
    expect(react).toContain('<svg');
    expect(react).toContain('<input');
    expect(react.match(/^function [A-Z]/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('imports only npm packages whose resolution on the module CDN has been verified', () => {
    const specifiers = assistantBlocks().flatMap((block) => bareImports(block.body));
    // Every entry here must be checked against the module CDN before it ships:
    // a specifier that does not resolve turns the whole document into an error card.
    expect(specifiers).toEqual(['react', 'canvas-confetti']);
  });

  it('builds its own DOM from a plain module in the js document', () => {
    const js = documentAt('js').body;
    expect(js).toContain("document.querySelector('#document-root')");
    expect(js).toContain('document.createElement');
    expect(js).toContain('addEventListener');
    // A js document is a module run for its DOM effects, not a component to mount.
    expect(js).not.toContain('export ');
  });

  it('computes, prints, and plots in the python document', () => {
    const python = documentAt('python').body;
    expect(python).toContain('import numpy as np');
    expect(python).toContain('import matplotlib.pyplot as plt');
    expect(python).toContain('print(');
  });

  it('fits a trend and draws a multi-panel figure in the python document', () => {
    const python = documentAt('python').body;
    expect(python).toContain('np.polyfit');
    expect(python).toContain('plt.subplots(1, 2');
    expect(python.match(/print\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('draws a flowchart in the mermaid document', () => {
    expect(documentAt('mermaid').body.startsWith('flowchart')).toBe(true);
  });

  it('announces both failure documents as deliberate, in the card title and the lead-in', () => {
    for (const position of ['compileFailure', 'runtimeFailure'] as const) {
      const block = documentAt(position);
      // The panel titles a code document after its first declaration, so that
      // name is the card's label — it has to say the failure is intended.
      expect(/^const (\w+)/.exec(block.body)?.[1]).toMatch(/OnPurpose$/);
      expect(block.leadIn).toMatch(/on purpose/i);
    }
  });

  it('leaves a JSX tag unclosed in the compile-failure document', () => {
    const broken = documentAt('compileFailure').body;
    expect(broken.match(/<div>/g)).toHaveLength(1);
    expect(broken).not.toContain('</div>');
  });

  it('reads through an undefined property at render time in the runtime-failure document', () => {
    const broken = documentAt('runtimeFailure').body;
    expect(broken).toContain('config.palette.accent');
    expect(broken).not.toContain('palette:');
    // Balanced tags: this one must reach the renderer before it throws.
    expect(broken.match(/<section>/g)).toHaveLength(1);
    expect(broken.match(/<\/section>/g)).toHaveLength(1);
  });
});
