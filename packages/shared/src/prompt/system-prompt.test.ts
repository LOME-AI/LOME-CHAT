import { describe, expect, it } from 'vitest';
import { buildTurnSystemPrompt } from './system-prompt.js';

const NOW = new Date('2026-07-08T13:45:00.000Z');

describe('buildTurnSystemPrompt', () => {
  describe('base preamble', () => {
    it('states the HushBox assistant identity', () => {
      expect(buildTurnSystemPrompt({ now: NOW })).toContain(
        'You are a helpful AI assistant powered by HushBox.'
      );
    });

    it('describes the unified multi-model product', () => {
      const prompt = buildTurnSystemPrompt({ now: NOW });
      expect(prompt).toContain('unified AI chat interface');
      expect(prompt).toContain('switch models mid-conversation');
    });

    it('states the encryption notice', () => {
      const prompt = buildTurnSystemPrompt({ now: NOW });
      expect(prompt).toContain('All conversations are encrypted');
      expect(prompt).toContain('only the user can decrypt them');
    });

    it('carries the current date as YYYY-MM-DD from the injected clock', () => {
      expect(buildTurnSystemPrompt({ now: NOW })).toContain('Current date: 2026-07-08');
    });
  });

  describe('code-execution capability blocks are omitted (deferred capability)', () => {
    it('never mentions Python code execution', () => {
      expect(buildTurnSystemPrompt({ now: NOW })).not.toContain('Python Code Execution');
    });

    it('never mentions JavaScript code execution', () => {
      expect(buildTurnSystemPrompt({ now: NOW })).not.toContain('JavaScript Code Execution');
    });
  });

  describe('custom instructions section', () => {
    it('appends the section when instructions are present', () => {
      const prompt = buildTurnSystemPrompt({ now: NOW, customInstructions: 'Be terse.' });
      expect(prompt).toContain("## User's Custom Instructions\nBe terse.");
    });

    it('omits the section entirely when instructions are absent', () => {
      expect(buildTurnSystemPrompt({ now: NOW })).not.toContain("User's Custom Instructions");
    });

    it('omits the section when instructions are an empty string', () => {
      expect(buildTurnSystemPrompt({ now: NOW, customInstructions: '' })).not.toContain(
        "User's Custom Instructions"
      );
    });

    it('treats whitespace-only instructions as absent (base-only, no dangling section)', () => {
      expect(buildTurnSystemPrompt({ now: NOW, customInstructions: '   \n\t ' })).toBe(
        buildTurnSystemPrompt({ now: NOW })
      );
    });

    it('places the custom-instructions section after the base preamble', () => {
      const prompt = buildTurnSystemPrompt({ now: NOW, customInstructions: 'Speak French.' });
      const baseIndex = prompt.indexOf('You are a helpful AI assistant');
      const customIndex = prompt.indexOf("## User's Custom Instructions");
      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(customIndex).toBeGreaterThan(baseIndex);
    });
  });

  it('base-only output is exactly the preamble (no trailing capability sections)', () => {
    expect(buildTurnSystemPrompt({ now: NOW })).toBe(
      [
        'You are a helpful AI assistant powered by HushBox.',
        'HushBox is a unified AI chat interface that lets users access multiple AI models — including GPT, Claude, Gemini, and more — from a single application. Users can switch models mid-conversation while keeping their conversation history.',
        'All conversations are encrypted. Messages are encrypted before storage, and only the user can decrypt them.',
        'You provide accurate, helpful responses while being concise and clear.',
        'Current date: 2026-07-08',
      ].join('\n')
    );
  });
});
