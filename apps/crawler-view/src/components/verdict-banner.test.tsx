import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerdictBanner } from './verdict-banner';
import type { Audience, Finding } from '../engine';

function verdict(overrides: Partial<Record<Audience, Finding[]>>): Record<Audience, Finding[]> {
  const pass: Finding = { level: 'pass', message: 'No blocking issues.', bots: [] };
  return {
    ai: overrides.ai ?? [pass],
    search: overrides.search ?? [pass],
    social: overrides.social ?? [pass],
  };
}

describe('VerdictBanner', () => {
  it('renders each finding message and its affected bot labels', () => {
    render(
      <VerdictBanner
        verdict={verdict({
          ai: [
            {
              level: 'fail',
              message: 'Near-empty page for crawlers.',
              bots: ['GPTBot', 'ClaudeBot'],
            },
          ],
        })}
      />
    );

    expect(screen.getByText('Near-empty page for crawlers.')).toBeInTheDocument();
    expect(screen.getByText('GPTBot')).toBeInTheDocument();
    expect(screen.getByText('ClaudeBot')).toBeInTheDocument();
  });

  it('shows the worst level as the audience verdict label', () => {
    render(
      <VerdictBanner
        verdict={verdict({
          search: [
            { level: 'warn', message: 'Missing meta description.', bots: ['Googlebot'] },
            { level: 'fail', message: 'Blocked by robots.txt.', bots: ['Googlebot'] },
          ],
        })}
      />
    );

    // Worst of warn+fail is FAIL; the pass audiences still read PASS.
    expect(screen.getAllByText('FAIL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PASS').length).toBeGreaterThan(0);
  });
});
