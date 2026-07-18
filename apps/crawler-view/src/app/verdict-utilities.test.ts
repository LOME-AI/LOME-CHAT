import { describe, it, expect } from 'vitest';
import { worstVerdict, overallVerdict } from './verdict-utilities';
import type { Audience, Finding } from '../engine';

describe('worstVerdict', () => {
  it('returns the most severe level across findings', () => {
    const findings: Finding[] = [
      { level: 'pass', message: '', bots: [] },
      { level: 'warn', message: '', bots: [] },
      { level: 'fail', message: '', bots: [] },
    ];
    expect(worstVerdict(findings)).toBe('fail');
  });

  it('defaults to pass for an empty finding list', () => {
    expect(worstVerdict([])).toBe('pass');
  });
});

describe('overallVerdict', () => {
  it('rolls the worst level across all audiences', () => {
    const verdict: Record<Audience, Finding[]> = {
      ai: [{ level: 'pass', message: '', bots: [] }],
      search: [{ level: 'warn', message: '', bots: [] }],
      social: [{ level: 'pass', message: '', bots: [] }],
    };
    expect(overallVerdict(verdict)).toBe('warn');
  });
});
