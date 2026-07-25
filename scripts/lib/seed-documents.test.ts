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

describe('DOCUMENT_SHOWCASE_MESSAGES', () => {
  it('names the conversation so it is recognisable in the sidebar', () => {
    expect(DOCUMENT_SHOWCASE_TITLE).toBe('Document showcase');
  });

  it('opens with a user prompt and answers with one assistant message per document', () => {
    expect(DOCUMENT_SHOWCASE_MESSAGES[0]?.senderType).toBe('user');
    expect(DOCUMENT_SHOWCASE_MESSAGES.slice(1).map((message) => message.senderType)).toEqual(
      Array.from({ length: 7 }, () => 'ai')
    );
  });

  it('gives every assistant message a lead-in line above exactly one fence', () => {
    for (const block of assistantBlocks()) {
      expect(block.leadIn.length).toBeGreaterThan(0);
      expect(block.body).not.toContain('```');
    }
  });

  it('covers each panel path in order: html, react, python, mermaid, two broken react, plain code', () => {
    expect(assistantBlocks().map((block) => block.language)).toEqual([
      'html',
      'jsx',
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
    const html = assistantBlocks()[0]?.body ?? '';
    expect(html).toContain('<script>');
    expect(html).toContain('addEventListener');
    expect(html).toContain('<button');
  });

  it('imports an npm package by bare specifier in the react document and never imports React', () => {
    const react = assistantBlocks()[1]?.body ?? '';
    expect(react).toContain("from 'canvas-confetti'");
    expect(react).toContain('export default function');
    expect(react).not.toMatch(/from ['"]react['"]/);
  });

  it('computes, prints, and plots in the python document', () => {
    const python = assistantBlocks()[2]?.body ?? '';
    expect(python).toContain('import numpy as np');
    expect(python).toContain('import matplotlib.pyplot as plt');
    expect(python).toContain('print(');
  });

  it('draws a flowchart in the mermaid document', () => {
    expect(assistantBlocks()[3]?.body.startsWith('flowchart')).toBe(true);
  });

  it('leaves a JSX tag unclosed in the compile-failure document', () => {
    const broken = assistantBlocks()[4]?.body ?? '';
    expect(broken.match(/<div>/g)).toHaveLength(1);
    expect(broken).not.toContain('</div>');
  });

  it('reads through an undefined property at render time in the runtime-failure document', () => {
    const broken = assistantBlocks()[5]?.body ?? '';
    expect(broken).toContain('config.palette.accent');
    expect(broken).not.toContain('palette:');
    // Balanced tags: this one must reach the renderer before it throws.
    expect(broken.match(/<section>/g)).toHaveLength(1);
    expect(broken.match(/<\/section>/g)).toHaveLength(1);
  });
});
