import { describe, expect, it } from 'vitest';
import { regenerateTurnBodySchema, startTurnBodySchema, trialTurnBodySchema } from './routes.js';

/**
 * The chat turn body schemas gate `customInstructions` at the boundary: it is
 * optional, typed as a string, and length-bounded (5000, matching the
 * InferenceRequest cap). These are pure Zod checks — no route, DO, or stack.
 */

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

const startBase = {
  conversationId: UUID_A,
  model: 'answer-model',
  userMessage: { id: UUID_B, content: 'hello' },
};

const regenerateBase = {
  conversationId: UUID_A,
  model: 'answer-model',
  targetMessageId: UUID_A,
  action: 'retry' as const,
  userMessage: { id: UUID_B, content: 'hello' },
};

const trialBase = { model: 'answer-model', prompt: 'hello' };

describe('startTurnBodySchema customInstructions', () => {
  it('accepts an omitted custom-instructions field', () => {
    expect(startTurnBodySchema.safeParse(startBase).success).toBe(true);
  });

  it('accepts a custom-instructions string up to the 5000-char bound', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      customInstructions: 'x'.repeat(5000),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-string custom-instructions value', () => {
    const parsed = startTurnBodySchema.safeParse({ ...startBase, customInstructions: 42 });
    expect(parsed.success).toBe(false);
  });
});

describe('regenerateTurnBodySchema customInstructions', () => {
  it('accepts a bounded custom-instructions string', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      customInstructions: 'be terse',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('trialTurnBodySchema customInstructions', () => {
  it('accepts a bounded custom-instructions string', () => {
    const parsed = trialTurnBodySchema.safeParse({
      ...trialBase,
      customInstructions: 'answer in French',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = trialTurnBodySchema.safeParse({
      ...trialBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });
});
