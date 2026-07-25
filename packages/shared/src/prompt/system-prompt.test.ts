import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PREAMBLE, RUNNABLE_DOCUMENTS_GUIDANCE } from './base-preamble.js';
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

  describe('runnable-documents capability section', () => {
    it('advertises the runnable-documents guidance on every turn', () => {
      expect(buildTurnSystemPrompt({ now: NOW })).toContain(RUNNABLE_DOCUMENTS_GUIDANCE);
    });

    it('places the capability guidance after the base preamble', () => {
      const prompt = buildTurnSystemPrompt({ now: NOW });
      const baseIndex = prompt.indexOf('You are a helpful AI assistant');
      const guidanceIndex = prompt.indexOf(RUNNABLE_DOCUMENTS_GUIDANCE);
      expect(baseIndex).toBeGreaterThanOrEqual(0);
      expect(guidanceIndex).toBeGreaterThan(baseIndex);
    });

    it('places the capability guidance before the custom-instructions section', () => {
      const prompt = buildTurnSystemPrompt({ now: NOW, customInstructions: 'Be terse.' });
      const guidanceIndex = prompt.indexOf(RUNNABLE_DOCUMENTS_GUIDANCE);
      const customIndex = prompt.indexOf("## User's Custom Instructions");
      expect(guidanceIndex).toBeGreaterThan(0);
      expect(customIndex).toBeGreaterThan(guidanceIndex);
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

  it('base-only output is the preamble+date followed by the runnable-documents guidance', () => {
    expect(buildTurnSystemPrompt({ now: NOW })).toBe(
      [`${BASE_SYSTEM_PREAMBLE}\nCurrent date: 2026-07-08`, RUNNABLE_DOCUMENTS_GUIDANCE].join(
        '\n\n'
      )
    );
  });
});
