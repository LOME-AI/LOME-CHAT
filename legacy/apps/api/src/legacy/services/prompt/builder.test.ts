import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPrompt } from './builder.js';
import type { ModelFeatureId } from '@hushbox/shared';

describe('buildPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('base module', () => {
    it('always includes base system prompt', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: [],
      });

      expect(result.systemPrompt).toContain('HushBox');
      expect(result.systemPrompt).toContain('helpful');
    });

    it('includes current date in base prompt', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: [],
      });

      expect(result.systemPrompt).toContain('2025-01-15');
    });

    it('returns empty tools array when no capabilities', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: [],
      });

      expect(result.tools).toEqual([]);
    });
  });

  describe('python module', () => {
    it('includes python section when python-execution capability present', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: ['python-execution'],
      });

      expect(result.systemPrompt).toContain('Python Code Execution');
      expect(result.systemPrompt).toContain('execute_python');
    });

    it('includes execute_python tool when capability present', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: ['python-execution'],
      });

      const pythonTool = result.tools.find((t) => t.function.name === 'execute_python');
      expect(pythonTool).toBeDefined();
      if (pythonTool) {
        expect(pythonTool.type).toBe('function');
        expect(pythonTool.function.parameters).toHaveProperty('properties');
      }
    });

    it('excludes python section when capability not present', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: [],
      });

      expect(result.systemPrompt).not.toContain('Python Code Execution');
    });
  });

  describe('javascript module', () => {
    it('includes javascript section when javascript-execution capability present', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: ['javascript-execution'],
      });

      expect(result.systemPrompt).toContain('JavaScript Code Execution');
      expect(result.systemPrompt).toContain('execute_javascript');
    });

    it('includes execute_javascript tool when capability present', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: ['javascript-execution'],
      });

      const jsTool = result.tools.find((t) => t.function.name === 'execute_javascript');
      expect(jsTool).toBeDefined();
      if (jsTool) {
        expect(jsTool.type).toBe('function');
      }
    });

    it('excludes javascript section when capability not present', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: [],
      });

      expect(result.systemPrompt).not.toContain('JavaScript Code Execution');
    });
  });

  describe('multiple capabilities', () => {
    it('includes all modules for supported capabilities', () => {
      const capabilities: ModelFeatureId[] = ['python-execution', 'javascript-execution'];
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: capabilities,
      });

      expect(result.systemPrompt).toContain('HushBox');
      expect(result.systemPrompt).toContain('Python Code Execution');
      expect(result.systemPrompt).toContain('JavaScript Code Execution');
    });

    it('includes all tools from active modules', () => {
      const capabilities: ModelFeatureId[] = ['python-execution', 'javascript-execution'];
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: capabilities,
      });

      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((t) => t.function.name)).toContain('execute_python');
      expect(result.tools.map((t) => t.function.name)).toContain('execute_javascript');
    });
  });

  describe('prompt structure', () => {
    it('joins module sections with double newlines', () => {
      const result = buildPrompt({
        modelId: 'test/model',
        supportedCapabilities: ['python-execution'],
      });

      expect(result.systemPrompt).toMatch(/HushBox[\s\S]*\n\n[\s\S]*Python/);
    });
  });
});
