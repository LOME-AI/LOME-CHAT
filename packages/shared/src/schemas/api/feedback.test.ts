import { describe, expect, it } from 'vitest';
import { submitFeedbackBodySchema } from './feedback.js';

describe('submitFeedbackBodySchema', () => {
  it('accepts a valid kind and body', () => {
    const parsed = submitFeedbackBodySchema.parse({ kind: 'bug', body: 'It crashed on save.' });
    expect(parsed).toEqual({ kind: 'bug', body: 'It crashed on save.' });
  });

  it('trims surrounding whitespace from the body', () => {
    const parsed = submitFeedbackBodySchema.parse({ kind: 'idea', body: '  add dark mode  ' });
    expect(parsed.body).toBe('add dark mode');
  });

  it('rejects an empty body', () => {
    expect(submitFeedbackBodySchema.safeParse({ kind: 'praise', body: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only body', () => {
    expect(submitFeedbackBodySchema.safeParse({ kind: 'bug', body: '   ' }).success).toBe(false);
  });

  it('rejects a body longer than 4000 characters', () => {
    expect(
      submitFeedbackBodySchema.safeParse({ kind: 'bug', body: 'x'.repeat(4001) }).success
    ).toBe(false);
  });

  it('accepts a body of exactly 4000 characters', () => {
    expect(
      submitFeedbackBodySchema.safeParse({ kind: 'bug', body: 'x'.repeat(4000) }).success
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(submitFeedbackBodySchema.safeParse({ kind: 'complaint', body: 'hello' }).success).toBe(
      false
    );
  });
});
