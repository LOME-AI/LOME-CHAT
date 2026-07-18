import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnswerBotPanel } from './answer-bot-panel';
import type { ContentInfo } from '../engine';

function content(overrides: Partial<ContentInfo>): ContentInfo {
  return {
    h1Count: 1,
    headingOutline: [{ level: 1, text: 'Heading' }],
    hasSkippedHeadingLevels: false,
    wordCount: 200,
    textToHtmlRatio: 0.5,
    links: { internal: 3, external: 1, nofollow: 0 },
    images: { total: 2, withAlt: 2 },
    textBlob: 'Plenty of readable prose for a crawler to ingest.',
    ...overrides,
  };
}

describe('AnswerBotPanel', () => {
  it('makes the empty-body failure loud when word count is near zero', () => {
    render(<AnswerBotPanel content={content({ wordCount: 0, textBlob: '' })} />);

    expect(screen.getByText(/Near-empty page for no-JavaScript crawlers/i)).toBeInTheDocument();
    expect(screen.getByText('0 words')).toBeInTheDocument();
  });

  it('does not show the empty-body highlight for a healthy page', () => {
    render(<AnswerBotPanel content={content({ wordCount: 200 })} />);

    expect(
      screen.queryByText(/Near-empty page for no-JavaScript crawlers/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText('200 words')).toBeInTheDocument();
  });
});
