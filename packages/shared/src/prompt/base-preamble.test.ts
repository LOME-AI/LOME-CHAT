import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PREAMBLE, RUNNABLE_DOCUMENTS_GUIDANCE } from './base-preamble.js';

describe('BASE_SYSTEM_PREAMBLE', () => {
  it('is the exact static base-identity preamble the system-prompt builder opens with', () => {
    expect(BASE_SYSTEM_PREAMBLE).toBe(
      [
        'You are a helpful AI assistant powered by HushBox.',
        'HushBox is a unified AI chat interface that lets users access multiple AI models — including GPT, Claude, Gemini, and more — from a single application. Users can switch models mid-conversation while keeping their conversation history.',
        'All conversations are encrypted. Messages are encrypted before storage, and only the user can decrypt them.',
        'You provide accurate, helpful responses while being concise and clear.',
      ].join('\n')
    );
  });

  it('carries no dynamic date line (the builder appends its own)', () => {
    expect(BASE_SYSTEM_PREAMBLE).not.toContain('Current date:');
  });
});

describe('RUNNABLE_DOCUMENTS_GUIDANCE', () => {
  it('names each runnable-document fence tag', () => {
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('`html`');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('`js`');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('`jsx`');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('`python`');
  });

  it('biases toward one complete runnable document for visual/interactive asks', () => {
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('visual, interactive, or self-contained');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('prefer ONE complete runnable document');
  });

  it('states the React default-export, no-import, bare-specifier npm rules', () => {
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('default export');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('Do not import React');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('bare specifier');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('canvas-confetti');
  });

  it('describes the Python Run gesture, scientific packages, and auto-install', () => {
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('presses Run');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('matplotlib');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('auto-install');
  });

  it('pins the runtime constraints a document must respect', () => {
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('exactly ONE file');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('no network at runtime');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('`input()`');
    expect(RUNNABLE_DOCUMENTS_GUIDANCE).toContain('visible output');
  });
});
