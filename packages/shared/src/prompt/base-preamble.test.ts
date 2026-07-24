import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PREAMBLE } from './base-preamble.js';

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
